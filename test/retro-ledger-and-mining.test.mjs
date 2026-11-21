import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compactLedgerInPlace,
  markFollowThrough,
  queryLedger,
  recordCandidate,
  recordDecision,
} from "../skills/yjx-retro/scripts/retro-ledger.mjs";
import { mineSessions } from "../skills/yjx-retro-sessions/scripts/mine-sessions.mjs";
import { runHealthCheck } from "../skills/yjx-retro-sessions/scripts/health-check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ledgerCliPath = path.resolve(__dirname, "../skills/yjx-retro/scripts/retro-ledger.mjs");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ledgerCliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`CLI exited ${code}: ${stderr || stdout}`));
    });
  });
}

test("retro-ledger 支持同 session 幂等计数、并发进程安全写入及僵死锁回收", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-ledger-"));
  const stateDir = path.join(root, "state");
  const repoDir = path.join(root, "repo");
  await mkdir(repoDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = recordCandidate({
    stateDir,
    scope: "project",
    cwd: repoDir,
    patternKey: "check-before-edit",
    summary: "Read file before editing",
    sessionId: "s1",
    relatedFiles: ["src/app.js"],
  });
  assert.equal(first.result.action, "created");

  const dup = recordCandidate({
    stateDir,
    scope: "project",
    cwd: repoDir,
    patternKey: "check-before-edit",
    summary: "Read file before editing",
    sessionId: "s1",
  });
  assert.equal(dup.result.action, "idempotent");
  assert.equal(dup.result.entry.distinctSessions, 1);

  // Spawn 6 concurrent processes writing distinct sessions to the same ledger
  await Promise.all(
    ["s2", "s3", "s4", "s5", "s6", "s7"].map((sid) =>
      runCli([
        "record-candidate",
        "--state-dir",
        stateDir,
        "--scope",
        "project",
        "--cwd",
        repoDir,
        "--pattern-key",
        "check-before-edit",
        "--summary",
        "Read file before editing",
        "--session-id",
        sid,
      ])
    )
  );

  // Simulate a stale lock file left by a crashed process
  const queriedBefore = queryLedger({ stateDir, scope: "project", cwd: repoDir });
  const ledgerFile = path.join(stateDir, "projects", `${queriedBefore.project.projectKey}.json`);
  const staleLock = `${ledgerFile}.lock`;
  await writeFile(staleLock, "{}");
  const old = new Date(Date.now() - 120_000);
  await utimes(staleLock, old, old);

  const afterStale = recordCandidate({
    stateDir,
    scope: "project",
    cwd: repoDir,
    patternKey: "check-before-edit",
    summary: "Read file before editing",
    sessionId: "s8",
  });
  assert.equal(afterStale.result.entry.distinctSessions, 8);
});

test("retro-ledger 强制执行 TTL 过期（保留安全红线）、硬上限裁剪及 Follow-through/拒绝过滤", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-ledger-gc-"));
  const stateDir = path.join(root, "state");
  const repoDir = path.join(root, "repo");
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, "keep.md"), "# keep\n");
  t.after(() => rm(root, { recursive: true, force: true }));

  const now = "2026-11-20T00:00:00.000Z";
  const stale90d = "2026-08-01T00:00:00.000Z";
  const stale200d = "2026-04-01T00:00:00.000Z";
  const ledger = {
    version: 1,
    scope: "global",
    candidates: [
      { patternKey: "expired-weak", summary: "old 1x", safety: false, distinctSessions: 1, lastSeen: stale90d },
      { patternKey: "kept-safety", summary: "safety guardrail", safety: true, distinctSessions: 1, lastSeen: stale90d },
      { patternKey: "kept-multi", summary: "2x pattern", safety: false, distinctSessions: 2, lastSeen: stale90d },
      ...Array.from({ length: 55 }, (_, i) => ({
        patternKey: `cap-${i}`,
        summary: `cap ${i}`,
        safety: false,
        distinctSessions: 1,
        lastSeen: now,
      })),
    ],
    decisions: [
      { patternKey: "old-reject", decision: "rejected", summary: "old rej", decidedAt: stale200d },
      { patternKey: "fresh-reject", decision: "rejected", summary: "fresh rej", decidedAt: now },
    ],
  };

  compactLedgerInPlace(ledger, now);
  const candKeys = new Set(ledger.candidates.map((c) => c.patternKey));
  assert.equal(candKeys.has("expired-weak"), false);
  assert.equal(candKeys.has("kept-safety"), true);
  assert.equal(candKeys.has("kept-multi"), true);
  assert.equal(ledger.candidates.length, 50);
  assert.deepEqual(
    ledger.decisions.map((d) => d.patternKey),
    ["fresh-reject"]
  );

  // Applied + follow-through + missing file detection
  recordCandidate({
    stateDir,
    scope: "project",
    cwd: repoDir,
    patternKey: "use-check-script",
    summary: "Run check script before finish",
    sessionId: "s1",
  });
  recordDecision({
    stateDir,
    scope: "project",
    cwd: repoDir,
    patternKey: "use-check-script",
    decision: "applied",
    summary: "Run check script before finish",
    target: "missing-script.mjs",
    sessionId: "s1",
  });
  markFollowThrough({
    stateDir,
    scope: "project",
    cwd: repoDir,
    patternKey: "use-check-script",
    status: "ineffective",
    note: "Agent still skipped it",
  });
  const q = queryLedger({ stateDir, scope: "project", cwd: repoDir });
  assert.equal(q.readyCandidates.length, 0);
  assert.equal(q.activeCandidates.length, 0);
  assert.equal(q.followThrough.length, 1);
  assert.deepEqual(q.followThrough[0].missingFiles, ["missing-script.mjs"]);
  assert.equal(q.followThrough[0].followThrough.status, "ineffective");
});

