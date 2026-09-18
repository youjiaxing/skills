#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, open, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG = Object.freeze({
  model: 'gpt-5.6-luna',
  reasoning: 'xhigh',
  fast: true,
});

const HELP = `Usage: node run-codex-cu.mjs [options]

Read one complete GUI test brief from standard input, execute it with Codex
Computer Use, and print a JSON summary.

Options:
  --cwd PATH             Project directory to test (default: current directory)
  --model ID             Codex model (default: ${DEFAULT_CONFIG.model})
  --reasoning EFFORT     Reasoning effort (default: ${DEFAULT_CONFIG.reasoning})
  --fast on|off          Explicitly enable or disable Fast
  --codex PATH           Codex executable (default: CODEX_CLI_PATH or codex)
  --artifacts-dir PATH   Directory for JSONL and stderr logs (default: OS temp)
  --dry-run              Print resolved configuration without starting Codex
  -h, --help             Show this help

Policy:
  Changing the model disables Fast unless --fast on is explicit.
  Changing only reasoning keeps Fast enabled by default.
`;

function requireValue(args, flag) {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseFast(value) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error('--fast must be on or off');
}

export function parseOptions(argv, {
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const options = {
    cwd: path.resolve(cwd),
    model: DEFAULT_CONFIG.model,
    reasoning: DEFAULT_CONFIG.reasoning,
    fastOverride: null,
    codex: env.CODEX_CLI_PATH || 'codex',
    artifactsDir: null,
    dryRun: false,
    help: false,
  };

  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--cwd') options.cwd = path.resolve(requireValue(args, argument));
    else if (argument === '--model') options.model = requireValue(args, argument);
    else if (argument === '--reasoning') options.reasoning = requireValue(args, argument);
    else if (argument === '--fast') options.fastOverride = parseFast(requireValue(args, argument));
    else if (argument === '--codex') options.codex = requireValue(args, argument);
    else if (argument === '--artifacts-dir') options.artifactsDir = path.resolve(requireValue(args, argument));
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }

  const modelChanged = options.model !== DEFAULT_CONFIG.model;
  options.fast = options.fastOverride ?? !modelChanged;
  return options;
}

function tomlString(value) {
  return JSON.stringify(value);
}

export function buildCodexArgs(options) {
  const args = [
    'exec',
    '--json',
    '-m', options.model,
    '-c', `model_reasoning_effort=${tomlString(options.reasoning)}`,
  ];

  if (options.fast) {
    args.push('-c', 'service_tier="fast"', '--enable', 'fast_mode');
  } else {
    args.push('-c', 'service_tier="default"', '--disable', 'fast_mode');
  }

  args.push(
    '-c', 'approval_policy="never"',
    '-s', 'danger-full-access',
    '--skip-git-repo-check',
    '-',
  );
  return args;
}

export function buildPrompt(brief) {
  const task = brief.trim();
  if (!task) throw new Error('a GUI test brief is required on standard input');
  return [
    'You are the delegated GUI test agent for one task on this computer.',
    'You are responsible for preparing, building, and launching the target as needed, operating the interface the way a user would, and reporting what you observed with evidence.',
    'You are not responsible for product code, configuration, or fixes; the invoking agent owns those. Change nothing in the tested repository.',
    'Use Computer Use to complete the task. Base the result on the GUI you actually operated; do not substitute a website or another app when the task names a specific surface.',
    'Launch and attach to exactly the copy described in the task. Never drive a different copy of the same product, such as one already installed or already running.',
    'Confirm that the interface you are driving is the copy you launched. If you cannot confirm it, stop and report STATUS: BLOCKED with what you found.',
    'Do not use the `yjx-codex-cu` skill or its runner script.',
    'Do not hand this task to another agent: start no nested Codex session, subagent, or Computer Use harness.',
    'Stay inside the task; do not investigate the invoking agent or its files.',
    'End with a concise report whose first line is exactly one of: STATUS: PASS, STATUS: FAIL, or STATUS: BLOCKED.',
    'Include the GUI path exercised and the relevant evidence or blocker.',
    '',
    'Task:',
    task,
  ].join('\n');
}

