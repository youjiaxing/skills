/**
 * Cross-platform terminal host: prefer a new tab in the current multi-tab
 * emulator, fall back to an independent OS window.
 *
 * Contract (20260806-1636 / issue 04):
 * - Injectable detect + openTab adapters (fake detectors in unit tests)
 * - Best-effort Windows (Windows Terminal) + macOS (iTerm2 / Terminal.app)
 * - Detection success is **not** persisted across processes
 * - Same ic process may memory-cache a successful host id
 * - Optional explicit preferredHost overrides auto-detect
 * - openTab / detect failure → safe independent-window path (never hard-crash launch)
 *
 * No import of real-launcher (avoids cycles). Callers inject openFallbackWindow
 * and optional resolveExecutable / quoteWindowsArgs when building production hosts.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const HOST_IDS = Object.freeze({
  WINDOWS_TERMINAL: 'windows-terminal',
  MACOS_TERMINAL: 'macos-terminal',
  ITERM2: 'iterm2',
  FALLBACK_WINDOW: 'fallback-window',
});

const KNOWN_HOST_IDS = new Set(Object.values(HOST_IDS));

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeTerminalHostId(raw) {
  if (raw == null) return null;
  const id = String(raw).trim();
  if (!id) return null;
  return KNOWN_HOST_IDS.has(id) ? id : null;
}

/**
 * Best-effort: is `name` on PATH?
 * @param {string} name
 * @param {{ platform?: string, which?: (name: string) => string|null }} [options]
 */
export function commandOnPath(name, options = {}) {
  if (typeof options.which === 'function') {
    const found = options.which(name);
    return Boolean(found);
  }
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const looked = spawnSync('where.exe', [name], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return looked.status === 0 && Boolean(String(looked.stdout || '').trim());
  }
  const looked = spawnSync('command', ['-v', name], {
    encoding: 'utf8',
    shell: true,
  });
  return looked.status === 0 && Boolean(String(looked.stdout || '').trim());
}

/**
 * Best-effort: macOS app bundle exists / is installed.
 * @param {string} appName e.g. "iTerm" or "Terminal"
 * @param {{ platform?: string, appExists?: (name: string) => boolean, runOsascript?: (source: string) => { status: number } }} [options]
 */
export function macAppAvailable(appName, options = {}) {
  if (typeof options.appExists === 'function') {
    return options.appExists(appName);
  }
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return false;
  const run =
    options.runOsascript
    || ((source) =>
      spawnSync('osascript', ['-e', source], {
        encoding: 'utf8',
      }));
  const result = run(`id of application "${appName}"`);
  return result.status === 0;
}

function defaultResolveExecutable(command) {
  return command;
}

