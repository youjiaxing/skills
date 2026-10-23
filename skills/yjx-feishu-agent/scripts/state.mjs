import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function validateRequestId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value ?? '') || value.endsWith('.')) {
    throw new Error('request-id must contain 1–128 letters, digits, dots, underscores or hyphens');
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('request-id is a reserved Windows filename');
  }
  return value;
}

export function recordPath(stateDir, requestId) {
  return path.join(stateDir, 'requests', validateRequestId(requestId), 'record.json');
}

export async function readRecord(stateDir, requestId) {
  return JSON.parse(await readFile(recordPath(stateDir, requestId), 'utf8'));
}

export async function saveRecord(stateDir, record) {
  const target = recordPath(stateDir, record.requestId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  record.updatedAt = new Date().toISOString();
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Atomic directory creation reserves the request ID before any external send.
export async function reserveRecord(stateDir, initial) {
  const directory = path.dirname(recordPath(stateDir, initial.requestId));
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { return { fresh: false, record: await readRecord(stateDir, initial.requestId) }; }
    catch { throw new Error('Request exists but its journal is unavailable; inspect state before retrying'); }
  }
  await saveRecord(stateDir, initial);
  return { fresh: true, record: initial };
}

// A timed-out queue item may run later. Retain this gate after releasing the
// process lock so a new request ID cannot silently bypass unresolved work.
export async function resolveThreadRequest(stateDir, record, refresh) {
  const target = path.join(stateDir, 'threads', `${record.threadId}.json`);
  let prior;
  try { prior = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!prior || prior.requestId === record.requestId) return { old: null };
  let old = await readRecord(stateDir, prior.requestId);
  let refreshError;
  if (old.submitted && !['completed','failed','interrupted'].includes(old.status) && refresh) {
    try { old = await refresh(prior.requestId); }
    catch (error) {
      // Read-only reconciliation may temporarily fail while the original turn is
      // still active. The gate remains; retry on the next admitted message.
      if (!['Codex executable not found','Ambiguous correlation: more than one turn matches this request'].includes(error.message)) throw error;
      refreshError = error.message;
    }
  }
  return { old, refreshError };
}

export async function claimThreadRequest(stateDir, record) {
  const directory = path.join(stateDir, 'threads');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${record.threadId}.json`);
  let prior;
  try { prior = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior && prior.requestId !== record.requestId) {
    const old = await readRecord(stateDir, prior.requestId);
    if (old.submitted && !['completed', 'failed', 'interrupted'].includes(old.status)) {
      throw new Error(`Previous request ${old.requestId} is unresolved; refresh its status before sending another request`);
    }
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ requestId: record.requestId }), { mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

// No stale-lock stealing: a crashed sender may already have submitted its work.
export async function lockThread(stateDir, threadId, deadline) {
  const directory = path.join(stateDir, 'locks', threadId);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(directory, { mode: 0o700 });
      const token = randomUUID();
      try {
        await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'));
        if (owner.token === token) await rm(directory, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) return null;
      await delay(Math.min(100, Math.max(1, deadline - performance.now())));
    }
  }
}
