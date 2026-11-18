import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const RATE_LIMIT_API_CODES = new Set([230429, 230020, 99991400]);
export const QUOTA_EXHAUSTED_CODE = 99991403;

const hash = value => createHash('sha256').update(String(value)).digest('hex');

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

export function parseRetryAfterHeaders(headers) {
  for (const name of ['x-ogw-ratelimit-reset', 'retry-after']) {
    const raw = headerValue(headers, name);
    if (raw === null || raw === undefined || raw === '') continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(15000, Math.max(200, Math.ceil(seconds * 1000)));
    }
  }
  return null;
}

export function extractFeishuError(error) {
  const apiCode = Number.isSafeInteger(error?.apiCode) ? error.apiCode
    : Number.isSafeInteger(error?.response?.data?.code) ? error.response.data.code
    : Number.isSafeInteger(error?.code) ? error.code
    : null;
  const httpStatus = Number.isSafeInteger(error?.httpStatus) ? error.httpStatus
    : Number.isSafeInteger(error?.response?.status) ? error.response.status
    : Number.isSafeInteger(error?.status) ? error.status
    : null;
  const retryAfterMs = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0
    ? error.retryAfterMs
    : parseRetryAfterHeaders(error?.response?.headers ?? error?.headers);
  return { apiCode, httpStatus, retryAfterMs };
}

export function isRateLimitError(errorOrInfo) {
  const info = extractFeishuError(errorOrInfo);
  if (RATE_LIMIT_API_CODES.has(info.apiCode)) return true;
  if (info.httpStatus === 429 && info.apiCode !== QUOTA_EXHAUSTED_CODE) return true;
  return false;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function readJsonSafe(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function isStaleLock(owner, dirStat, curNow, staleLockMs) {
  if (owner) {
    const age = Number.isFinite(owner.createdAt) ? curNow - owner.createdAt : staleLockMs + 1;
    return (!isProcessAlive(owner.pid) && age > 200) || age > staleLockMs;
  }
  return Boolean(dirStat && curNow - dirStat.mtimeMs > Math.min(1000, staleLockMs));
}

async function acquireGateMutex(lockDir, { staleLockMs = 5000, mutexWaitMs = 5000, now = Date.now, sleep = delay } = {}) {
  await mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  const reclaimLockDir = `${lockDir}.reclaim`;
  const deadline = now() + mutexWaitMs;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      const token = randomUUID();
      const ownerFile = path.join(lockDir, 'owner.json');
      try {
        const handle = await open(ownerFile, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: now() })); }
        finally { await handle.close(); }
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return async () => {
        const owner = await readJsonSafe(ownerFile);
        if (owner?.token === token) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readJsonSafe(path.join(lockDir, 'owner.json'));
      let dirStat = null;
      if (!owner) {
        try { dirStat = await stat(lockDir); } catch { /* Lock already released. */ }
      }
      if (isStaleLock(owner, dirStat, now(), staleLockMs)) {
        let reclaimAcquired = false;
        try {
          await mkdir(reclaimLockDir, { mode: 0o700 });
          reclaimAcquired = true;
          const currentOwner = await readJsonSafe(path.join(lockDir, 'owner.json'));
          let currentStat = null;
          if (!currentOwner) {
            try { currentStat = await stat(lockDir); } catch { /* Lock already released. */ }
          }
          const sameTarget = owner ? currentOwner?.token === owner.token : !currentOwner;
          if (sameTarget && isStaleLock(currentOwner, currentStat, now(), staleLockMs)) {
            await rm(lockDir, { recursive: true, force: true }).catch(() => {});
          }
        } catch (reclaimError) {
          if (reclaimError?.code === 'EEXIST') {
            try {
              const rStat = await stat(reclaimLockDir);
              if (now() - rStat.mtimeMs > staleLockMs) {
                await rm(reclaimLockDir, { recursive: true, force: true }).catch(() => {});
              }
            } catch { /* Reclaim lock already released. */ }
          }
        } finally {
          if (reclaimAcquired) {
            await rm(reclaimLockDir, { recursive: true, force: true }).catch(() => {});
          }
        }
        if (reclaimAcquired) continue;
      }
      if (now() >= deadline) return null;
      await sleep(Math.min(25, Math.max(1, deadline - now())));
    }
  }
}

