#!/usr/bin/env node
/**
 * Zero-token multi-session pre-scanner for `yjx-retro-sessions`.
 * Reads T3 Code SQLite + Codex CLI JSONL + Claude Code CLI JSONL, deduplicates
 * CLI sessions already imported/hosted inside T3 via nativeThreadRef IDs, filters
 * noise/subagents/self-retro runs, and ranks high-friction sessions plus
 * deterministic failure, phrase, and skill-usage clusters.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const RETRO_SELF_NAMES = new Set(["yjx-retro", "yjx-retro-skill", "yjx-retro-sessions"]);
const SUBAGENT_TOOLS = new Set(["Agent", "spawn_agent", "invoke_subagent", "delegate_task"]);
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/gi;

const CORRECTION_PATTERNS = [
  /不对|错了|不是这样|不要|别这样|停止|重来|重新|为什么这么|误解|漏了|没按/,
  /\b(wrong|no,|stop doing|don't|do not|revert|undo|retry|instead of|missed|ignored)\b/i,
];

function redact(text) {
  return String(text ?? "").replace(SECRET_RE, "[REDACTED]");
}

function oneLine(text, max = 180) {
  return redact(String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, max);
}

function safeJson(raw, fallback = null) {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizePathKey(p) {
  if (!p) return "";
  const resolved = path.resolve(String(p));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathMatchesCwd(candidatePath, filterCwdKey) {
  if (!filterCwdKey) return true;
  if (!candidatePath) return false;
  const candKey = normalizePathKey(candidatePath);
  return (
    candKey === filterCwdKey ||
    candKey.startsWith(`${filterCwdKey}${path.sep}`) ||
    filterCwdKey.startsWith(`${candKey}${path.sep}`)
  );
}

function stripSystemWrappers(text) {
  return String(text ?? "")
    .replace(/<(?:t3_code_instructions|runtime_info|environment_context|instructions|permissions instructions|user_action|collaboration_mode|turn_started|SYSTEM_MESSAGE|CONTEXT_SUMMARY)>[\s\S]*?<\/(?:t3_code_instructions|runtime_info|environment_context|instructions|permissions instructions|user_action|collaboration_mode|turn_started|SYSTEM_MESSAGE|CONTEXT_SUMMARY)>/gi, "")
    .replace(/<\/?(?:user_request|ADDITIONAL_METADATA)>/gi, "")
    .trim();
}

function extractSkillTagsAndTokens(text) {
  const skills = new Set();
  const tagRe = /<skill>\s*<name>([^<\s]+)<\/name>/gi;
  let m;
  while ((m = tagRe.exec(text)) !== null) skills.add(m[1].trim());
  const tokRe = /(?:^|[^\w$])\$([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)(?![\w-])/g;
  while ((m = tokRe.exec(text)) !== null) {
    if (!/^(?:env|home|path|pwd|tmp|temp)$/i.test(m[1])) skills.add(m[1]);
  }
  return [...skills];
}

function normalizePhrase(text) {
  const clean = oneLine(stripSystemWrappers(text), 200)
    .replace(/^(\$[a-z0-9_-]+\s*)+/i, "")
    .trim();
  if (clean.length < 12) return null;
  if (/^(ok|yes|no|1|2|3|继续|好的|谢谢|收到)$/i.test(clean)) return null;
  return clean.toLowerCase().replace(/[0-9a-f]{7,}/g, "<id>").replace(/\s+/g, " ");
}

function extractCommandString(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.command === "string" && payload.command.trim()) return payload.command;
  const inp = payload.input;
  if (typeof inp === "string" && inp.trim()) return inp;
  if (inp && typeof inp === "object") {
    for (const k of ["CommandLine", "command", "cmd", "Path", "path"]) {
      if (typeof inp[k] === "string" && inp[k].trim()) {
        return payload.toolName ? `${payload.toolName}: ${inp[k]}` : inp[k];
      }
    }
  }
  return payload.toolName ? String(payload.toolName) : "";
}

function normalizeCmdHead(cmd) {
  let stripped = String(cmd ?? "")
    .replace(/^\s*(?:"(?:[^"]*[\\/])?(?:pwsh|powershell|bash|sh|cmd)(?:\.exe)?"|(?:pwsh|powershell|bash|sh|cmd)(?:\.exe)?)\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c|\/c)\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
  if (stripped.startsWith("@'")) {
    const rest = stripped.slice(2).trim();
    stripped = rest ? `pwsh-heredoc: ${rest}` : "pwsh-heredoc";
  }
  if (!stripped || stripped === "[object Object]") return null;
  const parts = stripped.split(/\s+/).slice(0, 3);
  return oneLine(parts.join(" "), 80);
}

function isCorrectionPrompt(text) {
  const clean = stripSystemWrappers(text);
  if (!clean) return false;
  return CORRECTION_PATTERNS.some((re) => re.test(clean));
}

function isPureRetroSession(userPrompts, skillsUsed) {
  if (skillsUsed.some((s) => RETRO_SELF_NAMES.has(s)) && userPrompts.length <= 3) {
    return true;
  }
  if (userPrompts.length > 0 && userPrompts.every((p) => /^\s*\$(?:yjx-retro|yjx-retro-skill|yjx-retro-sessions)\b/i.test(p))) {
    return true;
  }
  return false;
}

function walkJsonlFiles(rootDir) {
  const results = [];
  if (!rootDir || !fs.existsSync(rootDir)) return results;
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "subagents") continue;
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  return results;
}

function extractNativeIdFromProviderThread(providerThreadId, payload) {
  const ids = [];
  if (payload?.nativeThreadRef?.nativeId) {
    ids.push(String(payload.nativeThreadRef.nativeId));
  }
  if (typeof providerThreadId === "string" && !providerThreadId.includes("pending%")) {
    const marker = ":native-thread:";
    const idx = providerThreadId.indexOf(marker);
    if (idx >= 0) ids.push(providerThreadId.slice(idx + marker.length));
  }
  if (typeof payload?.appThreadId === "string" && payload.appThreadId.startsWith("import:")) {
    const parts = payload.appThreadId.split(":");
    if (parts.length >= 3) ids.push(parts.slice(2).join(":"));
  }
  return ids.filter(Boolean);
}

/**
 * Scan T3 SQLite and also collect native provider session IDs so Codex/Claude CLI
 * duplicates of T3 sessions are skipped deterministically.
 */
