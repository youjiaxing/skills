import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deliver, recoverUpdate, reconcileOutbound, supersedeUpdate, outboundPaths, submissionOutcome } from '../scripts/outbound-core.mjs';

const card = text => ({ schema: '2.0', config: { update_multi: true }, body: { elements: [{ tag: 'markdown', content: text }] } });
async function setup(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'outbound-recovery-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const transport = { send: async () => { calls.push('send'); return 'om_test'; },
    update: async (id, content) => { calls.push({ id, content }); return id; } };
  const options = { stateDir, appId: 'cli_test', directory: stateDir, transport };
  const initial = { operation: 'send', requestId: 'initial', chatId: 'oc_test', msgType: 'interactive', content: card('old') };
  const update = { operation: 'update', requestId: 'update', targetRequestId: 'initial', expectedRevision: 1,
    msgType: 'interactive', content: card('new') };
  return { options, calls, transport, initial, update, paths: outboundPaths(stateDir, 'cli_test') };
}

for (const applied of [false, true]) test(`unknown update recovers the original card once, prior effect=${applied}`, async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  let remote = card('old');
  c.transport.update = async (id, content) => {
    if (applied) remote = content;
    throw new Error('timeout');
  };
  const unknown = await deliver(c.update, c.options);
  assert.equal(submissionOutcome(unknown), 'unknown');
  c.transport.update = async (id, content) => { c.calls.push({ id, content }); remote = content; return id; };
  const results = await Promise.all([recoverUpdate({ ...c.options, requestId: 'update' }),
    recoverUpdate({ ...c.options, requestId: 'update' })]);
  assert.ok(results.every(r => r.status === 'sent' && r.revision === 2));
  assert.equal(c.calls.filter(x => x !== 'send').length, 1);
  assert.deepEqual(remote, unknown.content);
  const target = JSON.parse(await readFile(c.paths.target('initial'), 'utf8'));
  assert.equal(target.pending, null);
  assert.equal(target.messageId, 'om_test');
  const stored = JSON.parse(await readFile(c.paths.request('update'), 'utf8'));
  assert.equal(stored.fingerprint, unknown.fingerprint);
  assert.equal(stored.firstSubmittedAt, unknown.firstSubmittedAt);
  assert.equal(stored.recoveryAttempts, 1);
  assert.equal((await deliver({ ...c.update, requestId: 'next', expectedRevision: 2,
    content: card('latest') }, c.options)).revision, 3);
  assert.equal(c.calls.filter(x => x === 'send').length, 1);
});

test('failed recovery retains unknown even when its retry is explicitly rejected; next attempt can recover', async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  c.transport.update = async () => { throw new Error('timeout'); };
  await deliver(c.update, c.options);
  c.transport.update = async () => { throw Object.assign(new Error('rejected'), { apiCode: 230099 }); };
  const failed = await recoverUpdate({ ...c.options, requestId: 'update' });
  assert.equal(submissionOutcome(failed), 'unknown');
  assert.equal(JSON.parse(await readFile(c.paths.target('initial'), 'utf8')).pending, 'update');
  c.transport.update = async id => id;
  assert.equal((await recoverUpdate({ ...c.options, requestId: 'update' })).status, 'sent');
});

test('unknown send is never replayed by card recovery', async t => {
  const c = await setup(t);
  c.transport.send = async () => { c.calls.push('send'); throw new Error('timeout'); };
  await deliver(c.initial, c.options);
  await assert.rejects(recoverUpdate({ ...c.options, requestId: 'initial' }), /journaled card update/);
  assert.deepEqual(c.calls, ['send']);
});

test('recovery rejects expired work, newer target revisions, and other pending owners without writes', async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  c.transport.update = async () => { throw new Error('timeout'); };
  await deliver(c.update, c.options);
  c.transport.update = async () => { assert.fail('must not write'); };
  await assert.rejects(recoverUpdate({ ...c.options, requestId: 'update', notAfter: '2020-01-01T00:00:00Z' }), /expired/);
  const target = JSON.parse(await readFile(c.paths.target('initial'), 'utf8'));
  for (const changed of [{ ...target, revision: 3 }, { ...target, pending: 'another' }]) {
    const before = JSON.stringify(changed);
    await writeFile(c.paths.target('initial'), before);
    await assert.rejects(recoverUpdate({ ...c.options, requestId: 'update' }), /Target changed/);
    assert.equal(await readFile(c.paths.target('initial'), 'utf8'), before);
  }
});

test('durable acknowledgement after a partial commit is repaired without repeating the patch', async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  c.transport.update = async () => { throw new Error('timeout'); };
  const record = await deliver(c.update, c.options);
  record.acknowledgement = { messageId: 'om_test' };
  await writeFile(c.paths.request('update'), JSON.stringify(record));
  c.transport.update = async () => { assert.fail('must not repeat acknowledged update'); };
  assert.equal((await recoverUpdate({ ...c.options, requestId: 'update' })).retried, false);
  assert.equal((await reconcileOutbound({ ...c.options, requestId: 'update' })).revision, 2);
});

test('superseding an unknown update releases the same card for a newer snapshot and does not replay the old one', async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  c.transport.update = async () => { throw new Error('timeout'); };
  await deliver(c.update, c.options);
  c.transport.update = async () => { assert.fail('supersede must not patch'); };
  const released = await supersedeUpdate({ ...c.options, requestId: 'update' });
  assert.equal(released.status, 'superseded');
  assert.equal(submissionOutcome(JSON.parse(await readFile(c.paths.request('update'), 'utf8'))), 'unknown');
  const target = JSON.parse(await readFile(c.paths.target('initial'), 'utf8'));
  assert.equal(target.pending, null);
  assert.equal(target.revision, 1);
  await assert.rejects(recoverUpdate({ ...c.options, requestId: 'update' }), /not replayed/);
  c.transport.update = async (id, content) => { c.calls.push({ id, content }); return id; };
  const latest = await deliver({ ...c.update, requestId: 'latest', expectedRevision: 1, content: card('latest') }, c.options);
  assert.equal(latest.status, 'sent');
  assert.equal(latest.revision, 2);
  assert.equal(c.calls.filter(x => x === 'send').length, 1);
});
