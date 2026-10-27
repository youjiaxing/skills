import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { lockThread } from './state.mjs';
import { readJson, atomicJson, receiverStatus, recoverReceiverLock } from './receiver-runtime.mjs';

export async function withReceiverControl(paths, operation) {
  const release = await lockThread(paths.runtime, 'lifecycle', performance.now() + 10000);
  if (!release) throw new Error('Receiver lifecycle operation is busy; inspect before retrying');
  try { return await operation(); } finally { await release(); }
}

export async function recoveryEnabled(paths, stateDir) {
  const policy = await readJson(path.join(paths.runtime, 'recovery.json'));
  return policy?.enabled === true && policy.stateDir === stateDir;
}

export async function setRecovery(paths, stateDir, enabled) {
  await atomicJson(path.join(paths.runtime, 'recovery.json'), {
    enabled, stateDir, updatedAt: new Date().toISOString(),
  });
}

// Managed logon/failure restart only, under the lifecycle lock and after policy
// validation. This never touches Codex sender locks or unsettled request records.
export async function recoverManagedReceiver(appId, options = {}) {
  const status = await receiverStatus(appId, options);
  if (status.state !== 'stale_lock') return { recovered: false, state: status.state };
  const recovered = await recoverReceiverLock(appId, options);
  return { recovered, state: (await receiverStatus(appId, options)).state };
}

// Only fixed stages, allowlisted system codes and numeric API/HTTP codes persist.
export function runtimeFailure(error, stage) {
  const systemCodes = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ENOSPC', 'EIO',
    'EMFILE', 'ENFILE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);
  return { stage, code: 'RUNTIME_FAILURE',
    ...(systemCodes.has(error?.code) ? { systemCode: error.code } : {}),
    ...(Number.isSafeInteger(error?.apiCode) ? { apiCode: error.apiCode } : {}),
    ...(Number.isSafeInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
  };
}

export async function recordRuntimeFailure(paths, error, stage) {
  const failure = { pid: process.pid, observedAt: new Date().toISOString(), ...runtimeFailure(error, stage) };
  await atomicJson(path.join(paths.runtime, 'last-failure.json'), failure);
  await appendFile(path.join(paths.runtime, 'failures.ndjson'), `${JSON.stringify(failure)}\n`, { mode: 0o600 });
  return failure;
}

// Invoked under the lifecycle lock. Never steal locks or replay admitted requests.
export async function ensureReceiver({ enabled, status, start }) {
  if (!enabled) return { recovery: 'disabled' };
  if (status.state === 'running') return { recovery: 'already_running' };
  if (status.state !== 'stopped') return { recovery: 'blocked', receiverState: status.state };
  await start();
  return { recovery: 'start_requested' };
}
