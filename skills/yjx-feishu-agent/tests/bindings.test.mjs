import test from 'node:test';
import assert from 'node:assert/strict';
import { rebind, setQuoteRouting } from '../scripts/bindings.mjs';
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
test('receiver distinguishes safe target block from uncertain submitted task', () => {
  assert.match(resultText({ status:'blocked', submitted:false, error:{code:'TARGET_ARCHIVED'} }, 'r'), /已归档.*未提交/);
  assert.match(resultText({ status:'blocked', submitted:false, error:{code:'TARGET_UNAVAILABLE'} }, 'r'), /不能据此判断/);
  assert.match(resultText({ status:'unconfirmed', submitted:true, error:{code:'TARGET_ARCHIVED'} }, 'r'), /不要重复/);
});
