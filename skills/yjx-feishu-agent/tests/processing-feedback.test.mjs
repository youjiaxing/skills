import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProcessingFeedback, feedbackOutcome } from '../scripts/processing-feedback.mjs';
import { createReceiver, digest, writeJournal } from '../scripts/feishu-core.mjs';
import { reactionTransport } from '../scripts/reaction-transport.mjs';

const appId = 'cli_test';
const record = {requestId:`fs-${digest('test')}`, messageId:'om_request'};
const reaction = (emoji, id = emoji, owner = appId) => ({reaction_id:id,
  operator:{operator_type:'app', operator_id:owner}, reaction_type:{emoji_type:emoji}});
async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'yjx-feedback-'));
  t.after(() => rm(stateDir, {recursive:true, force:true}));
  const calls = [], warnings = [], items = [];
  const transport = {
    async list(id, emoji) { calls.push(['list',id,emoji]); return items.filter(i => i.reaction_type.emoji_type === emoji); },
    async create(id, emoji) { calls.push(['create',id,emoji]); const r = reaction(emoji); items.push(r); return r; },
    async remove(id, rid) { calls.push(['delete',id,rid]); items.splice(items.findIndex(i => i.reaction_id === rid),1); },
    ...overrides,
  };
  const options = {stateDir, appId, transport, log:x => warnings.push(x)};
  const feedback = createProcessingFeedback(options);
  const root = path.join(stateDir,'feishu',digest(appId));
  const journal = async () => JSON.parse(await readFile(path.join(root,'feedback',`${record.requestId}.json`),'utf8'));
  return {feedback, options, calls, items, warnings, root, journal};
}

test('accepted and terminal transitions serialize late receipts, with owned cleanup only', async t => {
  let finish, entered;
  const gate = new Promise(r => {finish=r;});
  const started = new Promise(r => {entered=r;});
  const f = await fixture(t, {async create(id, emoji) {
    f.calls.push(['create',id,emoji]);
    if (emoji === 'OnIt') { entered(); await gate; }
    const item = reaction(emoji); f.items.push(item); return item;
  }});
  f.items.push(reaction('OnIt','someone-else','cli_other'),reaction('SMILE','unrelated'));
  f.feedback.update(record,'accepted');
  await started;
  f.feedback.update(record,'completed');
  finish(); await f.feedback.stop();
  assert.deepEqual(f.calls.filter(c => c[0] === 'create').map(c => c[2]),['OnIt','DONE']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'delete').map(c => c[2]),['OnIt']);
  assert.equal((await f.journal()).desired,'completed');
  assert.deepEqual(f.items.map(i => i.reaction_id).sort(),['DONE','someone-else','unrelated']);
  f.feedback.update(record,'accepted'); await f.feedback.stop();
  assert.equal((await f.journal()).desired,'completed');
});

test('unknown create is only reconciled read-only, never posted again even if absent', async t => {
  const f = await fixture(t, {async create(id, emoji) {f.calls.push(['create',id,emoji]); throw new Error('lost');}});
  f.feedback.update(record,'accepted'); await f.feedback.stop();
  f.feedback.update(record,'accepted'); await f.feedback.stop();
  assert.equal(f.calls.filter(c => c[0] === 'create').length,1);
  assert.equal((await f.journal()).attempts.accepted.status,'unknown');
  assert.equal(f.warnings.length,1);
});

test('ambiguous create with later proven bot receipt is cleaned after terminal mark', async t => {
  const f = await fixture(t, {async create(id, emoji) {
    f.calls.push(['create',id,emoji]); const item = reaction(emoji); f.items.push(item);
    if (emoji === 'OnIt') throw new Error('lost acknowledgement');
    return item;
  }});
  f.feedback.update(record,'accepted'); await f.feedback.stop();
  f.feedback.update(record,'attention'); await f.feedback.stop();
  assert.deepEqual(f.items.map(i => i.reaction_id),['CrossMark']);
  assert.equal((await f.journal()).attempts.accepted.status,'deleted');
});

test('preexisting own emoji is never adopted or removed; permission failure is best effort', async t => {
  const f = await fixture(t);
  f.items.push(reaction('OnIt','external'));
  f.feedback.update(record,'accepted'); f.feedback.update(record,'completed'); await f.feedback.stop();
  assert.ok(f.items.some(i => i.reaction_id === 'external'));
  assert.equal(f.calls.filter(c => c[0] === 'delete').length,0);
  const denied = await fixture(t,{async list() { throw new Error('no scope'); }});
  denied.feedback.update(record,'accepted'); await denied.feedback.stop();
  assert.equal(denied.warnings.length,1);
  assert.equal(denied.calls.length,0);
});

test('restart uses persisted completion evidence, does not reapply old accepted markers', async t => {
  const f = await fixture(t);
  f.feedback.update(record,'accepted'); await f.feedback.stop();
  await mkdir(path.join(f.root,'messages'),{recursive:true});
  await writeJournal(path.join(f.root,'messages',`${record.requestId}.json`),
    {...record,feedbackVersion:1,status:'unconfirmed',codexStatus:'completed',replyMessageId:'om_answer'});
  const restarted = createProcessingFeedback(f.options);
  await restarted.recover(); await restarted.stop();
  assert.equal((await f.journal()).desired,'completed');
  assert.deepEqual(f.items.map(i => i.reaction_id),['DONE']);
  assert.equal(feedbackOutcome({status:'replied',codexStatus:'completed'}),'attention');
  assert.equal(feedbackOutcome({codexStatus:'blocked',replyMessageId:'om_error'}),'attention');
});

