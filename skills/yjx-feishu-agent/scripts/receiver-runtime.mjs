import { mkdir, readFile, rename, open, unlink, rmdir, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from './feishu-core.mjs';

export function receiverPaths(appId, home = os.homedir()) {
  const root = path.join(home, '.yjx-feishu-agent-receivers');
  const key = digest(appId);
  return { lock: path.join(root, 'locks', key), runtime: path.join(root, 'runtime', key),
    taskName: `yjx-feishu-agent-${key.slice(0, 20)}` };
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

export async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Telemetry is not an ownership or authorization source. Keep strict readJson
// for receiver owners, recovery intent, stop controls and request journals.
export async function readRuntimeSnapshot(file) {
  try {
    const value = await readJson(file);
    if (value === null) return { value: null, state: 'missing' };
    if (typeof value !== 'object' || Array.isArray(value)) return { value: null, state: 'unreadable' };
    return { value, state: 'readable' };
  } catch { return { value: null, state: 'unreadable' }; }
}

export async function atomicJson(file, value, { replace = rename, wait = delay } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt += 1) {
      try { await replace(temporary, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
        await wait(50 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function receiverStatus(appId, { home, alive = processAlive } = {}) {
  const paths = receiverPaths(appId, home);
  let owner;
  try { owner = await readJson(path.join(paths.lock, 'owner.json')); }
  catch { return { state: 'incomplete_lock', ownerState: 'unreadable', runtimeDirectory: paths.runtime }; }
  const snapshot = await readRuntimeSnapshot(path.join(paths.runtime, 'status.json'));
  const runtime = snapshot.value;
  const diagnostic = snapshot.state === 'unreadable' ? { runtimeState: 'unreadable' } : {};
  if (owner && (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !owner.token)) {
    return { state: 'incomplete_lock', ownerState: 'invalid', runtimeDirectory: paths.runtime, ...diagnostic };
  }
  if (!owner) {
    try {
      await lstat(paths.lock);
      return { state: 'incomplete_lock', lockDirectory: paths.lock, runtimeDirectory: paths.runtime };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { state: 'stopped', runtimeDirectory: paths.runtime, ...diagnostic,
        ...(runtime?.connection==='stopped' ? {stopReason:runtime.stopReason ?? 'unknown',updatedAt:runtime.updatedAt,
          ...(runtime.failure ? { failure: runtime.failure } : {})} : {}) };
    }
  }
  const living = alive(owner.pid);
  if (living === false) return { state: 'stale_lock', pid: owner.pid, runtimeDirectory: paths.runtime, ...diagnostic };
  const matching = runtime?.pid === owner.pid && runtime?.token === owner.token;
  const fresh = matching && Date.now() - Date.parse(runtime.updatedAt) < 15000;
  return { state: fresh && living === true ? 'running' : 'unknown', pid: owner.pid,
    connection: matching ? runtime.connection : 'unknown',
    updatedAt: matching ? runtime.updatedAt : null,
    runtimeDirectory: paths.runtime, ...diagnostic };
}

// Explicit recovery only. Serialize recoverers before re-reading the lock;
// direct serve cannot replace a lock while its old directory still exists.
export async function recoverReceiverLock(appId, { home, alive = processAlive } = {}) {
  const paths = receiverPaths(appId, home);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const mutex = path.join(paths.runtime, 'recover.lock');
  await mkdir(mutex);
  try {
    const ownerFile = path.join(paths.lock, 'owner.json');
    const owner = await readJson(ownerFile);
    if (!owner) {
      try { await lstat(paths.lock); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      throw new Error('Receiver lock has no owner; inspect its directory and processes manually');
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !owner.token) {
      throw new Error('Receiver owner is invalid; inspect before recovery');
    }
    if (alive(owner.pid) !== false) throw new Error('Receiver owner may still be alive; refusing lock recovery');
    const again = await readJson(ownerFile);
    if (again?.pid !== owner.pid || again?.token !== owner.token || alive(owner.pid) !== false) {
      throw new Error('Receiver ownership changed; refusing lock recovery');
    }
    await unlink(ownerFile);
    await rmdir(paths.lock); // Never remove request journals or Codex sender locks.
    return true;
  } finally { await rmdir(mutex); }
}
