#!/usr/bin/env node
import { readFile, mkdir, open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadCredentials } from './feishu-credentials.mjs';
import { defaultStateDir, validateThreadId } from './codex.mjs';
import { lockThread } from './state.mjs';
import { validateBindings, writeJournal, digest } from './feishu-core.mjs';
import { inspectTarget } from './target.mjs';

export async function rebind(config, { chatId, expectedThread, threadId }, check) {
  validateBindings(config);
  validateThreadId(expectedThread); validateThreadId(threadId);
  const next = structuredClone(config);
  const binding = next.bindings.find(b => b.chatId === chatId);
  if (!binding || binding.threadId !== expectedThread) throw new Error('Binding changed or missing');
  if (threadId === expectedThread) throw new Error('Target unchanged');
  const target = await check({ threadId, codex: config.codex ?? 'codex', cwd: config.cwd ?? process.cwd() });
  if (target.state !== 'readable') throw new Error('New target is not readable and active');
  binding.threadId = threadId;
  return validateBindings(next);
}

export async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help') {
    console.log('Usage: node bindings.mjs list|check [--chat oc_ID] [--state-dir PATH]\nRebind (receiver must be stopped): rebind --chat oc_ID --expected-thread OLD_UUID --thread NEW_UUID [--state-dir PATH]\nNever creates/unarchives chats or replays requests.');
    return;
  }
  if (!['list','check','rebind'].includes(command)) throw new Error('Unknown command');
  const keys = { '--chat': 'chatId', '--expected-thread': 'expectedThread', '--thread': 'threadId', '--state-dir': 'stateDir' };
  const options = {};
  while (args.length) {
    const key = keys[args.shift()], value = args.shift();
    if (!key || !value || options[key]) throw new Error('Invalid arguments');
    options[key] = value;
  }
  if (command !== 'rebind' && (options.expectedThread || options.threadId)) throw new Error('Unexpected mutation arguments');
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir());
  const file = path.join(stateDir, 'feishu', 'bindings.json');
  if (command !== 'rebind') {
    const config = validateBindings(JSON.parse(await readFile(file, 'utf8')));
    const selected = config.bindings.filter(b => !options.chatId || b.chatId === options.chatId);
    if (!selected.length) throw new Error('Group not bound');
    const rows = [];
    for (const binding of selected) rows.push({ ...binding, ...(command === 'check' ? {
      target: await inspectTarget({ threadId: binding.threadId, codex: config.codex ?? 'codex', cwd: config.cwd ?? process.cwd() }) } : {}) });
    console.log(JSON.stringify({ bindings: rows }));
    return;
  }
  const { appId } = await loadCredentials(stateDir);
  const release = await lockThread(path.join(os.homedir(), '.yjx-feishu-agent-receivers'), digest(appId), performance.now());
  if (!release) throw new Error('Stop receiver and inspect leftover lock first');
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    const next = await rebind(config, options, inspectTarget);
    const history = path.join(stateDir, 'feishu', 'binding-history');
    await mkdir(history, { recursive: true, mode: 0o700 });
    const backup = path.join(history, `${Date.now()}-${randomUUID()}.json`);
    const handle = await open(backup, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ previous: config, next, createdAt: new Date().toISOString() })); await handle.sync(); }
    finally { await handle.close(); }
    await writeJournal(file, next);
    console.log(JSON.stringify({ status: 'rebound', chatId: options.chatId, threadId: options.threadId, history: backup, restartRequired: true }));
  } finally { await release(); }
}
try {
  if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2)).catch(() => {
    console.log(JSON.stringify({ status: 'error', message: 'Check binding, expected target, readable new chat, and stopped receiver; no automatic recovery' }));
    process.exitCode = 2;
  });
} catch { /* Import only. */ }
