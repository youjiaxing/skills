import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureReceiver, recoveryEnabled, setRecovery, runtimeFailure, withReceiverControl } from '../scripts/receiver-recovery.mjs';
import { atomicJson } from '../scripts/receiver-runtime.mjs';
import { watchdogDefinition, taskDefinition, legacyTaskDefinition, matchesTask } from '../scripts/receiver.mjs';

test('watchdog starts a stopped failed receiver on subsequent ticks instead of exhausting three retries', async () => {
  let attempts = 0;
  for (let i = 0; i < 5; i += 1) {
    const result = await ensureReceiver({ enabled: true, status: { state: 'stopped', stopReason: 'runtime_failed' },
      start: async () => { attempts += 1; } });
    assert.equal(result.recovery, 'start_requested');
  }
  assert.equal(attempts, 5);
});

test('watchdog never restarts live, uncertain, dead-lock or intentionally disabled receivers', async () => {
  const start = async () => assert.fail('must not start or replay');
  assert.equal((await ensureReceiver({ enabled: false, status: { state: 'stopped' }, start })).recovery, 'disabled');
  for (const state of ['running', 'unknown', 'stale_lock', 'incomplete_lock']) {
    const result = await ensureReceiver({ enabled: true, status: { state }, start });
    assert.equal(result.recovery, state === 'running' ? 'already_running' : 'blocked');
  }
});

test('explicit stop policy serializes against pending managed startup and scopes state directory', async t => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'yjx-recovery-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const paths = { runtime };
  assert.equal(await recoveryEnabled(paths, 'fixture-state'), false);
  await withReceiverControl(paths, () => setRecovery(paths, 'fixture-state', true));
  assert.equal(await recoveryEnabled(paths, 'other-state'), false);
  await Promise.all([
    withReceiverControl(paths, () => setRecovery(paths, 'fixture-state', false)),
    withReceiverControl(paths, async () => {
      assert.equal(await recoveryEnabled(paths, 'fixture-state'), false);
    }),
  ]);
});

test('runtime snapshots retry transient replacement failures without erasing prior file', async t => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'yjx-heartbeat-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const file = path.join(runtime, 'status.json');
  await atomicJson(file, { state: 'old' });
  let calls = 0;
  await atomicJson(file, { state: 'new' }, { wait: async () => {}, replace: async (...args) => {
    if (++calls < 3) throw Object.assign(new Error('secret must not matter'), { code: 'EPERM' });
    await rename(...args);
  } });
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(await readFile(file)), { state: 'new' });
  calls = 0;
  await assert.rejects(atomicJson(file, { state: 'lost' }, { wait: async () => {}, replace: async () => {
    calls += 1; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  } }), { code: 'ENOSPC' });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await readFile(file)), { state: 'new' });
});

test('failure metadata excludes SDK payloads, secrets and arbitrary exception strings', () => {
  const failure = runtimeFailure({ code: 'EPERM', message: 'appSecret=private', config: { token: 'private' }, apiCode: 42 }, 'receiver');
  assert.deepEqual(failure, { stage: 'receiver', code: 'RUNTIME_FAILURE', systemCode: 'EPERM', apiCode: 42 });
  assert.doesNotMatch(JSON.stringify(runtimeFailure({ code: 'private', stack: 'private' }, 'watchdog')), /private/);
});

test('watchdog definition repeats every minute and rejects changed recovery cadence', () => {
  const options = { sid: 'S-1-5-21-123', node: 'C:\\node.exe', args: 'receiver.mjs ensure', cwd: 'C:\\fixture' };
  const definition = watchdogDefinition(options);
  assert.match(definition, /<TimeTrigger>/);
  assert.match(definition, /<Interval>PT1M<\/Interval>/);
  assert.equal(matchesTask(definition, definition), true);
  const schedulerExport = definition.replace('<StopAtDurationEnd>false</StopAtDurationEnd>', '')
    .replace('<Enabled>true</Enabled></TimeTrigger>', '')
    .replace('<Repetition>', '<StartBoundary>2026-01-01T00:00:00</StartBoundary><Repetition>')
    .replace('</Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary>', '</Repetition></TimeTrigger>');
  assert.equal(matchesTask(schedulerExport, definition), true);
  assert.equal(matchesTask(definition.replace('PT1M</Interval><StopAtDurationEnd>', 'PT1H</Interval><StopAtDurationEnd>'), definition), false);
  assert.equal(matchesTask(definition, taskDefinition(options)), false);
  const legacy = legacyTaskDefinition(options);
  assert.equal(matchesTask(legacy.replace('<Actions', '<Triggers><BootTrigger/></Triggers><Actions'), legacy), false);
});
