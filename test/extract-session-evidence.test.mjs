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