export function scanT3Database(dbPath, { sinceMs, untilMs, filterCwdKey }) {
  const t3NativeIds = new Set();
  const sessions = [];
  let droppedNoise = 0;

  if (!dbPath || !fs.existsSync(dbPath)) {
    return { t3NativeIds, sessions, droppedNoise, available: false };
  }

  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const ptRows = db
      .prepare("SELECT provider_thread_id, payload_json FROM orchestration_v2_projection_provider_threads")
      .all();
    for (const r of ptRows) {
      const p = safeJson(r.payload_json, {});
      for (const nid of extractNativeIdFromProviderThread(r.provider_thread_id, p)) {
        t3NativeIds.add(nid);
      }
    }

    const subRows = db
      .prepare("SELECT DISTINCT child_thread_id FROM orchestration_v2_projection_subagents WHERE child_thread_id IS NOT NULL")
      .all();
    const subagentThreadIds = new Set(subRows.map((r) => r.child_thread_id));

    const projRows = db
      .prepare("SELECT project_id, workspace_root FROM projection_projects")
      .all();
    const projectRootById = new Map(projRows.map((r) => [r.project_id, r.workspace_root]));

    const threads = db
      .prepare(
        `SELECT thread_id, project_id, title, default_provider, created_at, updated_at, deleted_at, payload_json
         FROM orchestration_v2_projection_threads
         WHERE deleted_at IS NULL`
      )
      .all();

    const itemsStmt = db.prepare(
      `SELECT turn_item_id, run_id, type, status, updated_at, payload_json
       FROM orchestration_v2_projection_turn_items
       WHERE thread_id = ?
       ORDER BY ordinal`
    );

    for (const th of threads) {
      if (subagentThreadIds.has(th.thread_id)) {
        droppedNoise++;
        continue;
      }
      const updatedMs = Date.parse(th.updated_at || th.created_at || "");
      if (Number.isFinite(sinceMs) && Number.isFinite(updatedMs) && updatedMs < sinceMs) continue;
      if (Number.isFinite(untilMs) && Number.isFinite(updatedMs) && updatedMs > untilMs) continue;

      const tPayload = safeJson(th.payload_json, {});
      const cwd = tPayload.worktreePath || projectRootById.get(th.project_id) || null;
      if (!pathMatchesCwd(cwd, filterCwdKey)) continue;

      const items = itemsStmt.all(th.thread_id);
      const summary = summarizeT3Thread(th, cwd, items);
      if (!summary) {
        droppedNoise++;
        continue;
      }
      sessions.push(summary);
    }
  } finally {
    db.close();
  }
  return { t3NativeIds, sessions, droppedNoise, available: true };
}

