#!/usr/bin/env node
/**
 * Shared atomic dual-ledger CLI for `yjx-retro` and `yjx-retro-sessions`.
 * Manages weak-signal candidates (promotion threshold) and decision memory
 * (applied/rejected/deferred) with lock-protected atomic writes, idempotent
 * session counting, scope isolation, and piggybacked TTL/LRU compaction.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIMITS = {
  maxCandidatesPerScope: 50,
  candidateTtlDays: 60,
  maxRejectedPerScope: 200,
  rejectedTtlDays: 180,
  deferredResurfaceDays: 30,
  maxAppliedPerScope: 100,
  maxDeferredPerScope: 100,
  maxStoredSessions: 10,
  maxDedupIds: 60,
  maxRelatedFiles: 10,
  summaryMaxChars: 200,
  reasonMaxChars: 240,
  lockStaleMs: 30_000,
  lockTimeoutMs: 5_000,
  defaultMinSessionsToPromote: 2,
};

const VALID_DECISIONS = new Set(["applied", "rejected", "deferred"]);
const VALID_FOLLOWTHROUGH = new Set(["verified", "ineffective", "missing"]);

export function getStateDir(explicitDir) {
  return path.resolve(explicitDir || process.env.YJX_RETRO_STATE_DIR || path.join(os.homedir(), ".yjx-retro"));
}

function sha12(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 12);
}

function normalizeGitUrl(raw) {
  return String(raw || "").trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return "";
  }
}

export function resolveProjectIdentity(cwd = process.cwd()) {
  const absCwd = path.resolve(cwd || process.cwd());
  const top = gitOutput(absCwd, ["rev-parse", "--show-toplevel"]);
  const root = top ? path.resolve(top) : absCwd;
  const remote = normalizeGitUrl(gitOutput(root, ["remote", "get-url", "origin"]));
  const basis = remote || root.toLowerCase();
  const projectKey = sha12(basis);
  const name = path.basename(root) || projectKey;
  return { projectKey, name, root, remote: remote || null };
}

function compactText(text, maxChars) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function uniqueShortList(items, maxItems) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    const val = String(raw || "").trim();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= maxItems) break;
  }
  return out;
}

function daysBetween(isoA, isoB) {
  const msA = Date.parse(isoA);
  const msB = Date.parse(isoB);
  if (!Number.isFinite(msA) || !Number.isFinite(msB)) return 0;
  return Math.max(0, (msB - msA) / 86_400_000);
}

function emptyLedger(scope, project = null) {
  return {
    version: 1,
    scope,
    project,
    updatedAt: new Date().toISOString(),
    candidates: [],
    decisions: [],
  };
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, Math.max(1, ms));
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LIMITS.lockTimeoutMs;
  let backoff = 15;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LIMITS.lockStaleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for retro ledger lock: ${lockPath}`);
      }
      sleepSync(backoff + Math.floor(Math.random() * 15));
      backoff = Math.min(120, backoff * 2);
    }
  }
}

function writeAtomicJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      const transient = err && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES");
      if (!transient || attempt >= 5) throw err;
      sleepSync(15 * (attempt + 1));
    }
  }
}

function readLedgerFile(filePath, scope, project = null) {
  if (!fs.existsSync(filePath)) return emptyLedger(scope, project);
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    version: 1,
    scope: parsed.scope || scope,
    project: parsed.project ?? project,
    updatedAt: parsed.updatedAt || new Date().toISOString(),
    candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
  };
}

function withLockedLedger({ stateDir, scope, project, mutate }) {
  const filePath =
    scope === "global"
      ? path.join(stateDir, "global.json")
      : path.join(stateDir, "projects", `${project.projectKey}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  acquireLock(lockPath);
  try {
    const ledger = readLedgerFile(filePath, scope, project);
    const result = mutate(ledger);
    compactLedgerInPlace(ledger);
    ledger.updatedAt = new Date().toISOString();
    writeAtomicJson(filePath, ledger);
    if (scope === "project" && project) {
      updateProjectIndex(stateDir, project);
    }
    return { ledger, filePath, result };
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function updateProjectIndex(stateDir, project) {
  const idxPath = path.join(stateDir, "projects.json");
  const lockPath = `${idxPath}.lock`;
  acquireLock(lockPath);
  try {
    let idx = {};
    if (fs.existsSync(idxPath)) {
      try {
        idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
      } catch {
        idx = {};
      }
    }
    idx[project.projectKey] = {
      name: project.name,
      root: project.root,
      remote: project.remote,
      updatedAt: new Date().toISOString(),
    };
    writeAtomicJson(idxPath, idx);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/**
 * Enforce TTL expiry and per-scope hard LRU caps so ledgers stay bounded
 * without any background cron daemon.
 */
