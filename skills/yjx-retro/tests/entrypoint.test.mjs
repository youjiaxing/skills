import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeT3Thread, formatMarkdown, preflightT3Thread } from "../scripts/extract-session-evidence.mjs";
import { queryLedger, recordCandidate, recordDecision } from "../scripts/retro-ledger.mjs";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts");

// Installed skills are reached through a symlinked directory; the CLI must still run main().
for (const script of ["retro-ledger.mjs"]) {
  test(`${script} runs when invoked through a symlinked skill directory`, (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-entry-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const link = path.join(tmp, "skill-scripts");
    try {
      fs.symlinkSync(scriptsDir, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`cannot create directory link: ${error.code}`);
      return;
    }
    const output = execFileSync(process.execPath, ["--no-warnings", path.join(link, script), "--help"], { encoding: "utf8" });
    assert.match(output, /Usage:/);
  });
}

test("extract-session-evidence separates agent relay messages from human inputs in T3 preflight, analysis, and markdown", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-relay-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, "statev2.sqlite");
  const threadId = "thread-relay-test";
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
  db.prepare(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?)"
  ).run(threadId, "Relay Separation Test", "2026-11-24T00:00:00Z", "2026-11-24T00:02:00Z", JSON.stringify({ worktreePath: tmp }));
  db.prepare(
    "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("run-1", threadId, 1, "codex", "codex-1", "pt-1", "completed", "2026-11-24T00:00:00Z", "2026-11-24T00:00:30Z", JSON.stringify({}));
  db.prepare(
    "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("run-2", threadId, 2, "codex", "codex-1", "pt-1", "completed", "2026-11-24T00:01:00Z", "2026-11-24T00:01:30Z", JSON.stringify({}));
  db.prepare(
    "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("pt-1", threadId, "codex-1", "codex", 1, 2, JSON.stringify({}));

  const insertItem = db.prepare(
    "INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  insertItem.run(
    "turn-item:message:human-1",
    threadId,
    "run-1",
    "pt-1",
    1000001,
    "user_message",
    "completed",
    "2026-11-24T00:00:01Z",
    JSON.stringify({
      createdBy: "user",
      creationSource: "mobile",
      startedAt: "2026-11-24T00:00:01Z",
      text: "请帮我修复构建脚本",
    })
  );
  insertItem.run(
    "turn-item:message:relay-1",
    threadId,
    "run-2",
    "pt-1",
    2000001,
    "user_message",
    "completed",
    "2026-11-24T00:01:01Z",
    JSON.stringify({
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: "sender-thread-999",
      startedAt: "2026-11-24T00:01:01Z",
      text: "[T3 Code: agent relay] 同步上游策略 $yjx-retro",
    })
  );
  db.close();

  const preflight = preflightT3Thread(dbPath, threadId);
  assert.equal(preflight.rangeHumanInputCount, 1);
  assert.equal(preflight.rangeRelayMessageCount, 1);
  assert.equal(preflight.retroInvocations.length, 0);

  const report = analyzeT3Thread(dbPath, threadId);
  assert.equal(report.humanInputs.length, 1);
  assert.equal(report.humanInputs[0].text, "请帮我修复构建脚本");
  assert.equal(report.relayMessages.length, 1);
  assert.equal(report.relayMessages[0].senderThreadId, "sender-thread-999");
  assert.equal(report.relayMessages[0].creationSource, "mcp");
  assert.equal(report.runStats.find((r) => r.runId === "run-2")?.triggerKind, "agent_relay");

  const md = formatMarkdown(report);
  assert.match(md, /## Human Inputs \(1\)/);
  assert.match(md, /## Relay Messages \(1\)/);
  assert.match(md, /senderThread=`sender-thread-999`/);
  const humanSection = md.split("## Relay Messages (1)")[0];
  assert.doesNotMatch(humanSection, /sender-thread-999/);
});

test("retro-ledger stores baseRoot for global scope and reports legacy cross-repo relative paths as unverifiedFiles", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-ledger-global-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const stateDir = path.join(tmp, "state");
  const skillsRoot = path.join(tmp, "skills-repo");
  const otherRoot = path.join(tmp, "other-repo");
  fs.mkdirSync(path.join(skillsRoot, "skills", "demo"), { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "global.json"),
    JSON.stringify({
      version: 1,
      scope: "global",
      project: null,
      updatedAt: "2026-11-24T10:00:00Z",
      candidates: [],
      decisions: [
        {
          patternKey: "legacy-global-without-baseroot",
          decision: "applied",
          summary: "Legacy global entry",
          target: "skills/demo/SKILL.md",
          relatedFiles: ["skills/demo/SKILL.md"],
          sessions: ["s-1"],
          decidedAt: "2026-11-24T10:00:00Z",
          followThrough: null,
        },
      ],
    }),
    "utf8"
  );

  const legacyFromOther = queryLedger({ stateDir, scope: "global", cwd: otherRoot });
  assert.deepEqual(legacyFromOther.followThrough[0].missingFiles, []);
  assert.deepEqual(legacyFromOther.followThrough[0].unverifiedFiles, ["skills/demo/SKILL.md"]);

  const mdOutput = execFileSync(
    process.execPath,
    ["--no-warnings", path.join(scriptsDir, "retro-ledger.mjs"), "query", "--state-dir", stateDir, "--scope", "global", "--cwd", otherRoot],
    { encoding: "utf8" }
  );
  assert.match(mdOutput, /unverifiedFiles=skills\/demo\/SKILL\.md/);
  assert.doesNotMatch(mdOutput, /missingFiles=/);

  const legacyFromSkills = queryLedger({ stateDir, scope: "global", cwd: skillsRoot });
  assert.deepEqual(legacyFromSkills.followThrough[0].missingFiles, []);
  assert.deepEqual(legacyFromSkills.followThrough[0].unverifiedFiles, []);

  recordDecision({
    stateDir,
    scope: "global",
    cwd: skillsRoot,
    patternKey: "new-global-with-baseroot",
    decision: "applied",
    summary: "New global entry",
    target: "skills/demo/SKILL.md",
    relatedFiles: ["skills/demo/SKILL.md"],
    sessionId: "s-2",
    nowIso: "2026-11-24T11:00:00Z",
  });
  recordDecision({
    stateDir,
    scope: "global",
    cwd: skillsRoot,
    patternKey: "missing-global-with-baseroot",
    decision: "applied",
    summary: "Actually missing global entry",
    target: "skills/demo/MISSING.md",
    relatedFiles: ["skills/demo/MISSING.md"],
    sessionId: "s-2",
    nowIso: "2026-11-24T12:00:00Z",
  });
  recordCandidate({
    stateDir,
    scope: "global",
    cwd: skillsRoot,
    patternKey: "global-candidate-with-baseroot",
    summary: "Global candidate",
    sessionId: "s-2",
    relatedFiles: ["skills/demo/SKILL.md"],
    safety: true,
    nowIso: "2026-11-24T12:00:00Z",
  });

  const fromOther = queryLedger({ stateDir, scope: "global", cwd: otherRoot });
  const byKey = new Map(fromOther.followThrough.map((f) => [f.patternKey, f]));
  assert.deepEqual(byKey.get("new-global-with-baseroot").missingFiles, []);
  assert.deepEqual(byKey.get("new-global-with-baseroot").unverifiedFiles, []);
  assert.deepEqual(byKey.get("missing-global-with-baseroot").missingFiles, ["skills/demo/MISSING.md"]);
  assert.deepEqual(byKey.get("missing-global-with-baseroot").unverifiedFiles, []);
  assert.deepEqual(fromOther.readyCandidates[0].staleFiles, []);
  assert.deepEqual(fromOther.readyCandidates[0].unverifiedFiles, []);
});
