#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const RETRO_SKILL_NAMES = new Set(["yjx-retro", "yjx-retro-skill"]);
const RUN_OUTCOME_FOLLOWING_RUNS = 3;

function oneLine(text, max) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Drop a leading shell launcher (e.g. "C:\...\pwsh.exe" -Command, bash -lc) so previews show the actual command.
function stripShellWrapper(cmd) {
  return String(cmd ?? "").replace(
    /^\s*(?:"(?:[^"]*[\\/])?(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?"|(?:[^"\s]*[\\/])?(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?)\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c|\/c)\s+/i,
    ""
  );
}

// $name tokens in user messages are skill references (T3 stores user-picked skills this way).
// Whether a token is an invocation or a mention is a semantic call left to the model.
function extractSkillTokens(text) {
  if (!text) return [];
  const names = [];
  const re = /(?:^|[^\w$])\$([a-z][a-z0-9]*(?:[-_:.][a-z0-9]+)*)(?![\w-])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

const WRITE_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
const SKILL_PATH_RE = /[A-Za-z0-9_./\\:-]*skills[\\/][A-Za-z0-9_./\\:-]*\.md/gi;

function classifySkillFileAccess(toolName, cmdText) {
  const ops = extractSkillFileOps(toolName, cmdText);
  return ops.writes.length > 0 ? "write" : "read";
}

function buildRunOutcomes(runs, startIndex, endIndexExclusive) {
  const out = [];
  const end = Math.min(endIndexExclusive, startIndex + 1 + RUN_OUTCOME_FOLLOWING_RUNS);
  for (let i = startIndex; i < end; i++) {
    const r = runs[i];
    out.push({
      run: r.run,
      status: r.status || null,
      tools: r.tools,
      assistantOutput: r.assistantMessages > 0,
      aborts: r.aborts,
      userPreview: i === startIndex ? null : r.userPreview,
      lastAssistantPreview: r.lastAssistant ? oneLine(r.lastAssistant, 160) : null,
    });
  }
  return out;
}

function parseOrdinalArg(name, value) {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n)) {
    throw new Error(`${name} requires an integer ordinal`);
  }
  return n;
}

function printHelp() {
  console.log(`Usage:
  node extract-session-evidence.mjs --session-id <thread-or-session-id> [options]
  node extract-session-evidence.mjs --file <rollout.jsonl> [--file <rollout2.jsonl> ...] [options]
  node extract-session-evidence.mjs --item-id <turn-item-id> [--item-id <id2> ...] [--session-id <id>] [options]
  node extract-session-evidence.mjs --cleanup <temp-evidence-path>

Options:
  --session-id <id>       Locate T3 thread in <t3-db> or rollout-*.jsonl files under <codex-home>/sessions
                          (defaults to $T3CODE_THREAD_ID or $CODEX_THREAD_ID when no --file is given)
  --file <path>           Explicit JSONL file path (can be specified multiple times)
  --codex-home <dir>      Codex home directory (default: $CODEX_HOME or ~/.codex)
  --t3-home <dir>         T3 Code home directory (default: $T3CODE_HOME or ~/.t3)
  --t3-db <path>          Explicit T3 statev2.sqlite path (default: <t3-home>/userdata/statev2.sqlite)
  --until-ordinal <n>     Exclude records with ordinal > <n> (fix retro cutoff point before the current call)
  --since-ordinal <n>     Exclude records with ordinal < <n> (start of a repeated retro range; session_meta is still read)
  --since-time <ISO>      Inclusive cross-thread evidence start (otherwise derived from the parent's range)
  --until-time <ISO>      Exclusive cross-thread evidence cutoff; never reuse parent ordinals in children
  --subagents-only        Output only compact child evidence, reusing the parent's existing context
  --preflight             Read only session metadata, compaction/handoff markers and yjx-retro / yjx-retro-skill invocations,
                           then print the review range start and routing decision; each earlier invocation
                           carries runOutcomes (its run plus up to 3 following runs: status, tool count,
                           assistant output, last reply preview) for judging whether it delivered
  --item-id <id>          Fetch full un-truncated JSON record(s) for one or more T3 turn_item_id values (repeatable)
  --format <json|md>      Output format: json (default) or md
  --output <path>         Write output to file instead of stdout
  --cleanup <path>        Remove a temporary retro* evidence file inside the system temp directory
  --help, -h              Show this help message
`);
}

function parseArgs(argv) {
  const opts = {
    sessionId: null,
    files: [],
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    t3Home: process.env.T3CODE_HOME || path.join(os.homedir(), ".t3"),
    t3Db: null,
    untilOrdinal: null,
    sinceOrdinal: null,
    sinceTime: null,
    untilTime: null,
    subagentsOnly: false,
    preflight: false,
    itemIds: [],
    format: "json",
    output: null,
    cleanupPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--session-id") {
      opts.sessionId = argv[++i];
    } else if (arg === "--file") {
      opts.files.push(argv[++i]);
    } else if (arg === "--codex-home") {
      opts.codexHome = argv[++i];
    } else if (arg === "--t3-home") {
      opts.t3Home = argv[++i];
    } else if (arg === "--t3-db") {
      opts.t3Db = argv[++i];
    } else if (arg === "--until-ordinal") {
      opts.untilOrdinal = parseOrdinalArg(arg, argv[++i]);
    } else if (arg === "--since-ordinal") {
      opts.sinceOrdinal = parseOrdinalArg(arg, argv[++i]);
    } else if (arg === "--since-time" || arg === "--until-time") {
      const value = argv[++i];
      if (!value || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
        throw new Error(`${arg} requires an ISO timestamp with timezone`);
      }
      opts[arg === "--since-time" ? "sinceTime" : "untilTime"] = new Date(value).toISOString();
    } else if (arg === "--subagents-only") {
      opts.subagentsOnly = true;
    } else if (arg === "--preflight") {
      opts.preflight = true;
    } else if (arg === "--item-id") {
      const value = argv[++i];
      if (!value) throw new Error("--item-id requires a turn_item_id value");
      opts.itemIds.push(value);
    } else if (arg === "--format") {
      opts.format = argv[++i];
    } else if (arg === "--output") {
      opts.output = argv[++i];
    } else if (arg === "--cleanup") {
      const value = argv[++i];
      if (!value) throw new Error("--cleanup requires a file path");
      opts.cleanupPath = value;
    } else if (!arg.startsWith("-")) {
      opts.files.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.t3Db) {
    opts.t3Db = path.join(opts.t3Home, "userdata", "statev2.sqlite");
  }
  if (opts.sinceTime && opts.untilTime && opts.sinceTime >= opts.untilTime) {
    throw new Error("--since-time must precede --until-time");
  }
  return opts;
}

// Dispatch text is only a candidate marker. A child ID must come from a paired
// structured result or the host's explicit subagent relation, never from quoted code.
function isAgentDispatch(name, input = "") {
  return /(?:^|[_.])(?:spawn_agent|delegate_task|Agent|Task)$/.test(name || "") ||
    /\btools\.(?:multi_agent_v1__spawn_agent|mcp__t3_code_direct__delegate_task)\s*\(/.test(input);
}

function isAgentControl(name, input = "") {
  return /(?:^|[_.])(?:send_input|wait_agent|resume_agent|close_agent)$/.test(name || "") ||
    /\btools\.multi_agent_v1__(?:send_input|wait_agent|resume_agent|close_agent)\s*\(/.test(input);
}

export async function preflightFiles(filePaths, opts = {}) {
  const untilOrdinal = opts.untilOrdinal ?? null;
  const files = [];
  const compactions = [];
  const retroByOrdinal = new Map();
  const retroWithoutOrdinal = [];
  const subagentMarkers = [];
  let sessionMeta = null;
  let pendingHumanPreview = null;
  let lastRetroEntry = null;
  const turns = [];
  let currentTurn = null;
  const turnIndexByEntry = new Map();
  const registerRetro = (inv) => {
    lastRetroEntry = inv;
    if (currentTurn) turnIndexByEntry.set(inv, currentTurn.index);
  };

  for (let fIdx = 0; fIdx < filePaths.length; fIdx++) {
    const filePath = path.resolve(filePaths[fIdx]);
    const tag = `F${fIdx + 1}`;
    let lineNo = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const ord = typeof obj.ordinal === "number" ? obj.ordinal : null;
      if (untilOrdinal !== null && ord !== null && ord > untilOrdinal) continue;

      const payload = obj.payload || {};
      if (obj.type === "response_item" &&
          (payload.type === "function_call" || payload.type === "custom_tool_call") &&
          (isAgentDispatch(payload.name, typeof payload.input === "string" ? payload.input : payload.arguments || "") ||
           isAgentControl(payload.name, typeof payload.input === "string" ? payload.input : payload.arguments || ""))) {
        subagentMarkers.push({ location: `${tag}:L${lineNo}`, ordinal: ord, timestamp: obj.timestamp || null });
      }
      if (obj.type === "session_meta" && payload) {
        sessionMeta ??= {
          id: payload.id || payload.session_id || null,
          cwd: payload.cwd || null,
          forkedFromId: payload.forked_from_id || null,
          forkedFromOrdinalExclusive: payload.forked_from_ordinal_exclusive ?? null,
        };
      }
      if (obj.type === "compacted") {
        compactions.push({
          location: `${tag}:L${lineNo}`,
          ordinal: ord,
          timestamp: obj.timestamp || null,
          windowNumber: payload.window_number ?? null,
        });
      }
      if (obj.type === "event_msg" && payload.type === "task_started") {
        currentTurn = {
          index: turns.length,
          run: turns.length + 1,
          status: "running",
          tools: 0,
          assistantMessages: 0,
          aborts: 0,
          userPreview: null,
          lastAssistant: null,
        };
        turns.push(currentTurn);
      } else if (obj.type === "event_msg" && payload.type === "task_complete" && currentTurn) {
        currentTurn.status = "completed";
        if (typeof payload.last_agent_message === "string" && payload.last_agent_message.trim()) {
          currentTurn.lastAssistant = payload.last_agent_message.trim();
        }
      } else if (obj.type === "event_msg" && payload.type === "turn_aborted" && currentTurn) {
        currentTurn.status = "interrupted";
        currentTurn.aborts++;
      } else if (
        obj.type === "response_item" &&
        (payload.type === "function_call" || payload.type === "custom_tool_call") &&
        currentTurn
      ) {
        currentTurn.tools++;
      }
      if (
        obj.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "assistant" &&
        currentTurn
      ) {
        const aText = extractContentText(payload.content).trim();
        if (aText) {
          currentTurn.assistantMessages++;
          currentTurn.lastAssistant = aText;
        }
      }
      if (
        obj.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "user"
      ) {
        const rawText = extractContentText(payload.content);
        const cls = classifyUserMessage(rawText);
        if (cls.kind === "skill_injection" && RETRO_SKILL_NAMES.has(cls.name)) {
          const inv = {
            location: `${tag}:L${lineNo}`,
            ordinal: ord,
            timestamp: obj.timestamp || null,
            userPreview: pendingHumanPreview,
            assistantPreview: null,
          };
          registerRetro(inv);
          if (ord === null) retroWithoutOrdinal.push(inv);
          else if (!retroByOrdinal.has(ord)) retroByOrdinal.set(ord, inv);
        } else if (cls.kind === "human") {
          pendingHumanPreview = cls.cleanText.slice(0, 240);
          if (currentTurn && currentTurn.userPreview === null) {
            currentTurn.userPreview = oneLine(cls.cleanText, 60);
          }
          if (isRetroInvocationText(rawText)) {
            const inv = {
              location: `${tag}:L${lineNo}`,
              ordinal: ord,
              timestamp: obj.timestamp || null,
              userPreview: pendingHumanPreview,
              assistantPreview: null,
            };
            registerRetro(inv);
            if (ord === null) retroWithoutOrdinal.push(inv);
            else if (!retroByOrdinal.has(ord)) retroByOrdinal.set(ord, inv);
          }
        }
      } else if (
        obj.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "assistant" &&
        lastRetroEntry &&
        !lastRetroEntry.assistantPreview
      ) {
        const aText = extractContentText(payload.content).trim();
        if (aText) lastRetroEntry.assistantPreview = aText.slice(0, 240);
      }
    }

    files.push({ path: filePath, tag });
  }

  const retroInvocations = [...retroByOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  // One invocation can leave several candidates in the same turn (the `$skill` message plus the
  // injected <skill> body); all of them belong to the current call, never to a previous retro.
  const lastCandidate = untilOrdinal === null ? retroInvocations[retroInvocations.length - 1] ?? null : null;
  const lastTurnIndex = lastCandidate ? turnIndexByEntry.get(lastCandidate) : undefined;
  const isCurrentInvocation = (inv) =>
    Boolean(lastCandidate) &&
    (inv === lastCandidate || (lastTurnIndex !== undefined && turnIndexByEntry.get(inv) === lastTurnIndex));
  const currentRetro = retroInvocations.find(isCurrentInvocation) ?? null;
  retroInvocations.forEach((inv, idx) => {
    if (isCurrentInvocation(inv) || !turnIndexByEntry.has(inv)) return;
    const startIndex = turnIndexByEntry.get(inv);
    let endIndex = turns.length;
    for (const later of retroInvocations.slice(idx + 1)) {
      const laterIndex = turnIndexByEntry.get(later);
      if (laterIndex !== undefined && laterIndex > startIndex) {
        endIndex = laterIndex;
        break;
      }
    }
    inv.runOutcomes = buildRunOutcomes(turns, startIndex, endIndex);
  });
  const previousRetros = retroInvocations.filter((inv) => !isCurrentInvocation(inv));
  const previousRetro = previousRetros[previousRetros.length - 1] ?? null;
  const rangeStartOrdinal = opts.sinceOrdinal ?? (previousRetro ? previousRetro.ordinal : null);
  const rangeCompactions = compactions.filter(
    (c) => rangeStartOrdinal === null || c.ordinal === null || c.ordinal > rangeStartOrdinal
  );

  return {
    route: rangeCompactions.length > 0 ? "full" : "fast",
    subagentEvidenceRequired: subagentMarkers.length > 0,
    subagentCandidates: subagentMarkers,
    rangeStartOrdinal,
    previousRetro,
    currentRetro,
    retroInvocations,
    retroInvocationsWithoutOrdinal: retroWithoutOrdinal,
    rangeCompactions,
    compactions,
    rangeHandoffs: [],
    handoffs: [],
    forkedFrom: sessionMeta
      ? {
          id: sessionMeta.forkedFromId,
          ordinalExclusive: sessionMeta.forkedFromOrdinalExclusive,
        }
      : null,
    files,
    cutoffOrdinal: untilOrdinal,
    rule: "rangeStartOrdinal defaults to the latest retro candidate from an earlier turn (session start if none) and is unconfirmed: confirm the last delivered retro from userPreview/assistantPreview/runOutcomes and rerun with --since-ordinal if it differs; candidates in the current call's turn belong to the current call; compaction inside the range selects full; Forked From is informational only",
  };
}
function normalizeT3ThreadId(rawId) {
  if (!rawId) return null;
  const trimmed = String(rawId).trim();
  return trimmed.startsWith("thread_") ? trimmed.slice("thread_".length) : trimmed;
}

function safeJsonParse(raw, fallback = {}) {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function isRetroInvocationText(text) {
  if (!text || typeof text !== "string") return false;
  const cls = classifyUserMessage(text);
  if (cls.kind === "skill_injection" && RETRO_SKILL_NAMES.has(cls.name)) {
    return true;
  }
  if (cls.kind === "human") {
    return /(?:^|\s|\$|\/|\[)(?:yjx-retro-skill|yjx-retro)(?![\w-])/i.test(cls.cleanText);
  }
  return false;
}

function decodeT3Citations(text) {
  if (!text || typeof text !== "string" || !text.includes("t3-citation://")) {
    return [];
  }
  const citations = [];
  const re = /\[([^\]]*)\]\((t3-citation:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const label = m[1];
    const rawUrl = m[2];
    try {
      const u = new URL(rawUrl);
      const quotedText = u.searchParams.get("text");
      const comment = u.searchParams.get("comment");
      citations.push({
        label,
        quotedText: quotedText || null,
        comment: comment || null,
      });
    } catch {
      continue;
    }
  }
  return citations;
}

function isCrossContextHandoff(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.title === "Fork context") return false;
  return true;
}

function safeDecodeURIComponent(str) {
  if (typeof str !== "string") return "";
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function parseScheduledTaskMessage(turnItemId, payload) {
  const decodedId = safeDecodeURIComponent(turnItemId || "");
  const m = decodedId.match(
    /^turn-item:message:scheduled-task-message:(.+):(\d+):(scheduled|manual)$/
  );
  const payloadTaskId =
    payload && typeof payload.scheduledTaskId === "string" && payload.scheduledTaskId
      ? payload.scheduledTaskId
      : null;
  if (!m && !payloadTaskId) return null;
  const scheduledTaskId = m ? m[1] : payloadTaskId;
  const triggerAtMs = m ? Number(m[2]) : null;
  const modeSuffix = m ? m[3] : null;
  return {
    scheduledTaskId,
    triggerKind: modeSuffix === "manual" ? "scheduled-manual" : "scheduled",
    triggerMode: modeSuffix || "scheduled",
    triggerAtMs: Number.isFinite(triggerAtMs) ? triggerAtMs : null,
  };
}

function loadT3ScheduledTasks(db, threadId) {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'")
    .get();
  if (!hasTable) return new Map();
  const rows = db
    .prepare("SELECT * FROM scheduled_tasks WHERE thread_id = ?")
    .all(threadId);
  const map = new Map();
  for (const r of rows) {
    if (!r.task_id) continue;
    map.set(r.task_id, {
      scheduledTaskId: r.task_id,
      title: r.title || null,
      threadMode: r.thread_mode || null,
      schedule: safeJsonParse(r.schedule_json, null),
      enabled: r.enabled !== undefined && r.enabled !== null ? Boolean(r.enabled) : null,
      lastRunStatus: r.last_run_status || null,
    });
  }
  return map;
}

function loadT3ChildThreadStats(db, childThreadId) {
  if (!childThreadId) return { childItemCount: 0, childFailedCount: 0 };
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM orchestration_v2_projection_turn_items WHERE thread_id = ?"
    )
    .get(childThreadId);
  return {
    childItemCount: Number(row?.total) || 0,
    childFailedCount: Number(row?.failed) || 0,
  };
}

function loadT3ThreadItems(db, threadId) {
  const hasPositions = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_turn_item_positions'"
    )
    .get();
  if (hasPositions) {
    const rows = db
      .prepare(
        `SELECT ti.turn_item_id, ti.run_id, ti.provider_thread_id, ti.ordinal, ti.type, ti.status, ti.updated_at, ti.payload_json, p.ordinal AS pos_ordinal
         FROM orchestration_v2_projection_turn_items ti
         LEFT JOIN orchestration_v2_turn_item_positions p
           ON p.thread_id = ti.thread_id AND p.turn_item_id = ti.turn_item_id
         WHERE ti.thread_id = ?
         ORDER BY COALESCE(p.ordinal, ti.ordinal), ti.ordinal`
      )
      .all(threadId);
    return rows.map((r, idx) => ({ ...r, position: idx }));
  }
  const rows = db
    .prepare(
      `SELECT turn_item_id, run_id, provider_thread_id, ordinal, type, status, updated_at, payload_json
       FROM orchestration_v2_projection_turn_items
       WHERE thread_id = ?
       ORDER BY ordinal`
    )
    .all(threadId);
  return rows.map((r, idx) => ({ ...r, position: idx }));
}

export function hasT3Thread(dbPath, rawThreadId) {
  const threadId = normalizeT3ThreadId(rawThreadId);
  if (!threadId || !dbPath || !fs.existsSync(dbPath)) return false;
  let db;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const row = db
      .prepare("SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ?")
      .get(threadId);
    return Boolean(row);
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function lookupT3Item(dbPath, itemId, rawThreadId = null) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`T3 database not found: ${dbPath}`);
  }
  const threadId = normalizeT3ThreadId(rawThreadId);
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const row = threadId
      ? db
          .prepare(
            "SELECT thread_id, turn_item_id, run_id, provider_thread_id, ordinal, type, status, updated_at, payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ? AND thread_id = ?"
          )
          .get(itemId, threadId)
      : db
          .prepare(
            "SELECT thread_id, turn_item_id, run_id, provider_thread_id, ordinal, type, status, updated_at, payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ?"
          )
          .get(itemId);
    if (!row) {
      throw new Error(`Turn item not found in T3 database: ${itemId}`);
    }
    return {
      threadId: row.thread_id,
      itemId: row.turn_item_id,
      runId: row.run_id,
      providerThreadId: row.provider_thread_id,
      ordinal: row.ordinal,
      type: row.type,
      status: row.status,
      updatedAt: row.updated_at,
      payload: safeJsonParse(row.payload_json, null),
    };
  } finally {
    db.close();
  }
}

