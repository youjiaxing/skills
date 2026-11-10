#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import crypto from "node:crypto";

function printHelp() {
  console.log(`Usage:
  node extract-session-evidence.mjs --session-id <thread-or-session-id> [options]
  node extract-session-evidence.mjs --file <rollout.jsonl> [--file <rollout2.jsonl> ...] [options]

Options:
  --session-id <id>       Locate rollout-*.jsonl files for this session/thread ID under <codex-home>/sessions
  --file <path>           Explicit JSONL file path (can be specified multiple times)
  --codex-home <dir>      Codex home directory (default: $CODEX_HOME or ~/.codex)
  --until-ordinal <n>     Exclude records with ordinal > <n> (fix retro cutoff point)
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
    untilOrdinal: null,
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
    } else if (arg === "--until-ordinal") {
      opts.untilOrdinal = Number(argv[++i]);
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
  return opts;
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
    .replace(/^#\s*AGENTS\.md instructions for [^\n]+\n\n<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, "")
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

async function analyzeFiles(filePaths, opts) {
  const filesMeta = [];
  const seenOrdinals = new Set();
  const allOrdinals = [];
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
      if (opts.untilOrdinal !== null && ord !== null && ord > opts.untilOrdinal) {
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
        if (!sessionMetaSummary) {
          sessionMetaSummary = {
            id: fileSessionId,
            cwd: obj.payload.cwd || null,
            forkedFromId: obj.payload.forked_from_id || null,
            forkedFromOrdinalExclusive: obj.payload.forked_from_ordinal_exclusive ?? null,
          };
        }
      }

      // Deduplicate by ordinal across rollout files when ordinal is present
      if (ord !== null) {
        if (seenOrdinals.has(ord)) {
          continue;
        }
        seenOrdinals.add(ord);
        allOrdinals.push(ord);
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
      minOrdinal: allOrdinals.length > 0 ? allOrdinals[0] : null,
      maxOrdinal: allOrdinals.length > 0 ? allOrdinals[allOrdinals.length - 1] : null,
      uniqueOrdinals: allOrdinals.length,
      ordinalGaps,
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
  lines.push("");
  lines.push("## Files");
  for (const f of s.files) {
    lines.push(
      `- **${f.tag}**: \`${f.path}\` (${f.lines} lines, ${f.sizeBytes} bytes, ordinal \`${f.firstOrdinal}..${f.lastOrdinal}\`)`
    );
  }
  lines.push("");
  lines.push(`## Compactions (${report.compactions.length})`);
  for (const c of report.compactions) {
    lines.push(`- ${c.location} (ordinal ${c.ordinal}, ${c.timestamp})`);
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
    lines.push(
      `- ${nz.callLocation}->${nz.outputLocation} (exit: ${nz.exitCodes.join(",")}): \`${(
        nz.commandPreview || ""
      ).replace(/\s+/g, " ")}\``
    );
  }
  lines.push("");
  lines.push(`## Human Inputs (${report.humanInputs.length})`);
  for (const h of report.humanInputs) {
    lines.push(`### [${h.index}] ${h.location} (ordinal ${h.ordinal}, ${h.timestamp})`);
    if (h.precedingAssistant) {
      lines.push(
        `> Preceding Assistant (${h.precedingAssistant.location}): ${h.precedingAssistant.preview.replace(
          /\n/g,
          " "
        )}`
      );
    }
    lines.push("```text");
    lines.push(h.text);
    lines.push("```");
  }
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.sessionId && opts.files.length === 0)) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
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

  const report = await analyzeFiles(targetFiles, opts);
  const outText =
    opts.format === "md" ? formatMarkdown(report) : JSON.stringify(report, null, 2);

  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.writeFileSync(opts.output, outText, "utf8");
  } else {
    process.stdout.write(outText + "\n");
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
