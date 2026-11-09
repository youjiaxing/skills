#!/usr/bin/env node
/**
 * Read-only coordinator helper for yjx-issue-flow:
 * 1. resolve-thread --cwd <path> [--limit <n>]
 *    Queries codex app-server thread/list with explicit sourceKinds (including "unknown")
 *    and useStateDbOnly: true so worktree threads hidden from default list_threads are found.
 * 2. filter-wait-poll --seen-message-id <id> (reads wait_threads JSON from stdin or --input)
 *    Suppresses intermediate timedOut: true polls whose thread status is still "active"
 *    and whose latestAssistantMessage.id has not changed.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];

function findCodexBinary() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }
  try {
    const found = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {
    // fall through to common node version manager locations
  }
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmRoot)) {
    const versions = fs.readdirSync(nvmRoot).sort().reverse();
    for (const v of versions) {
      const candidate = path.join(nvmRoot, v, 'bin', 'codex');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'codex';
}

export async function resolveThreadByCwd({ cwd, limit = 20, timeoutMs = 25000 }) {
  if (!cwd) throw new Error('--cwd is required for resolve-thread');
  const normalizedCwd = path.resolve(cwd);
  const codexBin = findCodexBinary();

  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('readonly app-server thread/list lookup timed out'));
    }, timeoutMs);

    const rl = readline.createInterface({ input: child.stdout });
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      if (data.id === 1) {
        if (data.error) {
          clearTimeout(timer);
          child.kill('SIGTERM');
          reject(new Error(JSON.stringify(data.error)));
          return;
        }
        send({ method: 'initialized' });
        send({
          id: 2,
          method: 'thread/list',
          params: {
            limit,
            cwd: normalizedCwd,
            sourceKinds: DEFAULT_SOURCE_KINDS,
            useStateDbOnly: true,
          },
        });
      } else if (data.id === 2) {
        clearTimeout(timer);
        rl.close();
        child.kill('SIGTERM');
        if (data.error) {
          reject(new Error(JSON.stringify(data.error)));
          return;
        }
        const items = data.result?.data ?? data.result?.items ?? data.result?.threads ?? [];
        resolve({
          cwd: normalizedCwd,
          count: Array.isArray(items) ? items.length : 0,
          threads: items,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'issue_flow_readonly_locator', version: '1.0.0' },
      },
    });
  });
}

export function evaluateWaitPoll(rawResult, seenMessageIds = {}) {
  const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
  const payload =
    parsed?.content && Array.isArray(parsed.content)
      ? JSON.parse(parsed.content.find((x) => x.type === 'text')?.text ?? '{}')
      : parsed;

  const polls = Array.isArray(payload?.polls) ? payload.polls : [];
  const nextCursors = {};
  const nextSeenMessageIds = { ...seenMessageIds };
  let meaningfulChange = Boolean(payload?.wake) || Boolean(payload?.errors?.length);

  const summaries = polls.map((p) => {
    const threadId = p.threadId ?? p.id ?? 'unknown';
    if (p.cursor) nextCursors[threadId] = p.cursor;
    const msgId = p.latestAssistantMessage?.id ?? null;
    const prevMsgId = seenMessageIds[threadId] ?? null;
    if (msgId) nextSeenMessageIds[threadId] = msgId;
    const status = p.status ?? p.threadStatus ?? 'unknown';
    if (status !== 'active' || (msgId && msgId !== prevMsgId)) {
      meaningfulChange = true;
    }
    return {
      threadId,
      status,
      cursor: p.cursor ?? null,
      latestAssistantMessageId: msgId,
      latestAssistantPhase: p.latestAssistantMessage?.phase ?? null,
    };
  });

  return {
    meaningfulChange,
    timedOut: Boolean(payload?.timedOut),
    wake: payload?.wake ?? null,
    errors: payload?.errors ?? [],
    nextCursors,
    nextSeenMessageIds,
    summaries,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const flag = (name, fallback = undefined) => {
    const idx = args.indexOf(name);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
  };

  if (subcommand === 'resolve-thread') {
    const cwd = flag('--cwd');
    const limit = Number(flag('--limit', '20'));
    const result = await resolveThreadByCwd({ cwd, limit });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (subcommand === 'filter-wait-poll') {
    const inputPath = flag('--input');
    const seenRaw = flag('--seen-json', '{}');
    const raw = inputPath ? fs.readFileSync(inputPath, 'utf8') : fs.readFileSync(0, 'utf8');
    const evaluated = evaluateWaitPoll(raw, JSON.parse(seenRaw));
    if (evaluated.meaningfulChange || args.includes('--always-print')) {
      process.stdout.write(JSON.stringify(evaluated, null, 2) + '\n');
    }
    return;
  }

  process.stderr.write(
    'Usage:\n' +
      '  node issue-flow-threads.mjs resolve-thread --cwd <worktree-path> [--limit 20]\n' +
      '  node issue-flow-threads.mjs filter-wait-poll [--input <file>] [--seen-json \'{"threadId":"msgId"}\']\n',
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(String(err?.stack || err) + '\n');
    process.exit(1);
  });
}