test('safe marker warning is persisted and cleared after a confirmed terminal transition',async t=>{
  let denied=true;
  const f=await fixture(t,{async list() {
    if(denied) { const e=new Error('secret-error-body');e.apiCode=99991672;throw e; }
    return [];
  }});
  f.feedback.update(record,'accepted');await f.feedback.stop();
  const warning=(await f.journal()).lastWarning;
  assert.equal(warning.apiCode,99991672);
  assert.ok(!JSON.stringify(warning).includes('secret-error'));
  denied=false;f.feedback.update(record,'completed');await f.feedback.stop();
  assert.equal((await f.journal()).lastWarning,undefined);
});

test('restart covers durable admission before first marker write, excluding pre-upgrade tasks',async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root,'messages'),{recursive:true});
  await writeJournal(path.join(f.root,'messages',`${record.requestId}.json`),
    {...record,feedbackVersion:1,status:'accepted'});
  const old = {...record,requestId:`fs-${digest('old')}`,messageId:'om_old',status:'accepted'};
  await writeJournal(path.join(f.root,'messages',`${old.requestId}.json`),old);
  await f.feedback.recover(); await f.feedback.stop();
  assert.equal((await f.journal()).desired,'attention');
  assert.deepEqual(f.calls.filter(c => c[0] === 'create'),[['create',record.messageId,'CrossMark']]);
});

const config = {version:1, bindings:[{chatId:'oc_test',users:['ou_user'],threadId:'11111111-1111-4111-8111-111111111111'}]};
const event = {sender:{sender_type:'user',sender_id:{open_id:'ou_user'}},message:{
  message_id:'om_input',chat_id:'oc_test',chat_type:'group',message_type:'text',
  content:JSON.stringify({text:'@_bot test'}),mentions:[{key:'@_bot',id:{open_id:'ou_bot'}}]}};
async function runReceiver(t, overrides = {}) {
  const f = await fixture(t), replies = [], marks = [];
  const receiver = createReceiver({stateDir:f.options.stateDir,appId,botId:'ou_bot',config,
    send:async () => ({status:'completed',answer:'result'}),
    reply:async (...args) => {replies.push(args); return {message_id:'om_answer'};},
    feedback:{update(r, desired) {marks.push(desired);}},...overrides});
  await receiver.handle(event); await receiver.stop();
  return {...f, receiver, replies, marks};
}

test('completion requires answer receipt; routing bookkeeping failure still marks done',async t => {
  const f = await runReceiver(t,{async confirmReply() {throw new Error('route journal unavailable');}});
  assert.deepEqual(f.marks,['accepted','completed']);
  assert.equal(f.replies.length,1);
  assert.equal((await f.receiver.unsettled())[0].status,'unconfirmed');
  const noReceipt = await runReceiver(t,{reply:async () => ({})});
  assert.deepEqual(noReceipt.marks,['accepted','attention']);
});

test('errors get one explanation only before any reply attempt',async t => {
  const failed = await runReceiver(t,{send:async () => {throw new Error('lost task result');}});
  assert.equal(failed.replies.length,1);
  assert.deepEqual(failed.marks,['accepted','attention']);
  let attempts = 0;
  const unknown = await runReceiver(t,{reply:async () => {attempts++; throw new Error('lost reply');}});
  assert.equal(attempts,1);
  assert.deepEqual(unknown.marks,['accepted','attention']);
});

test('answer receipt that cannot be persisted must not publish completion',async t => {
  const f = await fixture(t), marks = [];
  const messages = path.join(f.root,'messages');
  const receiver = createReceiver({stateDir:f.options.stateDir,appId,botId:'ou_bot',config,
    feedback:{update(r,state) {marks.push(state);}},
    send:async () => ({status:'completed',answer:'result'}),
    reply:async () => {
      await rename(messages,`${messages}-saved`);
      await writeFile(messages,'prevent journal writes');
      return {message_id:'om_not_durable'};
    }});
  await receiver.handle(event); await receiver.stop();
  assert.deepEqual(marks,['accepted','attention']);
});

test('marker network waits never hold up Codex or its reply',async t => {
  let release;
  const gate = new Promise(r => {release=r;});
  const f = await fixture(t,{async list() {await gate; return [];}});
  let sent=false, replied=false;
  const receiver = createReceiver({stateDir:f.options.stateDir,appId,botId:'ou_bot',config,feedback:f.feedback,
    send:async () => {sent=true; return {status:'completed',answer:'done'};},
    reply:async () => {replied=true; return {message_id:'om_answer'};}});
  await receiver.handle(event); await receiver.stop();
  assert.ok(sent && replied);
  release(); await f.feedback.stop();
});

test('dedicated HTTP transport aborts slow token fetch and paginates without secret errors',async () => {
  const transport = reactionTransport({appId,appSecret:'never-log'}, {timeoutMs:20,
    fetchImpl:async (url,{signal}) => new Promise((resolve,reject) => {
      const timer = setTimeout(resolve,1000);
      signal.addEventListener('abort',() => {clearTimeout(timer); reject(signal.reason);},{once:true});
    })});
  await assert.rejects(transport.create('om_test','OnIt'), {name:'TimeoutError'});
  let calls=0;
  const paged = reactionTransport({appId,appSecret:'never-log'}, {fetchImpl:async (url, options) => {
    calls++;
    if (calls === 1) return {ok:true,json:async () => ({code:0,tenant_access_token:'private',expire:1000})};
    assert.equal(new URL(url).searchParams.get('page_size'),'50');
    assert.equal(options.headers.Authorization,'Bearer private');
    return {ok:true,json:async () => ({code:0,data:{items:[reaction('OnIt',String(calls))],
      has_more:calls===2,page_token:calls===2 ? 'next' : undefined}})};
  }});
  assert.equal((await paged.list('om_test','OnIt')).length,2);
  assert.equal(calls,3);
});
