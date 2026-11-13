import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeFiles,
  formatMarkdown,
  preflightFiles,
} from "../skills/yjx-retro-skill/scripts/extract-session-evidence.mjs";

function meta(ordinal) {
  return { ordinal, type: "session_meta", payload: { id: "sess-r", cwd: "/repo" } };
}
function human(ordinal, text) {
  return {
    ordinal,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}
function skill(ordinal, name) {
  return human(ordinal, `<skill>\n<name>${name}</name>\n<path>/skills/${name}/SKILL.md</path>\nbody\n</skill>`);
}
function compacted(ordinal) {
  return { ordinal, type: "compacted", payload: { window_number: 1 } };
}
async function writeSession(t, records) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout-1.jsonl");
  await writeFile(file, records.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  return file;
}

test("跨 rollout 文件相同 ordinal：内容相同时去重，分叉回滚导致内容不同时同时保留并记录冲突", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const f1 = path.join(root, "rollout-1.jsonl");
  const f2 = path.join(root, "rollout-2.jsonl");

  const shared0 = {
    timestamp: "2026-11-10T01:00:00.000Z",
    ordinal: 0,
    type: "session_meta",
    payload: { id: "sess-1", cwd: "/repo" },
  };
  const shared1 = {
    timestamp: "2026-11-10T01:00:01.000Z",
    ordinal: 1,
    type: "response_item",
    payload: {
      type: "message",
      id: "msg-a1",
      role: "assistant",
      content: [{ type: "output_text", text: "Question Q12?" }],
    },
  };
  const f1Ord2UserApprove = {
    timestamp: "2026-11-10T01:00:05.000Z",
    ordinal: 2,
    type: "response_item",
    payload: {
      type: "message",
      id: "msg-u1",
      role: "user",
      content: [{ type: "input_text", text: "1" }],
    },
  };
  const f1Ord3Aborted = {
    timestamp: "2026-11-10T01:00:06.000Z",
    ordinal: 3,
    type: "event_msg",
    payload: { type: "turn_aborted", reason: "interrupted" },
  };

  // F2 从 ordinal < 2 分叉重开，复用了 ordinal 2 和 3
  const f2Ord2Meta = {
    timestamp: "2026-11-10T01:00:10.000Z",
    ordinal: 2,
    type: "session_meta",
    payload: {
      id: "sess-1",
      cwd: "/repo",
      history_base: { end_ordinal_exclusive: 2 },
    },
  };
  const f2Ord3NewUser = {
    timestamp: "2026-11-10T01:00:12.000Z",
    ordinal: 3,
    type: "response_item",
    payload: {
      type: "message",
      id: "msg-u2",
      role: "user",
      content: [{ type: "input_text", text: "$yjx-save-context" }],
    },
  };

  await writeFile(
    f1,
    [shared0, shared1, f1Ord2UserApprove, f1Ord3Aborted].map((x) => JSON.stringify(x)).join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    f2,
    [shared0, shared1, f2Ord2Meta, f2Ord3NewUser].map((x) => JSON.stringify(x)).join("\n") + "\n",
    "utf8"
  );

  const report = await analyzeFiles([f1, f2]);

  // 1. 唯一 ordinal 数量仍为 4 (0..3)，无假缺号
  assert.equal(report.session.uniqueOrdinals, 4);
  assert.equal(report.session.ordinalGaps.length, 0);

  // 2. 相同内容的 shared0 / shared1 被去重；不同内容的 ordinal 2 和 3 均被保留
  assert.equal(report.humanInputs.length, 2);
  assert.deepEqual(
    report.humanInputs.map((h) => ({ loc: h.location, ord: h.ordinal, text: h.text })),
    [
      { loc: "F1:L3", ord: 2, text: "1" },
      { loc: "F2:L4", ord: 3, text: "$yjx-save-context" },
    ]
  );

  // 3. 冲突列表与 history_base 被显式记录
  assert.equal(report.session.files[1].historyBaseEndOrdinalExclusive, 2);
  assert.equal(report.session.ordinalCollisions.length, 2);
  assert.equal(report.session.ordinalCollisions[0].ordinal, 2);
  assert.equal(report.session.ordinalCollisions[1].ordinal, 3);

  const md = formatMarkdown(report);
  assert.match(md, /history_base < 2/);
  assert.match(md, /Ordinal Collisions/);
});

