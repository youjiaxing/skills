/**
 * Real WorkerLauncher — foreground Grok Build / Claude Code processes.
 *
 * Shares the same launch DTO as the fake launcher (buildLaunchContract /
 * buildResumeContract). Chain Run injects either implementation.
 *
 * Contract highlights (ticket 12):
 * - Foreground, intervenable TUI — never default to headless -p/--print/--single
 * - model/effort omitted → do not pass corresponding flags (runtime product default)
 * - Resumable paths never enable --no-session-persistence (or equivalents)
 * - Spawn bookkeeping returns at least pid; session id best-effort
 *   (default: preallocate UUID via --session-id so needs-resume can fulfill)
 * - Resume: --resume <id> + original cwd/runtime; no fresh skill entry prompt
 *
 * Terminal / window API is intentionally thin: detached child with visible
 * console (Windows new console group). Callers may replace spawnWorker.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { normalizeOptionalFlag } from './build-launch-contract.mjs';

/** Flags never allowed on the default foreground / resumable Worker path. */
const FORBIDDEN_WORKER_FLAGS = new Set([
  '-p',
  '--print',
  '--single',
  '--no-session-persistence',
]);

/**
 * Resolve binary name for a runtime. Overridable via options.commands.
 * @param {'grok'|'claude'} runtime
 * @param {Record<string, string>} [commands]
 */
export function resolveCommand(runtime, commands = {}) {
  if (commands[runtime]) return commands[runtime];
  if (runtime === 'grok') return 'grok';
  if (runtime === 'claude') return 'claude';
  throw new Error(`unsupported runtime: ${runtime}`);
}

/**
 * Pure argv builder — primary unit seam for the real launcher.
 *
 * @param {object} request launch / resume DTO from build-*-contract
 * @param {object} [options]
 * @param {() => string} [options.generateSessionId]
 * @param {boolean} [options.preallocateSessionId=true]
 * @param {Record<string, string>} [options.commands]
 * @returns {{
 *   command: string,
 *   args: string[],
 *   cwd: string,
 *   title: string|null,
 *   runtime: string,
 *   kind: string,
 *   sessionId: string|null,
 *   sessionIdStatus: 'preallocated'|'provided'|'unavailable',
 *   sessionIdNote: string|null,
 *   model: string|null,
 *   effort: string|null,
 * }}
 */
export function buildWorkerInvocation(request = {}, options = {}) {
  const {
    generateSessionId = randomUUID,
    preallocateSessionId = true,
    commands = {},
  } = options;

  const runtime = request.runtime;
  if (runtime !== 'grok' && runtime !== 'claude') {
    throw new Error(`runtime is required and must be grok|claude (got ${runtime})`);
  }
  if (!request.cwd) throw new Error('cwd is required');

  const kind = request.kind === 'resume' ? 'resume' : 'initial';
  const model = normalizeOptionalFlag(request.model);
  const effort = normalizeOptionalFlag(request.effort);
  const title = request.title ?? null;
  const command = resolveCommand(runtime, commands);
  const args = [];

  /** @type {string|null} */
  let sessionId = request.sessionId ? String(request.sessionId) : null;
  /** @type {'preallocated'|'provided'|'unavailable'} */
  let sessionIdStatus = sessionId ? 'provided' : 'unavailable';
  /** @type {string|null} */
  let sessionIdNote = null;

  if (kind === 'resume') {
    if (!sessionId) {
      throw new Error('sessionId is required for resume launch');
    }
    sessionIdStatus = 'provided';
    if (runtime === 'grok') {
      args.push('--cwd', request.cwd);
    }
    args.push('--resume', sessionId);
    // model/effort on resume: only if explicitly present (rare); omit otherwise.
    appendModelEffort(runtime, args, model, effort);
    // No initial prompt / skill re-entry on resume.
  } else {
    // initial
    if (!sessionId && preallocateSessionId) {
      sessionId = generateSessionId();
      sessionIdStatus = 'preallocated';
      sessionIdNote = null;
    } else if (!sessionId) {
      sessionIdStatus = 'unavailable';
      sessionIdNote =
        'session id not captured for foreground TUI spawn '
        + '(preallocateSessionId=false); needs-resume cannot auto-fulfill until an id is recorded';
    }

    if (runtime === 'grok') {
      args.push('--cwd', request.cwd);
      if (sessionId) {
        args.push('--session-id', sessionId);
      }
      appendModelEffort(runtime, args, model, effort);
      const prompt = request.initialPrompt ?? '';
      if (prompt) args.push(prompt);
    } else {
      // claude: title via -n; working directory is spawn cwd (no --cwd flag).
      if (title) {
        args.push('-n', title);
      }
      if (sessionId) {
        args.push('--session-id', sessionId);
      }
      appendModelEffort(runtime, args, model, effort);
      const prompt = request.initialPrompt ?? '';
      if (prompt) args.push(prompt);
    }
  }

  assertNoForbiddenFlags(args);

  return {
    command,
    args,
    cwd: request.cwd,
    title,
    runtime,
    kind,
    sessionId,
    sessionIdStatus,
    sessionIdNote,
    model,
    effort,
  };
}

