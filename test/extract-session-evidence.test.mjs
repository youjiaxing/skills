import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeFiles,
  formatMarkdown,
  preflightFiles,
} from "../skills/yjx-retro/scripts/extract-session-evidence.mjs";

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
    lookupT3Items,
  } = await import("../skills/yjx-retro/scripts/extract-session-evidence.mjs");

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

  // 4. 批量 itemIds 回查（含 CLI 重复 --item-id 参数）
  const items = lookupT3Items(dbPath, ["item:cmd2", "item:u2", "item:cmd2"], threadId);
  assert.deepEqual(items.map((x) => x.itemId), ["item:cmd2", "item:u2"]);
  const cliBatch = execFileSync(
    process.execPath,
    [
      new URL("../skills/yjx-retro/scripts/extract-session-evidence.mjs", import.meta.url).pathname,
      "--t3-db",
      dbPath,
      "--session-id",
      threadId,
      "--item-id",
      "item:u2",
      "--item-id",
      "item:cmd2",
    ],
    { encoding: "utf8" }
  );
  const parsedBatch = JSON.parse(cliBatch);
  assert.equal(parsedBatch.count, 2);
  assert.deepEqual(parsedBatch.items.map((x) => x.itemId), ["item:u2", "item:cmd2"]);
});
test("T3 SQLite 多定时器与 freshContext 分段：预检分流 full，剥离定时触发并聚合工具经济性与子代理子线程统计", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const {
    preflightT3Thread,
    analyzeT3Thread,
    formatMarkdown,
  } = await import("../skills/yjx-retro/scripts/extract-session-evidence.mjs");

  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-t3-timers-"));
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
    CREATE TABLE scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT,
      thread_id TEXT,
      thread_mode TEXT,
      schedule_json TEXT,
      enabled INTEGER,
      last_run_status TEXT
    );
  `);

  const threadId = "11111111-2222-3333-4444-555555555555";
  const childId = "thread:delegated-task:child-1";
  const taskA = "scheduled-task:command:mcp:aaa:schedule-task:morning-sync";
  const taskB = "scheduled-task:command:mcp:bbb:schedule-task:evening-check";

  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?)").run(
    threadId,
    "多定时器测试",
    "2026-11-15T00:00:00.000Z",
    "2026-11-15T02:00:00.000Z",
    JSON.stringify({ worktreePath: "D:/repo" })
  );
  db.prepare("INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    taskA,
    "早间同步",
    threadId,
    "fresh_session",
    JSON.stringify({ kind: "cron", expr: "0 8 * * *" }),
    1,
    "succeeded"
  );
  db.prepare("INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    taskB,
    "晚间检查",
    threadId,
    "continue",
    JSON.stringify({ kind: "interval", everyMs: 600000 }),
    1,
    "failed"
  );

  const insertRun = db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  // 同一 provider(codex) 下：Run 1 正常，Run 2 freshContext=true（保持同 providerThreadId 以专门验证 freshContext 单独触发 full），Run 3 沿用上下文，Run 4 另一定时器失败
  insertRun.run("run:1", threadId, 1, "codex", "codex", "pt:codex:1", "completed", "2026-11-15T00:00:00.000Z", "2026-11-15T00:01:00.000Z", JSON.stringify({ modelSelection: { model: "gpt-6.1-sol" } }));
  insertRun.run("run:2", threadId, 2, "codex", "codex", "pt:codex:1", "completed", "2026-11-15T00:10:00.000Z", "2026-11-15T00:11:00.000Z", JSON.stringify({ modelSelection: { model: "gpt-6.1-sol" }, freshContext: true }));
  insertRun.run("run:3", threadId, 3, "codex", "codex", "pt:codex:1", "completed", "2026-11-15T00:20:00.000Z", "2026-11-15T00:21:00.000Z", JSON.stringify({ modelSelection: { model: "gpt-6.1-sol" } }));
  insertRun.run("run:4", threadId, 4, "codex", "codex", "pt:codex:1", "failed", "2026-11-15T00:30:00.000Z", "2026-11-15T00:31:00.000Z", JSON.stringify({ modelSelection: { model: "gpt-6.1-sol" } }));

  const insertItem = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertPos = db.prepare("INSERT INTO orchestration_v2_turn_item_positions VALUES (?, ?, ?)");
  const addItem = (id, runId, ptId, ord, type, status, payload, tId = threadId) => {
    insertItem.run(id, tId, runId, ptId, ord, type, status, "2026-11-15T00:10:00.000Z", JSON.stringify(payload));
    if (tId === threadId) insertPos.run(tId, id, ord);
  };

  // Run 1: 真人输入 + subagent
  addItem("turn-item:message:human-1", "run:1", "pt:codex:1", 1000001, "user_message", "completed", { text: "帮我配置两个定时同步任务" });
  addItem("item:sub1", "run:1", "pt:codex:1", 1000002, "subagent", "completed", { title: "调研同步脚本", driver: "codex", childThreadId: childId });
  addItem("item:a1", "run:1", "pt:codex:1", 1000003, "assistant_message", "completed", { text: "已配置完成" });
  // 子线程记录：2 条记录，其中 1 条失败
  addItem("child:1", null, null, 1, "command_execution", "completed", { input: "ls" }, childId);
  addItem("child:2", null, null, 2, "command_execution", "failed", { input: "bad" }, childId);

  // Run 2: taskA 手动试跑 + freshContext=true + prompt 中故意提及 yjx-retro-skill（不得被误判为复盘调用）+ 0 工具静默
  addItem(
    `turn-item:message:scheduled-task-message:${encodeURIComponent(taskA)}:1794000000000:manual`,
    "run:2",
    "pt:codex:1",
    2000001,
    "user_message",
    "completed",
    { scheduledTaskId: taskA, text: "执行早间同步，不要调用 yjx-retro-skill" }
  );

  // Run 3: taskA 定时触发 + 1 次成功命令 + 助手回复
  addItem(
    `turn-item:message:scheduled-task-message:${encodeURIComponent(taskA)}:1794000600000:scheduled`,
    "run:3",
    "pt:codex:1",
    3000001,
    "user_message",
    "completed",
    { scheduledTaskId: taskA, text: "执行早间同步" }
  );
  addItem("item:cmd3", "run:3", "pt:codex:1", 3000002, "command_execution", "completed", { input: "python sync.py", exitCode: 0, output: "ok" });
  addItem("item:a3", "run:3", "pt:codex:1", 3000003, "assistant_message", "completed", { text: "早间同步完成" });

  // Run 4: taskB 定时触发 + 1 次失败命令 + run 失败
  addItem(
    `turn-item:message:scheduled-task-message:${encodeURIComponent(taskB)}:1794001200000:scheduled`,
    "run:4",
    "pt:codex:1",
    4000001,
    "user_message",
    "completed",
    { scheduledTaskId: taskB, text: "执行晚间检查" }
  );
  addItem("item:cmd4", "run:4", "pt:codex:1", 4000002, "command_execution", "failed", { input: "python check.py", exitCode: 1, output: "Process exited with code 1" });
  db.close();

  // 1. 预检：同 provider / 同 providerThreadId 下，仅凭 freshContext=true 应分流到 full；且定时 prompt 提及 yjx-retro-skill 不算复盘调用
  const pre = preflightT3Thread(dbPath, threadId);
  assert.equal(pre.route, "full");
  assert.equal(pre.retroInvocations.length, 0);
  assert.equal(pre.rangeFreshContextCount, 1);
  assert.equal(pre.rangeScheduledTaskCount, 3);
  assert.equal(pre.rangeHumanInputCount, 1);
  assert.equal(pre.rangeScheduledTasks.length, 2);

  // 2. 完整提取：contextSegments 应按 freshContext 拆分为 2 段；humanInputs 仅含 1 条真人输入；scheduledTriggers 含 3 条
  const report = analyzeT3Thread(dbPath, threadId);
  assert.equal(report.humanInputs.length, 1);
  assert.equal(report.humanInputs[0].text, "帮我配置两个定时同步任务");
  assert.equal(report.scheduledTriggers.length, 3);
  assert.deepEqual(
    report.scheduledTriggers.map((x) => x.triggerKind),
    ["scheduled-manual", "scheduled", "scheduled"]
  );
  assert.equal(report.contextSegments.length, 2);
  assert.deepEqual(report.contextSegments[0].boundaryReasons, ["initial"]);
  assert.deepEqual(report.contextSegments[1].boundaryReasons, ["fresh_context"]);
  assert.equal(report.contextSegments[0].humanRuns, 1);
  assert.equal(report.contextSegments[1].manualScheduledRuns, 1);
  assert.equal(report.contextSegments[1].scheduledRuns, 2);

  const statA = report.scheduledTasks.find((x) => x.scheduledTaskId === taskA).inRangeStats;
  assert.equal(statA.totalRuns, 2);
  assert.equal(statA.manualTriggerRuns, 1);
  assert.equal(statA.scheduledAutoRuns, 1);
  assert.equal(statA.zeroToolRuns, 1);
  assert.equal(statA.nonZeroToolRuns, 1);
  assert.equal(statA.silentRuns, 1);
  assert.equal(statA.outputRuns, 1);
  assert.equal(statA.totalToolCalls, 1);

  const statB = report.scheduledTasks.find((x) => x.scheduledTaskId === taskB).inRangeStats;
  assert.equal(statB.totalRuns, 1);
  assert.equal(statB.failedOrInterruptedRuns, 1);
  assert.equal(statB.failedToolRuns, 1);

  assert.equal(report.subagents.length, 1);
  assert.equal(report.subagents[0].childItemCount, 2);
  assert.equal(report.subagents[0].childFailedCount, 1);

  const md = formatMarkdown(report);
  assert.match(md, /## Context Segments \(2\)/);
  assert.match(md, /## Scheduled Tasks \(2\)/);
  assert.match(md, /## Scheduled Triggers \(3\)/);
  assert.match(md, /childItems=2, childFailed=1/);
});

test("T3 SQLite 无 scheduled_tasks 表时仍可从 turn_item_id 解码历史定时触发", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const {
    preflightT3Thread,
    analyzeT3Thread,
  } = await import("../skills/yjx-retro/scripts/extract-session-evidence.mjs");

  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-t3-noschedtable-"));
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
  `);
  const tid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?)").run(tid, "无表兼容测试", "2026-11-15T00:00:00.000Z", "2026-11-15T00:01:00.000Z", "{}");
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("r1", tid, 1, "codex", "codex", "pt:1", "completed", "2026-11-15T00:00:00.000Z", "2026-11-15T00:01:00.000Z", "{}");
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "turn-item:message:scheduled-task-message:scheduled-task:legacy-1:1794000000000:scheduled",
    tid,
    "r1",
    "pt:1",
    1000001,
    "user_message",
    "completed",
    "2026-11-15T00:00:00.000Z",
    JSON.stringify({ text: "legacy timer" })
  );
  db.close();

  const pre = preflightT3Thread(dbPath, tid);
  assert.equal(pre.route, "fast");
  assert.equal(pre.rangeScheduledTaskCount, 1);
  assert.equal(pre.rangeHumanInputCount, 0);

  const report = analyzeT3Thread(dbPath, tid);
  assert.equal(report.humanInputs.length, 0);
  assert.equal(report.scheduledTriggers.length, 1);
  assert.equal(report.scheduledTasks[0].scheduledTaskId, "scheduled-task:legacy-1");
  assert.equal(report.scheduledTasks[0].inRangeStats.scheduledAutoRuns, 1);
});