function summarizeT3Thread(th, cwd, items) {
  const userPrompts = [];
  const skillsSet = new Set();
  const failedCmds = [];
  const scheduledRunIds = new Set();
  let corrections = 0;
  let interrupts = 0;
  let failedTools = 0;
  let totalTools = 0;
  let scheduledOnly = true;

  for (const item of items) {
    if (item.type !== "user_message") continue;
    const p = safeJson(item.payload_json, {});
    const isSched = Boolean(p.scheduledTaskId || String(item.turn_item_id || "").includes("scheduled"));
    if (isSched && item.run_id) scheduledRunIds.add(item.run_id);
  }

  for (const item of items) {
    if (item.run_id && scheduledRunIds.has(item.run_id)) continue;
    const p = safeJson(item.payload_json, {});
    if (item.type === "user_message") {
      if (p.scheduledTaskId || String(item.turn_item_id || "").includes("scheduled")) {
        continue;
      }
      scheduledOnly = false;
      const text = typeof p.text === "string" ? p.text : "";
      for (const s of extractSkillTagsAndTokens(text)) skillsSet.add(s);
      const clean = oneLine(stripSystemWrappers(text), 200);
      if (clean) {
        userPrompts.push(clean);
        if (userPrompts.length > 1 && isCorrectionPrompt(clean)) corrections++;
      }
    } else if (item.type === "command_execution" || item.type === "dynamic_tool") {
      if (String(item.turn_item_id || "").includes("workspace-preparation")) continue;
      totalTools++;
      const exitCode = p.exitCode ?? p.exit_code;
      const isErr =
        item.status === "failed" ||
        item.status === "error" ||
        (typeof exitCode === "number" && exitCode !== 0);
      if (isErr) {
        failedTools++;
        const head = normalizeCmdHead(extractCommandString(p));
        if (head) failedCmds.push(head);
      }
    } else if (item.type === "run_interrupt_request" || item.type === "error") {
      interrupts++;
    }
  }

  if (scheduledOnly || userPrompts.length === 0) return null;
  const skillsUsed = [...skillsSet];
  if (isPureRetroSession(userPrompts, skillsUsed)) return null;

  const frictionScore = interrupts * 3 + failedTools * 2 + corrections * 3;
  return {
    source: "t3",
    sessionId: th.thread_id,
    title: oneLine(th.title || userPrompts[0] || th.thread_id, 90),
    cwd,
    provider: th.default_provider || "t3",
    updatedAt: th.updated_at || th.created_at,
    humanTurns: userPrompts.length,
    totalTools,
    failedTools,
    corrections,
    interrupts,
    frictionScore,
    skillsUsed,
    failedCmds,
    userPrompts,
  };
}

