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

      const result = {
        pid: spawned.pid,
        sessionId: invocation.sessionId,
        sessionIdStatus: invocation.sessionIdStatus,
        sessionIdNote: invocation.sessionIdNote,
        invocation,
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