test("预检：重复复盘以上一次复盘调用为起点，只按范围内的压缩分流", async (t) => {
  // 压缩发生在上一次复盘之前：范围内无压缩，走快速分支
  const before = await writeSession(t, [
    meta(0),
    human(1, "task A"),
    compacted(2),
    skill(3, "yjx-retro-skill"),
    human(4, "task B"),
    skill(5, "yjx-grill"),
    skill(6, "yjx-retro-skill"),
  ]);
  const r1 = await preflightFiles([before]);
  assert.equal(r1.currentRetro.ordinal, 6);
  assert.equal(r1.previousRetro.ordinal, 3);
  assert.equal(r1.rangeStartOrdinal, 3);
  assert.equal(r1.rangeCompactions.length, 0);
  assert.equal(r1.compactions.length, 1);
  assert.equal(r1.route, "fast");

  // 压缩发生在上一次复盘之后：走完整分支
  const after = await writeSession(t, [
    meta(0),
    skill(1, "yjx-retro-skill"),
    human(2, "task B"),
    compacted(3),
    skill(4, "yjx-retro-skill"),
  ]);
  const r2 = await preflightFiles([after]);
  assert.equal(r2.rangeStartOrdinal, 1);
  assert.deepEqual(r2.rangeCompactions.map((c) => c.ordinal), [3]);
  assert.equal(r2.route, "full");

  // 首次复盘：范围从会话开头算，任何压缩都走完整分支
  const first = await writeSession(t, [meta(0), human(1, "task A"), compacted(2), skill(3, "yjx-retro-skill")]);
  const r3 = await preflightFiles([first]);
  assert.equal(r3.previousRetro, null);
  assert.equal(r3.rangeStartOrdinal, null);
  assert.equal(r3.route, "full");

  // 显式截止点已排除本次调用时，截止点内最后一次复盘即为上一次复盘
  const r4 = await preflightFiles([before], { untilOrdinal: 5 });
  assert.equal(r4.currentRetro, null);
  assert.equal(r4.previousRetro.ordinal, 3);
  assert.equal(r4.route, "fast");
});

test("完整提取：--since-ordinal 只保留起点之后的记录，仍保留会话身份且不制造缺号", async (t) => {
  const file = await writeSession(t, [
    meta(0),
    human(1, "old task"),
    compacted(2),
    skill(3, "yjx-retro-skill"),
    human(4, "复盘结果太啰嗦"),
    human(5, "new task"),
  ]);
  const report = await analyzeFiles([file], { sinceOrdinal: 3, untilOrdinal: 5 });
  assert.equal(report.session.id, "sess-r");
  assert.equal(report.session.minOrdinal, 3);
  assert.equal(report.session.maxOrdinal, 5);
  assert.equal(report.session.ordinalGaps.length, 0);
  assert.equal(report.compactions.length, 0);
  assert.deepEqual(report.skills.injected.map((i) => i.ordinal), [3]);
  assert.deepEqual(report.humanInputs.map((h) => h.text), ["复盘结果太啰嗦", "new task"]);
  assert.match(formatMarkdown(report), /Review Range: since ordinal 3, until ordinal 5/);
});