function parseCodexSessionFile(filePath, { sinceMs, untilMs, filterCwdKey, t3NativeIds }) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { status: "skip" };
  }
  if (Number.isFinite(sinceMs) && stat.mtimeMs < sinceMs) return { status: "skip" };

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let meta = null;
  const userPrompts = [];
  const skillsSet = new Set();
  const failedCmds = [];
  let totalTools = 0;
  let failedTools = 0;
  let corrections = 0;
  let lastTsMs = stat.mtimeMs;

  for (const line of lines) {
    if (!line.trim()) continue;
    const obj = safeJson(line);
    if (!obj) continue;
    if (obj.timestamp) {
      const ms = Date.parse(obj.timestamp);
      if (Number.isFinite(ms)) lastTsMs = ms;
    }
    if (obj.type === "session_meta" && obj.payload) {
      meta = obj.payload;
      if (meta.id && t3NativeIds.has(String(meta.id))) {
        return { status: "deduped_t3" };
      }
      if (meta.source?.subagent || meta.parent_thread_id) {
        return { status: "noise" };
      }
      if (!pathMatchesCwd(meta.cwd, filterCwdKey)) {
        return { status: "skip" };
      }
    } else if (obj.type === "response_item" && obj.payload?.type === "message" && obj.payload.role === "user") {
      const content = obj.payload.content;
      const text = Array.isArray(content)
        ? content.map((c) => c?.text || "").join("\n")
        : String(content || "");
      for (const s of extractSkillTagsAndTokens(text)) skillsSet.add(s);
      if (text.includes("<skill>") && !stripSystemWrappers(text).replace(/<skill>[\s\S]*?<\/skill>/gi, "").trim()) {
        continue;
      }
      const clean = oneLine(stripSystemWrappers(text), 200);
      if (clean) {
        userPrompts.push(clean);
        if (userPrompts.length > 1 && isCorrectionPrompt(clean)) corrections++;
      }
    } else if (obj.type === "response_item" && obj.payload?.type === "function_call") {
      totalTools++;
    } else if (obj.type === "response_item" && obj.payload?.type === "function_call_output") {
      const out = String(obj.payload.output || "");
      if (/Exit code:\s*[1-9]\d*|Process exited with code [1-9]\d*/i.test(out)) {
        failedTools++;
      }
    }
  }

  if (Number.isFinite(sinceMs) && lastTsMs < sinceMs) return { status: "skip" };
  if (Number.isFinite(untilMs) && lastTsMs > untilMs) return { status: "skip" };
  if (!meta?.id || userPrompts.length === 0) return { status: "noise" };
  if (t3NativeIds.has(String(meta.id))) return { status: "deduped_t3" };

  const skillsUsed = [...skillsSet];
  if (isPureRetroSession(userPrompts, skillsUsed)) return { status: "noise" };

  return {
    status: "kept",
    session: {
      source: "codex",
      sessionId: meta.id,
      filePath,
      title: oneLine(userPrompts[0], 90),
      cwd: meta.cwd || null,
      provider: "codex-cli",
      updatedAt: new Date(lastTsMs).toISOString(),
      humanTurns: userPrompts.length,
      totalTools,
      failedTools,
      corrections,
      interrupts: 0,
      frictionScore: failedTools * 2 + corrections * 3,
      skillsUsed,
      failedCmds,
      userPrompts,
    },
  };
}