export function lookupT3Items(dbPath, itemIds, rawThreadId = null) {
  const uniqueIds = [];
  for (const id of itemIds || []) {
    if (id && !uniqueIds.includes(id)) uniqueIds.push(id);
  }
  if (uniqueIds.length === 0) return [];
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`T3 database not found: ${dbPath}`);
  }
  const threadId = normalizeT3ThreadId(rawThreadId);
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const sql = threadId
      ? `SELECT thread_id, turn_item_id, run_id, provider_thread_id, ordinal, type, status, updated_at, payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id IN (${placeholders}) AND thread_id = ?`
      : `SELECT thread_id, turn_item_id, run_id, provider_thread_id, ordinal, type, status, updated_at, payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id IN (${placeholders})`;
    const rows = threadId ? db.prepare(sql).all(...uniqueIds, threadId) : db.prepare(sql).all(...uniqueIds);
    const byId = new Map(rows.map((r) => [r.turn_item_id, r]));
    const missing = uniqueIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new Error(`Turn item(s) not found in T3 database: ${missing.join(", ")}`);
    }
    return uniqueIds.map((id) => {
      const row = byId.get(id);
      return {
        threadId: row.thread_id,
        itemId: row.turn_item_id,
        runId: row.run_id,
        providerThreadId: row.provider_thread_id,
        ordinal: row.ordinal,
        type: row.type,
        status: row.status,
        updatedAt: row.updated_at,
        payload: safeJsonParse(row.payload_json, null),
      };
    });
  } finally {
    db.close();
  }
}