export function compactLedgerInPlace(ledger, nowIso = new Date().toISOString()) {
  const filteredCandidates = [];
  for (const c of ledger.candidates || []) {
    if (!c?.patternKey) continue;
    const distinct = Number(c.distinctSessions ?? (c.sessions?.length || 1));
    const age = daysBetween(c.lastSeen || c.firstSeen || nowIso, nowIso);
    if (!c.safety && distinct < 2 && age > LIMITS.candidateTtlDays) {
      continue;
    }
    filteredCandidates.push(c);
  }
  filteredCandidates.sort((a, b) => {
    const safeDiff = Number(Boolean(b.safety)) - Number(Boolean(a.safety));
    if (safeDiff !== 0) return safeDiff;
    const countDiff = Number(b.distinctSessions || 1) - Number(a.distinctSessions || 1);
    if (countDiff !== 0) return countDiff;
    return String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""));
  });
  ledger.candidates = filteredCandidates.slice(0, LIMITS.maxCandidatesPerScope);

  const byDecision = { applied: [], rejected: [], deferred: [] };
  for (const d of ledger.decisions || []) {
    if (!d?.patternKey || !VALID_DECISIONS.has(d.decision)) continue;
    const age = daysBetween(d.decidedAt || nowIso, nowIso);
    if (d.decision === "rejected" && age > LIMITS.rejectedTtlDays) continue;
    byDecision[d.decision].push(d);
  }
  const sortNewest = (arr) =>
    arr.sort((a, b) => String(b.decidedAt || "").localeCompare(String(a.decidedAt || "")));
  ledger.decisions = [
    ...sortNewest(byDecision.applied).slice(0, LIMITS.maxAppliedPerScope),
    ...sortNewest(byDecision.rejected).slice(0, LIMITS.maxRejectedPerScope),
    ...sortNewest(byDecision.deferred).slice(0, LIMITS.maxDeferredPerScope),
  ];
  return ledger;
}

export function recordCandidate({
  stateDir,
  scope = "project",
  cwd = process.cwd(),
  patternKey,
  summary,
  sessionId,
  relatedFiles = [],
  safety = false,
  nowIso = new Date().toISOString(),
}) {
  if (!patternKey) throw new Error("--pattern-key is required");
  if (!summary) throw new Error("--summary is required");
  if (!sessionId) throw new Error("--session-id is required");
  const resolvedDir = getStateDir(stateDir);
  const project = scope === "project" ? resolveProjectIdentity(cwd) : null;
  const cleanKey = compactText(patternKey, 120);
  const cleanSummary = compactText(summary, LIMITS.summaryMaxChars);
  const cleanFiles = uniqueShortList(relatedFiles, LIMITS.maxRelatedFiles);

  return withLockedLedger({
    stateDir: resolvedDir,
    scope,
    project,
    mutate(ledger) {
      const existing = ledger.candidates.find((c) => c.patternKey === cleanKey);
      if (!existing) {
        const entry = {
          patternKey: cleanKey,
          summary: cleanSummary,
          safety: Boolean(safety),
          distinctSessions: 1,
          seenSessionIds: [sessionId],
          sessions: [sessionId],
          relatedFiles: cleanFiles,
          firstSeen: nowIso,
          lastSeen: nowIso,
        };
        ledger.candidates.push(entry);
        return { action: "created", entry };
      }

      const seen = new Set(existing.seenSessionIds || existing.sessions || []);
      const isNewSession = !seen.has(sessionId);
      if (isNewSession) {
        existing.distinctSessions = Number(existing.distinctSessions || seen.size || 1) + 1;
        const nextSeen = [...(existing.seenSessionIds || existing.sessions || []), sessionId];
        existing.seenSessionIds = nextSeen.slice(-LIMITS.maxDedupIds);
        existing.sessions = [...(existing.sessions || []), sessionId].slice(-LIMITS.maxStoredSessions);
      }
      existing.summary = cleanSummary;
      existing.safety = Boolean(existing.safety || safety);
      existing.relatedFiles = uniqueShortList([...(existing.relatedFiles || []), ...cleanFiles], LIMITS.maxRelatedFiles);
      existing.lastSeen = nowIso;
      return { action: isNewSession ? "incremented" : "idempotent", entry: existing };
    },
  });
}

