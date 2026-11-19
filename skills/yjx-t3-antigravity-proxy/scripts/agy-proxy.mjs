#!/usr/bin/env node

import { execFile as cpExecFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath,  } from 'node:url';
import { promisify } from 'node:util';
import { createAcpProxySession, createLineParser, parseGeminiDirFromArgs, terminateProcessTree } from './lib/acp-proxy.mjs';
import {
  DEFAULT_CONFIG,
  ensureDefaultConfig,
  launcherFileName,
  loadConfig,
  readJsonSafe,
  resolveBoundContext,
  resolveUpstreamBinary,
  restoreT3SettingsBinaryPath,
  settingsFilePath,
  updateT3SettingsBinaryPath,
  writeFileAtomic,
} from './lib/store.mjs';

const execFileAsync = promisify(cpExecFile);

function quotePosixSingle(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function validateWindowsBatchValue(label, value) {
  const str = String(value);
  if (/[\r\n"%]/u.test(str)) {
    throw new Error(`Unsupported character in Windows launcher ${label}: ${str}`);
  }
  return str;
}

export function renderPosixLauncher({ nodePath, runtimeEntry, installDir }) {
  const qNode = quotePosixSingle(nodePath);
  const qEntry = quotePosixSingle(runtimeEntry);
  const qInstall = quotePosixSingle(installDir);
  return [
    '#!/bin/sh',
    'set -eu',
    `NODE_BIN=${qNode}`,
    'if [ ! -x "$NODE_BIN" ]; then',
    '  NODE_BIN="$(command -v node || true)"',
    'fi',
    'if [ -z "$NODE_BIN" ]; then',
    '  echo "[agy-proxy] Node.js >= 22.13 is required but was not found." >&2',
    '  exit 127',
    'fi',
    `exec "$NODE_BIN" ${qEntry} --install-dir ${qInstall} "$@"`,
    '',
  ].join('\n');
}

export function renderWindowsLauncher({ nodePath, runtimeEntry, installDir }) {
  const safeNode = validateWindowsBatchValue('nodePath', nodePath);
  const safeEntry = validateWindowsBatchValue('runtimeEntry', runtimeEntry);
  const safeInstall = validateWindowsBatchValue('installDir', installDir);
  return [
    '@echo off',
    'setlocal',
    `set "NODE_BIN=${safeNode}"`,
    'if not exist "%NODE_BIN%" (',
    '  for /f "delims=" %%I in (\'where node 2^>nul\') do (',
    '    if not defined FOUND_NODE set "FOUND_NODE=%%I"',
    '  )',
    '  if defined FOUND_NODE set "NODE_BIN=%FOUND_NODE%"',
    ')',
    'if not exist "%NODE_BIN%" (',
    '  echo [agy-proxy] Node.js ^>= 22.13 is required but was not found. 1>&2',
    '  exit /b 127',
    ')',
    `"%NODE_BIN%" "${safeEntry}" --install-dir "${safeInstall}" %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

export async function verifyNodeSqliteSupport(nodePath) {
  if (path.resolve(nodePath) === path.resolve(process.execPath)) {
    try {
      await import('node:sqlite');
      return { ok: true, nodePath, version: process.version };
    } catch (error) {
      return {
        ok: false,
        nodePath,
        reason: `Current Node.js (${process.version}) does not support node:sqlite (requires >= 22.13.0): ${error?.message || error}`,
      };
    }
  }
  try {
    const { stdout } = await execFileAsync(
      nodePath,
      ['--input-type=module', '-e', "import('node:sqlite').then(() => console.log(process.version))"],
      { windowsHide: true, timeout: 5000 },
    );
    return { ok: true, nodePath, version: stdout.trim() };
  } catch (error) {
    return {
      ok: false,
      nodePath,
      reason: `Node binary at "${nodePath}" failed node:sqlite check (requires Node >= 22.13.0): ${error?.message || error}`,
    };
  }
}

export function parseCliArgs(argv) {
  let explicitInstallDir = null;
  let explicitT3Home = null;
  let explicitNodePath = null;
  let mode = null;
  let dryRun = false;
  let jsonOutput = false;
  const passthrough = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install-dir' && i + 1 < argv.length) {
      explicitInstallDir = argv[++i];
      continue;
    }
    if (arg.startsWith('--install-dir=')) {
      explicitInstallDir = arg.slice('--install-dir='.length);
      continue;
    }
    if (!mode && passthrough.length === 0) {
      if (arg === '--setup') {
        mode = 'setup';
        continue;
      }
      if (arg === '--status') {
        mode = 'status';
        continue;
      }
      if (arg === '--restore') {
        mode = 'restore';
        continue;
      }
    }
    if (mode) {
      if (arg === '--t3-home' && i + 1 < argv.length) {
        explicitT3Home = argv[++i];
        continue;
      }
      if (arg.startsWith('--t3-home=')) {
        explicitT3Home = arg.slice('--t3-home='.length);
        continue;
      }
      if (arg === '--node-path' && i + 1 < argv.length) {
        explicitNodePath = argv[++i];
        continue;
      }
      if (arg.startsWith('--node-path=')) {
        explicitNodePath = arg.slice('--node-path='.length);
        continue;
      }
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (arg === '--json') {
        jsonOutput = true;
        continue;
      }
    }
    passthrough.push(arg);
  }

  return {
    mode: mode || 'proxy',
    explicitInstallDir,
    explicitT3Home,
    explicitNodePath,
    dryRun,
    jsonOutput,
    passthrough,
  };
}

async function copyRuntimeFileIfDifferent(srcPath, destPath, mode = 0o644) {
  if (path.resolve(srcPath) === path.resolve(destPath)) {
    return false;
  }
  const content = await readFile(srcPath, 'utf8');
  await writeFileAtomic(destPath, content, mode);
  return true;
}

export async function runSetup(options = {}) {
  const {
    explicitInstallDir = null,
    explicitT3Home = null,
    explicitNodePath = null,
    dryRun = false,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    sourceScriptsDir = path.dirname(fileURLToPath(import.meta.url)),
  } = options;

  const ctx = await resolveBoundContext({ explicitInstallDir, explicitT3Home, env });
  const nodePath = path.resolve(explicitNodePath || process.execPath);
  const sqliteCheck = await verifyNodeSqliteSupport(nodePath);
  if (!sqliteCheck.ok) {
    throw new Error(sqliteCheck.reason);
  }

  const launcherPath = path.join(ctx.installDir, 'bin', launcherFileName(platform));
  let upstream = null;
  let upstreamError = null;
  try {
    upstream = await resolveUpstreamBinary({
      t3Home: ctx.t3Home,
      platform,
      arch,
      env,
      forbiddenPaths: [launcherPath],
    });
  } catch (error) {
    upstreamError = error?.message || String(error);
    if (!dryRun) {
      throw new Error(
        `Cannot resolve upstream antigravity binary: ${upstreamError}. Ensure T3 Code has installed antigravity-acp or pass AGY_PROXY_UPSTREAM_BIN.`,
      );
    }
  }

  const runtimeDir = path.join(ctx.installDir, 'runtime');
  const runtimeEntry = path.join(runtimeDir, 'agy-proxy.mjs');
  const configPath = path.join(ctx.installDir, 'config.json');
  const settingsPath = settingsFilePath(ctx.t3Home);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      t3Home: ctx.t3Home,
      installDir: ctx.installDir,
      nodePath,
      nodeVersion: sqliteCheck.version,
      launcherPath,
      runtimeEntry,
      configPath,
      configExists: existsSync(configPath),
      settingsPath,
      upstream: upstream || { error: upstreamError },
    };
  }

  await mkdir(path.join(runtimeDir, 'lib'), { recursive: true });
  await mkdir(path.dirname(launcherPath), { recursive: true });

  await copyRuntimeFileIfDifferent(path.join(sourceScriptsDir, 'agy-proxy.mjs'), runtimeEntry, 0o755);
  await copyRuntimeFileIfDifferent(
    path.join(sourceScriptsDir, 'lib', 'store.mjs'),
    path.join(runtimeDir, 'lib', 'store.mjs'),
    0o644,
  );
  await copyRuntimeFileIfDifferent(
    path.join(sourceScriptsDir, 'lib', 'acp-proxy.mjs'),
    path.join(runtimeDir, 'lib', 'acp-proxy.mjs'),
    0o644,
  );

  const launcherContent = platform === 'win32'
    ? renderWindowsLauncher({ nodePath, runtimeEntry, installDir: ctx.installDir })
    : renderPosixLauncher({ nodePath, runtimeEntry, installDir: ctx.installDir });
  await writeFileAtomic(launcherPath, launcherContent, platform === 'win32' ? 0o644 : 0o755);
  if (platform !== 'win32') {
    await chmod(launcherPath, 0o755);
  }

  const configResult = await ensureDefaultConfig(ctx.installDir);
  const installRecord = {
    version: 1,
    t3Home: ctx.t3Home,
    installDir: ctx.installDir,
    nodePath,
    nodeVersion: sqliteCheck.version,
    launcherPath,
    runtimeEntry,
    sourceScriptsDir,
    installedAt: new Date().toISOString(),
  };
  await writeFileAtomic(
    path.join(runtimeDir, 'install.json'),
    `${JSON.stringify(installRecord, null, 2)}\n`,
    0o644,
  );

  const settingsResult = await updateT3SettingsBinaryPath({
    t3Home: ctx.t3Home,
    installDir: ctx.installDir,
    launcherPath,
  });

  return {
    ok: true,
    dryRun: false,
    t3Home: ctx.t3Home,
    installDir: ctx.installDir,
    nodePath,
    nodeVersion: sqliteCheck.version,
    launcherPath,
    runtimeEntry,
    configPath: configResult.configPath,
    configCreated: configResult.created,
    settings: settingsResult,
    upstream,
  };
}

export async function runStatus(options = {}) {
  const {
    explicitInstallDir = null,
    explicitT3Home = null,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
  } = options;

  const ctx = await resolveBoundContext({ explicitInstallDir, explicitT3Home, env });
  const launcherPath = path.join(ctx.installDir, 'bin', launcherFileName(platform));
  const { config, configPath, exists: configExists } = await loadConfig(ctx.installDir, env);
  const sPath = settingsFilePath(ctx.t3Home);
  const settingsRes = await readJsonSafe(sPath);
  const configuredBinaryPath = settingsRes.ok ? settingsRes.value?.providers?.antigravity?.binaryPath ?? null : null;

  let upstream = null;
  let upstreamError = null;
  try {
    upstream = await resolveUpstreamBinary({
      t3Home: ctx.t3Home,
      platform,
      arch,
      env,
      forbiddenPaths: [launcherPath],
    });
  } catch (error) {
    upstreamError = error?.message || String(error);
  }

  const nodeToCheck = ctx.installRecord?.nodePath || process.execPath;
  const sqliteCheck = existsSync(nodeToCheck)
    ? await verifyNodeSqliteSupport(nodeToCheck)
    : { ok: false, nodePath: nodeToCheck, reason: 'node_binary_missing' };

  return {
    t3Home: ctx.t3Home,
    installDir: ctx.installDir,
    installed: Boolean(ctx.installRecord && existsSync(launcherPath)),
    installRecord: ctx.installRecord,
    launcherPath,
    launcherExists: existsSync(launcherPath),
    configPath,
    configExists,
    config,
    settingsPath: sPath,
    settingsExists: settingsRes.ok,
    configuredBinaryPath,
    settingsPointingToProxy: typeof configuredBinaryPath === 'string'
      && path.resolve(configuredBinaryPath) === path.resolve(launcherPath),
    nodeCheck: sqliteCheck,
    upstream: upstream || { error: upstreamError },
  };
}

export async function runRestore(options = {}) {
  const {
    explicitInstallDir = null,
    explicitT3Home = null,
    platform = process.platform,
    env = process.env,
  } = options;
  const ctx = await resolveBoundContext({ explicitInstallDir, explicitT3Home, env });
  const launcherPath = path.join(ctx.installDir, 'bin', launcherFileName(platform));
  return await restoreT3SettingsBinaryPath({
    t3Home: ctx.t3Home,
    installDir: ctx.installDir,
    launcherPath,
  });
}

async function runPassthroughCommand({ upstreamBinary, upstreamArgs }) {
  return await new Promise((resolve) => {
    const child = spawn(upstreamBinary, upstreamArgs, {
      stdio: 'inherit',
      windowsHide: true,
    });
    const onSigInt = () => {
      try { child.kill('SIGINT'); } catch {}
    };
    const onSigTerm = () => {
      try { child.kill('SIGTERM'); } catch {}
    };
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    child.on('error', (error) => {
      process.stderr.write(`[agy-proxy] Failed spawning upstream binary: ${error?.message || error}\n`);
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      resolve({ code: 1, signal: null });
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      resolve({ code, signal });
    });
  });
}

async function runAcpProxy({ installDir, upstreamBinary, upstreamArgs, config, geminiHome }) {
  const child = spawn(upstreamBinary, upstreamArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let stdoutQueue = Promise.resolve();
  function writeClientLine(payload) {
    const line = `${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`;
    stdoutQueue = stdoutQueue.then(() => new Promise((resolve) => {
      if (process.stdout.destroyed) {
        resolve();
        return;
      }
      if (!process.stdout.write(line)) {
        process.stdout.once('drain', resolve);
      } else {
        resolve();
      }
    }));
  }

  function writeUpstreamLine(payload) {
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
    const line = `${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`;
    child.stdin.write(line);
  }

  const proxy = createAcpProxySession({
    installDir,
    config,
    geminiHome,
    sendToClient: writeClientLine,
    sendToUpstream: writeUpstreamLine,
    onRetireUpstream: async (reason) => {
      process.stderr.write(`[agy-proxy] Retiring upstream ACP process (${reason})\n`);
      await terminateProcessTree(child).catch((err) => {
        process.stderr.write(`[agy-proxy] Failed terminating upstream tree: ${err?.message || err}\n`);
      });
    },
  });

  await proxy.ensureHistoricalLoaded();

  const clientParser = createLineParser((line) => {
    proxy.handleClientMessage(line);
  });
  let lastUpstreamMsgPromise = Promise.resolve();
  const upstreamParser = createLineParser((line) => {
    lastUpstreamMsgPromise = proxy.handleUpstreamMessage(line);
  });

  let upstreamQueue = Promise.resolve();
  child.stdout.on('data', (chunk) => {
    upstreamQueue = upstreamQueue.then(() => {
      upstreamParser.push(chunk);
    });
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  process.stdin.on('data', (chunk) => {
    clientParser.push(chunk);
  });
  process.stdin.on('end', () => {
    clientParser.flush();
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
  });
  process.stdin.on('error', () => {
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
  });

  let cleanedUp = false;
  const cleanupTree = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await terminateProcessTree(child).catch(() => {});
  };

  const onSignal = async () => {
    await cleanupTree();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return await new Promise((resolve) => {
    let settled = false;
    const finish = async (code, signal) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      upstreamParser.flush();
      await upstreamQueue.catch(() => {});
      await lastUpstreamMsgPromise.catch(() => {});
      proxy.failAllPending(`Upstream antigravity exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
      await new Promise((r) => setTimeout(r, 0));
      await stdoutQueue.catch(() => {});
      resolve({ code, signal });
    };

    child.on('error', async (error) => {
      process.stderr.write(`[agy-proxy] Upstream error: ${error?.message || error}\n`);
      await finish(1, null);
    });
    child.on('close', async (code, signal) => {
      await finish(code, signal);
    });
  });
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.mode === 'setup') {
    const result = await runSetup({
      explicitInstallDir: parsed.explicitInstallDir,
      explicitT3Home: parsed.explicitT3Home,
      explicitNodePath: parsed.explicitNodePath,
      dryRun: parsed.dryRun,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (parsed.mode === 'status') {
    const result = await runStatus({
      explicitInstallDir: parsed.explicitInstallDir,
      explicitT3Home: parsed.explicitT3Home,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (parsed.mode === 'restore') {
    const result = await runRestore({
      explicitInstallDir: parsed.explicitInstallDir,
      explicitT3Home: parsed.explicitT3Home,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const ctx = await resolveBoundContext({
    explicitInstallDir: parsed.explicitInstallDir,
    explicitT3Home: parsed.explicitT3Home,
  });
  const launcherPath = path.join(ctx.installDir, 'bin', launcherFileName());
  const upstream = await resolveUpstreamBinary({
    t3Home: ctx.t3Home,
    forbiddenPaths: [launcherPath],
  });

  if (parsed.passthrough[0] !== 'acp') {
    const res = await runPassthroughCommand({
      upstreamBinary: upstream.binaryPath,
      upstreamArgs: parsed.passthrough,
    });
    if (res.signal) {
      process.kill(process.pid, res.signal);
    } else {
      process.exit(res.code ?? 0);
    }
    return;
  }

  const { config } = await loadConfig(ctx.installDir);
  const geminiHome = parseGeminiDirFromArgs(parsed.passthrough)
    || process.env.AGY_PROXY_GEMINI_HOME?.trim()
    || process.env.GEMINI_HOME?.trim()
    || path.join(os.homedir(), '.gemini');

  const res = await runAcpProxy({
    installDir: ctx.installDir,
    upstreamBinary: upstream.binaryPath,
    upstreamArgs: parsed.passthrough,
    config,
    geminiHome,
  });
  if (res.signal) {
    process.exit(1);
  } else {
    process.exit(res.code ?? 0);
  }
}

function isMainEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    const a = realpathSync(process.argv[1]);
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}
if (isMainEntrypoint()) {
  main().catch((error) => {
    process.stderr.write(`[agy-proxy] Fatal: ${error?.message || error}\n`);
    process.exit(1);
  });
}