export function createFeishuRateLimiter({
  gateDir,
  appId,
  minIntervalMs = 350,
  baseBackoffMs = 1500,
  maxBackoffMs = 15000,
  maxRetries = 3,
  maxOperationMs = null,
  attemptHeadroomMs = 0,
  staleLockMs = 5000,
  mutexWaitMs = 5000,
  random = Math.random,
  sleep = delay,
  now = Date.now,
} = {}) {
  const disabled = !gateDir || !appId;
  const root = disabled ? null : path.join(path.resolve(gateDir), 'feishu-rate-limit-v1', hash(appId));
  const gateFile = root ? path.join(root, 'gate.json') : null;
  const lockDir = root ? path.join(root, 'gate.lock') : null;

  async function withGateState(fn) {
    if (disabled) return null;
    const release = await acquireGateMutex(lockDir, { staleLockMs, mutexWaitMs, now, sleep });
    if (!release) return null;
    try {
      const existing = await readJsonSafe(gateFile);
      const state = existing && existing.version === 1
        ? { version: 1, nextAllowedAt: Number(existing.nextAllowedAt) || 0, cooldownUntil: Number(existing.cooldownUntil) || 0 }
        : { version: 1, nextAllowedAt: 0, cooldownUntil: 0 };
      const result = fn(state);
      if (result?.skipSave) return result;
      state.updatedAt = now();
      await writeJsonAtomic(gateFile, state);
      return result;
    } finally {
      await release();
    }
  }

  async function reserveSlot({ deadlineMs = Infinity } = {}) {
    if (disabled) return 0;
    const scheduled = await withGateState(state => {
      const t = now();
      const slot = Math.max(t, state.nextAllowedAt, state.cooldownUntil);
      if (Number.isFinite(deadlineMs) && slot > deadlineMs) {
        return { slot, rejectedByDeadline: true, skipSave: true };
      }
      state.nextAllowedAt = slot + minIntervalMs;
      return { slot, rejectedByDeadline: false };
    });
    if (scheduled?.rejectedByDeadline) {
      const error = new Error('Feishu rate-limit gate wait exceeds operation deadline');
      error.apiCode = 230429;
      error.rateLimitedLocalGate = true;
      throw error;
    }
    if (!Number.isFinite(scheduled?.slot)) return 0;
    const waitMs = scheduled.slot - now();
    if (waitMs > 0) await sleep(waitMs);
    return Math.max(0, waitMs);
  }

  async function recordCooldown(backoffMs) {
    if (disabled || !(backoffMs > 0)) return 0;
    const cooldownUntil = await withGateState(state => {
      const target = now() + backoffMs;
      state.cooldownUntil = Math.max(state.cooldownUntil, target);
      state.nextAllowedAt = Math.max(state.nextAllowedAt, state.cooldownUntil);
      return { cooldownUntil: state.cooldownUntil };
    });
    return cooldownUntil?.cooldownUntil ?? 0;
  }

  function computeBackoffMs(attempt, retryAfterMs) {
    const exp = baseBackoffMs * (2 ** attempt);
    const jitter = Math.round(random() * baseBackoffMs * 0.35);
    const candidate = Math.max(exp + jitter, retryAfterMs ?? 0);
    return Math.min(maxBackoffMs, candidate);
  }

  async function execute(fn, options = {}) {
    const effectiveOperationMs = Number.isFinite(options.maxOperationMs) ? options.maxOperationMs : maxOperationMs;
    const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs
      : Number.isFinite(effectiveOperationMs) ? now() + effectiveOperationMs
      : Infinity;
    const headroomMs = Number.isFinite(options.attemptHeadroomMs) ? options.attemptHeadroomMs : attemptHeadroomMs;
    const limit = Number.isInteger(options.maxRetries) ? options.maxRetries : maxRetries;
    for (let attempt = 0; ; attempt++) {
      await reserveSlot({ deadlineMs: Number.isFinite(deadlineMs) ? deadlineMs - headroomMs : Infinity });
      // Mutex acquisition and timers can overrun the reserved slot, even when
      // the rate-limit gate is disabled. Recheck immediately before the write.
      if (now() + headroomMs >= deadlineMs) {
        throw Object.assign(new Error('Feishu operation deadline exceeded'), {notSent:true});
      }
      try {
        return await fn(attempt);
      } catch (error) {
        const info = extractFeishuError(error);
        if (!isRateLimitError(info) || attempt >= limit) throw error;
        const backoffMs = computeBackoffMs(attempt, info.retryAfterMs);
        await recordCooldown(backoffMs);
        if (Number.isFinite(deadlineMs) && now() + backoffMs + headroomMs > deadlineMs) {
          throw error;
        }
      }
    }
  }

  return { reserveSlot, recordCooldown, execute, gateFile };
}