export function recordDecision({
  stateDir,
  scope = "project",
  cwd = process.cwd(),
  patternKey,
  decision,
  summary,
  target = null,
  reason = null,
  sessionId = null,
  relatedFiles = [],
  nowIso = new Date().toISOString(),
}) {
  if (!patternKey) throw new Error("--pattern-key is required");
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error(`--decision must be one of applied|rejected|deferred, got: ${decision}`);
  }
  if (!summary) throw new Error("--summary is required");
  const resolvedDir = getStateDir(stateDir);
  const project = scope === "project" ? resolveProjectIdentity(cwd) : null;
  const cleanKey = compactText(patternKey, 120);

  return withLockedLedger({
    stateDir: resolvedDir,
    scope,
    project,
    mutate(ledger) {
      const idx = ledger.decisions.findIndex((d) => d.patternKey === cleanKey);
      const prev = idx >= 0 ? ledger.decisions[idx] : null;
      const sessions = uniqueShortList(
        [...(prev?.sessions || []), ...(sessionId ? [sessionId] : [])],
        LIMITS.maxStoredSessions
      );
      const entry = {
        patternKey: cleanKey,
        decision,
        summary: compactText(summary, LIMITS.summaryMaxChars),
        target: target ? compactText(target, 200) : prev?.target || null,
        reason: reason ? compactText(reason, LIMITS.reasonMaxChars) : prev?.reason || null,
        relatedFiles: uniqueShortList([...(prev?.relatedFiles || []), ...relatedFiles], LIMITS.maxRelatedFiles),
        sessions,
        decidedAt: nowIso,
        followThrough: decision === "applied" ? prev?.followThrough || null : undefined,
      };
      if (idx >= 0) ledger.decisions[idx] = entry;
      else ledger.decisions.push(entry);

      // Remove active candidate once resolved as applied or rejected.
      if (decision === "applied" || decision === "rejected") {
        ledger.candidates = ledger.candidates.filter((c) => c.patternKey !== cleanKey);
      }
      return { action: idx >= 0 ? "updated" : "recorded", entry };
    },
  });
}

export function markFollowThrough({
  stateDir,
  scope = "project",
  cwd = process.cwd(),
  patternKey,
  status,
  note = null,
  nowIso = new Date().toISOString(),
}) {
  if (!patternKey) throw new Error("--pattern-key is required");
  if (!VALID_FOLLOWTHROUGH.has(status)) {
    throw new Error(`--status must be one of verified|ineffective|missing, got: ${status}`);
  }
  const resolvedDir = getStateDir(stateDir);
  const project = scope === "project" ? resolveProjectIdentity(cwd) : null;
  const cleanKey = compactText(patternKey, 120);

  return withLockedLedger({
    stateDir: resolvedDir,
    scope,
    project,
    mutate(ledger) {
      const item = ledger.decisions.find((d) => d.patternKey === cleanKey && d.decision === "applied");
      if (!item) {
        throw new Error(`No applied decision found for patternKey=${cleanKey} in scope=${scope}`);
      }
      item.followThrough = {
        status,
        checkedAt: nowIso,
        note: note ? compactText(note, LIMITS.reasonMaxChars) : null,
      };
      return { action: "followthrough_updated", entry: item };
    },
  });
}

function checkMissingFiles(files, baseRoot) {
  const missing = [];
  for (const rel of files || []) {
    const candidate = path.isAbsolute(rel) ? rel : path.resolve(baseRoot || process.cwd(), rel);
    if (!fs.existsSync(candidate)) missing.push(rel);
  }
  return missing;
}