test("mine-sessions 基于 T3 nativeThreadRef 对 Codex/Claude 去重，过滤噪声与窄窗口，并聚合故障/短语", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-mine-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dbPath = path.join(root, "statev2.sqlite");
  const codexDir = path.join(root, "codex");
  const claudeDir = path.join(root, "claude");
  await mkdir(path.join(codexDir, "2026", "11"), { recursive: true });
  await mkdir(path.join(claudeDir, "proj-a", "subagents"), { recursive: true });

  const nowIso = "2026-11-20T10:00:00.000Z";
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, child_thread_id TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      default_provider TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT, payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_turn_items (
      turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, ordinal INTEGER,
      type TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO projection_projects VALUES (?, ?)").run("p1", "/repo/app");
  db.prepare("INSERT INTO orchestration_v2_projection_subagents VALUES (?, ?)").run("sub1", "t-sub");
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)").run(
    "provider-thread:provider:codex:native-thread:codex-in-t3",
    JSON.stringify({ nativeThreadRef: { driver: "codex", nativeId: "codex-in-t3" } })
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)").run(
    "provider-thread:provider:claudeAgent:native-thread:claude-in-t3",
    JSON.stringify({ nativeThreadRef: { driver: "claudeAgent", nativeId: "claude-in-t3" } })
  );

  // Kept T3 thread (with a mixed scheduled run whose failures must NOT inflate human friction score)
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,?)").run(
    "t-main", "p1", "Fix build issue", "codex", nowIso, nowIso, "{}"
  );
  const addItem = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?,?)");
  addItem.run("i1", "t-main", "r1", 1, "user_message", "completed", nowIso, JSON.stringify({ text: "Please always verify tests before commit" }));
  addItem.run("i1b", "t-main", "r2", 2, "user_message", "completed", nowIso, JSON.stringify({ text: "Use token sk-1234567890abcdef12345" }));
  addItem.run("i2", "t-main", "r2", 3, "command_execution", "failed", nowIso, JSON.stringify({ command: "npm run check-all", exitCode: 1 }));
  addItem.run("i3", "t-main", "r3", 4, "user_message", "completed", nowIso, JSON.stringify({ text: "不对，你漏了边界测试" }));
  addItem.run("s1", "t-main", "r-sched", 5, "user_message", "completed", nowIso, JSON.stringify({ scheduledTaskId: "sched-1", text: "cron ping" }));
  addItem.run("s2", "t-main", "r-sched", 6, "command_execution", "failed", nowIso, JSON.stringify({ command: "cron-noise", exitCode: 1 }));
  addItem.run("s3", "t-main", "r-sched", 7, "run_interrupt_request", "completed", nowIso, JSON.stringify({}));

  // Subagent T3 thread (must be dropped)
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,?)").run(
    "t-sub", "p1", "Child task", "codex", nowIso, nowIso, "{}"
  );
  addItem.run("i4", "t-sub", "r1", 1, "user_message", "completed", nowIso, JSON.stringify({ text: "Please always verify tests before commit" }));

  // Self-retro T3 thread (must be dropped)
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,?)").run(
    "t-retro", "p1", "Retro", "codex", nowIso, nowIso, "{}"
  );
  addItem.run("i5", "t-retro", "r1", 1, "user_message", "completed", nowIso, JSON.stringify({ text: "$yjx-retro" }));
  db.close();

  // Duplicate Codex JSONL already in T3 -> deduped
  await writeFile(
    path.join(codexDir, "2026", "11", "dup.jsonl"),
    [
      JSON.stringify({ type: "session_meta", timestamp: nowIso, payload: { id: "codex-in-t3", cwd: "/repo/app" } }),
      JSON.stringify({ type: "response_item", timestamp: nowIso, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "dup session" }] } }),
    ].join("\n")
  );
  // Standalone Codex JSONL -> kept
  await writeFile(
    path.join(codexDir, "2026", "11", "solo.jsonl"),
    [
      JSON.stringify({ type: "session_meta", timestamp: nowIso, payload: { id: "codex-solo", cwd: "/repo/app" } }),
      JSON.stringify({ type: "response_item", timestamp: nowIso, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please always verify tests before commit" }] } }),
    ].join("\n")
  );

  // Duplicate Claude JSONL already in T3 -> deduped
  await writeFile(
    path.join(claudeDir, "proj-a", "claude-in-t3.jsonl"),
    [
      JSON.stringify({ type: "user", sessionId: "claude-in-t3", isSidechain: false, cwd: "/repo/app", timestamp: nowIso, message: { role: "user", content: "dup claude" } }),
    ].join("\n")
  );
  // Standalone Claude JSONL -> kept, plus subagent file ignored
  await writeFile(
    path.join(claudeDir, "proj-a", "claude-solo.jsonl"),
    [
      JSON.stringify({ type: "user", sessionId: "claude-solo", isSidechain: false, cwd: "/repo/app", timestamp: nowIso, message: { role: "user", content: "Fix failing lint" } }),
      JSON.stringify({ type: "assistant", sessionId: "claude-solo", isSidechain: false, timestamp: nowIso, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm run check-all" } }] } }),
      JSON.stringify({ type: "user", sessionId: "claude-solo", isSidechain: false, timestamp: nowIso, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "fail" }] } }),
    ].join("\n")
  );
  await writeFile(
    path.join(claudeDir, "proj-a", "subagents", "agent-1.jsonl"),
    JSON.stringify({ type: "user", sessionId: "claude-sub", isSidechain: true, timestamp: nowIso, message: { role: "user", content: "subagent" } })
  );

  const res = mineSessions({
    days: 14,
    t3DbPath: dbPath,
    codexDir,
    claudeDir,
    nowMs: Date.parse("2026-11-20T12:00:00.000Z"),
  });

  assert.equal(res.counts.totalKept, 3);
  assert.equal(res.counts.t3Kept, 1);
  assert.equal(res.counts.codexKept, 1);
  assert.equal(res.counts.claudeKept, 1);
  assert.equal(res.counts.dedupedByT3, 2);
  assert.equal(res.disuseEvidence.sufficient, false);
  assert.equal(res.repeatedFailures[0].command, "npm run check-all");
  assert.equal(res.repeatedFailures[0].count, 2);
  assert.equal(res.repeatedPhrases.length, 1);
  assert.equal(res.repeatedPhrases[0].sample, "Please always verify tests before commit");
  assert.equal(res.topFrictionSessions[0].sessionId, "t-main");
  assert.equal(res.topFrictionSessions[0].failedTools, 1);
  assert.equal(res.topFrictionSessions[0].interrupts, 0);
  const mainSessionPrompts = JSON.stringify(res);
  assert.equal(mainSessionPrompts.includes("sk-1234567890abcdef12345"), false);
});

