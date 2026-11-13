#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const RETRO_SKILL_NAME = "yjx-retro-skill";

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
  node extract-session-evidence.mjs --item-id <turn-item-id> [--session-id <id>] [options]

Options:
  --session-id <id>       Locate T3 thread in <t3-db> or rollout-*.jsonl files under <codex-home>/sessions
                          (defaults to $T3CODE_THREAD_ID or $CODEX_THREAD_ID when no --file is given)
  --file <path>           Explicit JSONL file path (can be specified multiple times)
  --codex-home <dir>      Codex home directory (default: $CODEX_HOME or ~/.codex)
  --t3-home <dir>         T3 Code home directory (default: $T3CODE_HOME or ~/.t3)
  --t3-db <path>          Explicit T3 statev2.sqlite path (default: <t3-home>/userdata/statev2.sqlite)
  --until-ordinal <n>     Exclude records with ordinal > <n> (fix retro cutoff point before the current call)
  --since-ordinal <n>     Exclude records with ordinal < <n> (start of a repeated retro range; session_meta is still read)
  --preflight             Read only session metadata, compaction/handoff markers and yjx-retro-skill invocations,
                           then print the review range start and routing decision
  --item-id <id>          Fetch full un-truncated JSON record for a single T3 turn_item_id
  --format <json|md>      Output format: json (default) or md
  --output <path>         Write output to file instead of stdout
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
    preflight: false,
    itemId: null,
    format: "json",
    output: null,
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
    } else if (arg === "--preflight") {
      opts.preflight = true;
    } else if (arg === "--item-id") {
      opts.itemId = argv[++i];
    } else if (arg === "--format") {
      opts.format = argv[++i];
    } else if (arg === "--output") {
      opts.output = argv[++i];
    } else if (!arg.startsWith("-")) {
      opts.files.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!opts.t3Db) {
    opts.t3Db = path.join(opts.t3Home, "userdata", "statev2.sqlite");
  }
  return opts;
}

