#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { privateRoot, safeFile, readJson, atomicJson, validateConfig, acquireLock } from './storage.mjs';
import { Coordinator } from './coordinator.mjs';
import { ProjectCoordinator, projectStatus } from './project.mjs';

const script = fileURLToPath(import.meta.url);
const address = root => process.platform === 'win32' ? `\\\\.\\pipe\\yjx-task-hub-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24)}` : path.join(root, 'hub.sock');
const print = value => process.stdout.write(JSON.stringify(value) + '\n');
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
function idleTimeoutMs() {
  const value = Number(process.env.YJX_TASK_HUB_IDLE_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 100 && value <= 2147483647 ? value : DEFAULT_IDLE_TIMEOUT_MS;
}
function saveSyncRun(root, record) {
  const stored = readJson(root, 'sync-run.json', { version: 1, runs: [] });
  const runs = Array.isArray(stored.runs) ? stored.runs : (stored.session ? [stored] : []);
  const index = runs.findIndex(run => run.session === record.session);
  if (index < 0) runs.push(record); else runs[index] = record;
  atomicJson(root, 'sync-run.json', { version: 1, runs });
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`参数 ${flag} 需要非空值`);
  return value;
}

async function inputJson(args = []) {
  const file = optionValue(args, '--file');
  if (file !== null) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.length > 16 * 1024 * 1024) throw new Error('输入超过 16 MiB，请按任务分批');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  }
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 16 * 1024 * 1024) throw new Error('输入超过 16 MiB，请按任务分批');
  }
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function request(root, payload) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(address(root));
    client.setEncoding('utf8');
    let raw = '';
    client.setTimeout(15000, () => client.destroy(new Error('本地协调器无响应；结果未知，先 status 核对')));
    client.on('connect', () => client.write(JSON.stringify(payload) + '\n'));
    client.on('error', reject);
    client.on('close', () => {
      if (!raw.includes('\n')) reject(new Error('本地协调器已关闭；结果未知，先 status 核对'));
    });
    client.on('data', chunk => {
      raw += chunk;
      if (!raw.includes('\n')) return;
      client.end();
      try {
        const result = JSON.parse(raw.slice(0, raw.indexOf('\n')));
        if (result.error) reject(new Error(result.error)); else resolve(result);
      } catch (e) { reject(e); }
    });
  });
}