test("JSONL 预检：较早的复盘调用附带后续轮次结果，供模型判断是否已交付", async (t) => {
  const ev = (ordinal, type, extra = {}) => ({ ordinal, type: "event_msg", payload: { type, ...extra } });
  const assistant = (ordinal, text) => ({
    ordinal,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
  const file = await writeSession(t, [
    meta(0),
    ev(1, "task_started", { turn_id: "t1" }),
    human(2, "$yjx-retro-skill"),
    assistant(3, "我将先执行预检。"),
    ev(4, "task_complete", { last_agent_message: "我将先执行预检。" }),
    ev(5, "task_started", { turn_id: "t2" }),
    human(6, "继续"),
    { ordinal: 7, type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: "{}" } },
    ev(8, "turn_aborted", { reason: "interrupted" }),
    ev(9, "task_started", { turn_id: "t3" }),
    human(10, "$yjx-retro-skill"),
  ]);
  const pre = await preflightFiles([file]);
  assert.equal(pre.previousRetro.ordinal, 2);
  assert.equal(pre.currentRetro.ordinal, 10);
  assert.equal(pre.currentRetro.runOutcomes, undefined);
  assert.deepEqual(
    pre.previousRetro.runOutcomes.map((o) => [o.run, o.status, o.tools, o.aborts, o.userPreview]),
    [
      [1, "completed", 0, 0, null],
      [2, "interrupted", 1, 1, "继续"],
    ]
  );
  assert.equal(pre.previousRetro.runOutcomes[0].lastAssistantPreview, "我将先执行预检。");
});

test("JSONL 预检：同一轮里的 $skill 消息与 skill 注入属于同一次调用，上一次复盘只从更早的轮次选，范围内压缩仍分流到 full", async (t) => {
  const ev = (ordinal, type, extra = {}) => ({ ordinal, type: "event_msg", payload: { type, ...extra } });
  const assistant = (ordinal, text) => ({
    ordinal,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
  const file = await writeSession(t, [
    meta(0),
    ev(1, "task_started", { turn_id: "t1" }),
    human(2, "$yjx-retro-skill"),
    skill(3, "yjx-retro-skill"),
    assistant(4, "复盘报告：2 项建议"),
    ev(5, "task_complete", { last_agent_message: "复盘报告：2 项建议" }),
    ev(6, "task_started", { turn_id: "t2" }),
    human(7, "按建议修改"),
    compacted(8),
    ev(9, "task_complete", {}),
    ev(10, "task_started", { turn_id: "t3" }),
    human(11, "$yjx-retro-skill"),
    skill(12, "yjx-retro-skill"),
  ]);
  const pre = await preflightFiles([file]);
  assert.equal(pre.currentRetro.ordinal, 11);
  assert.equal(pre.previousRetro.ordinal, 3);
  assert.deepEqual(pre.rangeCompactions.map((c) => c.ordinal), [8]);
  assert.equal(pre.route, "full");
  assert.equal(pre.retroInvocations.find((r) => r.ordinal === 12).runOutcomes, undefined);
  assert.equal(pre.previousRetro.runOutcomes[0].lastAssistantPreview, "复盘报告：2 项建议");
});

test("T3 SQLite：预检附带后续轮次结果；完整提取输出逐轮工具统计、工具调用列表、Skill 文件读写区分、$skill 候选与失败判定依据", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { preflightT3Thread, analyzeT3Thread } = await import(
    "../skills/yjx-retro/scripts/extract-session-evidence.mjs"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-t3-outcome-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, provider TEXT, provider_instance_id TEXT, provider_thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, provider_instance_id TEXT, driver TEXT, first_run_ordinal INTEGER, last_run_ordinal INTEGER, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, provider_thread_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_turn_item_positions (thread_id TEXT, turn_item_id TEXT, ordinal INTEGER);
  `);
  const threadId = "7d3c0e3a-0000-4000-8000-000000000001";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?)").run(
    threadId,
    "复盘结果测试",
    "2026-11-16T00:00:00.000Z",
    "2026-11-16T00:10:00.000Z",
    "{}"
  );
  const insertRun = db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [n, status] of [[1, "completed"], [2, "completed"], [3, "interrupted"], [4, "running"]]) {
    insertRun.run(`run:${n}`, threadId, n, "codex", "codex", "pt:1", status, null, null, JSON.stringify({ modelSelection: { model: "m" } }));
  }
  const insertItem = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertPos = db.prepare("INSERT INTO orchestration_v2_turn_item_positions VALUES (?, ?, ?)");
  const add = (id, run, ord, type, status, payload) => {
    insertItem.run(id, threadId, run, "pt:1", ord, type, status, "2026-11-16T00:05:00.000Z", JSON.stringify(payload));
    insertPos.run(threadId, id, ord);
  };
  const pwshWrite =
    String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command '$p = "D:'"\repo\skills\demo\SKILL.md"; [IO.File]::WriteAllText($p, "x")'`;
  add("u1", "run:1", 1000001, "user_message", "completed", { text: "修改 demo skill" });
  add("c1", "run:1", 1000002, "command_execution", "completed", {
    input: "cat D:/repo/skills/demo/SKILL.md",
    output: "body",
    exitCode: 0,
    completedAt: "2026-11-16T00:01:00.000Z",
  });
  add("c2", "run:1", 1000003, "command_execution", "completed", {
    input: pwshWrite,
    output: "",
    exitCode: 0,
    completedAt: "2026-11-16T00:02:00.000Z",
  });
  add("c3", "run:1", 1000004, "command_execution", "completed", {
    input: "node --test",
    output: "AssertionError [ERR_ASSERTION]: expected",
    exitCode: 0,
    completedAt: "2026-11-16T00:03:00.000Z",
  });
  add("a1", "run:1", 1000005, "assistant_message", "completed", { text: "已修改。" });
  add("u2", "run:2", 2000001, "user_message", "completed", { text: "$yjx-retro-skill" });
  add("a2", "run:2", 2000002, "assistant_message", "completed", { text: "我将先执行预检。" });
  add("u3", "run:3", 3000001, "user_message", "completed", { text: "继续" });
  add("x3", "run:3", 3000002, "run_interrupt_request", "completed", { reason: "Stopped by user" });
  add("u4", "run:4", 4000001, "user_message", "completed", { text: "$yjx-retro-skill 再来一次，$HOME 不是 skill" });
  add("u4b", "run:4", 4000002, "user_message", "completed", { text: "$yjx-retro-skill 同一次调用的参数消息" });
  db.close();

  // 预检：较早的复盘调用附带本轮与后续轮次结果；同一轮里的多条候选都属于本次调用，不当作上一次复盘
  const pre = preflightT3Thread(dbPath, threadId);
  assert.equal(pre.previousRetro.itemId, "u2");
  assert.equal(pre.currentRetro.itemId, "u4");
  assert.equal(pre.rangeStartOrdinal, 2000001);
  assert.equal(pre.currentRetro.runOutcomes, undefined);
  assert.equal(pre.retroInvocations.find((r) => r.itemId === "u4b").runOutcomes, undefined);
  assert.match(pre.rule, /unconfirmed/);
  assert.deepEqual(
    pre.previousRetro.runOutcomes.map((o) => [o.run, o.status, o.tools, o.aborts, o.userPreview]),
    [
      [2, "completed", 0, 0, null],
      [3, "interrupted", 0, 1, "继续"],
    ]
  );
  assert.equal(pre.previousRetro.runOutcomes[0].lastAssistantPreview, "我将先执行预检。");
  assert.equal(preflightT3Thread(dbPath, threadId, { sinceOrdinal: 1000001 }).rangeStartOrdinal, 1000001);

  // 完整提取：逐轮统计、工具调用列表、读写区分（含被引号拆开的盘符）、$skill 候选、失败判定依据
  const report = analyzeT3Thread(dbPath, threadId);
  const run1 = report.runStats.find((r) => r.runOrdinal === 1);
  assert.equal(run1.toolCallCount, 3);
  assert.equal(run1.failedToolCount, 0);
  assert.equal(run1.lastAssistantPreview, "已修改。");
  assert.deepEqual(report.toolCalls.map((c) => c.itemId), ["c1", "c2", "c3"]);
  assert.match(report.toolCalls[1].commandPreview, /^'\$p = "D:/);
  assert.deepEqual(report.skills.fileReads.map((r) => r.paths), [["D:/repo/skills/demo/SKILL.md"]]);
  assert.deepEqual(report.skills.fileWrites.map((r) => r.paths), [[String.raw`D:\repo\skills\demo\SKILL.md`]]);
  assert.deepEqual(report.skills.userTokens.map((tk) => tk.names), [["yjx-retro-skill"], ["yjx-retro-skill"], ["yjx-retro-skill"]]);
  assert.deepEqual(report.nonZeroTools, []);
  assert.deepEqual(report.suspiciousSuccessOutputs.map((item) => [item.itemId, item.exitCodes]), [["c3", [0]]]);
  assert.match(report.suspiciousSuccessOutputs[0].outputPreview, /AssertionError/);
  assert.equal(report.toolCalls.find((call) => call.itemId === "c3").failed, false);

  const md = formatMarkdown(report);
  assert.match(md, /Run #1: .* \| tools=3 failed=0 output=yes aborts=0/);
  assert.match(md, /Run #3: .* \| tools=0 failed=0 output=no aborts=1/);
  assert.match(md, /\[Write\] T3:pos=2/);
  assert.match(md, /\[\$token\] T3:pos=5 \(run #2\) `\$yjx-retro-skill`/);
  assert.match(md, /## Tool Calls by Run \(3\)\n### Run #1\n- T3:pos=1 00:01:00 `command_execution` exit=0 out=4: `cat D:\/repo/);
});

test("Skill 读写判定：写入临时文件附带 Test-Path 或 here-string 提及技能路径时不误报为读写 Skill", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { analyzeT3Thread } = await import(
    "../skills/yjx-retro/scripts/extract-session-evidence.mjs"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-t3-skill-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, provider TEXT, provider_instance_id TEXT, provider_thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, provider_instance_id TEXT, driver TEXT, first_run_ordinal INTEGER, last_run_ordinal INTEGER, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, provider_thread_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_turn_item_positions (thread_id TEXT, turn_item_id TEXT, ordinal INTEGER);
  `);
  const threadId = "7d3c0e3a-0000-4000-8000-000000000099";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?)").run(
    threadId, "Skill读写误报测试", "2026-11-17T00:00:00.000Z", "2026-11-17T00:10:00.000Z", "{}"
  );
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "run:1", threadId, 1, "codex", "codex", "pt:1", "completed", null, null, JSON.stringify({ modelSelection: { model: "m" } })
  );
  const add = (id, ord, type, payload) => {
    db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, threadId, "run:1", "pt:1", ord, type, "completed", "2026-11-17T00:01:00.000Z", JSON.stringify(payload)
    );
    db.prepare("INSERT INTO orchestration_v2_turn_item_positions VALUES (?, ?, ?)").run(threadId, id, ord);
  };

  const saveContextHeredoc = [
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'$contextText = @\'"\'',
    "- .agents/skills/vk-implement/SKILL.md",
    "- .agents/skills/vk-code-review/SKILL.md",
    '\'"\'@',
    "$contextPath = 'C:/Users/Administrator/AppData/Local/Temp/yjx-context.md'",
    "[IO.File]::WriteAllText($contextPath, $contextText)",
    "\"'$allRefs = @('.agents/skills/vk-ai-tester/SKILL.md', '.agents/skills/vk-test-cases/SKILL.md')",
    "$missing = @($allRefs | Where-Object { -not (Test-Path -LiteralPath $_) })'",
  ].join("\n");

  const readSkillAndWriteTemp = [
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'$doc = Get-Content -Raw D:/repo/skills/real/SKILL.md;',
    "[IO.File]::WriteAllText('C:/Temp/out.md', $doc)'",
  ].join("\n");

  const applyPatchSkill = [
    "*** Begin Patch",
    "*** Update File: D:/repo/skills/real/SKILL.md",
    "@@",
    "- 参考 .agents/skills/other/SKILL.md",
    "+ 改为正向规则",
    "*** End Patch",
  ].join("\n");

  add("u1", 1000001, "user_message", { text: "保存上下文并改 real skill" });
  add("c1", 1000002, "command_execution", { input: saveContextHeredoc, output: "", exitCode: 0 });
  add("c2", 1000003, "command_execution", { input: readSkillAndWriteTemp, output: "", exitCode: 0 });
  add("c3", 1000004, "dynamic_tool", { toolName: "apply_patch", input: applyPatchSkill, output: "Success", exitCode: 0 });
  db.close();

  const report = analyzeT3Thread(dbPath, threadId);
  assert.deepEqual(
    report.skills.fileReads.map((r) => [r.callId, r.paths]),
    [["c2", ["D:/repo/skills/real/SKILL.md"]]]
  );
  assert.deepEqual(
    report.skills.fileWrites.map((w) => [w.callId, w.paths]),
    [["c3", ["D:/repo/skills/real/SKILL.md"]]]
  );
});

test("preflightFiles 同时识别新名 yjx-retro 与历史名 yjx-retro-skill，且不误判 yjx-retro-sessions", async (t) => {
  const ev = (ordinal, type, extra = {}) => ({ ordinal, type: "event_msg", payload: { type, ...extra } });
  const file = await writeSession(t, [
    meta(0),
    ev(1, "task_started", { turn_id: "t1" }),
    human(2, "task A"),
    skill(3, "yjx-retro-skill"),
    ev(4, "task_complete", {}),
    ev(5, "task_started", { turn_id: "t2" }),
    human(6, "使用 $yjx-retro-sessions 扫描历史"),
    ev(7, "task_complete", {}),
    ev(8, "task_started", { turn_id: "t3" }),
    human(9, "task B"),
    human(10, "$yjx-retro 再复盘一次"),
    skill(11, "yjx-retro"),
  ]);
  const pre = await preflightFiles([file]);
  assert.equal(pre.retroInvocations.length, 3);
  assert.equal(pre.previousRetro.ordinal, 3);
  assert.equal(pre.rangeStartOrdinal, 3);
});

test("collectSubagentEvidence 聚合根线程已成功完成但未存 output 的只读工具，不刷屏 tool-result-unavailable", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { collectSubagentEvidence } = await import("../skills/yjx-retro/scripts/extract-session-evidence.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "yjx-root-gaps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "statev2.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT,
      provider_thread_id TEXT, ordinal INTEGER, type TEXT NOT NULL, status TEXT NOT NULL,
      updated_at TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_subagents (
      subagent_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, child_thread_id TEXT,
      provider TEXT, provider_thread_id TEXT, origin TEXT, status TEXT,
      started_at TEXT, completed_at TEXT, updated_at TEXT, payload_json TEXT
    );
  `);
  const ts = "2026-11-20T01:00:00.000Z";
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)").run("t-root", "root", "{}");
  const add = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?,?,?)");
  add.run("u1", "t-root", "r1", "pt1", 1, "user_message", "completed", ts, JSON.stringify({ text: "hello", startedAt: ts }));
  add.run("d1", "t-root", "r1", "pt1", 2, "dynamic_tool", "completed", ts, JSON.stringify({ toolName: "Read", input: { Path: "a.md" }, output: null, startedAt: ts }));
  add.run("d2", "t-root", "r1", "pt1", 3, "dynamic_tool", "completed", ts, JSON.stringify({ toolName: "Read", input: { Path: "b.md" }, output: null, startedAt: ts }));
  db.close();

  const ev = await collectSubagentEvidence({ sessionId: "t-root", t3Db: dbPath });
  assert.equal(ev.gaps.length, 1);
  assert.equal(ev.gaps[0].reason, "root-completed-tool-output-not-persisted (Read x2)");
});
