import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { discoverT3Relations, formatSessionRelations } from "../skills/yjx-retro/scripts/session-relations.mjs";

// Structural database fixtures only: no conversations or model/Prompt evaluation.
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,title TEXT,created_at TEXT,deleted_at TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT,run_id TEXT,ordinal INTEGER);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT,run_id TEXT,ordinal INTEGER,turn_item_id TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT,thread_id TEXT,run_id TEXT,child_thread_id TEXT,origin TEXT,started_at TEXT);
    CREATE TABLE orchestration_v2_projection_context_transfers (context_transfer_id TEXT,source_thread_id TEXT,target_thread_id TEXT,target_run_id TEXT,type TEXT,status TEXT,updated_at TEXT,payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT,thread_id TEXT,run_id TEXT,created_at TEXT,updated_at TEXT,payload_json TEXT);
  `);
  const thread = (id, payload = {}, created = "2020-01-01T00:00:00Z") => db.prepare(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, NULL, ?)"
  ).run(id, id, created, JSON.stringify(payload));
  const run = (id, runId, ordinal, itemOrdinal = ordinal) => {
    db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)").run(id, runId, ordinal);
    db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?)").run(
      id, runId, itemOrdinal, `item-${id}-${itemOrdinal}`, JSON.stringify({ startedAt: "2020-01-02T00:00:00Z" }));
  };
  return { db, thread, run };
}
const untilTime = "2020-02-01T00:00:00Z";

test("结构闭包区分 fork 可见历史、side chat 起点及有方向回传，并按身份去重", (t) => {
  const { db, thread, run } = fixture(t);
  thread("parent"); run("parent", "p-2", 2); run("parent", "p-3", 3);
  thread("root", { lineage: { parentThreadId: "parent" }, forkedFrom: { type: "run", threadId: "parent", runId: "p-2" } });
  thread("side", { lineage: { parentThreadId: "parent", sideChat: true }, forkedFrom: { type: "run", threadId: "parent", runId: "p-3" } });
  thread("child");
  run("side", "s-1", 1);
  db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES ('dispatch', 'side', 's-1', 'child', 'provider_native', '2020-01-02T00:00:00Z')").run();
  db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES ('return', 'parent', 'p-3', '2020-01-03T00:00:00Z', '2020-01-03T00:00:00Z', ?)").run(JSON.stringify({ senderThreadId: "side" }));
  const direct = discoverT3Relations(db, "root", { untilTime });
  assert.equal(direct.nodes.some((n) => n.threadId === "child"), false);
  const graph = discoverT3Relations(db, "root", { untilTime, relationScope: "closure" });
  assert.deepEqual(graph.nodes.map((n) => n.threadId).sort(), ["child", "parent", "root", "side"]);
  assert.equal(graph.ancestors[0].throughRunOrdinal, 2);
  assert.equal(graph.ancestors[0].visibleHistoryInherited, true);
  const side = graph.edges.find((e) => e.kind === "side-chat");
  assert.equal(side.inheritsVisibleHistory, false);
  assert.equal(side.withinInheritedRange[0].within, false);
  const returned = graph.edges.find((e) => e.kind === "thread-message");
  assert.equal(returned.from, "side");
  assert.equal(returned.to, "parent");
  assert.equal(returned.withinInheritedRange[0].within, false);
  assert.equal(discoverT3Relations(db, "side", { untilTime }).ancestors[0].visibleHistoryInherited, false);
  assert.equal(graph.nodes.every((n) => n.reviewStatus === "not-reviewed"), true);
});

test("历史 cutoff 使用创建时间与 root 本地 Run，不能以当前 consumed 状态反推历史回传", (t) => {
  const { db, thread, run } = fixture(t);
  thread("root"); run("root", "r-1", 1, 10); run("root", "r-2", 2, 20);
  thread("late-fork", { forkedFrom: { type: "run", threadId: "root", runId: "r-1" } }, "2020-03-01T00:00:00Z");
  thread("child"); thread("late-dispatch", { lineage: { parentThreadId: "root", relationshipToParent: "subagent" } });
  run("child", "c-1", 1);
  db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES ('late', 'root', 'r-2', 'late-dispatch', 'app_owned', '2020-01-03T00:00:00Z')").run();
  const transfer = { sourcePoint: { threadId: "child", runId: "c-1" }, createdAt: "2020-01-03T00:00:00Z", consumedAt: "2020-03-01T00:00:00Z" };
  db.prepare("INSERT INTO orchestration_v2_projection_context_transfers VALUES ('merge', 'child', 'root', 'r-1', 'merge_back', 'consumed', '2020-03-01T00:00:00Z', ?)").run(JSON.stringify(transfer));
  const graph = discoverT3Relations(db, "root", { untilTime, untilOrdinal: 10, relationScope: "closure" });
  assert.deepEqual(graph.nodes.map((n) => n.threadId).sort(), ["child", "root"]);
  assert.equal(graph.rootRunLimit, 1);
  const edge = graph.edges.find((e) => e.transferType === "merge_back");
  assert.equal(edge.consumedBeforeCutoff, false);
  assert.equal(edge.statusAtCutoff, "unverified");
  assert.equal(edge.sourcePoint.throughRunOrdinal, 1);
  const markdown = formatSessionRelations(graph);
  assert.match(markdown, /status at cutoff=unverified, consumed before cutoff=false/);
  assert.match(markdown, /payload updated after cutoff/);
});

test("同 Run 的晚派发按条目序号排除，仅传 ordinal 时推导时间上界，缺时间时显式保留缺口", (t) => {
  const { db, thread, run } = fixture(t);
  thread("root"); run("root", "r-1", 1, 10);
  thread("late", { lineage: { parentThreadId: "root", relationshipToParent: "subagent" } });
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES ('root', 'r-1', 11, 'late-item', ?)").run(JSON.stringify({
    startedAt: "2020-01-03T00:00:00Z", subagentId: "late-dispatch",
  }));
  db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES ('late-dispatch', 'root', 'r-1', 'late', 'app_owned', '2020-01-03T01:00:00Z')").run();
  const inferred = discoverT3Relations(db, "root", { untilOrdinal: 10, relationScope: "closure" });
  assert.equal(inferred.untilTime, "2020-01-03T00:00:00.000Z");
  assert.deepEqual(inferred.nodes.map((n) => n.threadId), ["root"]);
  const explicit = discoverT3Relations(db, "root", { untilOrdinal: 10, untilTime, relationScope: "closure" });
  assert.deepEqual(explicit.nodes.map((n) => n.threadId), ["root"]);
  db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES ('outbound', 'late', NULL, '2020-01-03T01:00:00Z', '2020-01-03T01:00:00Z', ?)").run(JSON.stringify({ senderThreadId: "root" }));
  const outbound = discoverT3Relations(db, "root", { untilOrdinal: 10, untilTime });
  const message = outbound.edges.find((e) => e.messageId === "outbound");
  assert.equal(message.associationPoints.find((p) => p.role === "sender").threadId, "root");
  assert.equal(outbound.gaps.some((g) => g.reason === "root-association-item-unresolved" && g.source === message.location), true);
  assert.match(formatSessionRelations(outbound), /sender ordinal unavailable \(root cutoff unverified\)/);
  db.prepare("UPDATE orchestration_v2_projection_turn_items SET payload_json='{}'").run();
  const unknown = discoverT3Relations(db, "root", { untilOrdinal: 10 });
  assert.equal(unknown.gaps.some((g) => g.reason.includes("root-cutoff-time-unavailable")), true);
});

test("缺失可选表与无法解析的 fork 边界降级为具体缺口，保留已有线程证据", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT,title TEXT,payload_json TEXT)");
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('root', 'root', ?)").run(JSON.stringify({
    forkedFrom: { threadId: "missing-parent", runId: "missing-run", type: "run" },
  }));
  const graph = discoverT3Relations(db, "root", { untilTime, relationScope: "closure" });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.ancestors[0].throughRunOrdinal, null);
  assert.equal(graph.gaps.some((g) => g.reason === "relation-source-unavailable"), true);
  assert.equal(graph.gaps.some((g) => g.reason === "fork-boundary-unresolved"), true);
  assert.equal(graph.gaps.some((g) => g.reason === "related-thread-unavailable"), true);
  assert.equal(graph.discoveryStatus, "candidates-found-with-gaps");
});
