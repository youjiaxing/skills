import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeFiles, formatMarkdown } from "../skills/yjx-retro-skill/scripts/extract-session-evidence.mjs";

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
