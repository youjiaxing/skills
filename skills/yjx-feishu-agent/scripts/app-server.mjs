import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class RpcError extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
  }
}

export function timeLeft(deadline) {
  const left = Math.ceil(deadline - performance.now());
  if (left <= 0) throw new Error('Deadline exceeded');
  return left;
}

export async function resolveCodex(value, env = process.env) {
  const candidates = value.includes('/') || value.includes('\\')
    ? [path.resolve(value)]
    : (env.PATH ?? '').split(path.delimiter).flatMap((directory) => process.platform === 'win32'
      ? [path.join(directory, `${value}.exe`), path.join(directory, value)]
      : [path.join(directory, value)]);
  for (const candidate of candidates) {
    if (process.platform === 'win32' && !candidate.toLowerCase().endsWith('.exe')) continue;
    try { await access(candidate); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Codex executable not found. Set --codex or CODEX_CLI_PATH to the native binary (codex.exe on Windows).');
}

export class AppServer {
  constructor(binary, cwd, { prefixArgs = [], env = process.env } = {}) {
    this.events = [];
    this.unsupportedRequests = [];
    this.pending = new Map();
    this.emitter = new EventEmitter();
    this.sequence = 0;
    this.stopped = false;
    this.failure = null;
    this.child = spawn(binary, [...prefixArgs, 'app-server', '--stdio'], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.receive(line));
    // Drain diagnostics without copying credentials or unrelated logs to results.
    this.child.stderr.resume();
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.closed = new Promise((resolve) => this.child.once('close', (code, signal) => {
      this.stopped = true;
      this.fail(new Error(`App Server closed (${signal ?? code})`));
      resolve();
    }));
  }

  fail(error) {
    this.failure ??= error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emitter.emit('event');
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.fail(new Error('App Server emitted invalid JSON')); return; }
    if (message.method && Object.hasOwn(message, 'id')) {
      this.unsupportedRequests.push(message.method);
      this.write({ id: message.id, error: { code: -32601, message: 'This client does not implement host interactions or approval UI' } });
      this.emitter.emit('event');
    } else if (Object.hasOwn(message, 'id')) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new RpcError(message.error));
      else request.resolve(message.result);
    } else if (message.method) {
      this.events.push(message);
      if (this.events.length > 1024) this.events.shift();
      this.emitter.emit('event');
    }
  }

  write(message) {
    if (!this.stopped && !this.child.stdin.destroyed) {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  }

  call(method, params, deadline) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeLeft(deadline));
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async initialize(deadline) {
    await this.call('initialize', { clientInfo: { name: 'yjx_feishu_agent', version: '0.1.0' } }, deadline);
    this.write({ method: 'initialized' });
  }

  waitFor(predicate, deadline) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.emitter.off('event', check); };
      const check = () => {
        const found = this.events.find(predicate);
        if (found) { cleanup(); resolve(found); }
        else if (this.unsupportedRequests.length) {
          cleanup(); reject(new Error('Host interaction required: this client cannot supply Desktop tools or approval UI'));
        } else if (this.failure) { cleanup(); reject(this.failure); }
      };
      timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for turn completion')); }, timeLeft(deadline));
      this.emitter.on('event', check);
      check();
    });
  }

  async close() {
    if (this.stopped) return;
    this.child.stdin.end();
    let timer;
    await Promise.race([this.closed, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
    if (!this.stopped) this.child.kill('SIGKILL');
    await this.closed;
    this.lines.close();
  }
}

export function runQueue(binary, threadId, message, deadline, cwd) {
  const timeout = timeLeft(deadline);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['queue', '--thread', threadId, '--message', message], {
      cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let overflow = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 65536) { overflow = true; child.kill(); }
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !overflow) resolve(output.trim());
      else reject(new Error(`Queue submission was not confirmed (${signal ?? code}); inspect request before resending`));
    });
  });
}