function parseClaudeSessionFile(filePath, { sinceMs, untilMs, filterCwdKey, t3NativeIds }) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { status: "skip" };
  }
  if (Number.isFinite(sinceMs) && stat.mtimeMs < sinceMs) return { status: "skip" };

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = null;
  let hasMainRecord = false;
  let lastTsMs = stat.mtimeMs;
  const userPrompts = [];
  const skillsSet = new Set();
  const failedCmds = [];
  const toolCmdById = new Map();
  let totalTools = 0;
  let failedTools = 0;
  let corrections = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const obj = safeJson(line);
    if (!obj) continue;
    if (obj.sessionId) sessionId = String(obj.sessionId);
    if (t3NativeIds.has(sessionId)) return { status: "deduped_t3" };
    if (obj.cwd && !cwd) cwd = obj.cwd;
    if (obj.isSidechain === false) hasMainRecord = true;
    if (obj.timestamp) {
      const ms = Date.parse(obj.timestamp);
      if (Number.isFinite(ms)) lastTsMs = ms;
    }

    if (obj.type === "user" && !obj.isSidechain && obj.message) {
      const content = obj.message.content;
      if (typeof content === "string") {
        for (const s of extractSkillTagsAndTokens(content)) skillsSet.add(s);
        const clean = oneLine(stripSystemWrappers(content), 200);
        if (clean) {
          userPrompts.push(clean);
          if (userPrompts.length > 1 && isCorrectionPrompt(clean)) corrections++;
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result" && block.is_error) {
            failedTools++;
            const head = toolCmdById.get(block.tool_use_id);
            if (head) failedCmds.push(head);
          } else if (block?.type === "text" && block.text) {
            const clean = oneLine(stripSystemWrappers(block.text), 200);
            if (clean) {
              userPrompts.push(clean);
              if (userPrompts.length > 1 && isCorrectionPrompt(clean)) corrections++;
            }
          }
        }
      }
    } else if (obj.type === "assistant" && !obj.isSidechain && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block?.type === "tool_use") {
          totalTools++;
          if (block.name === "Skill" && block.input?.skill) {
            skillsSet.add(String(block.input.skill));
          }
          if (block.id && block.name === "Bash" && block.input?.command) {
            const head = normalizeCmdHead(block.input.command);
            if (head) toolCmdById.set(block.id, head);
          } else if (block.id && SUBAGENT_TOOLS.has(block.name)) {
            toolCmdById.set(block.id, block.name);
          }
        }
      }
    }
  }

  if (!hasMainRecord && userPrompts.length === 0) return { status: "noise" };
  if (!pathMatchesCwd(cwd, filterCwdKey)) return { status: "skip" };
  if (Number.isFinite(sinceMs) && lastTsMs < sinceMs) return { status: "skip" };
  if (Number.isFinite(untilMs) && lastTsMs > untilMs) return { status: "skip" };
  if (t3NativeIds.has(sessionId)) return { status: "deduped_t3" };
  if (userPrompts.length === 0) return { status: "noise" };

  const skillsUsed = [...skillsSet];
  if (isPureRetroSession(userPrompts, skillsUsed)) return { status: "noise" };

  return {
    status: "kept",
    session: {
      source: "claude",
      sessionId,
      filePath,
      title: oneLine(userPrompts[0], 90),
      cwd,
      provider: "claude-cli",
      updatedAt: new Date(lastTsMs).toISOString(),
      humanTurns: userPrompts.length,
      totalTools,
      failedTools,
      corrections,
      interrupts: 0,
      frictionScore: failedTools * 2 + corrections * 3,
      skillsUsed,
      failedCmds,
      userPrompts,
    },
  };
}