export function cleanupTempEvidenceFile(targetPath) {
  if (!targetPath) throw new Error("--cleanup requires a file path");
  const resolved = path.resolve(targetPath);
  const allowedRoots = [fs.realpathSync(os.tmpdir())];
  try {
    const tmpReal = fs.realpathSync("/tmp");
    if (!allowedRoots.includes(tmpReal)) allowedRoots.push(tmpReal);
  } catch {}
  const baseName = path.basename(resolved);
  if (!/^retro[-_A-Za-z0-9.]*\.(?:md|json)$/i.test(baseName)) {
    throw new Error(`Refusing to cleanup non-retro file name: ${baseName}`);
  }
  const parentDir = path.dirname(resolved);
  let parentReal;
  try {
    parentReal = fs.realpathSync(parentDir);
  } catch {
    parentReal = parentDir;
  }
  const insideAllowedTmp = allowedRoots.some(
    (root) => parentReal === root || parentReal.startsWith(root + path.sep)
  );
  if (!insideAllowedTmp) {
    throw new Error(`Refusing to cleanup file outside system temp directory: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) {
    return { cleaned: false, reason: "not-found", path: resolved };
  }
  const st = fs.lstatSync(resolved);
  if (!st.isFile()) {
    throw new Error(`Refusing to cleanup non-regular file (symlink/directory): ${resolved}`);
  }
  fs.unlinkSync(resolved);
  return { cleaned: true, path: resolved };
}

export function preflightT3Thread(dbPath, rawThreadId, opts = {}) {
  const threadId = normalizeT3ThreadId(rawThreadId);
  const untilOrdinal = opts.untilOrdinal ?? null;
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const threadRow = db
      .prepare("SELECT thread_id, title, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?")
      .get(threadId);
    if (!threadRow) {
      throw new Error(`T3 thread not found: ${threadId}`);
    }
    const threadPayload = safeJsonParse(threadRow.payload_json);
    const items = loadT3ThreadItems(db, threadId);
    const scheduledTasksMap = loadT3ScheduledTasks(db, threadId);

    const compactions = [];
    const handoffs = [];
    const retroByOrdinal = new Map();
    const subagentMarkers = [];
    let activeRetroCandidate = null;
    const preRunStats = new Map();
    const statsFor = (runId) => {
      if (!runId) return null;
      let rs = preRunStats.get(runId);
      if (!rs) {
        rs = { tools: 0, assistantMessages: 0, aborts: 0, userPreview: null, lastAssistant: null };
        preRunStats.set(runId, rs);
      }
      return rs;
    };

    for (const item of items) {
      const ord = typeof item.ordinal === "number" ? item.ordinal : null;
      if (untilOrdinal !== null && ord !== null && ord > untilOrdinal) continue;
      const loc = `T3:pos=${item.position}`;
      const payload = safeJsonParse(item.payload_json);
      if (item.type === "subagent" ||
          (item.type === "dynamic_tool" && (isAgentDispatch(payload.toolName, typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input || "")) ||
           isAgentControl(payload.toolName, typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input || ""))))) {
        subagentMarkers.push({ location: loc, ordinal: ord, timestamp: payload.startedAt || null, childThreadId: payload.childThreadId || null });
      }
      const rs = statsFor(item.run_id);
      if (rs) {
        if (
          (item.type === "command_execution" || item.type === "dynamic_tool") &&
          !item.turn_item_id.includes("workspace-preparation")
        ) {
          rs.tools++;
        } else if (item.type === "run_interrupt_request" || item.type === "error") {
          rs.aborts++;
        } else if (item.type === "assistant_message") {
          const aText = typeof payload.text === "string" ? payload.text.trim() : "";
          if (aText) {
            rs.assistantMessages++;
            rs.lastAssistant = aText;
          }
        } else if (item.type === "user_message" && rs.userPreview === null) {
          const uText = typeof payload.text === "string" ? payload.text : "";
          const uCls = classifyUserMessage(uText);
          if (uCls.kind === "human") rs.userPreview = oneLine(uCls.cleanText, 60);
        }
      }

      if (item.type === "compaction") {
        compactions.push({
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          timestamp: payload.completedAt || payload.startedAt || item.updated_at || null,
          driver: payload.driver || null,
          status: item.status || payload.status || null,
        });
      } else if (item.type === "handoff" && isCrossContextHandoff(payload)) {
        handoffs.push({
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          timestamp: payload.completedAt || payload.startedAt || item.updated_at || null,
          title: payload.title || null,
          strategy: payload.strategy || null,
          fromProviderInstanceIds: payload.fromProviderInstanceIds || [],
          toProviderInstanceId: payload.toProviderInstanceId || null,
        });
      } else if (item.type === "user_message") {
        activeRetroCandidate = null;
        const schedInfo = parseScheduledTaskMessage(item.turn_item_id, payload);
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!schedInfo && isRetroInvocationText(text) && ord !== null && !retroByOrdinal.has(ord)) {
          const cls = classifyUserMessage(text);
          const clean = cls.kind === "human" ? cls.cleanText : text.trim();
          const entry = {
            location: loc,
            itemId: item.turn_item_id,
            runId: item.run_id || null,
            ordinal: ord,
            timestamp: payload.startedAt || item.updated_at || null,
            userPreview: clean.slice(0, 240),
            assistantPreview: null,
          };
          retroByOrdinal.set(ord, entry);
          activeRetroCandidate = entry;
        }
      } else if (
        item.type === "assistant_message" &&
        activeRetroCandidate &&
        !activeRetroCandidate.assistantPreview &&
        (!activeRetroCandidate.runId || item.run_id === activeRetroCandidate.runId)
      ) {
        const aText = typeof payload.text === "string" ? payload.text.trim() : "";
        if (aText) activeRetroCandidate.assistantPreview = aText.slice(0, 240);
      }
    }

    const retroInvocations = [...retroByOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
    // One invocation can leave several candidate messages in the same run (e.g. `$skill` plus its
    // arguments); all of them belong to the current call, never to a previous retro.
    const lastCandidate =
      untilOrdinal === null ? retroInvocations[retroInvocations.length - 1] ?? null : null;
    const isCurrentInvocation = (inv) =>
      Boolean(lastCandidate) &&
      (inv === lastCandidate || (Boolean(lastCandidate.runId) && inv.runId === lastCandidate.runId));
    const currentRetro = retroInvocations.find(isCurrentInvocation) ?? null;
    const previousRetros = retroInvocations.filter((inv) => !isCurrentInvocation(inv));
    const previousRetro = previousRetros[previousRetros.length - 1] ?? null;
    const rangeStartOrdinal = opts.sinceOrdinal ?? (previousRetro ? previousRetro.ordinal : null);
    const effectiveEndOrdinal =
      untilOrdinal !== null
        ? untilOrdinal
        : currentRetro && currentRetro.ordinal !== null
        ? currentRetro.ordinal - 1
        : null;

    const inReviewRange = (ord) => {
      if (ord === null) return true;
      if (rangeStartOrdinal !== null && ord <= rangeStartOrdinal) return false;
      if (effectiveEndOrdinal !== null && ord > effectiveEndOrdinal) return false;
      return true;
    };

    const rangeCompactions = compactions.filter((c) => inReviewRange(c.ordinal));
    const rangeHandoffs = handoffs.filter((h) => inReviewRange(h.ordinal));

    const rangeProviderThreads = new Set();
    const rangeProviders = new Set();
    const rangeFreshContextRuns = [];
    const seenFreshRunIds = new Set();
    const rangeScheduledByTask = new Map();
    let rangeScheduledTaskCount = 0;
    let rangeHumanInputCount = 0;

    const runs = db
      .prepare(
        "SELECT run_id, ordinal, provider_instance_id, provider_thread_id, status, payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal"
      )
      .all(threadId)
      .map((r) => {
        const rp = safeJsonParse(r.payload_json);
        return {
          ...r,
          freshContext: Boolean(rp.freshContext),
        };
      });
    const runById = new Map(runs.map((r) => [r.run_id, r]));

    const outcomeRuns = runs
      .filter((r) => preRunStats.has(r.run_id))
      .map((r) => {
        const st = preRunStats.get(r.run_id);
        return {
          runId: r.run_id,
          run: r.ordinal,
          status: r.status || null,
          tools: st.tools,
          assistantMessages: st.assistantMessages,
          aborts: st.aborts,
          userPreview: st.userPreview,
          lastAssistant: st.lastAssistant,
        };
      });
    const runIndexById = new Map(outcomeRuns.map((r, idx) => [r.runId, idx]));
    retroInvocations.forEach((inv, idx) => {
      if (isCurrentInvocation(inv) || !runIndexById.has(inv.runId)) return;
      const startIndex = runIndexById.get(inv.runId);
      let endIndex = outcomeRuns.length;
      for (const later of retroInvocations.slice(idx + 1)) {
        const laterIndex = runIndexById.get(later.runId);
        if (laterIndex !== undefined && laterIndex > startIndex) {
          endIndex = laterIndex;
          break;
        }
      }
      inv.runOutcomes = buildRunOutcomes(outcomeRuns, startIndex, endIndex);
    });
    for (const item of items) {
      const ord = typeof item.ordinal === "number" ? item.ordinal : null;
      if (!inReviewRange(ord)) continue;
      if (item.provider_thread_id) rangeProviderThreads.add(item.provider_thread_id);
      const run = item.run_id ? runById.get(item.run_id) : null;
      if (run?.provider_instance_id) rangeProviders.add(run.provider_instance_id);
      if (run && run.freshContext && !seenFreshRunIds.has(run.run_id)) {
        seenFreshRunIds.add(run.run_id);
        rangeFreshContextRuns.push({
          runId: run.run_id,
          runOrdinal: run.ordinal,
          providerInstanceId: run.provider_instance_id || null,
          providerThreadId: run.provider_thread_id || null,
        });
      }
      if (item.type === "user_message") {
        const payload = safeJsonParse(item.payload_json);
        const schedInfo = parseScheduledTaskMessage(item.turn_item_id, payload);
        if (schedInfo) {
          rangeScheduledTaskCount++;
          let entry = rangeScheduledByTask.get(schedInfo.scheduledTaskId);
          if (!entry) {
            const meta = scheduledTasksMap.get(schedInfo.scheduledTaskId);
            entry = {
              scheduledTaskId: schedInfo.scheduledTaskId,
              title: meta?.title || null,
              threadMode: meta?.threadMode || null,
              scheduledCount: 0,
              manualCount: 0,
            };
            rangeScheduledByTask.set(schedInfo.scheduledTaskId, entry);
          }
          if (schedInfo.triggerKind === "scheduled-manual") entry.manualCount++;
          else entry.scheduledCount++;
        } else {
          const text = typeof payload.text === "string" ? payload.text : "";
          const cls = classifyUserMessage(text);
          if (cls.kind === "human") rangeHumanInputCount++;
        }
      }
    }

    const multiProviderInRange = rangeProviderThreads.size > 1 || rangeProviders.size > 1;
    const hasFreshContextInRange = rangeFreshContextRuns.length > 0;
    const route =
      rangeCompactions.length > 0 ||
      rangeHandoffs.length > 0 ||
      multiProviderInRange ||
      hasFreshContextInRange
        ? "full"
        : "fast";

    return {
      source: "t3_sqlite",
      threadId,
      title: threadRow.title || null,
      route,
      subagentEvidenceRequired: subagentMarkers.some((s) => effectiveEndOrdinal === null || s.ordinal === null || s.ordinal <= effectiveEndOrdinal),
      subagentCandidates: subagentMarkers.filter((s) => effectiveEndOrdinal === null || s.ordinal === null || s.ordinal <= effectiveEndOrdinal),
      rangeStartOrdinal,
      previousRetro,
      currentRetro,
      retroInvocations,
      retroInvocationsWithoutOrdinal: [],
      rangeCompactions,
      compactions,
      rangeHandoffs,
      handoffs,
      rangeProviders: [...rangeProviders],
      rangeProviderThreadCount: rangeProviderThreads.size,
      rangeFreshContextCount: rangeFreshContextRuns.length,
      rangeFreshContextRuns,
      rangeScheduledTaskCount,
      rangeScheduledTasks: [...rangeScheduledByTask.values()],
      rangeHumanInputCount,
      forkedFrom: threadPayload.forkedFrom || null,
      files: [{ path: path.resolve(dbPath), tag: "T3DB" }],
      cutoffOrdinal: untilOrdinal,
      rule: "rangeStartOrdinal defaults to the latest retro candidate from an earlier run (session start if none) and is unconfirmed: confirm the last delivered retro from userPreview/assistantPreview/runOutcomes and rerun with --since-ordinal if it differs; candidates in the current call's run belong to the current call; compaction, cross-provider handoff, freshContext reset, or multiple provider threads inside the range selects full; Forked From is informational only",
    };
  } finally {
    db.close();
  }
}
function parseT3ToolOutcome(itemType, itemStatus, payload) {
  const exitCodes = [];
  if (typeof payload.exitCode === "number" && !Number.isNaN(payload.exitCode)) {
    exitCodes.push(payload.exitCode);
  }
  const rawOut =
    typeof payload.output === "string"
      ? payload.output
      : payload.output !== undefined && payload.output !== null
      ? JSON.stringify(payload.output)
      : "";
  const outSummary = parseToolOutputSummary(rawOut);
  for (const code of outSummary.exitCodes) {
    if (!exitCodes.includes(code)) exitCodes.push(code);
  }
  const isErrorObj =
    payload.output && typeof payload.output === "object" && payload.output.isError === true;
  const statusFailed = itemStatus === "failed";
  const exitFailed = exitCodes.some((c) => c !== 0);
  const failed = statusFailed || isErrorObj || exitFailed;
  const suspiciousPattern = !failed && outSummary.suspiciousPattern;
  const failureReason = !failed
    ? null
    : statusFailed
    ? "status failed"
    : isErrorObj
    ? "tool error"
    : "exit code";
  return {
    exitCodes,
    failed,
    suspiciousPattern,
    failureReason,
    truncated: outSummary.truncated,
    preview: rawOut.slice(0, 320),
    outputChars: rawOut.length,
  };
}

export function analyzeT3Thread(dbPath, rawThreadId, opts = {}) {
  const threadId = normalizeT3ThreadId(rawThreadId);
  const untilOrdinal = opts.untilOrdinal ?? null;
  const sinceOrdinal = opts.sinceOrdinal ?? null;
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const threadRow = db
      .prepare(
        "SELECT thread_id, title, created_at, updated_at, payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?"
      )
      .get(threadId);
    if (!threadRow) {
      throw new Error(`T3 thread not found: ${threadId}`);
    }
    const threadPayload = safeJsonParse(threadRow.payload_json);
    const runRows = db
      .prepare(
        "SELECT run_id, ordinal, provider, provider_instance_id, provider_thread_id, status, requested_at, completed_at, payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal"
      )
      .all(threadId);
    const scheduledTasksMap = loadT3ScheduledTasks(db, threadId);
    const runs = runRows.map((r) => {
      const rp = safeJsonParse(r.payload_json);
      return {
        runId: r.run_id,
        ordinal: r.ordinal,
        providerInstanceId: r.provider_instance_id || r.provider || null,
        model: rp.modelSelection?.model || null,
        providerThreadId: r.provider_thread_id || null,
        freshContext: Boolean(rp.freshContext),
        contextHandoffId: rp.contextHandoffId || null,
        status: r.status || null,
        requestedAt: r.requested_at || null,
        completedAt: r.completed_at || null,
      };
    });
    const runById = new Map(runs.map((r) => [r.runId, r]));

    const providerThreadRows = db
      .prepare(
        "SELECT provider_thread_id, provider_instance_id, driver, first_run_ordinal, last_run_ordinal, payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ? ORDER BY first_run_ordinal"
      )
      .all(threadId);
    const providerThreads = providerThreadRows.map((pt) => {
      const ptp = safeJsonParse(pt.payload_json);
      return {
        providerThreadId: pt.provider_thread_id,
        providerInstanceId: pt.provider_instance_id,
        driver: pt.driver,
        nativeThreadId: ptp.nativeThreadRef?.nativeId || null,
        firstRunOrdinal: pt.first_run_ordinal,
        lastRunOrdinal: pt.last_run_ordinal,
      };
    });

    const items = loadT3ThreadItems(db, threadId);
    const allOrdinals = [];
    const compactions = [];
    const handoffs = [];
    const turnAborts = [];
    const approvalRequests = [];
    const subagents = [];
    const historicalGaps = [];
    const skillInjections = [];
    const skillReads = [];
    const skillWrites = [];
    const skillTokens = [];
    const toolCalls = [];
    const nonZeroTools = [];
    const suspiciousSuccessOutputs = [];
    const humanInputs = [];
    const scheduledTriggers = [];
    const runStatsMap = new Map();
    const contextSegments = [];
    let currentSegment = null;
    let pendingContextResetReason = null;

    const getOrInitRunStats = (runObj) => {
      if (!runObj) return null;
      let rs = runStatsMap.get(runObj.runId);
      if (!rs) {
        rs = {
          runId: runObj.runId,
          runOrdinal: runObj.ordinal,
          providerInstanceId: runObj.providerInstanceId || null,
          model: runObj.model || null,
          providerThreadId: runObj.providerThreadId || null,
          freshContext: Boolean(runObj.freshContext),
          status: runObj.status || null,
          triggerKind: "unknown",
          scheduledTaskId: null,
          scheduledTitle: null,
          threadMode: null,
          triggerLocation: null,
          triggerItemId: null,
          triggerOrdinal: null,
          toolCallCount: 0,
          failedToolCount: 0,
          fileChangeCount: 0,
          subagentCount: 0,
          assistantMessageCount: 0,
          errorOrAbortCount: 0,
          lastAssistantPreview: null,
        };
        runStatsMap.set(runObj.runId, rs);
      }
      return rs;
    };

    let firstOrd = null;
    let lastOrd = null;
    let firstTs = null;
    let lastTs = null;
    let lastAssistant = null;

    for (const item of items) {
      const ord = typeof item.ordinal === "number" ? item.ordinal : null;
      if (untilOrdinal !== null && ord !== null && ord > untilOrdinal) continue;
      if (sinceOrdinal !== null && ord !== null && ord < sinceOrdinal) continue;

      const payload = safeJsonParse(item.payload_json);
      if (opts.untilTime && timestampMs(payload.updatedAt || item.updated_at) >= timestampMs(opts.untilTime)) {
        historicalGaps.push({ location: `T3:pos=${item.position}`, itemId: item.turn_item_id, reason: "payload-updated-after-cutoff; historical value unavailable" });
        continue;
      }
      const ts = payload.completedAt || payload.startedAt || item.updated_at || null;
      const loc = `T3:pos=${item.position}`;

      if (ord !== null) {
        allOrdinals.push(ord);
        if (firstOrd === null || ord < firstOrd) firstOrd = ord;
        if (lastOrd === null || ord > lastOrd) lastOrd = ord;
      }
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }

      if (item.type === "compaction") {
        pendingContextResetReason = "compaction";
        compactions.push({
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          timestamp: ts,
          driver: payload.driver || null,
          status: item.status || payload.status || null,
        });
        continue;
      }

      if (item.type === "handoff") {
        if (isCrossContextHandoff(payload)) {
          pendingContextResetReason = "handoff";
        }
        handoffs.push({
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          timestamp: ts,
          title: payload.title || null,
          strategy: payload.strategy || null,
          fromProviderInstanceIds: payload.fromProviderInstanceIds || [],
          toProviderInstanceId: payload.toProviderInstanceId || null,
        });
        continue;
      }

      const run = item.run_id ? runById.get(item.run_id) : null;
      const runStats = getOrInitRunStats(run);
      const agentTag = run
        ? `${run.providerInstanceId || "unknown"}${run.model ? `/${run.model}` : ""} (run #${run.ordinal})`
        : null;

      if (run) {
        const boundaryReasons = [];
        if (!currentSegment) {
          boundaryReasons.push("initial");
          if (pendingContextResetReason) boundaryReasons.push(pendingContextResetReason);
        } else {
          if (pendingContextResetReason) boundaryReasons.push(pendingContextResetReason);
          if (run.runId !== currentSegment.lastRunId && run.freshContext) {
            boundaryReasons.push("fresh_context");
          }
          if ((run.providerThreadId || null) !== currentSegment.providerThreadId) {
            boundaryReasons.push("provider_thread_change");
          }
          if ((run.providerInstanceId || null) !== currentSegment.providerInstanceId) {
            boundaryReasons.push("provider_change");
          }
          if ((run.model || null) !== currentSegment.model) {
            boundaryReasons.push("model_change");
          }
        }
        if (boundaryReasons.length > 0) {
          currentSegment = {
            segmentIndex: contextSegments.length + 1,
            boundaryReasons,
            providerInstanceId: run.providerInstanceId || null,
            model: run.model || null,
            providerThreadId: run.providerThreadId || null,
            firstRunOrdinal: run.ordinal,
            lastRunOrdinal: run.ordinal,
            lastRunId: run.runId,
            runIds: new Set([run.runId]),
            firstItemOrdinal: ord,
            lastItemOrdinal: ord,
          };
          contextSegments.push(currentSegment);
        } else {
          currentSegment.lastRunOrdinal = run.ordinal;
          currentSegment.lastRunId = run.runId;
          currentSegment.runIds.add(run.runId);
          if (ord !== null) currentSegment.lastItemOrdinal = ord;
        }
        pendingContextResetReason = null;
      }

      if (item.type === "run_interrupt_request" || item.type === "error") {
        if (runStats) runStats.errorOrAbortCount++;
        turnAborts.push({
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          timestamp: ts,
          reason:
            payload.failure?.message ||
            payload.reason ||
            payload.title ||
            item.type,
        });
        continue;
      }

      if (item.type === "approval_request") {
        approvalRequests.push({
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          timestamp: ts,
          completedAt: payload.completedAt || null,
          status: item.status || payload.status || null,
          requestKind: payload.requestKind || null,
          promptPreview: oneLine(payload.prompt || "", 200),
        });
        continue;
      }

      if (item.type === "file_change") {
        if (runStats) runStats.fileChangeCount++;
        continue;
      }

      if (item.type === "subagent") {
        if (runStats) runStats.subagentCount++;
        const childStats = loadT3ChildThreadStats(db, payload.childThreadId || null);
        subagents.push({
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          timestamp: ts,
          title: payload.title || null,
          origin: payload.origin || null,
          driver: payload.driver || null,
          providerInstanceId: payload.providerInstanceId || null,
          childThreadId: payload.childThreadId || null,
          childItemCount: childStats.childItemCount,
          childFailedCount: childStats.childFailedCount,
          childStatsScope: "all currently recorded child history; use subagentEvidence for bounded review",
          status: item.status || payload.status || null,
          resultPreview: typeof payload.result === "string" ? payload.result.slice(0, 300) : null,
        });
        continue;
      }

      if (item.type === "assistant_message") {
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (text && runStats) {
          runStats.assistantMessageCount++;
          runStats.lastAssistantPreview = oneLine(text, 160);
        }
        lastAssistant = {
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          agent: agentTag,
          preview: text.slice(0, 300),
        };
        continue;
      }

      if (item.type === "user_message") {
        const rawText = typeof payload.text === "string" ? payload.text : "";
        const schedInfo = parseScheduledTaskMessage(item.turn_item_id, payload);
        if (schedInfo) {
          const taskMeta = scheduledTasksMap.get(schedInfo.scheduledTaskId);
          if (runStats) {
            runStats.triggerKind = schedInfo.triggerKind;
            runStats.scheduledTaskId = schedInfo.scheduledTaskId;
            runStats.scheduledTitle = taskMeta?.title || null;
            runStats.threadMode = taskMeta?.threadMode || null;
            runStats.triggerLocation = loc;
            runStats.triggerItemId = item.turn_item_id;
            runStats.triggerOrdinal = ord;
          }
          scheduledTriggers.push({
            index: scheduledTriggers.length + 1,
            location: loc,
            itemId: item.turn_item_id,
            ordinal: ord,
            timestamp: ts,
            runId: item.run_id || null,
            runOrdinal: run?.ordinal ?? null,
            freshContext: Boolean(run?.freshContext),
            agent: agentTag,
            triggerKind: schedInfo.triggerKind,
            scheduledTaskId: schedInfo.scheduledTaskId,
            scheduledTitle: taskMeta?.title || null,
            threadMode: taskMeta?.threadMode || null,
            text: rawText.trim(),
          });
          continue;
        }
        const cls = classifyUserMessage(rawText);
        if (cls.kind === "skill_injection") {
          skillInjections.push({
            location: loc,
            itemId: item.turn_item_id,
            ordinal: ord,
            timestamp: ts,
            name: cls.name,
            path: cls.path,
            sha256: cls.sha256,
          });
        } else if (cls.kind === "human") {
          if (runStats && runStats.triggerKind === "unknown") {
            runStats.triggerKind = "human";
            runStats.triggerLocation = loc;
            runStats.triggerItemId = item.turn_item_id;
            runStats.triggerOrdinal = ord;
          }
          const citations = decodeT3Citations(cls.cleanText);
          const tokens = extractSkillTokens(cls.cleanText);
          if (tokens.length > 0) {
            skillTokens.push({
              location: loc,
              itemId: item.turn_item_id,
              ordinal: ord,
              runOrdinal: run?.ordinal ?? null,
              names: tokens,
              userPreview: oneLine(cls.cleanText, 80),
            });
          }
          const attachedContexts = Array.isArray(payload.context?.records)
            ? payload.context.records.map((r) => ({
                kind: r.kind || null,
                threadId: r.threadId || null,
                environmentId: r.environmentId || null,
                title: r.title || r.label || null,
              }))
            : [];
          humanInputs.push({
            index: humanInputs.length + 1,
            location: loc,
            itemId: item.turn_item_id,
            ordinal: ord,
            timestamp: ts,
            runId: item.run_id || null,
            runOrdinal: run?.ordinal ?? null,
            freshContext: Boolean(run?.freshContext),
            agent: agentTag,
            text: cls.cleanText,
            citations,
            attachedContexts,
            precedingAssistant: lastAssistant ? { ...lastAssistant } : null,
          });
        }
        continue;
      }

      if (item.type === "command_execution" || item.type === "dynamic_tool") {
        if (item.turn_item_id.includes("workspace-preparation")) continue;
        if (runStats) runStats.toolCallCount++;
        const toolName =
          item.type === "command_execution"
            ? "command_execution"
            : payload.toolName || "dynamic_tool";
        const cmdInput =
          typeof payload.input === "string"
            ? payload.input
            : JSON.stringify(payload.input ?? "");
        const outSummary = parseT3ToolOutcome(item.type, item.status || payload.status, payload);
        if (outSummary.failed && runStats) runStats.failedToolCount++;
        toolCalls.push({
          location: loc,
          itemId: item.turn_item_id,
          ordinal: ord,
          timestamp: ts,
          runOrdinal: run?.ordinal ?? null,
          toolName,
          commandPreview: oneLine(stripShellWrapper(cmdInput), 100),
          exitCodes: outSummary.exitCodes,
          failed: outSummary.failed,
          outputChars: outSummary.outputChars,
        });

        if (toolName === "Skill" && payload.input && typeof payload.input === "object") {
          const skName = payload.input.skill || payload.output?.commandName || null;
          if (skName) {
            skillInjections.push({
              location: loc,
              itemId: item.turn_item_id,
              ordinal: ord,
              timestamp: ts,
              name: skName,
              path: `Skill:${skName}`,
              sha256: crypto.createHash("sha256").update(skName, "utf8").digest("hex"),
            });
          }
        }

        const skillOps = extractSkillFileOps(toolName, cmdInput);
        if (skillOps.reads.length > 0) {
          skillReads.push({
            callLocation: loc,
            outputLocation: loc,
            itemId: item.turn_item_id,
            ordinal: ord,
            callId: item.turn_item_id,
            access: "read",
            paths: skillOps.reads,
            exitCodes: outSummary.exitCodes,
            truncated: outSummary.truncated,
          });
        }
        if (skillOps.writes.length > 0) {
          skillWrites.push({
            callLocation: loc,
            outputLocation: loc,
            itemId: item.turn_item_id,
            ordinal: ord,
            callId: item.turn_item_id,
            access: "write",
            paths: skillOps.writes,
            exitCodes: outSummary.exitCodes,
            truncated: outSummary.truncated,
          });
        }

        if (outSummary.failed) {
          nonZeroTools.push({
            callLocation: loc,
            outputLocation: loc,
            itemId: item.turn_item_id,
            ordinal: ord,
            callId: item.turn_item_id,
            toolName,
            agent: agentTag,
            commandPreview: cmdInput.slice(0, 300),
            exitCodes: outSummary.exitCodes,
            failureReason: outSummary.failureReason,
            truncated: outSummary.truncated,
            outputPreview: outSummary.preview,
          });
        } else if (outSummary.suspiciousPattern) {
          suspiciousSuccessOutputs.push({
            callLocation: loc,
            outputLocation: loc,
            itemId: item.turn_item_id,
            ordinal: ord,
            callId: item.turn_item_id,
            toolName,
            agent: agentTag,
            commandPreview: cmdInput.slice(0, 300),
            exitCodes: outSummary.exitCodes,
            note: "exit 0; output matched error-like pattern — verify in context",
            truncated: outSummary.truncated,
            outputPreview: outSummary.preview,
          });
        }
      }
    }

    for (const tr of scheduledTriggers) {
      const rs = tr.runId ? runStatsMap.get(tr.runId) : null;
      tr.runStatus = rs?.status || null;
      tr.toolCallCount = rs?.toolCallCount ?? 0;
      tr.failedToolCount = rs?.failedToolCount ?? 0;
      tr.subagentCount = rs?.subagentCount ?? 0;
      tr.hasAssistantOutput = Boolean(rs && rs.assistantMessageCount > 0);
    }

    const finalizedSegments = contextSegments.map((seg) => {
      let humanRuns = 0;
      let scheduledRuns = 0;
      let manualScheduledRuns = 0;
      let failedRuns = 0;
      for (const rId of seg.runIds) {
        const rs = runStatsMap.get(rId);
        if (!rs) continue;
        if (rs.triggerKind === "human") humanRuns++;
        else if (rs.triggerKind === "scheduled") scheduledRuns++;
        else if (rs.triggerKind === "scheduled-manual") manualScheduledRuns++;
        if (
          rs.status === "failed" ||
          rs.status === "interrupted" ||
          rs.status === "canceled" ||
          rs.errorOrAbortCount > 0
        ) {
          failedRuns++;
        }
      }
      return {
        segmentIndex: seg.segmentIndex,
        boundaryReasons: seg.boundaryReasons,
        providerInstanceId: seg.providerInstanceId,
        model: seg.model,
        providerThreadId: seg.providerThreadId,
        firstRunOrdinal: seg.firstRunOrdinal,
        lastRunOrdinal: seg.lastRunOrdinal,
        runCount: seg.runIds.size,
        firstItemOrdinal: seg.firstItemOrdinal,
        lastItemOrdinal: seg.lastItemOrdinal,
        humanRuns,
        scheduledRuns,
        manualScheduledRuns,
        failedRuns,
      };
    });

    const allTaskIds = new Set(scheduledTasksMap.keys());
    for (const tr of scheduledTriggers) {
      allTaskIds.add(tr.scheduledTaskId);
    }
    const scheduledTasks = [];
    for (const taskId of allTaskIds) {
      const meta = scheduledTasksMap.get(taskId);
      const triggersForTask = scheduledTriggers.filter((tr) => tr.scheduledTaskId === taskId);
      let scheduledAutoRuns = 0;
      let manualTriggerRuns = 0;
      let completedRuns = 0;
      let failedOrInterruptedRuns = 0;
      let zeroToolRuns = 0;
      let nonZeroToolRuns = 0;
      let failedToolRuns = 0;
      let subagentRuns = 0;
      let silentRuns = 0;
      let outputRuns = 0;
      let totalToolCalls = 0;
      for (const tr of triggersForTask) {
        if (tr.triggerKind === "scheduled-manual") manualTriggerRuns++;
        else scheduledAutoRuns++;
        const rs = tr.runId ? runStatsMap.get(tr.runId) : null;
        const st = rs?.status || null;
        if (
          st === "failed" ||
          st === "interrupted" ||
          st === "canceled" ||
          (rs && rs.errorOrAbortCount > 0)
        ) {
          failedOrInterruptedRuns++;
        } else if (st === "completed") {
          completedRuns++;
        }
        const tools = rs?.toolCallCount ?? 0;
        totalToolCalls += tools;
        if (tools === 0) zeroToolRuns++;
        else nonZeroToolRuns++;
        if ((rs?.failedToolCount ?? 0) > 0) failedToolRuns++;
        if ((rs?.subagentCount ?? 0) > 0) subagentRuns++;
        if ((rs?.assistantMessageCount ?? 0) > 0) outputRuns++;
        else silentRuns++;
      }
      scheduledTasks.push({
        scheduledTaskId: taskId,
        title: meta?.title || null,
        threadMode: meta?.threadMode || null,
        schedule: meta?.schedule || null,
        enabled: meta?.enabled ?? null,
        lastRunStatus: meta?.lastRunStatus || null,
        inRangeStats: {
          totalRuns: triggersForTask.length,
          scheduledAutoRuns,
          manualTriggerRuns,
          completedRuns,
          failedOrInterruptedRuns,
          zeroToolRuns,
          nonZeroToolRuns,
          failedToolRuns,
          subagentRuns,
          silentRuns,
          outputRuns,
          totalToolCalls,
          firstLocation: triggersForTask[0]?.location || null,
          lastLocation: triggersForTask[triggersForTask.length - 1]?.location || null,
        },
      });
    }

    return {
      session: {
        source: "t3_sqlite",
        id: threadId,
        title: threadRow.title || null,
        cwd: threadPayload.worktreePath || null,
        forkedFromId: threadPayload.forkedFrom?.threadId || threadPayload.forkedFrom?.nodeId || null,
        forkedFromOrdinalExclusive: null,
        sinceOrdinal,
        untilOrdinal,
        minOrdinal: firstOrd,
        maxOrdinal: lastOrd,
        uniqueOrdinals: allOrdinals.length,
        ordinalGaps: [],
        ordinalCollisions: [],
        firstTimestamp: firstTs || threadRow.created_at || null,
        lastTimestamp: lastTs || threadRow.updated_at || null,
        runs,
        providerThreads,
        files: [
          {
            tag: "T3DB",
            path: path.resolve(dbPath),
            sessionId: threadId,
            lines: items.length,
            sizeBytes: fs.statSync(dbPath).size,
            firstOrdinal: firstOrd,
            lastOrdinal: lastOrd,
            firstTimestamp: firstTs,
            lastTimestamp: lastTs,
            historyBaseEndOrdinalExclusive: null,
            sha256: null,
          },
        ],
      },
      contextSegments: finalizedSegments,
      runStats: [...runStatsMap.values()]
        .sort((a, b) => a.runOrdinal - b.runOrdinal)
        .map((rs) => ({
          runId: rs.runId,
          runOrdinal: rs.runOrdinal,
          status: rs.status,
          triggerKind: rs.triggerKind,
          toolCallCount: rs.toolCallCount,
          failedToolCount: rs.failedToolCount,
          subagentCount: rs.subagentCount,
          assistantMessageCount: rs.assistantMessageCount,
          errorOrAbortCount: rs.errorOrAbortCount,
          lastAssistantPreview: rs.lastAssistantPreview,
        })),
      toolCalls,
      scheduledTasks,
      scheduledTriggers,
      compactions,
      handoffs,
      subagents,
      historicalGaps,
      turnAborts,
      approvalRequests,
      skills: {
        injected: skillInjections,
        userTokens: skillTokens,
        fileReads: skillReads,
        fileWrites: skillWrites,
      },
      nonZeroTools,
      suspiciousSuccessOutputs,
      wrapperCounts: {},
      humanInputs,
    };
  } finally {
    db.close();
  }
}
function findSessionFiles(sessionsRoot, sessionId) {
  const results = [];
  if (!fs.existsSync(sessionsRoot)) return results;
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name.includes(sessionId)
      ) {
        results.push(fullPath);
      }
    }
  }
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "input_image" || item.type === "image") {
      parts.push("[image attachment]");
    }
  }
  return parts.join("\n");
}

function classifyUserMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.startsWith("<skill>") && trimmed.includes("</skill>")) {
    const nameMatch = trimmed.match(/<name>([\s\S]*?)<\/name>/);
    const pathMatch = trimmed.match(/<path>([\s\S]*?)<\/path>/);
    return {
      kind: "skill_injection",
      name: nameMatch ? nameMatch[1].trim() : null,
      path: pathMatch ? pathMatch[1].trim() : null,
      sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    };
  }
  if (trimmed.startsWith("<subagent_notification>")) {
    return { kind: "subagent_notification" };
  }
  if (trimmed.startsWith("<turn_aborted>") || trimmed.startsWith("<user_action>")) {
    return { kind: "turn_aborted" };
  }
  const withoutOpenPage = trimmed
    .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/g, "")
    .trim();
  if (!withoutOpenPage) {
    return { kind: "open_page" };
  }
  const withoutEnvAndInstructions = withoutOpenPage
    .replace(/^#\s*AGENTS\.md instructions(?: for [^\n]+)?\n\n<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .trim();
  if (!withoutEnvAndInstructions) {
    return { kind: "instructions_or_env" };
  }
  return {
    kind: "human",
    cleanText: withoutEnvAndInstructions,
  };
}

function extractSkillPathsFromCommand(cmdText) {
  if (!cmdText) return [];
  const matches = new Set();
  const re = new RegExp(SKILL_PATH_RE.source, "gi");
  let m;
  while ((m = re.exec(cmdText)) !== null) {
    let found = m[0];
    // Shell quote concatenation such as "D:'"\\repo\\skills\\x.md splits the drive letter off.
    if (/^[\\/]/.test(found)) {
      const before = cmdText.slice(0, m.index).replace(/["'`]+$/, "");
      const drive = before.match(/(?:^|[^A-Za-z0-9])([A-Za-z]:)$/);
      if (drive) found = drive[1] + found;
    }
    matches.add(found);
  }
  return [...matches];
}

function extractApplyPatchSkillPaths(patchText) {
  if (!patchText) return [];
  const paths = new Set();
  const re = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$|^\*\*\*\s+Move\s+to:\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(patchText)) !== null) {
    const raw = (m[1] || m[2] || "").trim();
    for (const p of extractSkillPathsFromCommand(raw)) paths.add(p);
  }
  return [...paths];
}

