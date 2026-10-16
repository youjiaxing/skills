import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deliver, outboundStatus, prepareContent, outboundPaths } from '../scripts/outbound-core.mjs';
import { parseArgs } from '../scripts/outbound.mjs';

const card = text => ({ header: { title: { tag: 'plain_text', content: text } }, elements: [] });
async function setup(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'feishu-outbound-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const transport = {
    async upload(bytes) { calls.push(['upload', bytes.length]); return 'img_test'; },
    async send(chat, type, content, uuid) { calls.push(['send', chat, type, content, uuid]); return 'om_test'; },
    async update(id, content) { calls.push(['update', id, content]); return id; },
  };
  const options = { stateDir, appId: 'cli_test', directory: stateDir, transport };
  const initial = { operation: 'send', requestId: 'daily', chatId: 'oc_test', msgType: 'interactive', content: card('initial') };
  const update = { operation: 'update', requestId: 'change', targetRequestId: 'daily', expectedRevision: 1,
    msgType: 'interactive', content: card('updated') };
  return { stateDir, options, initial, update, calls, transport };
}

test('send/update/repeat and independent reminder retain one original message', async t => {
  const c = await setup(t);
  const first = await deliver(c.initial, c.options);
  assert.equal(first.revision, 1);
  assert.equal(first.content.config.update_multi, true);
  const changed = await deliver(c.update, c.options);
  assert.equal(changed.revision, 2);
  assert.equal(changed.messageId, first.messageId);
  assert.equal((await deliver(c.update, c.options)).deduplicated, true);
  await assert.rejects(deliver({ ...c.update, content: card('conflict') }, c.options), /different input/);
  await assert.rejects(deliver({ ...c.update, requestId: 'stale' }, c.options), /revision conflict/);
  const reminder = { ...c.initial, requestId: 'notice', requiresUpdate: 'change', msgType: 'text', content: { text: 'New item' } };
  assert.equal((await deliver(reminder, c.options)).status, 'sent');
  await deliver(reminder, c.options);
  assert.deepEqual(c.calls.map(c => c[0]), ['send', 'update', 'send']);
});

test('unknown update blocks later revisions and its dependent reminder without retry', async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  c.transport.update = async () => { c.calls.push(['unknown']); throw new Error('request with secret should not leak'); };
  const result = await deliver(c.update, c.options);
  assert.equal(result.status, 'unconfirmed');
  assert.ok(!JSON.stringify(result).includes('secret'));
  await deliver(c.update, c.options);
  await assert.rejects(deliver({ ...c.update, requestId: 'bypass' }, c.options), /unresolved/);
  await assert.rejects(deliver({ ...c.initial, requestId: 'notice', requiresUpdate: 'change' }, c.options), /not confirmed/);
  assert.equal(c.calls.length, 2);
  assert.equal((await outboundStatus({ ...c.options, requestId: 'change' })).status, 'unconfirmed');
});

test('concurrent sends deduplicate and competing updates cannot overwrite same revision', async t => {
  const c = await setup(t);
  const sends = await Promise.all([deliver(c.initial, c.options), deliver(c.initial, c.options)]);
  assert.equal(sends.filter(r => r.deduplicated).length, 1);
  const results = await Promise.allSettled([deliver(c.update, c.options), deliver({ ...c.update, requestId: 'other-change' }, c.options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.deepEqual(c.calls.map(c => c[0]), ['send','update']);
});

test('case-distinct request IDs keep independent journals on Windows filesystems', async t => {
  const c = await setup(t);
  const upper = { ...c.initial, requestId: 'DAILY', content: card('upper') };
  await Promise.all([deliver(c.initial, c.options), deliver(upper, c.options)]);
  assert.equal((await outboundStatus({ ...c.options, requestId: 'daily' })).content.header.title.content, 'initial');
  assert.equal((await outboundStatus({ ...c.options, requestId: 'DAILY' })).content.header.title.content, 'upper');
  assert.equal((await deliver(c.initial, c.options)).deduplicated, true);
  assert.equal((await deliver(upper, c.options)).deduplicated, true);
});

test('crash-left pending gate blocks subsequent update even with successful operation receipt', async t => {
  const c = await setup(t);
  await deliver(c.initial, c.options);
  await deliver(c.update, c.options);
  const targetPath = outboundPaths(c.stateDir, c.options.appId).target('daily');
  const head = JSON.parse(await readFile(targetPath, 'utf8'));
  head.pending = 'change'; // Durable state between operation receipt and clearing head gate.
  await writeFile(targetPath, JSON.stringify(head));
  await assert.rejects(deliver({ ...c.update, requestId: 'next', expectedRevision: 2 }, c.options), /unresolved/);
  assert.equal(c.calls.filter(c => c[0] === 'update').length, 1);
});

test('lost send receipt never retries and oversized card submits no message', async t => {
  const c = await setup(t);
  c.transport.send = async () => { c.calls.push(['lost']); throw new Error('lost receipt'); };
  assert.equal((await deliver(c.initial, c.options)).status, 'unconfirmed');
  assert.equal((await deliver(c.initial, c.options)).deduplicated, true);
  const result = await deliver({ ...c.initial, requestId: 'large', content: card('a'.repeat(31000)) }, c.options);
  assert.equal(result.status, 'blocked');
  assert.equal(c.calls.length, 1);
});

test('local images upload and changed image bytes conflict even when path is unchanged', async t => {
  const c = await setup(t);
  await writeFile(path.join(c.stateDir, 'image.png'), 'bytes');
  const input = { ...c.initial, images: { photo: 'image.png' }, content: { elements: [{ tag: 'img', img_key: 'local:photo' }] } };
  const result = await deliver(input, c.options);
  assert.equal(result.content.elements[0].img_key, 'img_test');
  await writeFile(path.join(c.stateDir, 'image.png'), 'changed');
  await assert.rejects(deliver(input, c.options), /different input/);
  assert.deepEqual(c.calls.map(c=>c[0]), ['upload','send']);
});

test('preparation failure submits no message and CLI rejects ambiguous input', async t => {
  const c = await setup(t);
  await writeFile(path.join(c.stateDir, 'a.png'), 'bytes');
  c.transport.upload = async () => { throw new Error('upload failure'); };
  const input = { ...c.initial, images: { a: 'a.png' }, content: { elements: [{ tag:'img', img_key:'local:a' }] } };
  const r = await deliver(input, c.options);
  assert.equal(r.status, 'blocked'); assert.equal(r.submitted, false);
  assert.equal(c.calls.length, 0);
  await assert.rejects(prepareContent({ ...c.initial, content: { config: { update_multi: false } } }), /Shared card/);
  assert.throws(() => parseArgs(['send','--input','a','--input','b']), /repeated/);
  assert.throws(() => parseArgs(['status','--input','a']), /incompatible/);
});