export function mineSessions({
  days = 14,
  since = null,
  until = null,
  cwd = null,
  sources = ["t3", "codex", "claude"],
  top = 10,
  t3DbPath = path.join(os.homedir(), ".t3", "userdata", "statev2.sqlite"),
  codexDir = path.join(os.homedir(), ".codex", "sessions"),
  claudeDir = path.join(os.homedir(), ".claude", "projects"),
  nowMs = Date.now(),
} = {}) {
  const untilMs = until ? Date.parse(until) : nowMs;
  const sinceMs = since ? Date.parse(since) : untilMs - days * 86_400_000;
  const windowDays = Math.max(0, Math.round(((untilMs - sinceMs) / 86_400_000) * 10) / 10);
  const filterCwdKey = cwd ? normalizePathKey(cwd) : "";
  const sourceSet = new Set(sources.map((s) => s.trim().toLowerCase()).filter(Boolean));

  // Always collect T3 native IDs when t3DbPath exists so CLI sources can dedupe against T3.
  const t3Res = scanT3Database(t3DbPath, { sinceMs, untilMs, filterCwdKey });
  const t3NativeIds = t3Res.t3NativeIds;

  const stats = {
    t3Kept: 0,
    codexKept: 0,
    claudeKept: 0,
    dedupedByT3: 0,
    droppedNoise: t3Res.droppedNoise,
  };
  let allSessions = [];

  if (sourceSet.has("t3")) {
    allSessions.push(...t3Res.sessions);
    stats.t3Kept = t3Res.sessions.length;
  }
  if (sourceSet.has("codex")) {
    for (const file of walkJsonlFiles(codexDir)) {
      const r = parseCodexSessionFile(file, { sinceMs, untilMs, filterCwdKey, t3NativeIds });
      if (r.status === "deduped_t3") stats.dedupedByT3++;
      else if (r.status === "noise") stats.droppedNoise++;
      else if (r.status === "kept") {
        allSessions.push(r.session);
        stats.codexKept++;
      }
    }
  }
  if (sourceSet.has("claude")) {
    for (const file of walkJsonlFiles(claudeDir)) {
      const r = parseClaudeSessionFile(file, { sinceMs, untilMs, filterCwdKey, t3NativeIds });
      if (r.status === "deduped_t3") stats.dedupedByT3++;
      else if (r.status === "noise") stats.droppedNoise++;
      else if (r.status === "kept") {
        allSessions.push(r.session);
        stats.claudeKept++;
      }
    }
  }

  const skillCounts = new Map();
  const cmdFailClusters = new Map();
  const phraseMap = new Map();

  for (const s of allSessions) {
    for (const sk of s.skillsUsed) {
      skillCounts.set(sk, (skillCounts.get(sk) || 0) + 1);
    }
    for (const cmd of s.failedCmds) {
      const cur = cmdFailClusters.get(cmd) || { command: cmd, count: 0, sessions: new Set() };
      cur.count++;
      cur.sessions.add(s.sessionId);
      cmdFailClusters.set(cmd, cur);
    }
    const seenInSession = new Set();
    for (const p of s.userPrompts) {
      const norm = normalizePhrase(p);
      if (!norm || seenInSession.has(norm)) continue;
      seenInSession.add(norm);
      const cur = phraseMap.get(norm) || { sample: p, sessions: new Set() };
      cur.sessions.add(s.sessionId);
      phraseMap.set(norm, cur);
    }
  }

  const repeatedPhrases = [...phraseMap.values()]
    .filter((v) => v.sessions.size >= 2)
    .sort((a, b) => b.sessions.size - a.sessions.size)
    .slice(0, 15)
    .map((v) => ({ sample: v.sample, sessionCount: v.sessions.size, sessions: [...v.sessions].slice(0, 8) }));

  const repeatedFailures = [...cmdFailClusters.values()]
    .filter((v) => v.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map((v) => ({ command: v.command, count: v.count, sessions: [...v.sessions].slice(0, 8) }));

  const topFrictionSessions = [...allSessions]
    .filter((s) => s.frictionScore > 0 || s.humanTurns >= 4)
    .sort((a, b) => b.frictionScore - a.frictionScore || b.humanTurns - a.humanTurns)
    .slice(0, top)
    .map((s) => ({
      source: s.source,
      sessionId: s.sessionId,
      filePath: s.filePath || null,
      title: s.title,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
      frictionScore: s.frictionScore,
      humanTurns: s.humanTurns,
      failedTools: s.failedTools,
      corrections: s.corrections,
      interrupts: s.interrupts,
      skillsUsed: s.skillsUsed,
    }));

  const windowSufficientForDisuse = allSessions.length >= 20 && windowDays >= 7 && !filterCwdKey;
  const disuseReason = windowSufficientForDisuse
    ? null
    : `Window too narrow to propose skill retirement (kept=${allSessions.length}, days=${windowDays}${filterCwdKey ? ", scoped to cwd" : ""})`;

  return {
    window: {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      days: windowDays,
      cwd: cwd || null,
      sources: [...sourceSet],
    },
    counts: {
      totalKept: allSessions.length,
      ...stats,
    },
    disuseEvidence: {
      sufficient: windowSufficientForDisuse,
      reason: disuseReason,
    },
    skillUsage: [...skillCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, sessions]) => ({ name, sessions })),
    repeatedFailures,
    repeatedPhrases,
    topFrictionSessions,
  };
}