test("T3 SQLite 多 Agent 会话：预检识别跨 Provider handoff 分流到 full，完整提取覆盖多 Agent Run、引用解码与单条回查", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const {
    preflightT3Thread,
    analyzeT3Thread,
    lookupT3Item,
  } = await import("../skills/yjx-retro-skill/scripts/extract-session-evidence.mjs");

  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-t3-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "statev2.sqlite");

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      title TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT,
      ordinal INTEGER,
      provider TEXT,
      provider_instance_id TEXT,
      provider_thread_id TEXT,
      status TEXT,
      requested_at TEXT,
      completed_at TEXT,
      payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY,
      thread_id TEXT,
      provider_instance_id TEXT,
      driver TEXT,
      first_run_ordinal INTEGER,
      last_run_ordinal INTEGER,
      payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY,
      thread_id TEXT,
      run_id TEXT,
      provider_thread_id TEXT,
      ordinal INTEGER,
      type TEXT,
      status TEXT,
      updated_at TEXT,
      payload_json TEXT
    );
    CREATE TABLE orchestration_v2_turn_item_positions (
      thread_id TEXT,
      turn_item_id TEXT,
      ordinal INTEGER
    );
  `);

  const threadId = "5f09ded6-ce6d-49b7-9e21-c0a9761830d3";
  db.prepare(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?)"
  ).run(
    threadId,
    "多 Agent 测试会话",
    "2026-11-13T07:54:42.000Z",
    "2026-11-13T07:56:00.000Z",
    JSON.stringify({ worktreePath: "D:/repo" })
  );

  const insertRun = db.prepare(
    "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertRun.run(
    "run:1",
    threadId,
    1,
    "codex",
    "codex",
    "pt:codex:1",
    "completed",
    "2026-11-13T07:54:42.000Z",
    "2026-11-13T07:54:50.000Z",
    JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol-1m" } })
  );
  insertRun.run(
    "run:2",
    threadId,
    2,
    "claudeAgent",
    "claudeAgent",
    "pt:claude:2",
    "completed",
    "2026-11-13T07:54:51.000Z",
    "2026-11-13T07:55:20.000Z",
    JSON.stringify({ modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } })
  );

  const insertItem = db.prepare(
    "INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertPos = db.prepare(
    "INSERT INTO orchestration_v2_turn_item_positions VALUES (?, ?, ?)"
  );
  const addItem = (id, runId, ptId, ord, type, status, payload) => {
    insertItem.run(id, threadId, runId, ptId, ord, type, status, "2026-11-13T07:55:00.000Z", JSON.stringify(payload));
    insertPos.run(threadId, id, ord);
  };

  addItem("item:u1", "run:1", "pt:codex:1", 1000001, "user_message", "completed", {
    text: "hi one",
    startedAt: "2026-11-13T07:54:42.000Z",
  });
  addItem("item:a1", "run:1", "pt:codex:1", 1000002, "assistant_message", "completed", {
    text: "你好，我是 Codex",
    completedAt: "2026-11-13T07:54:50.000Z",
  });
  addItem("item:h2", "run:2", "pt:claude:2", 2000001, "handoff", "completed", {
    title: "Provider handoff",
    strategy: "full_thread_summary",
    fromProviderInstanceIds: ["codex"],
    toProviderInstanceId: "claudeAgent",
    completedAt: "2026-11-13T07:54:51.000Z",
  });
  addItem("item:u2", "run:2", "pt:claude:2", 2000002, "user_message", "completed", {
    text: "[Assistant quote](t3-citation://v1/env/thread/msg?text=%E9%94%99%E8%AF%AF%E5%81%87%E8%AE%BE&comment=%E8%BF%99%E9%87%8C%E4%B8%8D%E5%AF%B9)\n请重新检查",
    startedAt: "2026-11-13T07:54:52.000Z",
  });
  addItem("item:cmd2", "run:2", "pt:claude:2", 2000003, "command_execution", "failed", {
    input: "cat skills/yjx-grill/SKILL.md",
    output: "Process exited with code 1\nError: failed",
    exitCode: 1,
    completedAt: "2026-11-13T07:55:00.000Z",
  });
  addItem("item:sk2", "run:2", "pt:claude:2", 2000004, "dynamic_tool", "completed", {
    toolName: "Skill",
    input: { skill: "writing-for-agents" },
    output: { success: true, commandName: "writing-for-agents" },
    completedAt: "2026-11-13T07:55:05.000Z",
  });
  addItem("item:u3", "run:2", "pt:claude:2", 2000005, "user_message", "completed", {
    text: "$yjx-retro-skill 复盘刚才的修改",
    startedAt: "2026-11-13T07:55:10.000Z",
  });
  addItem("item:a3", "run:2", "pt:claude:2", 2000006, "assistant_message", "completed", {
    text: "我将使用 yjx-retro-skill 进行复盘。",
    completedAt: "2026-11-13T07:55:15.000Z",
  });
  db.close();

  // 1. 预检：虽无 compaction，但存在跨 Provider handoff，应返回 full，且候选复盘包含 userPreview 与 assistantPreview
  const pre = preflightT3Thread(dbPath, `thread_${threadId}`);
  assert.equal(pre.route, "full");
  assert.equal(pre.rangeCompactions.length, 0);
  assert.equal(pre.rangeHandoffs.length, 1);
  assert.deepEqual(pre.rangeProviders, ["codex", "claudeAgent"]);
  assert.equal(pre.retroInvocations.length, 1);
  assert.match(pre.retroInvocations[0].userPreview, /\$yjx-retro-skill 复盘刚才的修改/);
  assert.match(pre.retroInvocations[0].assistantPreview, /我将使用 yjx-retro-skill 进行复盘/);

  // 2. 完整提取：包含两个 Run、1 个 handoff、解码后的 citation 批注、Skill 调用和失败命令
  const report = analyzeT3Thread(dbPath, threadId);
  assert.equal(report.session.runs.length, 2);
  assert.equal(report.handoffs.length, 1);
  assert.equal(report.humanInputs.length, 3);
  assert.equal(report.humanInputs[1].citations.length, 1);
  assert.equal(report.humanInputs[1].citations[0].quotedText, "错误假设");
  assert.equal(report.humanInputs[1].citations[0].comment, "这里不对");
  assert.equal(report.skills.injected.length, 1);
  assert.equal(report.skills.injected[0].name, "writing-for-agents");
  assert.equal(report.skills.fileReads.length, 1);
  assert.equal(report.nonZeroTools.length, 1);
  assert.equal(report.nonZeroTools[0].itemId, "item:cmd2");

  const md = formatMarkdown(report);
  assert.match(md, /## Runs \/ Providers \(2\)/);
  assert.match(md, /## Context Handoffs \(1\)/);
  assert.match(md, /Decoded Citation/);

  // 3. 单条 itemId 回查
  const item = lookupT3Item(dbPath, "item:cmd2", threadId);
  assert.equal(item.type, "command_execution");
  assert.equal(item.payload.exitCode, 1);
});