async function serve(root, syncRun = false, projectMode = false) {
  const lock = acquireLock(root);
  let coordinator;
  let server;
  let idleTimer;
  let lastActivityAt;
  let inFlight = 0;
  let shutdownStarted = false;
  let completionRecorded = false;
  let released = false;
  let closingStatus = 'incomplete';
  let closingReason = null;
  const clients = new Set();
  const socketPath = address(root);
  try {
    coordinator = projectMode ? new ProjectCoordinator(root) : new Coordinator(root);
    const startedAt = new Date().toISOString();
    if (syncRun) {
      // Owning the lock proves the previous coordinator has exited. Its writes
      // remain unknown; only close the run record, never its pending operations.
      const history = readJson(root, 'sync-run.json', { version: 1, runs: [] });
      const runs = Array.isArray(history.runs) ? history.runs : (history.session ? [history] : []);
      for (const run of runs) if (run.status === 'running') {
        saveSyncRun(root, { ...run, status: 'incomplete', stoppedAt: startedAt, stopReason: 'process_restarted' });
      }
      saveSyncRun(root, { session: lock.lockId, startedAt, status: 'running' });
    }
    const recordCompletion = (status, reason) => {
      if (completionRecorded) return;
      try {
        if (syncRun) {
          const pending = coordinator.pending();
          const coverage = coordinator.syncCoverage();
          saveSyncRun(root, { session: lock.lockId, startedAt, stoppedAt: new Date().toISOString(), status, stopReason: reason, syncCoverage: coverage, pendingCount: pending.length, uncommittedPlans: coordinator.plans.size });
        }
        completionRecorded = true;
      } catch (error) {
        process.stderr.write(`同步记录收尾失败：${error.message}\n`);
      }
    };
    const release = () => {
      if (released || inFlight > 0) return;
      released = true;
      try {
        recordCompletion(closingStatus, closingReason);
      } finally {
        try { lock.release(); }
        catch (error) { process.stderr.write(`锁释放失败：${error.message}\n`); }
        finally { process.exit(0); }
      }
    };
    const shutdown = (reason, gracefulClient = null, status = 'incomplete') => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      closingStatus = status;
      closingReason = reason;
      clearTimeout(idleTimer);
      if (!server?.listening) return release();
      server.close(release);
      for (const client of clients) if (client !== gracefulClient) client.destroy();
      setTimeout(() => {
        for (const client of clients) client.destroy();
        release();
      }, 1000).unref?.();
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      if (shutdownStarted) return;
      const delay = inFlight > 0 ? idleTimeoutMs() : Math.max(1, idleTimeoutMs() - (performance.now() - lastActivityAt));
      idleTimer = setTimeout(() => {
        if (shutdownStarted) return;
        if (inFlight > 0) { armIdleTimer(); return; }
        if (performance.now() - lastActivityAt < idleTimeoutMs()) { armIdleTimer(); return; }
        shutdown('idle_timeout');
      }, delay);
      idleTimer.unref?.();
    };
    if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
      if (!fs.lstatSync(socketPath).isSocket()) throw new Error('IPC 路径不是 socket，停止');
      fs.unlinkSync(socketPath);
    }
    let queue = Promise.resolve();
    server = net.createServer(client => {
      clients.add(client);
      client.setEncoding('utf8');
      let raw = '', handled = false;
      client.on('error', () => {});
      const requestDeadline = setTimeout(() => client.destroy(), 30000);
      requestDeadline.unref?.();
      client.on('close', () => { clients.delete(client); clearTimeout(requestDeadline); });
      client.setTimeout(15000, () => client.destroy());
      client.on('data', chunk => {
        if (shutdownStarted) { client.destroy(); return; }
        raw += chunk;
        if (raw.length > 16 * 1024 * 1024) { client.destroy(); return; }
        if (handled || !raw.includes('\n')) return;
        handled = true;
        clearTimeout(requestDeadline);
        queue = queue.then(async () => {
          let accepted = false;
          inFlight++;
          try {
            if (shutdownStarted) { client.destroy(); return; }
            const payload = JSON.parse(raw.slice(0, raw.indexOf('\n')));
            if (payload.session !== lock.lockId) throw new Error('会话令牌不符；仅当前持锁会话可写入');
            try { lock.touch(); }
            catch (error) { shutdown('lock_lost'); throw error; }
            accepted = true;
            lastActivityAt = performance.now();
            armIdleTimer();
            if (payload.action === 'stop') {
              const pending = coordinator.pending();
              const coverage = coordinator.syncCoverage();
              const attested = coordinator.syncAttested && pending.length === 0 && coordinator.plans.size === 0;
              shutdown('stop', client, attested ? 'verified' : 'incomplete');
              client.end(JSON.stringify({ stopped: true, pending, syncCoverage: coverage, ...(syncRun ? { syncStatus: attested ? 'verified' : 'incomplete' } : {}) }) + '\n');
              return;
            }
            const result = await coordinator.handle(payload);
            client.end(JSON.stringify(result) + '\n');
          } catch (e) {
            client.end(JSON.stringify({ error: e.message }) + '\n');
          } finally {
            inFlight--;
            if (accepted && !shutdownStarted) {
              lastActivityAt = performance.now();
              try { lock.touch(); } catch { shutdown('lock_lost'); }
              armIdleTimer();
            }
            if (shutdownStarted && clients.size === 0) release();
          }
        }).catch(() => {
          shutdown('request_failure');
        });
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
    print({ session: lock.lockId, pid: process.pid, root, mode: projectMode ? 'project' : 'personal', pending: coordinator.pending() });
    process.stdout.end();
    lastActivityAt = performance.now();
    armIdleTimer();
    for (const signal of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : ['SIGHUP'])]) {
      process.on(signal, () => shutdown(`signal:${signal}`));
    }
  } catch (e) {
    clearTimeout(idleTimer);
    server?.close(); lock.release(); throw e;
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help') {
    print({ usage: 'node <skill-dir>/scripts/hub.mjs init [--file <json-path>]|status [--project]|history|start [--sync|--project]|request --session <token> [--file <json-path>]|stop --session <token>', input: 'init/request 支持 --file <json-path> 或从 stdin 读取 JSON；start 持有本地锁直到 stop；--project 不依赖 TB 初始化；外部 MCP 调用由 Agent 执行', home: '~/.yjx-task-hub/ 或绝对路径 YJX_TASK_HUB_HOME' }); return;
  }
  const projectMode = args.includes('--project');
  if (projectMode && args.includes('--sync')) throw new Error('--project 与 --sync 不能同时使用');
  const root = privateRoot(undefined, cmd === 'init' || (cmd === 'start' && projectMode));
  if (cmd === 'history') { print(readJson(root, 'sync-run.json', { version: 1, runs: [] })); return; }
  if (cmd === 'init') {
    const config = validateConfig({ version: 1, activeWindowDays: 90, watchedTasks: [], ignoredTaskIds: [], ...await inputJson(args) });
    const lock = acquireLock(root);
    try {
      if (fs.existsSync(safeFile(root, 'config.json'))) throw new Error('配置已经存在，保持原文件；使用 status 核对');
      if (fs.existsSync(safeFile(root, 'state.json'))) throw new Error('发现旧状态，先核对其绑定再初始化');
      atomicJson(root, 'state.json', { version: 1, binding: config.notionDataSourceId, entries: {} });
      atomicJson(root, 'config.json', config);
      print({ initialized: true, root });
    } finally { lock.release(); }
    return;
  }
  if (cmd === 'status') {
    if (projectMode) { print({ root, ...projectStatus(root), lock: readJson(root, 'lock.json', null) }); return; }
    const config = validateConfig(readJson(root, 'config.json'));
    const state = readJson(root, 'state.json');
    const history = readJson(root, 'sync-run.json', { runs: [] });
    const lastSync = Array.isArray(history.runs) ? history.runs.at(-1) ?? null : history;
    print({ root, config, entries: Object.keys(state.entries).length, pending: Object.entries(state.entries).filter(([, e]) => e.pendingOp).map(([key, e]) => ({ key, ...e.pendingOp })), lock: readJson(root, 'lock.json', null), lastSync }); return;
  }
  if (cmd === '_serve') return serve(root, args.includes('--sync'), projectMode);
  if (cmd === 'start') {
    const child = spawn(process.execPath, [script, '_serve', ...(args.includes('--sync') ? ['--sync'] : []), ...(projectMode ? ['--project'] : [])], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, YJX_TASK_HUB_HOME: root } });
    const result = await new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.once('error', reject);
      child.stderr.on('data', c => { stderr += c; });
      child.stdout.on('data', c => { stdout += c; if (stdout.includes('\n')) resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))); });
      child.once('exit', code => reject(new Error(stderr || `协调器启动失败 ${code}`)));
    });
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    if (result.error) throw new Error(result.error);
    print(result); return;
  }
  const session = optionValue(args, '--session');
  if (!session) throw new Error('需要 start 返回的 --session 令牌');
  if (cmd === 'stop') { print(await request(root, { action: 'stop', session })); return; }
  if (cmd === 'request') { print(await request(root, { ...await inputJson(args), session })); return; }
  throw new Error('未知命令，使用 --help');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(script)) main().catch(e => { print({ error: e.message }); process.exitCode = 1; });