function appendModelEffort(runtime, args, model, effort) {
  if (model) {
    if (runtime === 'grok') {
      args.push('-m', model);
    } else {
      args.push('--model', model);
    }
  }
  if (effort) {
    // Both CLIs accept --effort (grok aliases --reasoning-effort).
    args.push('--effort', effort);
  }
}

function assertNoForbiddenFlags(args) {
  for (const arg of args) {
    if (FORBIDDEN_WORKER_FLAGS.has(arg)) {
      throw new Error(`refusing to launch with forbidden flag: ${arg}`);
    }
  }
}

/**
 * Resolve `grok` / `claude` to an absolute path when possible (Windows Process.Start
 * is more reliable with a full path).
 */
export function resolveExecutable(command, { platform = process.platform } = {}) {
  if (!command) throw new Error('command is required');
  if (command.includes('/') || command.includes('\\')) return command;
  if (platform === 'win32') {
    const looked = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
    if (looked.status === 0) {
      const first = String(looked.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first) return first;
    }
  } else {
    const looked = spawnSync('command', ['-v', command], { encoding: 'utf8', shell: true });
    if (looked.status === 0) {
      const first = String(looked.stdout || '').trim().split(/\r?\n/).find(Boolean);
      if (first) return first;
    }
  }
  return command;
}

/**
 * Grok stores sessions under ~/.grok/sessions/<url-encoded-cwd>/<session-id>/.
 * Encoding matches observed on-disk layout (backslash → %5C, colon → %3A).
 */
export function grokSessionDir(cwd, sessionId, { grokHome } = {}) {
  if (!cwd) throw new Error('cwd is required');
  if (!sessionId) throw new Error('sessionId is required');
  const home = grokHome || process.env.GROK_HOME || path.join(os.homedir(), '.grok');
  const encodedCwd = String(cwd).replace(/\\/gu, '%5C').replace(/:/gu, '%3A');
  return path.join(home, 'sessions', encodedCwd, String(sessionId));
}

/**
 * Flatten one chat_history.jsonl content field to searchable text.
 * Grok stores either a plain string or [{type:'text', text:'...'}].
 */
function flattenHistoryContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part == null) return '';
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && typeof part.text === 'string') return part.text;
      try {
        return JSON.stringify(part);
      } catch {
        return '';
      }
    }).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/**
 * Classify a Grok `chat_history.jsonl` body as blank vs restorable history.
 *
 * Blank (product bug / dead bootstrap): missing file, empty, or only system +
 * skills system-reminder user turns — no real operator `user_query`.
 * Non-blank: at least one user turn carrying `<user_query>` (and optionally
 * a skill slash like `/implement` / `/wayfinder`).
 *
 * This is the red/green probe for needs-resume: spawn success alone is not enough.
 *
 * @param {string|null|undefined} text raw jsonl
 * @returns {{
 *   exists: boolean,
 *   blank: boolean,
 *   userCount: number,
 *   systemCount: number,
 *   hasUserQuery: boolean,
 *   hasSkillEntry: boolean,
 *   lineCount: number,
 *   reason: string|null,
 * }}
 */
