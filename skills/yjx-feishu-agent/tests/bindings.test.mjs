import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { main, rebind, setQuoteRouting, setRequireMention } from '../scripts/bindings.mjs';
import { resultText } from '../scripts/feishu-core.mjs';
import { validateBindings } from '../scripts/feishu-core.mjs';
import { readTarget } from '../scripts/target.mjs';
import { RpcError } from '../scripts/app-server.mjs';
const old = '11111111-1111-4111-8111-111111111111';
const next = '22222222-2222-4222-8222-222222222222';
const config = { version: 1, cwd: '/workspace', bindings: [
  { chatId: 'oc_a', users: ['ou_owner'], threadId: old },
  { chatId: 'oc_b', users: ['ou_second'], threadId: next },
] };

test('quote routing changes only its explicit group and preserves fallback and allowlist',()=>{
  const changed=setQuoteRouting(config,{chatId:'oc_a',enabled:'true'});
  assert.deepEqual(changed.bindings[0],{...config.bindings[0],quoteRouting:true});
  assert.deepEqual(changed.bindings[1],config.bindings[1]);
  assert.equal(config.bindings[0].quoteRouting,undefined);
  assert.throws(()=>setQuoteRouting(config,{chatId:'oc_other',enabled:'true'}));
  assert.throws(()=>setQuoteRouting(config,{chatId:'oc_a',enabled:'yes'}));
});
test('requireMention changes only its explicit group and validates boolean values', () => {
  const changed = setRequireMention(config, { chatId: 'oc_a', enabled: 'false' });
  assert.deepEqual(changed.bindings[0], { ...config.bindings[0], requireMention: false });
  assert.deepEqual(changed.bindings[1], config.bindings[1]);
  assert.equal(config.bindings[0].requireMention, undefined);
  assert.throws(() => setRequireMention(config, { chatId: 'oc_other', enabled: 'false' }));
  assert.throws(() => setRequireMention(config, { chatId: 'oc_a', enabled: 'no' }));
  assert.throws(() => validateBindings({ version: 1, bindings: [{ ...config.bindings[0], requireMention: 'false' }] }), /requireMention/);
});
test('quote-only and quote-disabled authorization can be saved without a default thread',()=>{
  const quoteOnly={version:1,bindings:[{chatId:'oc_quote',users:['ou_owner']}]};
  assert.doesNotThrow(()=>validateBindings(quoteOnly));
  assert.doesNotThrow(()=>setQuoteRouting(quoteOnly,{chatId:'oc_quote',enabled:'false'}));
  assert.throws(()=>validateBindings({version:1,bindings:[{chatId:'oc_quote',users:[]}]}),/allowlist/);
});
test('rebind checks old identity and preserves allowlists and unrelated bindings', async () => {
  const options = { chatId: 'oc_a', expectedThread: old, threadId: next };
  const result = await rebind(config, options, async () => ({ state: 'readable' }));
  assert.equal(result.bindings[0].threadId, next);
  assert.deepEqual(result.bindings[0].users, config.bindings[0].users);
  assert.deepEqual(result.bindings[1], config.bindings[1]);
  assert.equal(config.bindings[0].threadId, old);
  await assert.rejects(rebind(config, { ...options, expectedThread: next }, () => { throw Error('must not check'); }), /changed/);
  for (const state of ['archived', 'unavailable', 'unknown']) {
    await assert.rejects(rebind(config, options, async () => ({ state })), /not readable/);
  }
});
test('only known path components classify active/archive; notLoaded is not deleted', async () => {
  for (const [file, state] of [['C:\\data\\sessions\\a.jsonl','readable'],['/data/archived_sessions/a.jsonl','archived'],['/other/a.jsonl','unknown'],[null,'unknown']]) {
    const result = await readTarget({ call: async () => ({ thread: { id: old, path: file, status: { type: 'notLoaded' } } }) }, old, 1);
    assert.equal(result.state, state);
  }
  assert.equal((await readTarget({ call: async () => { throw new RpcError({ code: -32600, message: `thread not loaded: ${old}` }); } }, old, 1)).state, 'unavailable');
  assert.equal((await readTarget({ call: async () => { throw Error('transport failed'); } }, old, 1)).state, 'unknown');
});

test('require-mention CLI writes live without taking the receiver lock', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yjx-feishu-bindings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'feishu'), { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'feishu', 'bindings.json');
  await writeFile(file, JSON.stringify({ version: 1, bindings: [
    { chatId: 'oc_a', users: ['ou_owner'], threadId: old },
  ] }));
  const lines = [];
  const orig = console.log;
  console.log = value => { lines.push(String(value)); };
  try { await main(['require-mention', '--chat', 'oc_a', '--enabled', 'false', '--state-dir', dir]); }
  finally { console.log = orig; }
  const result = JSON.parse(lines.at(-1));
  assert.equal(result.status, 'configured');
  assert.equal(result.requireMention, false);
  assert.equal(result.restartRequired, false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).bindings[0].requireMention, false);
});
