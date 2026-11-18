import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acceptedMessage, createReceiver, validateBindings } from '../scripts/feishu-core.mjs';
import { renderReply } from '../scripts/reply-renderer.mjs';

const config = { version: 1, bindings: [{ chatId: 'oc_test', users: ['ou_user'], threadId: '11111111-1111-4111-8111-111111111111' }] };
const event = (id = 'om_one') => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
  message: { message_id: id, chat_id: 'oc_test', chat_type: 'group', message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 hello' }), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] } });

async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'yjx-feishu-receiver-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const replies = [];
  const options = { appId: 'cli_test', botId: 'ou_bot', config, stateDir,
    send: async (input) => { calls.push(input); return { status: 'completed', answer: 'answer' }; },
    reply: async (...input) => { replies.push(input); }, ...overrides };
  return { receiver: createReceiver(options), options, calls, replies };
}

test('requires bound group, allowed human, text and mention of this bot', () => {
  assert.equal(acceptedMessage(event(), config, 'ou_bot').text, 'hello');
  for (const change of [
    (e) => { e.message.chat_id = 'oc_other'; },
    (e) => { e.sender.sender_id.open_id = 'ou_other'; },
    (e) => { e.sender.sender_type = 'app'; },
    (e) => { e.message.message_type = 'image'; },
    (e) => { e.message.mentions[0].id.open_id = 'ou_otherbot'; },
    (e) => { e.message.content = '{broken'; },
  ]) { const e = event(); change(e); assert.equal(acceptedMessage(e, config, 'ou_bot'), null); }
  assert.throws(() => validateBindings({ version: 1, bindings: [{ ...config.bindings[0], users: [] }] }), /allowlist/);
});

test('rich-text mention and quoted message are admitted with reference metadata', async t => {
  const e = event('om_rich');
  e.message.message_type = 'post';
  e.message.parent_id = 'om_quote';
  e.message.content = JSON.stringify({ title: '请查看', content: [[{ tag: 'at', user_id:'ou_bot' }, { tag:'text', text:'这条通知是什么意思？' }]] });
  const item = acceptedMessage(e, config, 'ou_bot');
  assert.equal(item?.parentId, 'om_quote');
  assert.match(item?.text ?? '', /这条通知是什么意思/);
  const f = await fixture(t, { context: async item => `${item.text}\n引用：周一交作业` });
  await f.receiver.handle(e);
  await f.receiver.stop();
  assert.match(f.calls[0]?.message ?? '', /引用：周一交作业/);
});

test('post at placeholder for bot is removed and mention-only task is ignored',()=>{
  const e=event('om_placeholder');e.message.message_type='post';
  e.message.content=JSON.stringify({content:[[{tag:'at',user_id:'@_user_1'}]]});
  assert.equal(acceptedMessage(e,config,'ou_bot'),null);
  e.message.content=JSON.stringify({content:[[{tag:'at',user_id:'@_user_1'},{tag:'text',text:'解释引用'}]]});
  assert.equal(acceptedMessage(e,config,'ou_bot').text,'解释引用');
});

test('duplicate concurrent deliveries invoke Codex and reply only once', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.receiver.handle(event()), f.receiver.handle(event())]);
  await f.receiver.stop();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].message, 'hello');
  assert.equal(f.calls[0].threadId, config.bindings[0].threadId);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0][0], 'om_one');
  assert.deepEqual(await f.receiver.unsettled(), []);
});

test('admission persists before completion and stop waits for all admitted work', async (t) => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  const f = await fixture(t, { send: async (input) => { calls.push(input); await gate; return { status: 'completed', answer: 'done' }; } });
  await f.receiver.handle(event('om_first'));
  await f.receiver.handle(event('om_second'));
  assert.equal((await f.receiver.unsettled()).length, 2);
  let stopped = false;
  const stopping = f.receiver.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finish();
  await stopping;
  assert.equal(calls.length, 2);
  assert.equal(f.replies.length, 2);
});

