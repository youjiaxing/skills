import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { receiverPaths, receiverStatus, readRuntimeSnapshot, processAlive } from './receiver-runtime.mjs';
import { runtimeFailure } from './receiver-recovery.mjs';

const execute = promisify(execFile);
const source = new URL('./receiver-diagnostics.ps1', import.meta.url);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const pid = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const stages = new Set(['initialization', 'feedback_recovery', 'connection_start', 'connection_status', 'heartbeat', 'stop_control', 'serve_exit']);
const connections = new Set(['starting', 'connecting', 'connected', 'reconnecting', 'disconnected', 'failed', 'stopped']);
const stopReasons = new Set(['control', 'sigint', 'sigterm', 'connection_failed', 'startup_timeout', 'runtime_failed']);

async function lockStatus(directory) {
  try { await lstat(directory); }
  catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'query_failed' }; }
  const owner = await readRuntimeSnapshot(path.join(directory, 'owner.json'));
  const ownerPid = pid(owner.value?.pid);
  return { state: 'present', ownerState: owner.state, pid: ownerPid,
    processAlive: ownerPid ? processAlive(ownerPid) : null };
}

export async function windowsDiagnostics(input, { run = execute } = {}) {
  let script;
  try {
    script = await readFile(source, 'utf8');
  } catch { return { state: 'query_failed', reason: 'bridge_unavailable' }; }
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const sections = ['task', 'process', 'taskHistory', 'systemHistory'];
  const results = await Promise.all(sections.map(async section => {
    try {
      const { stdout } = await run(executable, args, {
        windowsHide: true, encoding: 'utf8', timeout: 12000, maxBuffer: 256 * 1024,
        env: { ...process.env, YJX_RECEIVER_DIAG_INPUT: JSON.stringify({ ...input, section }) },
      });
      const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      if (!result || result.protocolVersion !== 1 || result.section !== section || !result.value || typeof result.value.state !== 'string') {
        return { state: 'query_failed', reason: 'invalid_response' };
      }
      return result.value;
    } catch (error) {
      // Do not return command lines, stdout/stderr or OS exception text.
      return { state: 'query_failed', reason: error instanceof SyntaxError ? 'invalid_response' : 'os_query_failed',
        ...(error.code === 'ENOENT' ? { systemCode: 'ENOENT' } : {}),
        ...(error.killed ? { timedOut: true } : {}) };
    }
  }));
  const failures = results.filter(value => value.state === 'query_failed').length;
  return { state: failures === sections.length ? 'query_failed' : failures ? 'partial' : 'queried',
    ...Object.fromEntries(sections.map((section, index) => [section, results[index]])) };
}

export async function receiverDiagnosis(appId, stateDir, { home, platform = process.platform, expectedAction, run } = {}) {
  const paths = receiverPaths(appId, home);
  const [receiver, heartbeat, recovery, failure, registration, lifecycle, recoveryMutex] = await Promise.all([
    receiverStatus(appId, { home }).catch(() => ({ state: 'query_failed' })),
    ...['status.json', 'recovery.json', 'last-failure.json', 'task-registration.json'].map(file => readRuntimeSnapshot(path.join(paths.runtime, file))),
    lockStatus(path.join(paths.runtime, 'locks', 'lifecycle')), lockStatus(path.join(paths.runtime, 'recover.lock')),
  ]);
  const observedAt = new Date().toISOString();
  const ownerPid = pid(receiver.pid);
  const lastHeartbeat = heartbeat.value;
  const lastFailure = failure.value;
  const os = platform === 'win32' ? await windowsDiagnostics({ taskName: paths.taskName, receiverPid: ownerPid, expectedAction, observedAt }, { run })
    : { state: 'not_supported', reason: 'no_managed_scheduler_on_this_platform' };
  return { type: 'receiver_diagnosis', observedAt, stateDir,
    receiver: { state: receiver.state, pid: ownerPid, runtimeDirectory: paths.runtime,
      connection: connections.has(receiver.connection) ? receiver.connection : null,
      updatedAt: date(receiver.updatedAt),
      ...(receiver.ownerState ? { ownerState: receiver.ownerState } : {}),
      ...(receiver.runtimeState ? { runtimeState: receiver.runtimeState } : {}) },
    heartbeat: { state: heartbeat.state, pid: pid(lastHeartbeat?.pid), updatedAt: date(lastHeartbeat?.updatedAt),
      connection: connections.has(lastHeartbeat?.connection) ? lastHeartbeat.connection : null,
      stopReason: stopReasons.has(lastHeartbeat?.stopReason) ? lastHeartbeat.stopReason : null },
    controlLocks: { lifecycle, recoveryMutex },
    recovery: { state: recovery.state, enabled: typeof recovery.value?.enabled === 'boolean' ? recovery.value.enabled : null,
      stateDirMatches: recovery.value ? recovery.value.stateDir === stateDir : null },
    lastFailure: { state: failure.state, ...(lastFailure ? {
      pid: pid(lastFailure.pid), observedAt: date(lastFailure.observedAt),
      ownerPidMatches: ownerPid && pid(lastFailure.pid) ? ownerPid === lastFailure.pid : null,
      ...runtimeFailure({ ...lastFailure, code: lastFailure.systemCode }, stages.has(lastFailure.stage) ? lastFailure.stage : 'unknown'),
      code: lastFailure.code === 'RUNTIME_FAILURE' ? lastFailure.code : null,
    } : {}) },
    registration: { state: registration.state, expectedTaskName: paths.taskName,
      taskNameMatches: registration.value ? registration.value.taskName === paths.taskName : null,
      stateDirMatches: registration.value ? registration.value.stateDir === stateDir : null },
    os,
  };
}