test("health-check 检出断链与超体积规则文件", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "skills", "demo-skill"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), `${"x".repeat(25_000)}\nSee [missing](docs/nope.md)\n`);
  await writeFile(
    path.join(root, "skills", "demo-skill", "SKILL.md"),
    "---\nname: wrong-name\ndescription: demo\n---\n\n[ref](references/missing.md)\n"
  );

  const res = runHealthCheck({ rootDir: root });
  const types = new Set(res.findings.map((f) => f.type));
  assert.equal(types.has("rule_over_cap"), true);
  assert.equal(types.has("dead_link"), true);
  assert.equal(types.has("name_mismatch"), true);
});

test("health-check 覆盖 references/*.md 断链、同/跨文件 GFM 标题锚点且不误报斜杠标题与参考文件", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yjx-health-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "skills", "demo-skill", "references"), { recursive: true });
  await writeFile(
    path.join(root, "skills", "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: demo\n---\n\n[ok](references/guide.md#无浏览器--非-macos-降级路线)\n[snake](references/guide.md#全局-mcp_configjson-配置)\n[self](#内部节)\n\n## 内部节\n"
  );
  await writeFile(
    path.join(root, "skills", "demo-skill", "references", "guide.md"),
    [
      "# Guide",
      "",
      "## 无浏览器 / 非 macOS 降级路线",
      "",
      "## 全局 `mcp_config.json` 配置",
      "",
      "[ok-self](#无浏览器--非-macos-降级路线)",
      "[line-ref](../SKILL.md#L1-L3)",
      "[bad-anchor](#不存在的锚点)",
      "[bad-ref](missing-sibling.md)",
      "",
    ].join("\n")
  );

  const res = runHealthCheck({ rootDir: root });
  assert.equal(res.filesChecked, 2);
  assert.equal(res.findings.length, 2);
  assert.deepEqual(
    res.findings.map((f) => `${f.path}:${f.type}`).sort(),
    [
      "skills/demo-skill/references/guide.md:dead_anchor",
      "skills/demo-skill/references/guide.md:dead_link",
    ]
  );
});
