#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { privateRoot, safeFile, readJson, atomicJson, validateConfig, acquireLock } from './storage.mjs';
import { Coordinator } from './coordinator.mjs';

const script = fileURLToPath(import.meta.url);
const address = root => process.platform === 'win32' ? `\\\\.\\pipe\\yjx-task-hub-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24)}` : path.join(root, 'hub.sock');
const print = value => process.stdout.write(JSON.stringify(value) + '\n');

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

async function serve(root) {
  const lock = acquireLock(root);
  let coordinator;
  let server;
  const socketPath = address(root);
  try {
    coordinator = new Coordinator(root);
    if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
      if (!fs.lstatSync(socketPath).isSocket()) throw new Error('IPC 路径不是 socket，停止');
      fs.unlinkSync(socketPath);
    }
    let queue = Promise.resolve();
    server = net.createServer(client => {
      client.setEncoding('utf8');
      let raw = '', handled = false;
      client.on('error', () => {});
      client.setTimeout(15000, () => client.destroy());
      client.on('data', chunk => {
        raw += chunk;
        if (raw.length > 16 * 1024 * 1024) { client.destroy(); return; }
        if (handled || !raw.includes('\n')) return;
        handled = true;
        queue = queue.then(async () => {
          try {
            const payload = JSON.parse(raw.slice(0, raw.indexOf('\n')));
            if (payload.session !== lock.lockId) throw new Error('会话令牌不符；仅当前持锁会话可写入');
            if (payload.action === 'stop') {
              client.end(JSON.stringify({ stopped: true, pending: coordinator.pending(), syncCoverage: coordinator.syncCoverage() }) + '\n');
              server.close(() => { lock.release(); process.exit(0); });
              return;
            }
            const result = await coordinator.handle(payload);
            client.end(JSON.stringify(result) + '\n');
          } catch (e) { client.end(JSON.stringify({ error: e.message }) + '\n'); }
        });
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
    print({ session: lock.lockId, pid: process.pid, root, pending: coordinator.pending() });
    process.stdout.end();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { lock.release(); process.exit(0); }));
  } catch (e) {
    server?.close(); lock.release(); throw e;
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '--help') {
    print({ usage: 'node <skill-dir>/scripts/hub.mjs init [--file <json-path>]|status|start|request --session <token> [--file <json-path>]|stop --session <token>', input: 'init/request 支持 --file <json-path> 或从 stdin 读取 JSON；start 持有本地锁直到 stop；外部 MCP 调用由 Agent 执行', home: '~/.yjx-task-hub/ 或绝对路径 YJX_TASK_HUB_HOME' }); return;
  }
  const root = privateRoot(undefined, cmd === 'init');
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
    const config = validateConfig(readJson(root, 'config.json'));
    const state = readJson(root, 'state.json');
    print({ root, config, entries: Object.keys(state.entries).length, pending: Object.entries(state.entries).filter(([, e]) => e.pendingOp).map(([key, e]) => ({ key, ...e.pendingOp })), lock: readJson(root, 'lock.json', null) }); return;
  }
  if (cmd === '_serve') return serve(root);
  if (cmd === 'start') {
    const child = spawn(process.execPath, [script, '_serve'], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, YJX_TASK_HUB_HOME: root } });
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