function stripShellHereDocs(cmdText) {
  let out = String(cmdText || "");
  out = out.replace(/@'(?:"'|\\'')?\r?\n[\s\S]*?\r?\n(?:(?:'"|\\'')?'@)/g, "@''@");
  out = out.replace(/@"(?:'"|\\")?\r?\n[\s\S]*?\r?\n(?:(?:"'|\\")?"@)/g, '@""@');
  out = out.replace(/<<[-~]?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\r\n]*\r?\n[\s\S]*?\r?\n[ \t]*\1(?=\r?\n|$)/g, "<<$1");
  return out;
}

function unwrapShellBody(cmdText) {
  let s = stripShellWrapper(cmdText).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1);
  }
  return s;
}

function extractSkillFileOps(toolName, cmdText) {
  const raw = String(cmdText || "");
  if (!raw) return { reads: [], writes: [] };

  if (toolName && WRITE_TOOL_NAMES.has(toolName)) {
    if (toolName === "apply_patch" || /^\*\*\* Begin Patch/m.test(raw)) {
      return { reads: [], writes: extractApplyPatchSkillPaths(raw) };
    }
    return { reads: [], writes: extractSkillPathsFromCommand(raw) };
  }

  const writeSet = new Set(extractApplyPatchSkillPaths(raw));
  const code = stripShellHereDocs(unwrapShellBody(raw));
  const stmts = code
    .split(/(?:\r?\n|;|&&|\|\|)+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const varPaths = new Map();
  const varConsumers = new Map();
  const addConsumer = (varName, stmt) => {
    if (!varConsumers.has(varName)) varConsumers.set(varName, []);
    varConsumers.get(varName).push(stmt);
  };

  for (const stmt of stmts) {
    const assignMatch = stmt.match(/^(?:["']+\s*)?(?:local\s+|export\s+)?(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
    if (assignMatch) {
      const vName = assignMatch[1].replace(/^\$/, "");
      const rhsPaths = extractSkillPathsFromCommand(assignMatch[2]);
      if (rhsPaths.length > 0) {
        varPaths.set(vName, rhsPaths);
        continue;
      }
    }
    const varRefs = stmt.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) || [];
    for (const ref of varRefs) {
      addConsumer(ref.slice(1), stmt);
    }
  }

  const resolveTargetsInExpr = (expr) => {
    const found = new Set(extractSkillPathsFromCommand(expr));
    const refs = String(expr || "").match(/\$[A-Za-z_][A-Za-z0-9_]*/g) || [];
    for (const ref of refs) {
      const paths = varPaths.get(ref.slice(1));
      if (paths) for (const p of paths) found.add(p);
    }
    return found;
  };

  for (const stmt of stmts) {
    let m;
    const dotNetRe = /\b(?:WriteAllText|WriteAllLines|AppendAllText)\s*\(\s*([^,)]+)/gi;
    while ((m = dotNetRe.exec(stmt)) !== null) {
      for (const p of resolveTargetsInExpr(m[1])) writeSet.add(p);
    }
    const psWriteRe = /\b(?:Set-Content|Add-Content|Out-File|Remove-Item)\b([^|]*)/i;
    if ((m = stmt.match(psWriteRe))) {
      for (const p of resolveTargetsInExpr(m[1])) writeSet.add(p);
    }
    const psMoveRe = /\b(?:Copy-Item|Move-Item)\b([^|]*)/i;
    if ((m = stmt.match(psMoveRe))) {
      const destM = m[1].match(/-Destination\s+([^\s]+)/i);
      if (destM) {
        for (const p of resolveTargetsInExpr(destM[1])) writeSet.add(p);
      } else {
        const args = m[1].trim().split(/\s+/).filter((a) => !a.startsWith("-"));
        if (args.length > 0) {
          for (const p of resolveTargetsInExpr(args[args.length - 1])) writeSet.add(p);
        }
      }
    }
    const sedRe = /\bsed\s+-i\b([^|]*)/i;
    if ((m = stmt.match(sedRe))) {
      for (const p of resolveTargetsInExpr(m[1])) writeSet.add(p);
    }
    const teeRe = /\btee\b([^|]*)/i;
    if ((m = stmt.match(teeRe))) {
      for (const p of resolveTargetsInExpr(m[1])) writeSet.add(p);
    }
    const redirRe = /(?:^|[^>=-])>>?\s*([^\s|&;]+)/g;
    while ((m = redirRe.exec(stmt)) !== null) {
      for (const p of resolveTargetsInExpr(m[1])) writeSet.add(p);
    }
  }

  const READ_CMD_RE = /\b(?:Get-Content|Import-|cat|type|head|tail|sed|awk|rg|grep|ReadAllText|ReadAllLines|Get-Item|Get-FileHash)\b/i;
  const CHECK_ONLY_RE = /\b(?:Test-Path|Exists)\b/i;
  const testPathOnlyVars = new Set();
  for (const [vName] of varPaths.entries()) {
    const consumers = varConsumers.get(vName) || [];
    if (consumers.length > 0 && consumers.every((c) => CHECK_ONLY_RE.test(c) && !READ_CMD_RE.test(c))) {
      testPathOnlyVars.add(vName);
    }
  }

  const readSet = new Set();
  for (const stmt of stmts) {
    if (CHECK_ONLY_RE.test(stmt) && !READ_CMD_RE.test(stmt)) continue;
    const assignMatch = stmt.match(/^(?:["']+\s*)?(?:local\s+|export\s+)?(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/);
    if (assignMatch && testPathOnlyVars.has(assignMatch[1].replace(/^\$/, ""))) continue;
    for (const p of extractSkillPathsFromCommand(stmt)) {
      if (!writeSet.has(p)) readSet.add(p);
    }
  }

  return { reads: [...readSet], writes: [...writeSet] };
}
function parseToolOutputSummary(outputArr) {
  const raw = extractContentText(outputArr);
  const exitCodes = [];
  const reExit = /"exit_code"\s*:\s*(-?\d+)|Process exited with code\s+(-?\d+)/g;
  let m;
  while ((m = reExit.exec(raw)) !== null) {
    const code = Number(m[1] ?? m[2]);
    if (!Number.isNaN(code)) exitCodes.push(code);
  }
  const exitFailed = exitCodes.some((c) => c !== 0);
  const patternFailed =
    /Script failed|exec_command failed|ParserError:|Traceback \(most recent call last\)|ModuleNotFoundError:|AssertionError|ValueError:/i.test(
      raw
    );
  const failed = exitFailed;
  const suspiciousPattern = !exitFailed && patternFailed;
  const truncated = /truncated output|chars truncated|tokens truncated/i.test(raw);
  return {
    exitCodes,
    failed,
    suspiciousPattern,
    failureReason: exitFailed ? "exit code" : null,
    truncated,
    preview: raw.slice(0, 320),
  };
}

function eventSignature(obj) {
  const payload = obj && typeof obj.payload === "object" && obj.payload ? obj.payload : {};
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        type: obj.type ?? null,
        payloadType: payload.type ?? null,
        role: payload.role ?? null,
        id: payload.id ?? payload.call_id ?? payload.turn_id ?? null,
        content: payload.content ?? payload.input ?? payload.arguments ?? payload.output ?? null,
      }),
      "utf8"
    )
    .digest("hex");
}

export async function analyzeFiles(filePaths, opts = {}) {
  const untilOrdinal = opts.untilOrdinal ?? null;
  const sinceOrdinal = opts.sinceOrdinal ?? null;
  const filesMeta = [];
  const seenOrdinals = new Map();
  const allOrdinals = [];
  const ordinalCollisions = [];
  const compactions = [];
  const turnAborts = [];
  const skillInjections = [];
  const skillReads = [];
  const nonZeroTools = [];
  const suspiciousSuccessOutputs = [];
  const wrapperLocations = {
    instructions_or_env: [],
    skill_injection: [],
    open_page: [],
    subagent_notification: [],
    turn_aborted: [],
  };
  const humanInputs = [];
  const toolCallsById = new Map();

  let sessionMetaSummary = null;
  let lastAssistant = null;

  for (let fIdx = 0; fIdx < filePaths.length; fIdx++) {
    const filePath = path.resolve(filePaths[fIdx]);
    const tag = `F${fIdx + 1}`;
    const stat = fs.statSync(filePath);
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    const fileSha256 = hash.digest("hex");

    let lineNo = 0;
    let firstOrd = null;
    let lastOrd = null;
    let firstTs = null;
    let lastTs = null;
    let fileSessionId = null;
    let historyBaseEndOrdinalExclusive = null;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const ord = typeof obj.ordinal === "number" ? obj.ordinal : null;
      if (untilOrdinal !== null && ord !== null && ord > untilOrdinal) {
        continue;
      }
      if (sinceOrdinal !== null && ord !== null && ord < sinceOrdinal) {
        if (obj.type === "session_meta" && obj.payload) {
          fileSessionId ??= obj.payload.id || obj.payload.session_id || null;
          sessionMetaSummary ??= {
            id: obj.payload.id || obj.payload.session_id || null,
            cwd: obj.payload.cwd || null,
            forkedFromId: obj.payload.forked_from_id || null,
            forkedFromOrdinalExclusive: obj.payload.forked_from_ordinal_exclusive ?? null,
          };
        }
        continue;
      }

      const ts = obj.timestamp || null;
      const loc = `${tag}:L${lineNo}`;

      if (ord !== null) {
        if (firstOrd === null || ord < firstOrd) firstOrd = ord;
        if (lastOrd === null || ord > lastOrd) lastOrd = ord;
      }
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }

      if (obj.type === "session_meta" && obj.payload) {
        fileSessionId = obj.payload.id || obj.payload.session_id || null;
        if (obj.payload.history_base && typeof obj.payload.history_base.end_ordinal_exclusive === "number") {
          historyBaseEndOrdinalExclusive = obj.payload.history_base.end_ordinal_exclusive;
        }
        if (!sessionMetaSummary) {
          sessionMetaSummary = {
            id: fileSessionId,
            cwd: obj.payload.cwd || null,
            forkedFromId: obj.payload.forked_from_id || null,
            forkedFromOrdinalExclusive: obj.payload.forked_from_ordinal_exclusive ?? null,
          };
        }
      }

      if (ord !== null) {
        const sig = eventSignature(obj);
        const existing = seenOrdinals.get(ord);
        if (existing) {
          if (existing.signatures.has(sig)) {
            continue;
          }
          existing.signatures.add(sig);
          ordinalCollisions.push({
            ordinal: ord,
            firstLocation: existing.firstLocation,
            firstType: existing.firstType,
            collidingLocation: loc,
            collidingType: `${obj.type}${obj.payload?.type ? `:${obj.payload.type}` : ""}`,
          });
        } else {
          seenOrdinals.set(ord, {
            firstLocation: loc,
            firstType: `${obj.type}${obj.payload?.type ? `:${obj.payload.type}` : ""}`,
            signatures: new Set([sig]),
          });
          allOrdinals.push(ord);
        }
      }

      const payload = obj.payload || {};

      if (obj.type === "compacted") {
        compactions.push({
          location: loc,
          ordinal: ord,
          timestamp: ts,
          windowNumber: payload.window_number ?? null,
        });
        continue;
      }

      if (obj.type === "event_msg" && payload.type === "turn_aborted") {
        turnAborts.push({
          location: loc,
          ordinal: ord,
          timestamp: ts,
          reason: payload.reason || null,
        });
        continue;
      }

      if (obj.type === "response_item") {
        const pType = payload.type;
        if (pType === "message" && payload.role === "assistant") {
          const text = extractContentText(payload.content).trim();
          lastAssistant = {
            location: loc,
            ordinal: ord,
            phase: payload.phase || null,
            preview: text.slice(0, 300),
          };
        } else if (pType === "message" && payload.role === "user") {
          const rawText = extractContentText(payload.content);
          const cls = classifyUserMessage(rawText);
          if (cls.kind === "skill_injection") {
            wrapperLocations.skill_injection.push(loc);
            skillInjections.push({
              location: loc,
              ordinal: ord,
              timestamp: ts,
              name: cls.name,
              path: cls.path,
              sha256: cls.sha256,
            });
          } else if (cls.kind === "human") {
            humanInputs.push({
              index: humanInputs.length + 1,
              location: loc,
              ordinal: ord,
              timestamp: ts,
              text: cls.cleanText,
              precedingAssistant: lastAssistant ? { ...lastAssistant } : null,
            });
          } else if (wrapperLocations[cls.kind]) {
            wrapperLocations[cls.kind].push(loc);
          }
        } else if (pType === "custom_tool_call" || pType === "function_call") {
          const callId = payload.call_id || payload.id;
          const cmdInput =
            typeof payload.input === "string"
              ? payload.input
              : typeof payload.arguments === "string"
              ? payload.arguments
              : JSON.stringify(payload.input ?? payload.arguments ?? "");
          const skillOps = extractSkillFileOps(payload.name || null, cmdInput);
          const record = {
            callLocation: loc,
            ordinal: ord,
            timestamp: ts,
            name: payload.name || null,
            callId,
            cmdPreview: cmdInput.slice(0, 300),
            skillPaths: [...skillOps.reads, ...skillOps.writes],
          };
          if (callId) toolCallsById.set(callId, record);
          if (skillOps.reads.length > 0) {
            skillReads.push({
              callLocation: loc,
              outputLocation: null,
              ordinal: ord,
              callId,
              access: "read",
              paths: skillOps.reads,
              exitCodes: [],
              truncated: false,
            });
          }
          if (skillOps.writes.length > 0) {
            skillReads.push({
              callLocation: loc,
              outputLocation: null,
              ordinal: ord,
              callId,
              access: "write",
              paths: skillOps.writes,
              exitCodes: [],
              truncated: false,
            });
          }
        } else if (pType === "custom_tool_call_output" || pType === "function_call_output") {
          const callId = payload.call_id;
          const priorCall = callId ? toolCallsById.get(callId) : null;
          const outSummary = parseToolOutputSummary(payload.output);
          if (priorCall && priorCall.skillPaths.length > 0) {
            for (const sr of skillReads.filter((r) => r.callId === callId)) {
              sr.outputLocation = loc;
              sr.exitCodes = outSummary.exitCodes;
              sr.truncated = outSummary.truncated;
            }
          }
          if (outSummary.failed) {
            nonZeroTools.push({
              callLocation: priorCall ? priorCall.callLocation : null,
              outputLocation: loc,
              ordinal: ord,
              callId: callId || null,
              toolName: priorCall ? priorCall.name : null,
              commandPreview: priorCall ? priorCall.cmdPreview : null,
              exitCodes: outSummary.exitCodes,
              failureReason: outSummary.failureReason,
              truncated: outSummary.truncated,
              outputPreview: outSummary.preview,
            });
          } else if (outSummary.suspiciousPattern) {
            suspiciousSuccessOutputs.push({
              callLocation: priorCall ? priorCall.callLocation : null,
              outputLocation: loc,
              ordinal: ord,
              callId: callId || null,
              toolName: priorCall ? priorCall.name : null,
              commandPreview: priorCall ? priorCall.cmdPreview : null,
              exitCodes: outSummary.exitCodes,
              note: "exit 0; output matched error-like pattern — verify in context",
              truncated: outSummary.truncated,
              outputPreview: outSummary.preview,
            });
          }
        }
      }
    }

    filesMeta.push({
      tag,
      path: filePath,
      sessionId: fileSessionId,
      lines: lineNo,
      sizeBytes: stat.size,
      firstOrdinal: firstOrd,
      lastOrdinal: lastOrd,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
      historyBaseEndOrdinalExclusive,
      sha256: fileSha256,
    });
  }

  allOrdinals.sort((a, b) => a - b);
  const ordinalGaps = [];
  for (let i = 1; i < allOrdinals.length; i++) {
    if (allOrdinals[i] !== allOrdinals[i - 1] + 1) {
      ordinalGaps.push({
        fromExclusive: allOrdinals[i - 1],
        toExclusive: allOrdinals[i],
      });
    }
  }

  return {
    session: {
      ...(sessionMetaSummary || {}),
      sinceOrdinal,
      untilOrdinal,
      minOrdinal: allOrdinals.length > 0 ? allOrdinals[0] : null,
      maxOrdinal: allOrdinals.length > 0 ? allOrdinals[allOrdinals.length - 1] : null,
      uniqueOrdinals: allOrdinals.length,
      ordinalGaps,
      ordinalCollisions,
      firstTimestamp: filesMeta[0]?.firstTimestamp || null,
      lastTimestamp: filesMeta[filesMeta.length - 1]?.lastTimestamp || null,
      files: filesMeta,
    },
    compactions,
    turnAborts,
    skills: {
      injected: skillInjections,
      fileReads: skillReads.filter((r) => r.access !== "write"),
      fileWrites: skillReads.filter((r) => r.access === "write"),
    },
    nonZeroTools,
    suspiciousSuccessOutputs,
    wrapperCounts: Object.fromEntries(
      Object.entries(wrapperLocations).map(([k, v]) => [k, { count: v.length, locations: v }])
    ),
    humanInputs,
  };
}
function timestampMs(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Decode JSON content blocks and newline-separated tool results without interpreting
// arbitrary prose or executing wrapper JavaScript.
function structuredToolValues(value) {
  const found = [];
  const queue = [value];
  while (queue.length) {
    const current = queue.pop();
    if (typeof current === "string") {
      try { queue.push(JSON.parse(current)); }
      catch {
        for (const line of current.split(/\r?\n/)) {
          if (!/^[\[{]/.test(line.trim())) continue;
          try { queue.push(JSON.parse(line)); } catch { /* not a complete JSON value */ }
        }
      }
    } else if (Array.isArray(current)) {
      queue.push(...current);
    } else if (current && typeof current === "object") {
      found.push(current);
      // Only transport envelopes are unwrapped, not arbitrary task data.
      if (current.content) queue.push(current.content);
      if (typeof current.text === "string") queue.push(current.text);
      if (current.structuredContent) queue.push(current.structuredContent);
    }
  }
  return found;
}

function agentControlIds(event) {
  const direct = /(?:^|[_.])(?:send_input|wait_agent|resume_agent|close_agent)$/.test(event.toolName || "");
  const wrapped = /\btools\.multi_agent_v1__(?:send_input|wait_agent|resume_agent|close_agent)\s*\(/.test(event.input || "");
  if (!direct && !wrapped) return [];
  const ids = new Set();
  if (direct) {
    for (const value of structuredToolValues(event.input)) {
      for (const id of [value.target, value.agent_id, ...(Array.isArray(value.targets) ? value.targets : [])]) {
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  // Wait results supply stable IDs even when the call was wrapped in exec.
  for (const value of structuredToolValues(event.output)) {
    if (value.status && typeof value.status === "object") {
      for (const id of Object.keys(value.status)) ids.add(id);
    }
  }
  return [...ids];
}

async function readJsonlEvidence(filePaths) {
  const events = [];
  const boundaries = [];
  const fingerprints = new Set();
  const calls = new Map();
  const gaps = [];
  let meta = null;
  for (const file of filePaths) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); }
      catch { gaps.push({ reason: "invalid-jsonl", location: `${file}:${lineNo}` }); continue; }
      const p = row.payload || {};
      boundaries.push({ ordinal: row.ordinal ?? null, timestamp: row.timestamp || null, location: `${file}:${lineNo}` });
      if (row.type === "session_meta") {
        if (meta && (meta.id || meta.session_id) !== (p.id || p.session_id)) {
          throw new Error(`Mixed session identities: ${file}:${lineNo}`);
        }
        meta ??= p;
        continue;
      }
      const fingerprint = `${row.timestamp || ""}:${eventSignature(row)}`;
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      const base = {
        location: `${file}:${lineNo}`, ordinal: row.ordinal ?? null,
        timestamp: row.timestamp || null, observedAt: row.timestamp || null, fingerprint,
      };
      if (row.type === "response_item") {
        if (p.type === "message") {
          events.push({ ...base, type: p.role, text: extractContentText(p.content), phase: p.phase });
        } else if (p.type === "function_call" || p.type === "custom_tool_call") {
          const event = { ...base, type: "tool", toolName: p.name, input: p.input ?? p.arguments ?? "", output: null };
          if (typeof event.input !== "string") event.input = JSON.stringify(event.input);
          events.push(event);
          if (p.call_id || p.id) calls.set(p.call_id || p.id, event);
        } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
          const event = calls.get(p.call_id);
          if (event) {
            event.output = p.output;
            event.observedAt = row.timestamp || null;
            event.outputLocation = base.location;
            event.outputOrdinal = row.ordinal ?? null;
            event.completedAt = row.timestamp || null;
          }
        }
      } else if (row.type === "event_msg" && p.type === "turn_aborted") {
        events.push({ ...base, type: "error", text: p.reason || "turn aborted" });
      }
    }
  }
  return { id: meta?.id || meta?.session_id || null, meta, events, boundaries, fingerprints, gaps, files: filePaths };
}

function readT3Evidence(db, threadId) {
  const thread = db.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?").get(threadId);
  if (!thread) throw new Error(`T3 thread not found: ${threadId}`);
  const meta = safeJsonParse(thread.payload_json);
  const events = loadT3ThreadItems(db, threadId).map((row) => {
    const p = safeJsonParse(row.payload_json);
    return {
      location: `T3:${threadId}:pos=${row.position}`, itemId: row.turn_item_id,
      ordinal: row.ordinal ?? null, timestamp: p.startedAt || null,
      observedAt: p.updatedAt || row.updated_at || p.completedAt || null,
      type: row.type === "user_message" ? "user" : row.type === "assistant_message" ? "assistant" :
        ["command_execution", "dynamic_tool"].includes(row.type) ? "tool" : row.type,
      text: p.text || "", phase: p.phase,
      toolName: row.type === "command_execution" ? "command_execution" : p.toolName,
      input: typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? ""),
      output: p.output, status: row.status, exitCode: p.exitCode,
      childThreadId: p.childThreadId || null, parentSubagentId: p.subagentId || null,
      requestKind: p.requestKind || null,
      prompt: p.prompt || null, completedAt: p.completedAt || null,
    };
  });
  const providers = db.prepare(
    "SELECT provider_thread_id, payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?"
  ).all(threadId).map((r) => ({
    providerThreadId: r.provider_thread_id, ...safeJsonParse(r.payload_json),
  }));
  return { id: threadId, meta, events, fingerprints: new Set(), gaps: [], providers };
}

function summarizeChildEvidence(data, events, gaps, { isRoot = false } = {}) {
  const tools = new Map();
  const commands = new Map();
  const skills = [];
  const requirements = [];
  const failures = [];
  const toolCalls = [];
  const rootOmittedTools = new Map();
  let result = null;
  for (const e of events) {
    if (e.type === "user") {
      const cls = classifyUserMessage(e.text);
      if (cls.kind === "skill_injection") skills.push({ location: e.location, name: cls.name, path: cls.path });
      else if (cls.kind === "human") requirements.push({ location: e.location, itemId: e.itemId || null, preview: oneLine(cls.cleanText, 240), truncated: cls.cleanText.length > 240 });
    } else if (e.type === "assistant" && e.text.trim()) {
      result = { location: e.location, itemId: e.itemId || null, phase: e.phase || null, preview: oneLine(e.text, 320), truncated: e.text.length > 320 };
    } else if (e.type === "error" || e.type === "run_interrupt_request") {
      failures.push({ location: e.location, reason: e.type });
    } else if (e.type === "approval_request") {
      failures.push({ location: e.location, reason: `approval_request (${e.status || "unknown"}, ${e.requestKind || "unknown"}): ${oneLine(e.prompt || "", 120)}` });
    } else if (e.type === "tool") {
      const outcome = parseT3ToolOutcome("dynamic_tool", e.status, { output: e.output, exitCode: e.exitCode });
      const group = tools.get(e.toolName) || { name: e.toolName, calls: 0, failed: 0, outputChars: 0 };
      group.calls++;
      group.failed += Number(outcome.failed);
      group.outputChars += outcome.outputChars;
      tools.set(e.toolName, group);
      toolCalls.push({ location: e.location, itemId: e.itemId || null, timestamp: e.timestamp, outputLocation: e.outputLocation || e.location,
        outputOrdinal: e.outputOrdinal ?? null, completedAt: e.completedAt || null, name: e.toolName,
        commandPreview: oneLine(stripShellWrapper(e.input), 160), failed: outcome.failed, outputChars: outcome.outputChars });
      const command = `${e.toolName}\n${e.input}`;
      const repeat = commands.get(command) || { toolName: e.toolName, commandPreview: oneLine(stripShellWrapper(e.input), 160), count: 0, firstLocation: e.location };
      repeat.count++;
      repeat.lastLocation = e.location;
      commands.set(command, repeat);
      if (outcome.failed || outcome.suspiciousPattern) failures.push({ location: e.location, reason: outcome.failureReason || "output-pattern-candidate; model verification required" });
      const ops = extractSkillFileOps(e.toolName, e.input);
      for (const p of ops.reads) {
        skills.push({ location: e.location, path: p, access: "read" });
      }
      for (const p of ops.writes) {
        skills.push({ location: e.location, path: p, access: "write" });
      }
      if (e.toolName === "Skill") {
        for (const input of structuredToolValues(e.input)) {
          if (input.skill) skills.push({ location: e.location, name: input.skill });
        }
      }
      if (e.output === null || e.output === undefined) {
        if (isRoot && !outcome.failed && String(e.status || "").toLowerCase() === "completed") {
          const toolLabel = e.toolName || "unknown";
          rootOmittedTools.set(toolLabel, (rootOmittedTools.get(toolLabel) || 0) + 1);
        } else {
          gaps.push({ reason: "tool-result-unavailable", location: e.location });
        }
      }
    }
  }
  if (rootOmittedTools.size > 0) {
    const summary = [...rootOmittedTools.entries()].map(([name, cnt]) => `${name} x${cnt}`).join(", ");
    gaps.push({ reason: `root-completed-tool-output-not-persisted (${summary})` });
  }
  return {
    coverage: gaps.length ? "partial-index; not a completed review" : "indexed; model review required",
    eventCount: events.length, requirements, skills, tools: [...tools.values()], toolCalls, failures,
    repeatedCalls: [...commands.values()].filter((c) => c.count > 1), result,
    // A repeated call is evidence, not an automatic retry/inefficiency verdict.
    gaps, files: data.files || [],
  };
}

/** Compact, read-only graph. IDs/relations are facts; task relevance and quality
 * remain model judgments. Parent ordinals never filter another thread. */
export async function collectSubagentEvidence(opts) {
  const snapshotAt = new Date().toISOString();
  const codexHome = opts.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const dbPath = opts.t3Db || path.join(opts.t3Home || process.env.T3CODE_HOME || path.join(os.homedir(), ".t3"), "userdata", "statev2.sqlite");
  const rootT3 = !opts.files?.length && opts.sessionId && hasT3Thread(dbPath, opts.sessionId);
  const db = rootT3 ? new DatabaseSync(dbPath, { readOnly: true }) : null;
  if (db) db.exec("BEGIN");
  const globalGaps = [];
  const sources = new Map();
  const nodes = new Map();
  const aliases = new Map();
  const load = async (ref) => {
    const key = `${ref.source}:${ref.id}`;
    if (sources.has(key)) return sources.get(key);
    const promise = ref.source === "t3" ? Promise.resolve(readT3Evidence(db, ref.id)) :
      readJsonlEvidence(ref.files || findSessionFiles(path.join(codexHome, "sessions"), ref.id));
    sources.set(key, promise);
    const data = await promise;
    if (!data.id || (ref.id && data.id !== ref.id)) throw new Error(`Session identity unavailable or mismatched: ${ref.id}`);
    for (const p of data.providers || []) {
      if (p.nativeThreadRef?.nativeId) aliases.set(p.nativeThreadRef.nativeId, ref.id);
    }
    return data;
  };
  const nativeRef = (id) => {
    if (db && !aliases.has(id)) {
      const row = db.prepare(
        "SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') = ?"
      ).get(id);
      if (row) aliases.set(id, row.thread_id);
    }
    return db && aliases.has(id) ? { source: "t3", id: aliases.get(id) } : { source: "codex", id };
  };
  try {
    const rootRef = rootT3 ? { source: "t3", id: normalizeT3ThreadId(opts.sessionId) } :
      { source: "codex", id: opts.sessionId || null, files: opts.files?.length ? opts.files : undefined };
    const root = await load(rootRef);
    rootRef.id = root.id;
    const rootKey = `${rootRef.source}:${root.id}`;
    const parentRecords = root.boundaries || root.events;
    const selectedRecords = parentRecords.filter((e) =>
      (opts.sinceOrdinal == null || (e.ordinal != null && e.ordinal >= opts.sinceOrdinal)) &&
      (opts.untilOrdinal == null || (e.ordinal != null && e.ordinal <= opts.untilOrdinal)));
    const after = opts.untilOrdinal == null ? null : parentRecords.find((e) => e.ordinal > opts.untilOrdinal);
    const lower = timestampMs(opts.sinceTime) ?? (opts.sinceOrdinal == null ? null : timestampMs(selectedRecords[0]?.timestamp));
    const lastSelectedTime = timestampMs(selectedRecords.at(-1)?.timestamp);
    const requestedUpper = timestampMs(opts.untilTime) ?? timestampMs(after?.timestamp) ??
      (opts.untilOrdinal == null ? timestampMs(snapshotAt) : after || lastSelectedTime === null ? null : lastSelectedTime + 1);
    const upper = requestedUpper === null ? null : Math.min(requestedUpper, timestampMs(snapshotAt));
    if (requestedUpper > timestampMs(snapshotAt)) globalGaps.push({ reason: "requested-cutoff-after-snapshot; limited-to-snapshot" });
    if (opts.sinceOrdinal != null && lower === null) globalGaps.push({ reason: "parent-start-time-unavailable" });
    if (!Number.isFinite(upper) || upper === null) globalGaps.push({ reason: "parent-cutoff-time-unavailable" });
    if (lower !== null && upper !== null && lower >= upper) throw new Error("Cross-thread start must precede cutoff");
    if (opts.untilOrdinal != null && !opts.untilTime && !after) globalGaps.push({ reason: "cutoff-derived-from-last-parent-event; supply --until-time to cover concurrent work" });
    const validRange = (opts.sinceOrdinal == null || lower !== null) && Number.isFinite(upper);
    const inTime = (e) => {
      const ms = timestampMs(e.timestamp);
      const end = timestampMs(e.completedAt);
      return validRange && ms !== null && ms < upper && (lower === null || ms >= lower ||
        (end !== null && end >= lower) || (end === null && e.type === "tool"));
    };
    const beforeParentCutoff = (e) => opts.untilOrdinal == null || (e.ordinal != null && e.ordinal <= opts.untilOrdinal);
    const rootInRange = (e) => beforeParentCutoff(e) && inTime(e) &&
      (opts.sinceOrdinal == null || (e.ordinal != null && e.ordinal >= opts.sinceOrdinal) || (e.outputOrdinal != null && e.outputOrdinal >= opts.sinceOrdinal));
    const queue = [{ ref: rootRef, parent: null, inherited: new Set(), referenced: true }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const entry = queue[cursor];
      const key = `${entry.ref.source}:${entry.ref.id}`;
      if (nodes.has(key)) {
        if (entry.parent) nodes.get(key).parents.push(entry.parent);
        nodes.get(key).referenced ||= entry.referenced;
        continue;
      }
      const node = { source: entry.ref.source, id: entry.ref.id, parents: entry.parent ? [entry.parent] : [], referenced: entry.referenced, taskRelevance: "pending model confirmation" };
      nodes.set(key, node);
      let data;
      try { data = key === rootKey ? root : await load(entry.ref); }
      catch (err) {
        node.evidence = { coverage: "missing", eventCount: 0, gaps: [{ reason: String(err.message) }] };
        continue;
      }
      const gaps = [...data.gaps];
      const parentId = data.meta?.parent_thread_id || data.meta?.source?.subagent?.thread_spawn?.parent_thread_id;
      if (entry.parent?.association === "dispatch" && entry.parent.nativeParentId && parentId && parentId !== entry.parent.nativeParentId) {
        node.evidence = { coverage: "missing", eventCount: 0, gaps: [{ reason: "native-parent-identity-mismatch" }] };
        continue;
      }
      if (entry.parent?.association === "dispatch" && entry.parent.nativeParentId && !parentId && entry.ref.source === "codex") {
        gaps.push({ reason: "native-parent-relation-unverified" });
      }
      const fingerprints = new Set([...entry.inherited, ...data.fingerprints]);
      let inheritedExcluded = 0;
      let updatedAfterCutoff = 0;
      let activityInRange = false;
      const visible = [];
      const isRoot = key === rootKey;
      for (const event of data.events) {
        if (event.fingerprint && entry.inherited.has(event.fingerprint)) { inheritedExcluded++; continue; }
        if (!isRoot && timestampMs(event.timestamp) === null) gaps.push({ reason: "event-time-unavailable", location: event.location });
        if (!(isRoot ? rootInRange(event) : inTime(event))) continue;
        activityInRange = true;
        if (lower !== null && timestampMs(event.timestamp) < lower && event.type === "tool" && timestampMs(event.completedAt) === null) {
          gaps.push({ reason: "execution-end-unavailable; overlap with start unverified", location: event.location });
        }
        const observed = timestampMs(event.observedAt);
        if (event.type !== "subagent" && observed !== null && observed >= upper) {
          updatedAfterCutoff++;
          gaps.push({ reason: "payload-updated-after-cutoff; historical value unavailable", location: event.location });
          continue;
        }
        const outputOutsideOrdinal = isRoot && node.source === "codex" && opts.untilOrdinal != null && event.output != null &&
          (event.outputOrdinal == null || event.outputOrdinal > opts.untilOrdinal);
        if (event.type === "tool" && (observed === null || outputOutsideOrdinal)) {
          gaps.push({ reason: observed === null ? "tool-result-time-unavailable" : "tool-result-outside-parent-ordinal", location: event.outputLocation || event.location });
          visible.push({ ...event, output: null, status: null, exitCode: undefined });
        } else visible.push(event);
      }
      const fork = data.meta?.forked_from_id || data.meta?.forkedFrom;
      if (!isRoot && fork && inheritedExcluded === 0 && entry.ref.source === "codex") {
        gaps.push({ reason: "fork-history-boundary-unverified" });
      }
      if (!isRoot && !data.events.length) gaps.push({ reason: "child-events-unavailable" });
      node.evidence = summarizeChildEvidence(data, visible.filter((e) => e.type !== "subagent"), gaps, { isRoot });
      node.evidence.inheritedExcluded = inheritedExcluded;
      node.evidence.updatedAfterCutoff = updatedAfterCutoff;
      node.active = activityInRange;
      node.providerThreads = (data.providers || []).map((p) => ({ providerThreadId: p.providerThreadId, nativeThreadId: p.nativeThreadRef?.nativeId || null }));
      for (const event of data.events) {
        // Earlier dispatches are retained as relations so resumed/continuing children
        // can be checked in a repeated retro. Post-cutoff dispatches are excluded.
        if (event.fingerprint && entry.inherited.has(event.fingerprint)) continue;
        if (isRoot && !beforeParentCutoff(event)) continue;
        const started = timestampMs(event.timestamp);
        if (started === null || started >= upper) continue;
        const parent = { source: node.source, id: node.id, location: event.location, itemId: event.itemId || null, ordinal: event.ordinal, timestamp: event.timestamp };
        const refs = [];
        const observed = timestampMs(event.observedAt);
        const resultInRange = observed !== null && observed < upper &&
          (!isRoot || node.source !== "codex" || opts.untilOrdinal == null || (event.outputOrdinal != null && event.outputOrdinal <= opts.untilOrdinal));
        if (event.type === "subagent") {
          if (event.childThreadId) refs.push({ source: "t3", id: event.childThreadId, association: "host-subagent" });
          else gaps.push({ reason: "subagent-child-id-unavailable", location: event.location });
          parent.subagentId = event.parentSubagentId;
          if (resultInRange) parent.requirementPreview = oneLine(event.prompt, 240);
        } else if (event.type === "tool") {
          const values = resultInRange ? structuredToolValues(event.output) : [];
          if (isAgentDispatch(event.toolName, event.input)) {
            for (const value of values) {
              if (typeof value.childThreadId === "string" && db) refs.push({ source: "t3", id: value.childThreadId, association: "dispatch" });
              if (typeof value.agent_id === "string") refs.push({ ...nativeRef(value.agent_id), association: "dispatch" });
              if (typeof value.agentId === "string") refs.push({ ...nativeRef(value.agentId), association: "dispatch" });
            }
            if (!refs.length) {
              gaps.push({ reason: "dispatch-result-unresolved; use host read-only relation lookup", location: event.location });
            }
          }
          const controlIds = agentControlIds({ ...event, output: resultInRange ? event.output : null });
          for (const id of controlIds) refs.push({ ...nativeRef(id), association: "control" });
          if (isAgentControl(event.toolName, event.input) && !controlIds.length) {
            gaps.push({ reason: "control-target-unresolved; inspect parent call at location", location: event.location });
          }
        }
        for (const ref of new Map(refs.map((r) => [`${r.source}:${r.id}`, r])).values()) {
          if (node.source === "codex") parent.nativeParentId = node.id;
          else if (data.providers?.length === 1) parent.nativeParentId = data.providers[0].nativeThreadRef?.nativeId;
          queue.push({ ref, parent: { ...parent, association: ref.association }, inherited: fingerprints, referenced: isRoot ? rootInRange(event) : inTime(event) });
        }
      }
    }
    // Propagate active descendants through idle ancestors without recurring forever
    // on malformed/cyclic host relations. Each identity is indexed only once.
    const retained = new Set([...nodes.entries()].filter(([key, n]) => key !== rootKey && (n.referenced || n.active)).map(([key]) => key));
    const pending = [...retained];
    for (let i = 0; i < pending.length; i++) {
      for (const parent of nodes.get(pending[i])?.parents || []) {
        const key = `${parent.source}:${parent.id}`;
        if (key !== rootKey && !retained.has(key)) { retained.add(key); pending.push(key); }
      }
    }
    globalGaps.push(...(nodes.get(rootKey)?.evidence?.gaps || []));
    for (const node of nodes.values()) {
      if (node.evidence.coverage !== "missing" && node.evidence.gaps.length) node.evidence.coverage = "partial-index; not a completed review";
    }
    return {
      snapshotAt, sinceTime: lower === null ? null : new Date(lower).toISOString(),
      untilTime: Number.isFinite(upper) ? new Date(upper).toISOString() : null,
      rule: "Explicit relation candidates; task relevance, retries, quality and parent adoption require model review. Child ordinals are local. Previews are excerpts; follow locations for necessary coverage.",
      gaps: globalGaps,
      children: [...nodes.entries()].filter(([key]) => retained.has(key)).map(([, node]) => node),
    };
  } finally {
    if (db) { db.exec("ROLLBACK"); db.close(); }
  }
}

function formatSubagentEvidence(evidence) {
  const lines = [`## Subagent Evidence (${evidence.children.length} relation candidates; model review required)`,
    `- Window: ${evidence.sinceTime || "session start"} <= time < ${evidence.untilTime || "unknown"}`,
    `- ${evidence.rule}`];
  for (const gap of evidence.gaps) lines.push(`- GAP: ${gap.reason}${gap.location ? ` (${gap.location})` : ""}`);
  for (const child of evidence.children) {
    lines.push("", `### ${child.source}:${child.id}`, `- Relevance: ${child.taskRelevance}`, `- Coverage: ${child.evidence.coverage}; events=${child.evidence.eventCount}`);
    for (const parent of child.parents) lines.push(`- Parent ${parent.source}:${parent.id} ${parent.location}${parent.requirementPreview ? `: ${parent.requirementPreview}` : ""}`);
    const e = child.evidence;
    for (const req of e.requirements || []) lines.push(`- Request ${req.location}${req.itemId ? ` [item ${req.itemId}]` : ""}: ${req.preview}${req.truncated ? " [excerpt]" : ""}`);
    for (const sk of e.skills || []) lines.push(`- Skill ${sk.location}: ${sk.name || sk.path} ${sk.access || ""}`);
    for (const tool of e.tools || []) lines.push(`- Tool ${tool.name}: calls=${tool.calls}, failed=${tool.failed}, outputChars=${tool.outputChars}`);
    for (const call of e.toolCalls || []) lines.push(`- Call ${call.timestamp || "time unknown"} ${call.location}${call.itemId ? ` [item ${call.itemId}]` : ""} -> ${call.outputLocation} (${call.completedAt || "end unknown"}) ${call.name}${call.failed ? " FAILED" : ""}: ${call.commandPreview}`);
    for (const repeat of e.repeatedCalls || []) lines.push(`- Repeated ${repeat.count}x ${repeat.firstLocation} -> ${repeat.lastLocation}: ${repeat.commandPreview}`);
    for (const fail of e.failures || []) lines.push(`- Check ${fail.location}: ${fail.reason}`);
    if (e.result) lines.push(`- Last assistant (${e.result.phase || "phase unknown"}) ${e.result.location}${e.result.itemId ? ` [item ${e.result.itemId}]` : ""}: ${e.result.preview}${e.result.truncated ? " [excerpt]" : ""}`);
    for (const gap of e.gaps) lines.push(`- GAP: ${gap.reason}${gap.location ? ` (${gap.location})` : ""}`);
  }
  return lines.join("\n");
}

function formatMarkdown(report) {
  if (report.subagentsOnly) return formatSubagentEvidence(report.subagentEvidence);
  const lines = [];
  const s = report.session;
  for (const gap of report.historicalGaps || []) lines.push(`- GAP ${gap.location}: ${gap.reason}`);
  lines.push(`# Session Evidence Report: ${s.id || "unknown"}`);
  if (s.title) {
    lines.push(`- Title: \`${s.title}\``);
  }
  lines.push(`- Workspace: \`${s.cwd || "unknown"}\``);
  lines.push(
    `- Forked From: \`${s.forkedFromId || "none"}\` (ordinal exclusive: ${
      s.forkedFromOrdinalExclusive ?? "none"
    })`
  );
  lines.push(
    `- Ordinals: \`${s.minOrdinal}..${s.maxOrdinal}\` (unique: ${s.uniqueOrdinals}, gaps: ${s.ordinalGaps.length})`
  );
  lines.push(`- Time Range: \`${s.firstTimestamp}\` -> \`${s.lastTimestamp}\``);
  lines.push(
    `- Review Range: since ordinal ${s.sinceOrdinal ?? "session start"}, until ordinal ${s.untilOrdinal ?? "end"}`
  );
  lines.push("");
  lines.push("## Files");
  for (const f of s.files) {
    const baseNote =
      f.historyBaseEndOrdinalExclusive !== null && f.historyBaseEndOrdinalExclusive !== undefined
        ? `, history_base < ${f.historyBaseEndOrdinalExclusive}`
        : "";
    lines.push(
      `- **${f.tag}**: \`${f.path}\` (${f.lines} lines, ${f.sizeBytes} bytes, ordinal \`${f.firstOrdinal}..${f.lastOrdinal}\`${baseNote})`
    );
  }
  if (Array.isArray(s.runs) && s.runs.length > 0) {
    const statsByRun = new Map((report.runStats || []).map((rs) => [rs.runId, rs]));
    lines.push("");
    lines.push(`## Runs / Providers (${s.runs.length})`);
    for (const r of s.runs) {
      const freshNote = r.freshContext ? ", freshContext=true" : "";
      const rs = statsByRun.get(r.runId);
      const statsNote = !report.runStats
        ? ""
        : rs
        ? ` | tools=${rs.toolCallCount} failed=${rs.failedToolCount} output=${
            rs.assistantMessageCount > 0 ? "yes" : "no"
          } aborts=${rs.errorOrAbortCount}${rs.subagentCount ? ` subagents=${rs.subagentCount}` : ""}`
        : " | outside range";
      lines.push(
        `- Run #${r.ordinal}: \`${r.providerInstanceId || "unknown"}\` / \`${r.model || "unknown"}\` (${r.status}${freshNote}, \`${r.runId}\`)${statsNote}`
      );
    }
  }
  if (Array.isArray(report.contextSegments) && report.contextSegments.length > 0) {
    lines.push("");
    lines.push(`## Context Segments (${report.contextSegments.length})`);
    for (const seg of report.contextSegments) {
      lines.push(
        `- Segment #${seg.segmentIndex} [${seg.boundaryReasons.join(", ")}]: runs #${seg.firstRunOrdinal}..#${seg.lastRunOrdinal} (${seg.runCount} runs, \`${seg.providerInstanceId || "unknown"}\` / \`${seg.model || "unknown"}\`, pt \`${seg.providerThreadId || "none"}\`) | human=${seg.humanRuns}, scheduled=${seg.scheduledRuns}, manual=${seg.manualScheduledRuns}, failed=${seg.failedRuns}`
      );
    }
  }
  if (Array.isArray(report.scheduledTasks) && report.scheduledTasks.length > 0) {
    lines.push("");
    lines.push(`## Scheduled Tasks (${report.scheduledTasks.length})`);
    for (const t of report.scheduledTasks) {
      const st = t.inRangeStats || {};
      lines.push(
        `- \`${t.scheduledTaskId}\` (${t.title || "untitled"}, mode=\`${t.threadMode || "unknown"}\`, enabled=${t.enabled ?? "unknown"}): inRange=${st.totalRuns ?? 0} (auto=${st.scheduledAutoRuns ?? 0}, manual=${st.manualTriggerRuns ?? 0}, completed=${st.completedRuns ?? 0}, failed/aborted=${st.failedOrInterruptedRuns ?? 0}, zeroTool=${st.zeroToolRuns ?? 0}, toolUsing=${st.nonZeroToolRuns ?? 0}, failedTools=${st.failedToolRuns ?? 0}, subagent=${st.subagentRuns ?? 0}, silent=${st.silentRuns ?? 0}, output=${st.outputRuns ?? 0}, totalTools=${st.totalToolCalls ?? 0})`
      );
    }
  }
  if (s.ordinalCollisions && s.ordinalCollisions.length > 0) {
    lines.push("");
    lines.push(`## Ordinal Collisions / Rewound Branches (${s.ordinalCollisions.length})`);
    for (const col of s.ordinalCollisions) {
      lines.push(
        `- ordinal ${col.ordinal}: ${col.firstLocation} (${col.firstType}) vs ${col.collidingLocation} (${col.collidingType})`
      );
    }
  }
  lines.push("");
  lines.push(`## Compactions (${report.compactions.length})`);
  for (const c of report.compactions) {
    const itemNote = c.itemId ? `, item \`${c.itemId}\`` : "";
    lines.push(`- ${c.location} (ordinal ${c.ordinal}, ${c.timestamp}${itemNote})`);
  }
  if (Array.isArray(report.handoffs) && report.handoffs.length > 0) {
    lines.push("");
    lines.push(`## Context Handoffs (${report.handoffs.length})`);
    for (const h of report.handoffs) {
      lines.push(
        `- ${h.location} (ordinal ${h.ordinal}, ${h.timestamp}): ${h.title || "handoff"} [${(
          h.fromProviderInstanceIds || []
        ).join(",")} -> ${h.toProviderInstanceId || "unknown"}] (\`${h.strategy || "unknown"}\`, item \`${h.itemId}\`)`
      );
    }
  }
  if (Array.isArray(report.subagents) && report.subagents.length > 0) {
    lines.push("");
    lines.push(`## Subagents (${report.subagents.length})`);
    for (const sub of report.subagents) {
      const childNote =
        sub.childItemCount > 0
          ? `, unbounded childItems=${sub.childItemCount}, childFailed=${sub.childFailedCount || 0}; bounded evidence below`
          : "";
      const cleanTitle = (sub.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
      lines.push(
        `- ${sub.location} (ordinal ${sub.ordinal}): \`${sub.driver || sub.providerInstanceId || "unknown"}\` ${cleanTitle} -> \`${sub.childThreadId || "none"}\` (${sub.status}${childNote}, item \`${sub.itemId}\`)`
      );
    }
  }
  lines.push("");
  const userTokens = report.skills.userTokens || [];
  const fileWrites = report.skills.fileWrites || [];
  lines.push(
    `## Skills (Injected/Skill tool: ${report.skills.injected.length}, User $tokens: ${userTokens.length}, File Reads: ${report.skills.fileReads.length}, File Writes: ${fileWrites.length})`
  );
  if (s.source === "t3_sqlite") {
    lines.push(
      "- Note: T3 does not store Codex `<skill>` injection bodies; `$name` tokens in user messages are skill references — judge invocation vs. mention from context."
    );
  }
  for (const inj of report.skills.injected) {
    lines.push(
      `- [Injected] ${inj.location} \`${inj.name}\` (\`${inj.path}\`, sha256: \`${inj.sha256.slice(0, 12)}\`)`
    );
  }
  for (const tk of userTokens) {
    lines.push(
      `- [$token] ${tk.location} (run #${tk.runOrdinal ?? "?"}) ${tk.names.map((n) => `\`$${n}\``).join(", ")}: ${JSON.stringify(
        tk.userPreview
      )}`
    );
  }
  for (const sr of [...report.skills.fileReads, ...fileWrites]) {
    const label = sr.access === "write" ? "Write" : "Read";
    lines.push(
      `- [${label}] ${sr.callLocation}->${sr.outputLocation || "?"} ${sr.paths
        .map((p) => `\`${p}\``)
        .join(", ")} (exit: ${sr.exitCodes.join(",") || "0"}, truncated: ${sr.truncated})`
    );
  }
  lines.push("");
  lines.push(`## Non-Zero / Failed Tool Calls (${report.nonZeroTools.length})`);
  for (const nz of report.nonZeroTools) {
    const itemNote = nz.itemId ? ` [item \`${nz.itemId}\`]` : "";
    const agentNote = nz.agent ? ` (${nz.agent})` : "";
    const reasonNote = nz.failureReason ? `; by: ${nz.failureReason}` : "";
    lines.push(
      `- ${nz.callLocation}->${nz.outputLocation}${itemNote}${agentNote} (exit: ${nz.exitCodes.join(",")}${reasonNote}): \`${(
        nz.commandPreview || ""
      ).replace(/\s+/g, " ")}\``
    );
  }
  const suspiciousOutputs = Array.isArray(report.suspiciousSuccessOutputs) ? report.suspiciousSuccessOutputs : [];
  if (suspiciousOutputs.length > 0) {
    lines.push("");
    lines.push(`## Suspicious Exit-0 Outputs (Verify in Context) (${suspiciousOutputs.length})`);
    for (const item of suspiciousOutputs) {
      const itemNote = item.itemId ? ` [item \`${item.itemId}\`]` : "";
      const agentNote = item.agent ? ` (${item.agent})` : "";
      lines.push(
        `- ${item.callLocation}->${item.outputLocation}${itemNote}${agentNote} (exit: ${item.exitCodes.join(",") || "0"}; ${item.note}): \`${(
          item.commandPreview || ""
        ).replace(/\s+/g, " ")}\``
      );
    }
  }
  const approvalRequests = Array.isArray(report.approvalRequests) ? report.approvalRequests : [];
  if (approvalRequests.length > 0) {
    lines.push("");
    lines.push(`## Approval Requests (${approvalRequests.length})`);
    for (const req of approvalRequests) {
      const itemNote = req.itemId ? ` [item \`${req.itemId}\`]` : "";
      const endNote = req.completedAt ? ` -> ${req.completedAt}` : "";
      lines.push(
        `- ${req.location} (ordinal ${req.ordinal}, ${req.timestamp || "?"}${endNote})${itemNote} kind=${req.requestKind || "unknown"} status=${req.status || "unknown"}: \`${(req.promptPreview || "").replace(/`/g, "'")}\``
      );
    }
  }
  const turnAborts = Array.isArray(report.turnAborts) ? report.turnAborts : [];
  if (turnAborts.length > 0) {
    lines.push("");
    lines.push(`## Interrupts / Errors (${turnAborts.length})`);
    for (const ab of turnAborts) {
      const itemNote = ab.itemId ? ` [item \`${ab.itemId}\`]` : "";
      lines.push(
        `- ${ab.location} (ordinal ${ab.ordinal ?? "?"}, ${ab.timestamp || "?"})${itemNote}: ${ab.reason || "aborted"}`
      );
    }
  }
  if (Array.isArray(report.scheduledTriggers) && report.scheduledTriggers.length > 0) {
    lines.push("");
    lines.push(`## Scheduled Triggers (${report.scheduledTriggers.length})`);
    for (const tr of report.scheduledTriggers) {
      const agentNote = tr.agent ? ` [${tr.agent}]` : "";
      const freshNote = tr.freshContext ? " freshContext=true" : "";
      lines.push(
        `- [${tr.index}] ${tr.location} (ordinal ${tr.ordinal}, ${tr.timestamp})${agentNote} \`${tr.triggerKind}\` task=\`${tr.scheduledTaskId}\`${freshNote} tools=${tr.toolCallCount ?? 0} failedTools=${tr.failedToolCount ?? 0} output=${tr.hasAssistantOutput ? "yes" : "no"} status=${tr.runStatus || "unknown"} item \`${tr.itemId}\``
      );
    }
  }
  lines.push("");
  lines.push(`## Human Inputs (${report.humanInputs.length})`);
  for (const h of report.humanInputs) {
    const agentNote = h.agent ? ` [${h.agent}]` : "";
    const freshNote = h.freshContext ? " [freshContext]" : "";
    const itemNote = h.itemId ? ` item \`${h.itemId}\`` : "";
    lines.push(
      `### [${h.index}] ${h.location} (ordinal ${h.ordinal}, ${h.timestamp})${agentNote}${freshNote}${itemNote}`
    );
    if (h.precedingAssistant) {
      lines.push(
        `> Preceding Assistant (${h.precedingAssistant.location}): ${h.precedingAssistant.preview.replace(
          /\n/g,
          " "
        )}`
      );
    }
    if (Array.isArray(h.citations) && h.citations.length > 0) {
      for (const c of h.citations) {
        lines.push(
          `> Decoded Citation (${c.label}): quoted=${JSON.stringify(c.quotedText)} comment=${JSON.stringify(c.comment)}`
        );
      }
    }
    if (Array.isArray(h.attachedContexts) && h.attachedContexts.length > 0) {
      for (const ctx of h.attachedContexts) {
        lines.push(
          `> Attached Context (${ctx.kind}): threadId=${ctx.threadId} env=${ctx.environmentId} title=${JSON.stringify(ctx.title)}`
        );
      }
    }
    lines.push("```text");
    lines.push(h.text);
    lines.push("```");
  }
  if (Array.isArray(report.toolCalls) && report.toolCalls.length > 0) {
    lines.push("");
    lines.push(`## Tool Calls by Run (${report.toolCalls.length})`);
    let currentRun;
    for (const tc of report.toolCalls) {
      if (tc.runOrdinal !== currentRun) {
        currentRun = tc.runOrdinal;
        lines.push(`### Run #${currentRun ?? "?"}`);
      }
      const time = typeof tc.timestamp === "string" ? tc.timestamp.slice(11, 19) : "?";
      const exitNote = tc.exitCodes.length > 0 ? tc.exitCodes.join(",") : "-";
      lines.push(
        `- ${tc.location} ${time} \`${tc.toolName}\` exit=${exitNote}${tc.failed ? " FAILED" : ""} out=${tc.outputChars}: \`${tc.commandPreview.replace(/`/g, "'")}\``
      );
    }
  }
  if (report.subagentEvidence) lines.push("", formatSubagentEvidence(report.subagentEvidence));
  return lines.join("\n");
}