test('uncertain reply is retained and not retried after receiver restart', async (t) => {
  let replyAttempts = 0;
  const f = await fixture(t, { reply: async () => { replyAttempts += 1; throw new Error('connection lost'); } });
  await f.receiver.handle(event());
  await f.receiver.stop();
  assert.equal((await f.receiver.unsettled())[0].status, 'unconfirmed');
  const restarted = createReceiver(f.options);
  await restarted.handle(event());
  await restarted.stop();
  assert.equal(f.calls.length, 1);
  assert.equal(replyAttempts, 1);
});

test('unconfirmed Codex results are reported without a successful answer claim', async (t) => {
  const f = await fixture(t, { send: async () => ({ status: 'unconfirmed', answer: 'late partial' }) });
  await f.receiver.handle(event());
  await f.receiver.stop();
  assert.match(f.replies[0][1], /还在处理/);
  assert.doesNotMatch(f.replies[0][1], /late partial|请求：|请在本机|不要重复/);
});

test('accepted reaction suppresses the duplicate pending-text reply', async (t) => {
  const f = await fixture(t, {
    feedback: { update: async () => ({ delivered:true }) },
    admitRoute: async (_item, persist) => persist({ threadId:null, agentTarget:{kind:'t3',threadId:'t3-test'} }),
    send: async () => ({ status:'running', submitted:true }),
  });
  f.options.reply = async (...input) => { f.replies.push(input); return { message_id:'om_reply' }; };
  const receiver = createReceiver(f.options);
  await receiver.handle(event());
  for (let index = 0; index < 50; index++) {
    await new Promise(resolve => setImmediate(resolve));
    if ((await receiver.unsettled()).length) break;
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.replies.length, 0);
  await receiver.stop();
  assert.equal(f.replies.length, 0);
});

test('failed accepted reaction leaves the pending-text fallback', async (t) => {
  const f = await fixture(t, {
    feedback: { update: async () => ({ delivered:false }) },
    admitRoute: async (_item, persist) => persist({ threadId:null, agentTarget:{kind:'t3',threadId:'t3-test'} }),
    send: async () => ({ status:'running', submitted:true }),
  });
  f.options.reply = async (...input) => { f.replies.push(input); return { message_id:`om_status_${f.replies.length}` }; };
  const receiver = createReceiver(f.options);
  await receiver.handle(event());
  for (let index = 0; index < 50; index++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (f.replies.length) break;
  }
  assert.match(f.replies[0]?.[1] ?? '', /还在处理/);
  await receiver.stop();
});

test('accepted reaction never hides a terminal failure', async (t) => {
  const f = await fixture(t, {
    feedback: { update: async () => ({ delivered:true }) },
    admitRoute: async (_item, persist) => persist({ threadId:null, agentTarget:{kind:'t3',threadId:'t3-test'} }),
    send: async () => ({ status:'failed', submitted:true }),
  });
  f.options.reply = async (...input) => { f.replies.push(input); return { message_id:`om_status_${f.replies.length}` }; };
  const receiver = createReceiver(f.options);
  await receiver.handle(event());
  for (let index = 0; index < 50; index++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (f.replies.length) break;
  }
  assert.match(f.replies[0]?.[1] ?? '', /这次没答上/);
  await receiver.stop();
});

test('bridge research requests wait for task state with independently bounded RPC calls',async t=>{
  const defaults=await fixture(t);
  await defaults.receiver.handle(event());await defaults.receiver.stop();
  assert.equal(defaults.calls[0].waitMode,'state');assert.equal(defaults.calls[0].timeoutMs,30000);
  const configured=await fixture(t,{config:{...config,codexTimeoutMs:600000,codexRpcTimeoutMs:50000}});
  await configured.receiver.handle(event());await configured.receiver.stop();
  assert.equal(configured.calls[0].timeoutMs,50000);assert.equal(configured.calls[0].waitMode,'state');
  for(const value of [0,999,120001,NaN,'30000']) {
    assert.throws(()=>validateBindings({...config,codexRpcTimeoutMs:value}),/codexRpcTimeoutMs/);
  }
});