function formatMarkdown(res) {
  const lines = [
    "# Multi-Session Pre-Scan Summary",
    "",
    `- Window: \`${res.window.since}\` .. \`${res.window.until}\` (${res.window.days}d, sources: ${res.window.sources.join(", ")})`,
    `- Scope CWD: ${res.window.cwd ? `\`${res.window.cwd}\`` : "all projects"}`,
    `- Kept sessions: **${res.counts.totalKept}** (T3: ${res.counts.t3Kept}, Codex: ${res.counts.codexKept}, Claude: ${res.counts.claudeKept}) | Deduped by T3: ${res.counts.dedupedByT3} | Filtered noise: ${res.counts.droppedNoise}`,
    `- Disuse retirement allowed: \`${res.disuseEvidence.sufficient}\`${res.disuseEvidence.reason ? ` (${res.disuseEvidence.reason})` : ""}`,
    "",
    `## Top High-Friction Sessions (${res.topFrictionSessions.length})`,
  ];
  for (const s of res.topFrictionSessions) {
    lines.push(
      `- [${s.source}] \`${s.sessionId}\` (score=${s.frictionScore}, turns=${s.humanTurns}, fails=${s.failedTools}, corr=${s.corrections}, int=${s.interrupts}) — ${s.title}${s.cwd ? ` (\`${s.cwd}\`)` : ""}`
    );
  }
  lines.push("", `## Repeated Command Failures (${res.repeatedFailures.length})`);
  for (const f of res.repeatedFailures) {
    lines.push(`- \`${f.command}\`: ${f.count} hits across ${f.sessions.length} session(s)`);
  }
  lines.push("", `## Repeated Human Phrases (${res.repeatedPhrases.length})`);
  for (const p of res.repeatedPhrases) {
    lines.push(`- (${p.sessionCount} sessions) "${p.sample}"`);
  }
  lines.push("", `## Observed Skill Usage (${res.skillUsage.length})`);
  for (const sk of res.skillUsage.slice(0, 20)) {
    lines.push(`- \`${sk.name}\`: ${sk.sessions} session(s)`);
  }
  return `${lines.join("\n")}\n`;
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") opts.days = Number(argv[++i]);
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--until") opts.until = argv[++i];
    else if (a === "--cwd") opts.cwd = argv[++i];
    else if (a === "--sources") opts.sources = argv[++i].split(",");
    else if (a === "--top") opts.top = Number(argv[++i]);
    else if (a === "--t3-db") opts.t3DbPath = argv[++i];
    else if (a === "--codex-dir") opts.codexDir = argv[++i];
    else if (a === "--claude-dir") opts.claudeDir = argv[++i];
    else if (a === "--format") opts.format = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: mine-sessions.mjs [--days 14] [--cwd <dir>] [--sources t3,codex,claude] [--top 10] [--format md|json]");
    return;
  }
  const res = mineSessions(opts);
  if (opts.format === "json") console.log(JSON.stringify(res, null, 2));
  else process.stdout.write(formatMarkdown(res));
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main();
  } catch (err) {
    console.error(`mine-sessions: ${err.message}`);
    process.exit(1);
  }
}