export async function preflightFiles(filePaths, opts = {}) {
  const untilOrdinal = opts.untilOrdinal ?? null;
  const files = [];
  const compactions = [];
  const retroByOrdinal = new Map();
  const retroWithoutOrdinal = [];
  let sessionMeta = null;
  let pendingHumanPreview = null;
  let lastRetroEntry = null;

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
      if (
        obj.type === "response_item" &&
        payload.type === "message" &&
        payload.role === "user"
      ) {
        const rawText = extractContentText(payload.content);
        const cls = classifyUserMessage(rawText);
        if (cls.kind === "skill_injection" && cls.name === RETRO_SKILL_NAME) {
          const inv = {
            location: `${tag}:L${lineNo}`,
            ordinal: ord,
            timestamp: obj.timestamp || null,
            userPreview: pendingHumanPreview,
            assistantPreview: null,
          };
          lastRetroEntry = inv;
          if (ord === null) retroWithoutOrdinal.push(inv);
          else if (!retroByOrdinal.has(ord)) retroByOrdinal.set(ord, inv);
        } else if (cls.kind === "human") {
          pendingHumanPreview = cls.cleanText.slice(0, 240);
          if (isRetroInvocationText(rawText)) {
            const inv = {
              location: `${tag}:L${lineNo}`,
              ordinal: ord,
              timestamp: obj.timestamp || null,
              userPreview: pendingHumanPreview,
              assistantPreview: null,
            };
            lastRetroEntry = inv;
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
  const currentRetro = untilOrdinal === null ? retroInvocations[retroInvocations.length - 1] ?? null : null;
  const previousRetros = currentRetro ? retroInvocations.slice(0, -1) : retroInvocations;
  const previousRetro = previousRetros[previousRetros.length - 1] ?? null;
  const rangeStartOrdinal = opts.sinceOrdinal ?? (previousRetro ? previousRetro.ordinal : null);
  const rangeCompactions = compactions.filter(
    (c) => rangeStartOrdinal === null || c.ordinal === null || c.ordinal > rangeStartOrdinal
  );

  return {
    route: rangeCompactions.length > 0 ? "full" : "fast",
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
    rule: "range starts at the previous retro invocation (session start if none); compaction or cross-provider handoff inside the range selects full; Forked From is informational only",
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
  if (cls.kind === "skill_injection" && cls.name === RETRO_SKILL_NAME) {
    return true;
  }
  if (cls.kind === "human") {
    return /(?:^|\s|\$|\/|\[)yjx-retro-skill(?:\b|\]|$)/i.test(cls.cleanText);
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

    const compactions = [];
    const handoffs = [];
    const retroByOrdinal = new Map();
    let activeRetroCandidate = null;

    for (const item of items) {
      const ord = typeof item.ordinal === "number" ? item.ordinal : null;
      if (untilOrdinal !== null && ord !== null && ord > untilOrdinal) continue;
      const loc = `T3:pos=${item.position}`;
      const payload = safeJsonParse(item.payload_json);

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
        const text = typeof payload.text === "string" ? payload.text : "";
        if (isRetroInvocationText(text) && ord !== null && !retroByOrdinal.has(ord)) {
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
    const currentRetro =
      untilOrdinal === null ? retroInvocations[retroInvocations.length - 1] ?? null : null;
    const previousRetros = currentRetro ? retroInvocations.slice(0, -1) : retroInvocations;
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
    const runs = db
      .prepare(
        "SELECT run_id, ordinal, provider_instance_id, provider_thread_id FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal"
      )
      .all(threadId);
    const runById = new Map(runs.map((r) => [r.run_id, r]));
    for (const item of items) {
      const ord = typeof item.ordinal === "number" ? item.ordinal : null;
      if (!inReviewRange(ord)) continue;
      if (item.provider_thread_id) rangeProviderThreads.add(item.provider_thread_id);
      const run = item.run_id ? runById.get(item.run_id) : null;
      if (run?.provider_instance_id) rangeProviders.add(run.provider_instance_id);
    }

    const multiProviderInRange = rangeProviderThreads.size > 1 || rangeProviders.size > 1;
    const route =
      rangeCompactions.length > 0 || rangeHandoffs.length > 0 || multiProviderInRange
        ? "full"
        : "fast";

    return {
      source: "t3_sqlite",
      threadId,
      title: threadRow.title || null,
      route,
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
      forkedFrom: threadPayload.forkedFrom || null,
      files: [{ path: path.resolve(dbPath), tag: "T3DB" }],
      cutoffOrdinal: untilOrdinal,
      rule: "range starts at the previous retro invocation (session start if none); compaction, cross-provider handoff, or multiple provider threads inside the range selects full; Forked From is informational only",
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
  const failed =
    itemStatus === "failed" ||
    isErrorObj ||
    exitCodes.some((c) => c !== 0) ||
    outSummary.failed;
  return {
    exitCodes,
    failed,
    truncated: outSummary.truncated,
    preview: rawOut.slice(0, 320),
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
    const runs = runRows.map((r) => {
      const rp = safeJsonParse(r.payload_json);
      return {
        runId: r.run_id,
        ordinal: r.ordinal,
        providerInstanceId: r.provider_instance_id || r.provider || null,
        model: rp.modelSelection?.model || null,
        providerThreadId: r.provider_thread_id || null,
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
    const subagents = [];
    const skillInjections = [];
    const skillReads = [];
    const nonZeroTools = [];
    const humanInputs = [];

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
      const ts = payload.completedAt || payload.startedAt || item.updated_at || null;
      const loc = `T3:pos=${item.position}`;
      const run = item.run_id ? runById.get(item.run_id) : null;
      const agentTag = run
        ? `${run.providerInstanceId || "unknown"}${run.model ? `/${run.model}` : ""} (run #${run.ordinal})`
        : null;

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

      if (item.type === "run_interrupt_request" || item.type === "error") {
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

      if (item.type === "subagent") {
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
          status: item.status || payload.status || null,
          resultPreview: typeof payload.result === "string" ? payload.result.slice(0, 300) : null,
        });
        continue;
      }

      if (item.type === "assistant_message") {
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
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
          const citations = decodeT3Citations(cls.cleanText);
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
        const toolName =
          item.type === "command_execution"
            ? "command_execution"
            : payload.toolName || "dynamic_tool";
        const cmdInput =
          typeof payload.input === "string"
            ? payload.input
            : JSON.stringify(payload.input ?? "");
        const outSummary = parseT3ToolOutcome(item.type, item.status || payload.status, payload);

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

        const skillPaths = extractSkillPathsFromCommand(cmdInput);
        if (skillPaths.length > 0) {
          skillReads.push({
            callLocation: loc,
            outputLocation: loc,
            itemId: item.turn_item_id,
            ordinal: ord,
            callId: item.turn_item_id,
            paths: skillPaths,
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
            truncated: outSummary.truncated,
            outputPreview: outSummary.preview,
          });
        }
      }
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
      compactions,
      handoffs,
      subagents,
      turnAborts,
      skills: {
        injected: skillInjections,
        fileReads: skillReads,
      },
      nonZeroTools,
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
  const re = /[A-Za-z0-9_./\\:-]*skills[\\/][A-Za-z0-9_./\\:-]*\.md/gi;
  let m;
  while ((m = re.exec(cmdText)) !== null) {
    matches.add(m[0]);
  }
  return [...matches];
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
  const failed =
    exitCodes.some((c) => c !== 0) ||
    /Script failed|exec_command failed|ParserError:|Traceback \(most recent call last\)|ModuleNotFoundError:|AssertionError|ValueError:/i.test(
      raw
    );
  const truncated = /truncated output|chars truncated|tokens truncated/i.test(raw);
  return {
    exitCodes,
    failed,
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
          const skillPaths = extractSkillPathsFromCommand(cmdInput);
          const record = {
            callLocation: loc,
            ordinal: ord,
            timestamp: ts,
            name: payload.name || null,
            callId,
            cmdPreview: cmdInput.slice(0, 300),
            skillPaths,
          };
          if (callId) toolCallsById.set(callId, record);
          if (skillPaths.length > 0) {
            skillReads.push({
              callLocation: loc,
              outputLocation: null,
              ordinal: ord,
              callId,
              paths: skillPaths,
              exitCodes: [],
              truncated: false,
            });
          }
        } else if (pType === "custom_tool_call_output" || pType === "function_call_output") {
          const callId = payload.call_id;
          const priorCall = callId ? toolCallsById.get(callId) : null;
          const outSummary = parseToolOutputSummary(payload.output);
          if (priorCall && priorCall.skillPaths.length > 0) {
            const sr = skillReads.find((r) => r.callId === callId);
            if (sr) {
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
      fileReads: skillReads,
    },
    nonZeroTools,
    wrapperCounts: Object.fromEntries(
      Object.entries(wrapperLocations).map(([k, v]) => [k, { count: v.length, locations: v }])
    ),
    humanInputs,
  };
}
function formatMarkdown(report) {
  const lines = [];
  const s = report.session;
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
    lines.push("");
    lines.push(`## Runs / Providers (${s.runs.length})`);
    for (const r of s.runs) {
      lines.push(
        `- Run #${r.ordinal}: \`${r.providerInstanceId || "unknown"}\` / \`${r.model || "unknown"}\` (${r.status}, \`${r.runId}\`)`
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
      lines.push(
        `- ${sub.location} (ordinal ${sub.ordinal}): \`${sub.driver || sub.providerInstanceId || "unknown"}\` ${sub.title || ""} -> \`${sub.childThreadId || "none"}\` (${sub.status}, item \`${sub.itemId}\`)`
      );
    }
  }
  lines.push("");
  lines.push(
    `## Skills (Injected: ${report.skills.injected.length}, File Reads: ${report.skills.fileReads.length})`
  );
  for (const inj of report.skills.injected) {
    lines.push(
      `- [Injected] ${inj.location} \`${inj.name}\` (\`${inj.path}\`, sha256: \`${inj.sha256.slice(0, 12)}\`)`
    );
  }
  for (const sr of report.skills.fileReads) {
    lines.push(
      `- [Read] ${sr.callLocation}->${sr.outputLocation || "?"} ${sr.paths
        .map((p) => `\`${p}\``)
        .join(", ")} (exit: ${sr.exitCodes.join(",") || "0"}, truncated: ${sr.truncated})`
    );
  }
  lines.push("");
  lines.push(`## Non-Zero / Failed Tool Calls (${report.nonZeroTools.length})`);
  for (const nz of report.nonZeroTools) {
    const itemNote = nz.itemId ? ` [item \`${nz.itemId}\`]` : "";
    const agentNote = nz.agent ? ` (${nz.agent})` : "";
    lines.push(
      `- ${nz.callLocation}->${nz.outputLocation}${itemNote}${agentNote} (exit: ${nz.exitCodes.join(",")}): \`${(
        nz.commandPreview || ""
      ).replace(/\s+/g, " ")}\``
    );
  }
  lines.push("");
  lines.push(`## Human Inputs (${report.humanInputs.length})`);
  for (const h of report.humanInputs) {
    const agentNote = h.agent ? ` [${h.agent}]` : "";
    const itemNote = h.itemId ? ` item \`${h.itemId}\`` : "";
    lines.push(
      `### [${h.index}] ${h.location} (ordinal ${h.ordinal}, ${h.timestamp})${agentNote}${itemNote}`
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
  if (!opts.sessionId && opts.files.length === 0 && !opts.itemId) {
    opts.sessionId = process.env.T3CODE_THREAD_ID || process.env.CODEX_THREAD_ID || null;
  }
  if (opts.help || (!opts.sessionId && opts.files.length === 0 && !opts.itemId)) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }

  if (opts.itemId) {
    const itemRecord = lookupT3Item(opts.t3Db, opts.itemId, opts.sessionId);
    writeOutput(JSON.stringify(itemRecord, null, 2), opts.output);
    return;
  }

  if (opts.sessionId && opts.files.length === 0 && hasT3Thread(opts.t3Db, opts.sessionId)) {
    if (opts.preflight) {
      const result = preflightT3Thread(opts.t3Db, opts.sessionId, opts);
      writeOutput(JSON.stringify(result, null, 2), opts.output);
      return;
    }
    const report = analyzeT3Thread(opts.t3Db, opts.sessionId, opts);
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

  const report = await analyzeFiles(targetFiles, opts);
  const outText =
    opts.format === "md" ? formatMarkdown(report) : JSON.stringify(report, null, 2);
  writeOutput(outText, opts.output);
}

export { formatMarkdown };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