export function classifyGrokChatHistory(text) {
  if (text == null) {
    return {
      exists: false,
      blank: true,
      userCount: 0,
      systemCount: 0,
      hasUserQuery: false,
      hasSkillEntry: false,
      lineCount: 0,
      reason: 'missing',
    };
  }

  const raw = String(text);
  if (raw.trim() === '') {
    return {
      exists: true,
      blank: true,
      userCount: 0,
      systemCount: 0,
      hasUserQuery: false,
      hasSkillEntry: false,
      lineCount: 0,
      reason: 'empty',
    };
  }

  const lines = raw.split(/\r?\n/u).filter((line) => line.trim() !== '');
  let userCount = 0;
  let systemCount = 0;
  let hasUserQuery = false;
  let hasSkillEntry = false;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const type = entry?.type || entry?.role || 'unknown';
    if (type === 'system') systemCount += 1;
    if (type === 'user') {
      userCount += 1;
      const body = flattenHistoryContent(entry.content);
      if (/<user_query\b/iu.test(body)) hasUserQuery = true;
      if (/\/implement\b/u.test(body) || /\/wayfinder\b/u.test(body)) {
        hasSkillEntry = true;
      }
    }
  }

  if (hasUserQuery) {
    return {
      exists: true,
      blank: false,
      userCount,
      systemCount,
      hasUserQuery,
      hasSkillEntry,
      lineCount: lines.length,
      reason: null,
    };
  }

  return {
    exists: true,
    blank: true,
    userCount,
    systemCount,
    hasUserQuery,
    hasSkillEntry,
    lineCount: lines.length,
    reason: userCount === 0
      ? 'no-user-turns'
      : 'bootstrap-reminder-only',
  };
}

/**
 * Read Grok session chat_history.jsonl and classify blank vs non-blank.
 * Inject readFile/access for unit tests; production uses fs promises.
 *
 * @returns {Promise<object>} classifyGrokChatHistory fields + path
 */
export async function readGrokChatHistory({
  cwd,
  sessionId,
  grokHome,
  readFile = (file) => fs.readFile(file, 'utf8'),
  access = (file) => fs.access(file),
} = {}) {
  if (!cwd) throw new Error('cwd is required');
  if (!sessionId) throw new Error('sessionId is required');

  const historyPath = path.join(
    grokSessionDir(cwd, sessionId, { grokHome }),
    'chat_history.jsonl',
  );

  try {
    await access(historyPath);
  } catch {
    return {
      ...classifyGrokChatHistory(null),
      path: historyPath,
    };
  }

  try {
    const text = await readFile(historyPath);
    return {
      ...classifyGrokChatHistory(text),
      path: historyPath,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        ...classifyGrokChatHistory(null),
        path: historyPath,
      };
    }
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort: set Grok session title after spawn by patching summary.json.
 * Embedded `/rename` in the initial prompt is plain text and does not rename.
 * Leading `/rename` blanks the whole prompt — so title is applied out-of-band.
 *
 * @returns {Promise<boolean>} true when the title was written
 */
export async function applyGrokSessionTitle({
  cwd,
  sessionId,
  title,
  grokHome,
  timeoutMs = 4000,
  intervalMs = 100,
  now = () => Date.now(),
  sleepFn = sleep,
  readFile = (file) => fs.readFile(file, 'utf8'),
  writeFile = (file, body) => fs.writeFile(file, body, 'utf8'),
  access = (file) => fs.access(file),
} = {}) {
  const trimmed = title == null ? '' : String(title).trim();
  if (!cwd || !sessionId || !trimmed) return false;

  const summaryPath = path.join(grokSessionDir(cwd, sessionId, { grokHome }), 'summary.json');
  const deadline = now() + Math.max(0, timeoutMs);

  while (now() <= deadline) {
    try {
      await access(summaryPath);
      let current = {};
      try {
        current = JSON.parse(await readFile(summaryPath));
      } catch {
        current = {};
      }
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        current = {};
      }
      current.generated_title = trimmed;
      current.session_summary = trimmed;
      current.title_is_manual = true;
      if (!current.info || typeof current.info !== 'object') {
        current.info = { id: String(sessionId), cwd: String(cwd) };
      } else {
        current.info.id = current.info.id || String(sessionId);
        current.info.cwd = current.info.cwd || String(cwd);
      }
      await writeFile(summaryPath, `${JSON.stringify(current, null, 2)}\n`);
      return true;
    } catch {
      // summary not created yet
    }
    await sleepFn(intervalMs);
  }
  return false;
}