function defaultQuoteWindowsArgs(args) {
  return (args ?? []).map((raw) => {
    const arg = String(raw);
    if (arg.length === 0) return '""';
    if (!/[\s\t"]/u.test(arg)) return arg;
    return `"${arg.replace(/"/gu, '\\"')}"`;
  }).join(' ');
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

function buildPosixShellLine(command, args, cwd) {
  const parts = [command, ...(args || [])].map(shellQuote).join(' ');
  return `cd ${shellQuote(cwd)} && exec ${parts}`;
}

/**
 * Poll a pid file written by a tab wrapper script.
 * @param {string} pidFile
 * @param {{ timeoutMs?: number, intervalMs?: number, now?: () => number, sleepSync?: (ms: number) => void, readFileSync?: Function }} [options]
 * @returns {number|null}
 */
export function pollPidFile(pidFile, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const now = options.now || (() => Date.now());
  const sleepSync = options.sleepSync || ((ms) => {
    spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`], {
      timeout: ms + 100,
      windowsHide: true,
    });
  });
  const readFileSync = options.readFileSync || ((file) => fs.readFileSync(file, 'utf8'));
  const deadline = now() + Math.max(0, timeoutMs);
  while (now() <= deadline) {
    try {
      const text = String(readFileSync(pidFile) || '').trim();
      const pid = Number(text);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // not yet
    }
    if (now() >= deadline) break;
    sleepSync(intervalMs);
  }
  return null;
}

function writeTempFile(prefix, body, ext) {
  const file = path.join(os.tmpdir(), `${prefix}-${randomUUID()}${ext}`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function tryUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

/**
 * Windows Terminal host — new tab in last focused WT window, with pidfile capture.
 * @param {object} [options]
 */
export function createWindowsTerminalHost(options = {}) {
  const platform = options.platform || process.platform;
  const which = options.which;
  const resolveExe = options.resolveExecutable || defaultResolveExecutable;
  const quoteArgs = options.quoteWindowsArgs || defaultQuoteWindowsArgs;
  const runWt =
    options.runWt
    || ((args, spawnOptions) => {
      const result = spawnSync('wt.exe', args, {
        encoding: 'utf8',
        windowsHide: true,
        cwd: spawnOptions?.cwd,
        env: spawnOptions?.env ?? process.env,
      });
      return {
        status: result.status ?? 1,
        error: result.error,
        stderr: result.stderr,
      };
    });

  return {
    id: HOST_IDS.WINDOWS_TERMINAL,
    isAvailable() {
      if (platform !== 'win32') return false;
      return commandOnPath('wt', { platform, which })
        || commandOnPath('wt.exe', { platform, which });
    },
    openTab(command, args, openOptions = {}) {
      if (typeof options.openTab === 'function') {
        return options.openTab(command, args, openOptions);
      }
      const cwd = openOptions.cwd || process.cwd();
      const exe = resolveExe(command);
      const argLine = quoteArgs(args);
      const pidFile = path.join(os.tmpdir(), `yjx-ic-pid-${randomUUID()}.txt`);
      const scriptBody = [
        '$ErrorActionPreference = \'Stop\'',
        '$psi = New-Object System.Diagnostics.ProcessStartInfo',
        `$psi.FileName = ${psSingleQuote(exe)}`,
        `$psi.Arguments = ${psSingleQuote(argLine)}`,
        `$psi.WorkingDirectory = ${psSingleQuote(cwd)}`,
        '$psi.UseShellExecute = $false',
        '$p = [System.Diagnostics.Process]::Start($psi)',
        'if (-not $p) { throw \'Process.Start returned null\' }',
        `Set-Content -LiteralPath ${psSingleQuote(pidFile)} -Value $p.Id -Encoding ascii`,
        '$p.WaitForExit()',
        'exit $p.ExitCode',
        '',
      ].join('\n');
      const scriptFile = writeTempFile('yjx-ic-wt', scriptBody, '.ps1');
      try {
        const wtArgs = [
          '-w', '0',
          'new-tab',
          '-d', cwd,
          '--',
          'powershell.exe',
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptFile,
        ];
        const result = runWt(wtArgs, { cwd, env: openOptions.env });
        if (result.error && result.status == null) {
          throw new Error(`Windows Terminal tab open failed: ${result.error.message}`);
        }
        // wt often returns 0 immediately after hand-off; pid comes from the wrapper.
        if (typeof options.resolveWorkerPid === 'function') {
          const pid = options.resolveWorkerPid({ command: exe, args, cwd, pidFile });
          if (pid != null && Number(pid) > 0) return { pid: Number(pid) };
        }
        const pid = pollPidFile(pidFile, {
          timeoutMs: options.pidTimeoutMs ?? 5000,
          sleepSync: options.sleepSync,
          readFileSync: options.readFileSync,
          now: options.now,
        });
        if (pid == null) {
          throw new Error(
            'Windows Terminal tab opened but worker pid file was not written in time',
          );
        }
        return { pid };
      } finally {
        // Script may still be starting; best-effort cleanup of pid file only after read.
        tryUnlink(pidFile);
        // Leave scriptFile briefly for the tab; best-effort delayed cleanup is out of scope.
        // Unlink script after a short delay is racy on Windows; leave for OS temp cleanup.
      }
    },
  };
}

/**
 * macOS Terminal.app — best-effort via `do script` + pid-capturing shell wrapper.
 * Note: classic Terminal.app often opens a new window (not a true tab); iTerm2
 * is preferred first on darwin when available. Still better than a detached
 * independent process when the operator lives in Terminal.
 */
export function createMacOSTerminalHost(options = {}) {
  const platform = options.platform || process.platform;
  const runOsascript =
    options.runOsascript
    || ((source) =>
      spawnSync('osascript', ['-e', source], { encoding: 'utf8' }));

  return {
    id: HOST_IDS.MACOS_TERMINAL,
    isAvailable() {
      if (platform !== 'darwin') return false;
      return macAppAvailable('Terminal', {
        platform,
        appExists: options.appExists,
        runOsascript,
      });
    },
    openTab(command, args, openOptions = {}) {
      if (typeof options.openTab === 'function') {
        return options.openTab(command, args, openOptions);
      }
      const cwd = openOptions.cwd || process.cwd();
      const pidFile = path.join(os.tmpdir(), `yjx-ic-pid-${randomUUID()}.txt`);
      const shellLine = [
        `echo $$ > ${shellQuote(pidFile)}`,
        buildPosixShellLine(command, args, cwd),
      ].join(' && ');
      const script = [
        'tell application "Terminal"',
        '  activate',
        `  do script ${appleScriptString(shellLine)}`,
        'end tell',
      ].join('\n');
      const result = runOsascript(script);
      if (result.status !== 0) {
        throw new Error(
          `Terminal.app tab open failed: ${result.stderr || result.error?.message || result.status}`,
        );
      }
      if (typeof options.resolveWorkerPid === 'function') {
        const pid = options.resolveWorkerPid({ command, args, cwd, pidFile });
        if (pid != null && Number(pid) > 0) return { pid: Number(pid) };
      }
      const pid = pollPidFile(pidFile, {
        timeoutMs: options.pidTimeoutMs ?? 5000,
        sleepSync: options.sleepSync,
        readFileSync: options.readFileSync,
        now: options.now,
      });
      tryUnlink(pidFile);
      if (pid == null) {
        throw new Error(
          'Terminal.app tab opened but worker pid file was not written in time',
        );
      }
      // Note: pid is the shell that then execs the worker (same pid after exec).
      return { pid };
    },
  };
}

/**
 * iTerm2 — new tab via osascript + pid-capturing shell line.
 */
export function createITerm2Host(options = {}) {
  const platform = options.platform || process.platform;
  const runOsascript =
    options.runOsascript
    || ((source) =>
      spawnSync('osascript', ['-e', source], { encoding: 'utf8' }));

  return {
    id: HOST_IDS.ITERM2,
    isAvailable() {
      if (platform !== 'darwin') return false;
      return macAppAvailable('iTerm', {
        platform,
        appExists: options.appExists,
        runOsascript,
      });
    },
    openTab(command, args, openOptions = {}) {
      if (typeof options.openTab === 'function') {
        return options.openTab(command, args, openOptions);
      }
      const cwd = openOptions.cwd || process.cwd();
      const pidFile = path.join(os.tmpdir(), `yjx-ic-pid-${randomUUID()}.txt`);
      const shellLine = [
        `echo $$ > ${shellQuote(pidFile)}`,
        buildPosixShellLine(command, args, cwd),
      ].join(' && ');
      const script = [
        'tell application "iTerm"',
        '  activate',
        '  try',
        '    tell current window',
        '      create tab with default profile',
        '    end tell',
        '  on error',
        '    create window with default profile',
        '  end try',
        '  tell current session of current window',
        `    write text ${appleScriptString(shellLine)}`,
        '  end tell',
        'end tell',
      ].join('\n');
      const result = runOsascript(script);
      if (result.status !== 0) {
        throw new Error(
          `iTerm2 tab open failed: ${result.stderr || result.error?.message || result.status}`,
        );
      }
      if (typeof options.resolveWorkerPid === 'function') {
        const pid = options.resolveWorkerPid({ command, args, cwd, pidFile });
        if (pid != null && Number(pid) > 0) return { pid: Number(pid) };
      }
      const pid = pollPidFile(pidFile, {
        timeoutMs: options.pidTimeoutMs ?? 5000,
        sleepSync: options.sleepSync,
        readFileSync: options.readFileSync,
        now: options.now,
      });
      tryUnlink(pidFile);
      if (pid == null) {
        throw new Error(
          'iTerm2 tab opened but worker pid file was not written in time',
        );
      }
      return { pid };
    },
  };
}

/**
 * Platform default host chain (detect order). Linux: empty → window only.
 * @param {object} [options]
 * @returns {Array<{ id: string, isAvailable: Function, openTab: Function }>}
 */
export function buildDefaultHostChain(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    return [createWindowsTerminalHost(options)];
  }
  if (platform === 'darwin') {
    return [
      createITerm2Host(options),
      createMacOSTerminalHost(options),
    ];
  }
  return [];
}

/**
 * Prefer-tab launcher with optional process-local cache and explicit override.
 *
 * Detection success is process-local only (never written to repo config).
 *
 * @param {object} [options]
 * @param {string|null} [options.preferredHost] explicit config override
 * @param {Array} [options.hosts] injectable host adapters
 * @param {(command: string, args: string[], options: object) => { pid: number }} [options.openFallbackWindow]
 * @param {boolean} [options.cache=true] memory-cache a *successful* host id in this process
 * @param {string} [options.platform]
 */
export function createTerminalHostLauncher(options = {}) {
  const {
    preferredHost = null,
    hosts = null,
    openFallbackWindow = null,
    cache = true,
    platform = process.platform,
  } = options;

  if (typeof openFallbackWindow !== 'function') {
    throw new Error('createTerminalHostLauncher requires openFallbackWindow');
  }

  const hostList = Array.isArray(hosts)
    ? hosts
    : buildDefaultHostChain({ platform, ...options });
  /** @type {string|null} successful open host id for this process */
  let cachedHostId = null;

  function findHost(id) {
    return hostList.find((h) => h && h.id === id) || null;
  }

  function isHostAvailable(host) {
    if (!host || typeof host.isAvailable !== 'function') return false;
    try {
      return Boolean(host.isAvailable());
    } catch {
      return false;
    }
  }

  /**
   * Ordered candidates for auto-detect: cached success first, then remaining
   * available hosts. Does not cache until openTab succeeds.
   * @param {Set<string>} [skipIds]
   */
  function listAvailableHosts(skipIds = new Set()) {
    /** @type {Array<object>} */
    const ordered = [];
    if (cache && cachedHostId && !skipIds.has(cachedHostId)) {
      const cached = findHost(cachedHostId);
      if (cached && isHostAvailable(cached)) ordered.push(cached);
    }
    for (const host of hostList) {
      if (!host || skipIds.has(host.id)) continue;
      if (ordered.some((h) => h.id === host.id)) continue;
      if (isHostAvailable(host)) ordered.push(host);
    }
    return ordered;
  }

  function openViaHost(host, command, args, openOptions) {
    const result = host.openTab(command, args, openOptions);
    if (result == null || result.pid == null || !Number.isFinite(Number(result.pid))) {
      throw new Error(`host ${host.id} openTab returned no pid`);
    }
    return {
      pid: Number(result.pid),
      mode: 'tab',
      hostId: host.id,
    };
  }

  function openWindow(command, args, openOptions) {
    const result = openFallbackWindow(command, args, openOptions);
    if (result == null || result.pid == null) {
      throw new Error('fallback window spawn returned no pid');
    }
    return {
      pid: Number(result.pid),
      mode: 'window',
      hostId: HOST_IDS.FALLBACK_WINDOW,
      child: result.child,
    };
  }

  function rememberSuccess(hostId) {
    if (cache) cachedHostId = hostId;
  }

  return {
    getCachedHostId() {
      return cachedHostId;
    },
    clearCache() {
      cachedHostId = null;
    },
    /**
     * Open a Worker: prefer tab on detected/explicit host; never throw solely
     * because tab detection failed — fall back to independent window.
     *
     * @param {string} command
     * @param {string[]} args
     * @param {object} [openOptions]
     * @returns {{ pid: number, mode: 'tab'|'window', hostId: string, child?: object }}
     */
    open(command, args, openOptions = {}) {
      const preferred = normalizeTerminalHostId(preferredHost)
        || (preferredHost && findHost(String(preferredHost)) ? String(preferredHost) : null);

      if (preferred === HOST_IDS.FALLBACK_WINDOW) {
        return openWindow(command, args, openOptions);
      }

      if (preferred) {
        const host = findHost(preferred);
        if (host) {
          try {
            const opened = openViaHost(host, command, args, openOptions);
            rememberSuccess(host.id);
            return opened;
          } catch {
            return openWindow(command, args, openOptions);
          }
        }
      }

      for (const host of listAvailableHosts()) {
        try {
          const opened = openViaHost(host, command, args, openOptions);
          rememberSuccess(host.id);
          return opened;
        } catch {
          // try next host; only independent window after the chain is exhausted
        }
      }

      return openWindow(command, args, openOptions);
    },
  };
}
