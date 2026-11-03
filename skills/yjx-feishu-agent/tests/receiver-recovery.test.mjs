import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoveryEnabled, setRecovery, runtimeFailure, withReceiverControl } from '../scripts/receiver-recovery.mjs';
import { atomicJson } from '../scripts/receiver-runtime.mjs';

test('explicit stop policy serializes against pending managed startup and scopes state directory', async t => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'yjx-recovery-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const paths = { runtime };
  assert.equal(await recoveryEnabled(paths, 'fixture-state'), false);
  await withReceiverControl(paths, () => setRecovery(paths, 'fixture-state', true));
  assert.equal(await recoveryEnabled(paths, 'other-state'), false);
  let acquired, proceed;
  const held = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { proceed = resolve; });
  const stopping = withReceiverControl(paths, async () => {
    acquired(); await gate;
    await setRecovery(paths, 'fixture-state', false);
  });
  await held; // OS directory locks guarantee exclusion, not FIFO acquisition order.
  const starting = withReceiverControl(paths, async () => {
    assert.equal(await recoveryEnabled(paths, 'fixture-state'), false);
  });
  proceed();
  await Promise.all([stopping, starting]);
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
  assert.doesNotMatch(JSON.stringify(runtimeFailure({ code: 'private', stack: 'private' }, 'receiver')), /private/);
});