/**
 * Windows argv → single Arguments string (CreateProcess / ProcessStartInfo rules).
 * Mirrors Python subprocess.list2cmdline / MSVC C argv encoding.
 */
export function windowsArgvToCommandLine(args) {
  return (args ?? []).map((raw) => {
    const arg = String(raw);
    if (arg.length === 0) return '""';
    if (!/[\s\t"]/u.test(arg)) return arg;

    let out = '"';
    let backslashes = 0;
    for (const ch of arg) {
      if (ch === '\\') {
        backslashes += 1;
        continue;
      }
      if (ch === '"') {
        out += '\\'.repeat(backslashes * 2 + 1);
        out += '"';
        backslashes = 0;
        continue;
      }
      if (backslashes > 0) {
        out += '\\'.repeat(backslashes);
        backslashes = 0;
      }
      out += ch;
    }
    if (backslashes > 0) {
      out += '\\'.repeat(backslashes * 2);
    }
    out += '"';
    return out;
  }).join(' ');
}

/**
 * Windows: open a *new* visible window via .NET ProcessStartInfo (UseShellExecute)
 * and return the real worker pid. Args travel as one correctly-quoted command line
 * (Start-Process -ArgumentList array form mangles multi-arg + multiline prompts).
 * Helper powershell itself is hidden; the child is not.
 */
export function spawnWindowsForeground(command, args, options = {}) {
  const exe = resolveExecutable(command, { platform: 'win32' });
  const cwd = options.cwd || process.cwd();
  const argLine = windowsArgvToCommandLine(args);

  // Pass command line via env to avoid PowerShell quoting of the script itself.
  const script = `
$ErrorActionPreference = 'Stop'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:YJX_LAUNCH_CMD
$psi.WorkingDirectory = $env:YJX_LAUNCH_CWD
$psi.UseShellExecute = $true
$psi.Arguments = $env:YJX_LAUNCH_ARGSTR
$p = [System.Diagnostics.Process]::Start($psi)
if (-not $p) { throw 'Process.Start returned null' }
Write-Output $p.Id
`.trim();

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: {
        ...process.env,
        ...(options.env || {}),
        YJX_LAUNCH_CMD: exe,
        YJX_LAUNCH_CWD: cwd,
        // Env vars are UTF-16 on Windows; multiline prompts are fine.
        YJX_LAUNCH_ARGSTR: argLine,
      },
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(
      `Windows foreground spawn failed for ${command}`
      + (detail ? `: ${detail}` : ` (exit ${result.status})`),
    );
  }

  const lines = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const pid = Number(lines[lines.length - 1]);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Windows foreground spawn did not return a pid (stdout=${JSON.stringify(result.stdout)})`);
  }
  return { pid };
}

/**
 * Default OS spawn for a foreground, intervenable Worker.
 * - Windows: new visible window via Start-Process (real worker pid).
 * - POSIX: detached process group (stdio ignored); desktop/terminal emulators
 *   may still be layered by the operator — contract forbids headless -p default.
 * Does not wait for exit — Chain Run tracks liveness via pid.
 */
export function defaultSpawnWorker(command, args, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    return spawnWindowsForeground(command, args, options);
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.on('error', () => {
    // Liveness checks will observe a dead/missing pid; avoid unhandled error.
  });
  child.unref();
  if (child.pid == null) {
    throw new Error(`failed to spawn ${command}: no pid`);
  }
  return { pid: child.pid, child };
}

export function defaultIsProcessAlive(pid) {
  if (pid == null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH / Windows "no such process"
    if (error && (error.code === 'ESRCH' || error.code === 'EINVAL')) return false;
    // EPERM means the process exists but we cannot signal it — treat as alive.
    if (error && error.code === 'EPERM') return true;
    return false;
  }
}

export function defaultKillProcess(pid) {
  if (pid == null || pid <= 0) return;
  try {
    process.kill(pid);
  } catch (error) {
    if (error && error.code === 'ESRCH') return;
    throw error;
  }
}

/**
 * Real WorkerLauncher port (swap-compatible with createFakeLauncher).
 *
 * @param {object} [options]
 * @param {(command: string, args: string[], options: object) => { pid: number }} [options.spawnWorker]
 * @param {(pid: number) => boolean} [options.isProcessAlive]
 * @param {(pid: number) => void|Promise<void>} [options.killProcess]
 * @param {() => string} [options.generateSessionId]
 * @param {boolean} [options.preallocateSessionId=true]
 * @param {Record<string, string>} [options.commands] override binary names
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {typeof applyGrokSessionTitle} [options.applySessionTitle] grok title hook
 * @param {boolean} [options.applyGrokTitle=true]
 * @param {number} [options.grokTitleTimeoutMs=4000]
 * @param {typeof readGrokChatHistory} [options.readHistory] resume history probe
 * @param {boolean} [options.probeResumeHistory=true] attach blank/non-blank on grok resume
 */
export function createRealLauncher(options = {}) {
  const {
    spawnWorker = defaultSpawnWorker,
    isProcessAlive = defaultIsProcessAlive,
    killProcess = defaultKillProcess,
    generateSessionId = randomUUID,
    preallocateSessionId = true,
    commands = {},
    env,
    applySessionTitle = applyGrokSessionTitle,
    applyGrokTitle = true,
    grokTitleTimeoutMs = 4000,
    readHistory = readGrokChatHistory,
    probeResumeHistory = true,
  } = options;

  /** @type {Array<object>} */
  const launches = [];
  /** @type {Array<number>} */
  const kills = [];

  return {
    launches,
    kills,
    /**
     * @param {object} request
     * @returns {Promise<{
     *   pid: number,
     *   sessionId: string|null,
     *   sessionIdStatus: string,
     *   sessionIdNote: string|null,
     *   invocation: object,
     * }>}
     */
    async launch(request) {
      const invocation = buildWorkerInvocation(request, {
        generateSessionId,
        preallocateSessionId,
        commands,
      });

      const spawned = spawnWorker(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        detached: true,
        windowsHide: false,
        env,
      });

      if (spawned?.pid == null) {
        throw new Error(`spawn of ${invocation.command} returned no pid`);
      }

      /** @type {boolean|null} */
      let titleApplied = null;
      if (
        applyGrokTitle
        && request.runtime === 'grok'
        && request.kind !== 'resume'
        && invocation.sessionId
        && request.title
        && typeof applySessionTitle === 'function'
      ) {
        try {
          titleApplied = await applySessionTitle({
            cwd: invocation.cwd,
            sessionId: invocation.sessionId,
            title: request.title,
            timeoutMs: grokTitleTimeoutMs,
          });
        } catch {
          titleApplied = false;
        }
      }

      /** @type {object|null} */
      let history = null;
      if (
        probeResumeHistory
        && request.kind === 'resume'
        && request.runtime === 'grok'
        && invocation.sessionId
        && typeof readHistory === 'function'
      ) {
        try {
          history = await readHistory({
            cwd: invocation.cwd,
            sessionId: invocation.sessionId,
          });
        } catch {
          history = {
            exists: false,
            blank: true,
            reason: 'probe-error',
          };
        }
      }

      const result = {
        pid: spawned.pid,
        sessionId: invocation.sessionId,
        sessionIdStatus: invocation.sessionIdStatus,
        sessionIdNote: invocation.sessionIdNote,
        invocation,
        titleApplied,
        // Resume acceptance: blank vs non-blank history (not spawn-success alone).
        history,
      };
      launches.push({ ...request, result, invocation });
      return result;
    },
    isAlive(processId) {
      return isProcessAlive(processId);
    },
    async kill(processId) {
      kills.push(processId);
      await killProcess(processId);
    },
  };
}