function textContainsComputerUse(value) {
  return typeof value === 'string' && /(^|[^a-z])(computer[ _-]?use|cua|sky)([^a-z]|$)/i.test(value);
}

function hasComputerUseMetadata(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if ((key === 'kind' || key === 'toolSurface' || key === 'surface') && textContainsComputerUse(String(child))) {
      return true;
    }
    if (hasComputerUseMetadata(child, seen)) return true;
  }
  return false;
}

export function isComputerUseItem(item) {
  if (!item || item.type !== 'mcp_tool_call') return false;
  if (textContainsComputerUse(item.server) || textContainsComputerUse(item.tool)) return true;
  return hasComputerUseMetadata(item._meta) || hasComputerUseMetadata(item.metadata);
}

export function createObservation() {
  return {
    threadId: null,
    terminalEvent: null,
    computerUseCalls: 0,
    computerUseFailedCalls: 0,
    finalMessage: null,
    reportedStatus: null,
    errors: [],
    malformedLines: 0,
  };
}

function itemSucceeded(item) {
  return !item?.error && item?.status !== 'failed' && item?.status !== 'error';
}

export function observeEvent(observation, event) {
  if (event.type === 'thread.started') observation.threadId = event.thread_id ?? null;
  if (event.type === 'turn.completed' || event.type === 'turn.failed') observation.terminalEvent = event.type;
  if (event.type === 'error') observation.errors.push(event);

  const item = event.item;
  if (event.type === 'item.completed' && isComputerUseItem(item)) {
    if (itemSucceeded(item)) observation.computerUseCalls += 1;
    else observation.computerUseFailedCalls += 1;
  }
  if (event.type === 'item.completed' && item?.type === 'agent_message') {
    observation.finalMessage = item.text ?? null;
    const match = item.text?.match(/^STATUS:\s*(PASS|FAIL|BLOCKED)\b/im);
    if (match) observation.reportedStatus = match[1];
  }
  return observation;
}

export function classifyResult({ exitCode, observation }) {
  if (exitCode !== 0 || observation.terminalEvent !== 'turn.completed') return 'BLOCKED';
  if (observation.computerUseCalls === 0) return 'BLOCKED';
  if (observation.reportedStatus === 'PASS') return 'PASS';
  if (observation.reportedStatus === 'FAIL') return 'FAIL';
  return 'BLOCKED';
}

async function findFile(root, predicate) {
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = await findFile(candidate, predicate);
        if (nested) return nested;
      } else if (predicate(entry.name, candidate)) {
        return candidate;
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return null;
}

export async function findRollout(threadId, {
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
} = {}) {
  if (!threadId) return null;
  const predicate = (name) => name.includes(threadId) && name.endsWith('.jsonl');
  return await findFile(path.join(codexHome, 'sessions'), predicate)
    ?? await findFile(path.join(codexHome, 'archived_sessions'), predicate);
}

export async function readTurnContext(rolloutPath) {
  if (!rolloutPath) return null;
  const handle = await open(rolloutPath, 'r');
  try {
    for await (const line of handle.readLines()) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'turn_context') {
        const payload = event.payload ?? {};
        return {
          model: payload.model ?? payload.collaboration_mode?.settings?.model ?? null,
          reasoning: payload.effort ?? payload.collaboration_mode?.settings?.reasoning_effort ?? null,
        };
      }
    }
  } finally {
    await handle.close();
  }
  return null;
}

export async function readStandardInput(input = process.stdin) {
  const chunks = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function makeArtifactsDir(requested) {
  if (requested) {
    await mkdir(requested, { recursive: true });
    return requested;
  }
  return await mkdtemp(path.join(os.tmpdir(), 'yjx-codex-cu-'));
}

async function waitForChild(child) {
  return await new Promise((resolve) => {
    let spawnError = null;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, spawnError }));
  });
}