test('reply rendering metadata is persisted before the remote reply',async t=>{
  const payloads=[];
  const f=await fixture(t,{prepareReply:renderReply,reply:async(...args)=>{
    payloads.push(args[3]);return {message_id:'om_rendered'};
  },send:async()=>({status:'completed',answer:'<!-- feishu:card -->\n结论\n\n**结果**'})});
  await f.receiver.handle(event('om_rendered_input'));await f.receiver.stop();
  assert.equal(payloads[0].msgType,'interactive');
  const {readFile}=await import('node:fs/promises');
  const record=JSON.parse(await readFile(`${f.options.stateDir}/feishu/${(await import('../scripts/feishu-core.mjs')).digest('cli_test')}/messages/fs-${(await import('../scripts/feishu-core.mjs')).digest('cli_test:om_rendered_input')}.json`,'utf8'));
  assert.equal(record.replyType,'interactive');assert.equal(record.replyMode,'card');assert.ok(record.replyPayloadDigest);
});

test('rejected group messages leave no request or reply', async (t) => {
  const f = await fixture(t);
  const wrong = event(); wrong.message.chat_id = 'oc_other';
  await f.receiver.handle(wrong);
  await f.receiver.stop();
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, 0);
  assert.deepEqual(await f.receiver.unsettled(), []);
});

test('admission rejects bursts before retaining an unbounded event backlog', async (t) => {
  const f = await fixture(t);
  const burst = Array.from({ length: 40 }, (_, i) => f.receiver.handle(event(`om_burst_${i}`)));
  const results = await Promise.allSettled(burst);
  await f.receiver.stop();
  assert.equal(results.filter((result) => result.status === 'rejected').length, 8);
  assert.equal(f.calls.length, 32);
});

test('binding fallback adds a fixed notice only to that route',async t=>{
  const f=await fixture(t,{admitRoute:async(item,persist)=>persist({threadId:config.bindings[0].threadId,autoUnarchive:false,routeMode:item.parentId?'binding-fallback':'default'}),
    send:async()=>({status:'completed',answer:'answer'})});
  const e=event('om_fallback');e.message.parent_id='om_unregistered';
  await f.receiver.handle(e);await f.receiver.handle(event('om_default'));await f.receiver.stop();
  assert.match(f.replies[0][1],/来源未登记.*回退/);
  assert.doesNotMatch(f.replies[1][1],/回退/);
});

test('quote-disabled groups can start without a default and block per message',()=>{
  validateBindings({version:1,bindings:[{chatId:'oc_disabled',users:['ou_user'],quoteRouting:false}]});
});

test('requireMention false accepts unmentioned messages from allowlisted users only', () => {
  const noMentionConfig = {
    version: 1,
    bindings: [{ ...config.bindings[0], requireMention: false }],
  };
  const unmentioned = event('om_nomention');
  unmentioned.message.content = JSON.stringify({ text: '直接问个问题' });
  unmentioned.message.mentions = [];

  assert.equal(acceptedMessage(unmentioned, noMentionConfig, 'ou_bot')?.text, '直接问个问题');
  assert.equal(acceptedMessage(unmentioned, config, 'ou_bot'), null);
  assert.equal(acceptedMessage(event('om_still_at'), noMentionConfig, 'ou_bot')?.text, 'hello');

  const nonAllowed = structuredClone(unmentioned);
  nonAllowed.sender.sender_id.open_id = 'ou_other';
  assert.equal(acceptedMessage(nonAllowed, noMentionConfig, 'ou_bot'), null);

  const fromBot = structuredClone(unmentioned);
  fromBot.sender.sender_type = 'app';
  assert.equal(acceptedMessage(fromBot, noMentionConfig, 'ou_bot'), null);
});