export function queryLedger({
  stateDir,
  scope = "all",
  cwd = process.cwd(),
  limit = 10,
  minSessions = LIMITS.defaultMinSessionsToPromote,
  nowIso = new Date().toISOString(),
}) {
  const resolvedDir = getStateDir(stateDir);
  const project = scope === "global" ? null : resolveProjectIdentity(cwd);
  const scopesToLoad = [];
  if (scope === "project" || scope === "all") {
    scopesToLoad.push({
      scope: "project",
      filePath: path.join(resolvedDir, "projects", `${project.projectKey}.json`),
      baseRoot: project.root,
    });
  }
  if (scope === "global" || scope === "all") {
    scopesToLoad.push({
      scope: "global",
      filePath: path.join(resolvedDir, "global.json"),
      baseRoot: cwd,
    });
  }

  const readyCandidates = [];
  const activeCandidates = [];
  const rejectedKeys = [];
  const deferredItems = [];
  const followThrough = [];

  for (const target of scopesToLoad) {
    const ledger = compactLedgerInPlace(readLedgerFile(target.filePath, target.scope, project), nowIso);
    for (const c of ledger.candidates) {
      const staleFiles = checkMissingFiles(c.relatedFiles, target.baseRoot);
      const item = {
        scope: target.scope,
        patternKey: c.patternKey,
        summary: c.summary,
        distinctSessions: Number(c.distinctSessions || c.sessions?.length || 1),
        safety: Boolean(c.safety),
        sessions: c.sessions || [],
        relatedFiles: c.relatedFiles || [],
        staleFiles,
        lastSeen: c.lastSeen,
      };
      if (item.distinctSessions >= minSessions || item.safety) {
        readyCandidates.push(item);
      } else {
        activeCandidates.push(item);
      }
    }

    for (const d of ledger.decisions) {
      if (d.decision === "rejected") {
        rejectedKeys.push({
          scope: target.scope,
          patternKey: d.patternKey,
          summary: d.summary,
          decidedAt: d.decidedAt,
        });
      } else if (d.decision === "deferred") {
        const ageDays = Math.floor(daysBetween(d.decidedAt, nowIso));
        deferredItems.push({
          scope: target.scope,
          patternKey: d.patternKey,
          summary: d.summary,
          decidedAt: d.decidedAt,
          resurfaceReady: ageDays >= LIMITS.deferredResurfaceDays,
        });
      } else if (d.decision === "applied") {
        const filesToCheck = d.relatedFiles?.length ? d.relatedFiles : d.target ? [d.target] : [];
        const missingFiles = checkMissingFiles(filesToCheck, target.baseRoot);
        followThrough.push({
          scope: target.scope,
          patternKey: d.patternKey,
          summary: d.summary,
          target: d.target,
          decidedAt: d.decidedAt,
          missingFiles,
          followThrough: d.followThrough || null,
        });
      }
    }
  }

  followThrough.sort((a, b) => String(b.decidedAt || "").localeCompare(String(a.decidedAt || "")));
  return {
    stateDir: resolvedDir,
    project,
    limits: {
      minSessionsToPromote: minSessions,
      candidateTtlDays: LIMITS.candidateTtlDays,
      rejectedTtlDays: LIMITS.rejectedTtlDays,
      maxCandidatesPerScope: LIMITS.maxCandidatesPerScope,
    },
    followThrough: followThrough.slice(0, 3),
    readyCandidates: readyCandidates.slice(0, limit),
    activeCandidates: activeCandidates.slice(0, limit),
    deferredItems: deferredItems.slice(0, limit),
    rejectedKeys,
  };
}

function formatQueryMarkdown(res) {
  const lines = ["# Retro Ledger Context", ""];
  if (res.project) {
    lines.push(`- Project: \`${res.project.name}\` (\`${res.project.projectKey}\`, root: \`${res.project.root}\`)`);
  }
  lines.push(`- State dir: \`${res.stateDir}\``);
  lines.push("");

  lines.push("## Follow-through (Recent Applied)");
  if (res.followThrough.length === 0) {
    lines.push("- None recorded in this scope.");
  } else {
    for (const f of res.followThrough) {
      const miss = f.missingFiles.length ? ` | missingFiles=${f.missingFiles.join(", ")}` : "";
      const prev = f.followThrough ? ` | prevCheck=${f.followThrough.status}` : "";
      lines.push(`- [${f.scope}] \`${f.patternKey}\`: ${f.summary} (target: \`${f.target || "n/a"}\`, at ${f.decidedAt}${miss}${prev})`);
    }
  }
  lines.push("");

  lines.push("## Candidates Ready to Promote");
  if (res.readyCandidates.length === 0) {
    lines.push("- None.");
  } else {
    for (const c of res.readyCandidates) {
      const stale = c.staleFiles.length ? ` | staleFiles=${c.staleFiles.join(", ")}` : "";
      lines.push(`- [${c.scope}] \`${c.patternKey}\` (${c.distinctSessions} sessions${c.safety ? ", safety" : ""}): ${c.summary}${stale}`);
    }
  }
  lines.push("");

  lines.push("## Active Weak Candidates");
  if (res.activeCandidates.length === 0) {
    lines.push("- None.");
  } else {
    for (const c of res.activeCandidates) {
      lines.push(`- [${c.scope}] \`${c.patternKey}\` (${c.distinctSessions} sessions): ${c.summary}`);
    }
  }
  lines.push("");

  lines.push(`## Rejected Fingerprints (${res.rejectedKeys.length})`);
  for (const r of res.rejectedKeys.slice(0, 20)) {
    lines.push(`- [${r.scope}] \`${r.patternKey}\`: ${r.summary} (${r.decidedAt})`);
  }
  return `${lines.join("\n")}\n`;
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { files: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--safety") opts.safety = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--file") opts.files.push(rest[++i]);
    else if (arg === "--state-dir") opts.stateDir = rest[++i];
    else if (arg === "--scope") opts.scope = rest[++i];
    else if (arg === "--cwd") opts.cwd = rest[++i];
    else if (arg === "--pattern-key") opts.patternKey = rest[++i];
    else if (arg === "--summary") opts.summary = rest[++i];
    else if (arg === "--session-id") opts.sessionId = rest[++i];
    else if (arg === "--decision") opts.decision = rest[++i];
    else if (arg === "--target") opts.target = rest[++i];
    else if (arg === "--reason") opts.reason = rest[++i];
    else if (arg === "--status") opts.status = rest[++i];
    else if (arg === "--note") opts.note = rest[++i];
    else if (arg === "--limit") opts.limit = Number(rest[++i]);
    else if (arg === "--min-sessions") opts.minSessions = Number(rest[++i]);
    else if (arg === "--format") opts.format = rest[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, opts };
}