function writeOutput(outText, outputPath) {
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, outText, "utf8");
  } else {
    process.stdout.write(outText + "\n");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cleanupPath) {
    const result = cleanupTempEvidenceFile(opts.cleanupPath);
    writeOutput(JSON.stringify(result, null, 2), opts.output);
    return;
  }
  if (!opts.sessionId && opts.files.length === 0 && opts.itemIds.length === 0) {
    opts.sessionId = process.env.T3CODE_THREAD_ID || process.env.CODEX_THREAD_ID || null;
  }
  if (opts.help || (!opts.sessionId && opts.files.length === 0 && opts.itemIds.length === 0)) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }

  if (opts.itemIds.length === 1) {
    const itemRecord = lookupT3Item(opts.t3Db, opts.itemIds[0], opts.sessionId);
    writeOutput(JSON.stringify(itemRecord, null, 2), opts.output);
    return;
  }
  if (opts.itemIds.length > 1) {
    const items = lookupT3Items(opts.t3Db, opts.itemIds, opts.sessionId);
    writeOutput(
      JSON.stringify({ threadId: normalizeT3ThreadId(opts.sessionId), count: items.length, items }, null, 2),
      opts.output
    );
    return;
  }

  if (opts.sessionId && opts.files.length === 0 && hasT3Thread(opts.t3Db, opts.sessionId)) {
    if (opts.preflight) {
      const result = preflightT3Thread(opts.t3Db, opts.sessionId, opts);
      writeOutput(JSON.stringify(result, null, 2), opts.output);
      return;
    }
    const subagentEvidence = await collectSubagentEvidence(opts);
    const report = opts.subagentsOnly ? { subagentsOnly: true, subagentEvidence } :
      { ...analyzeT3Thread(opts.t3Db, opts.sessionId, { ...opts, untilTime: subagentEvidence.untilTime }), subagentEvidence };
    const outText =
      opts.format === "md" ? formatMarkdown(report) : JSON.stringify(report, null, 2);
    writeOutput(outText, opts.output);
    return;
  }

  let targetFiles = [...opts.files];
  if (opts.sessionId && targetFiles.length === 0) {
    const sessionsRoot = path.join(opts.codexHome, "sessions");
    targetFiles = findSessionFiles(sessionsRoot, opts.sessionId);
    if (targetFiles.length === 0) {
      console.error(`No rollout JSONL files found for session ID: ${opts.sessionId}`);
      process.exit(2);
    }
  }

  if (opts.preflight) {
    const result = await preflightFiles(targetFiles, opts);
    writeOutput(JSON.stringify(result, null, 2), opts.output);
    return;
  }

  const subagentEvidence = await collectSubagentEvidence({ ...opts, files: targetFiles });
  const report = opts.subagentsOnly ? { subagentsOnly: true, subagentEvidence } :
    { ...await analyzeFiles(targetFiles, opts), subagentEvidence };
  const outText =
    opts.format === "md" ? formatMarkdown(report) : JSON.stringify(report, null, 2);
  writeOutput(outText, opts.output);
}

export { formatMarkdown };

const resolveReal = (targetPath) => { try { return fs.realpathSync(path.resolve(targetPath)); } catch { return path.resolve(targetPath); } };
const isMain = Boolean(process.argv[1]) && resolveReal(process.argv[1]) === resolveReal(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