export function buildSpawnOptions(options, {
  platform = process.platform,
  env = process.env,
} = {}) {
  const windowsShim = platform === 'win32' && !/\.(?:com|exe)$/i.test(options.codex);
  if (windowsShim && /\s/.test(options.codex)) {
    throw new Error('on Windows, put codex on PATH or pass a .exe path when the executable path contains spaces');
  }
  return {
    cwd: options.cwd,
    env,
    shell: windowsShim,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

async function pumpStream(source, destination) {
  for await (const chunk of source) await writeChunk(destination, chunk);
  destination.end();
}

export function exitCodeForStatus(status) {
  if (status === 'PASS') return 0;
  if (status === 'FAIL') return 1;
  return 2;
}

export async function runCodex(options, brief) {
  await access(options.cwd);
  const prompt = buildPrompt(brief);
  const artifactsDir = await makeArtifactsDir(options.artifactsDir);
  const eventsPath = path.join(artifactsDir, 'events.jsonl');
  const stderrPath = path.join(artifactsDir, 'stderr.log');
  const eventsStream = createWriteStream(eventsPath, { encoding: 'utf8' });
  const stderrStream = createWriteStream(stderrPath, { encoding: 'utf8' });
  const eventsFinished = finished(eventsStream);
  const stderrFinished = finished(stderrStream);
  const observation = createObservation();

  const child = spawn(options.codex, buildCodexArgs(options), buildSpawnOptions(options));
  const childCompletion = waitForChild(child);
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const stderrPump = pumpStream(child.stderr, stderrStream);

  let childResult;
  try {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      await writeChunk(eventsStream, `${line}\n`);
      try {
        observeEvent(observation, JSON.parse(line));
      } catch {
        observation.malformedLines += 1;
      }
    }

    eventsStream.end();
    childResult = await childCompletion;
    await stderrPump;
    await Promise.all([eventsFinished, stderrFinished]);
  } catch (error) {
    if (!child.killed) child.kill();
    eventsStream.destroy();
    stderrStream.destroy();
    await Promise.allSettled([childCompletion, stderrPump, eventsFinished, stderrFinished]);
    throw error;
  }

  const rolloutPath = await findRollout(observation.threadId);
  const recorded = await readTurnContext(rolloutPath);
  const status = classifyResult({ exitCode: childResult.code, observation });

  return {
    status,
    sessionId: observation.threadId,
    resumeCommand: observation.threadId ? `codex resume ${observation.threadId}` : null,
    requested: {
      model: options.model,
      reasoning: options.reasoning,
      fast: options.fast,
    },
    recorded: {
      model: recorded?.model ?? null,
      reasoning: recorded?.reasoning ?? null,
      fast: null,
      source: rolloutPath ? 'rollout' : null,
      missing: !recorded,
    },
    evidence: {
      computerUseCalls: observation.computerUseCalls,
      computerUseFailedCalls: observation.computerUseFailedCalls,
      terminalEvent: observation.terminalEvent,
      reportedStatus: observation.reportedStatus,
      finalMessage: observation.finalMessage,
      errors: observation.errors.length,
      malformedLines: observation.malformedLines,
    },
    process: {
      exitCode: childResult.code,
      signal: childResult.signal,
      spawnError: childResult.spawnError?.message ?? null,
    },
    artifacts: {
      directory: artifactsDir,
      events: eventsPath,
      stderr: stderrPath,
      rollout: rolloutPath,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      model: options.model,
      reasoning: options.reasoning,
      fast: options.fast,
      codex: options.codex,
      cwd: options.cwd,
      args: buildCodexArgs(options),
    }, null, 2)}\n`);
    return 0;
  }

  const brief = await readStandardInput();
  const summary = await runCodex(options, brief);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return exitCodeForStatus(summary.status);
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