function printHelp() {
  console.log(`Usage: retro-ledger.mjs <command> [options]

Commands:
  project-id         Resolve projectKey/root/remote for --cwd
  query              Query followThrough, ready/active candidates, and rejected fingerprints
  record-candidate   Idempotently record/increment a weak-signal candidate
  record-decision    Record applied|rejected|deferred decision (removes active candidate on applied/rejected)
  mark-followthrough Update verification status (verified|ineffective|missing) on an applied decision

Common options:
  --state-dir <dir>  Override state dir (default: $YJX_RETRO_STATE_DIR or ~/.yjx-retro)
  --scope <scope>    project | global | all (query defaults to all; writes default to project)
  --cwd <dir>        Working directory for project identity
  --format <md|json> Output format (query defaults to md)`);
}

function main() {
  const { command, opts } = parseCliArgs(process.argv.slice(2));
  if (!command || opts.help || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  let output;
  if (command === "project-id") {
    output = resolveProjectIdentity(opts.cwd || process.cwd());
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (command === "query") {
    const res = queryLedger({
      stateDir: opts.stateDir,
      scope: opts.scope || "all",
      cwd: opts.cwd || process.cwd(),
      limit: Number.isFinite(opts.limit) ? opts.limit : 10,
      minSessions: Number.isFinite(opts.minSessions) ? opts.minSessions : LIMITS.defaultMinSessionsToPromote,
    });
    if (opts.json || opts.format === "json") console.log(JSON.stringify(res, null, 2));
    else process.stdout.write(formatQueryMarkdown(res));
    return;
  }
  if (command === "record-candidate") {
    const res = recordCandidate({
      stateDir: opts.stateDir,
      scope: opts.scope || "project",
      cwd: opts.cwd || process.cwd(),
      patternKey: opts.patternKey,
      summary: opts.summary,
      sessionId: opts.sessionId,
      relatedFiles: opts.files,
      safety: Boolean(opts.safety),
    });
    console.log(JSON.stringify({ ok: true, filePath: res.filePath, ...res.result }, null, 2));
    return;
  }
  if (command === "record-decision") {
    const res = recordDecision({
      stateDir: opts.stateDir,
      scope: opts.scope || "project",
      cwd: opts.cwd || process.cwd(),
      patternKey: opts.patternKey,
      decision: opts.decision,
      summary: opts.summary,
      target: opts.target,
      reason: opts.reason,
      sessionId: opts.sessionId,
      relatedFiles: opts.files,
    });
    console.log(JSON.stringify({ ok: true, filePath: res.filePath, ...res.result }, null, 2));
    return;
  }
  if (command === "mark-followthrough") {
    const res = markFollowThrough({
      stateDir: opts.stateDir,
      scope: opts.scope || "project",
      cwd: opts.cwd || process.cwd(),
      patternKey: opts.patternKey,
      status: opts.status,
      note: opts.note,
    });
    console.log(JSON.stringify({ ok: true, filePath: res.filePath, ...res.result }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main();
  } catch (err) {
    console.error(`retro-ledger: ${err.message}`);
    process.exit(1);
  }
}
