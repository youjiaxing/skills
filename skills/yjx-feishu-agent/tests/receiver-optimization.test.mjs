import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReceiver, digest, messageDecision, validateBindings } from '../scripts/feishu-core.mjs';
import { diagnoseMessage } from '../scripts/message-diagnostics.mjs';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const event=(id,chat='oc_a')=>({sender:{sender_type:'user',sender_id:{open_id:'ou_user'}},message:{
  message_id:id,chat_id:chat,chat_type:'group',message_type:'text',mentions:[{key:'@bot',id:{open_id:'ou_bot'}}],
  content:JSON.stringify({text:'@bot private-body-never-store'})}});
async function setup(t,extra={}) {
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'receiver-optimization-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const config={version:1,bindings:[{chatId:'oc_a',threadId:A,users:['ou_user']},
    {chatId:'oc_a2',threadId:A,users:['ou_user']},{chatId:'oc_b',threadId:B,users:['ou_user']}]};
  const options={appId:'cli_test',botId:'ou_bot',stateDir,config,send:async()=>({status:'completed',answer:'answer'}),
    reply:async id=>({message_id:`${id}_reply`}),...extra};
  return {options,receiver:createReceiver(options),diag:id=>diagnoseMessage({...options,messageId:id})};
}
test('same thread stays serial across groups, independent thread bypasses blocked queue head; stop drains all',{timeout:10000},async t=>{
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  let bFinished;const independentDone=new Promise(r=>bFinished=r);
  const begins=[],ends=[];
  const f=await setup(t,{send:async input=>{
    begins.push(input.threadId);
    if(begins.length===1) {entered();await gate;}
    ends.push(input.threadId);if(input.threadId===B) bFinished();return {status:'completed',answer:'ok'};
  }});
  await f.receiver.handle(event('om_a'));await started;
  await f.receiver.handle(event('om_a2','oc_a2'));
  await f.receiver.handle(event('om_b','oc_b'));
  // Use the independent task's completion signal, not filesystem timing.
  await independentDone;
  assert.deepEqual(begins,[A,B]);assert.deepEqual(ends,[B]);
  let stopped=false;const stopping=f.receiver.stop().then(()=>stopped=true);
  await new Promise(r=>setImmediate(r));assert.equal(stopped,false);
  release();await stopping;
  assert.deepEqual(begins,[A,B,A]);
  assert.equal((await f.diag('om_a2')).task.status,'replied');
  await assert.rejects(f.receiver.handle(event('om_after')),/stopping/);
});
test('stop accepts already queued admissions and configurable concurrency is validated',async t=>{
  const f=await setup(t);
  const first=f.receiver.handle(event('om_first')),second=f.receiver.handle(event('om_second'));
  await f.receiver.stop();await Promise.all([first,second]);
  assert.equal((await f.diag('om_second')).task.status,'replied');
  assert.throws(()=>validateBindings({...f.options.config,maxConcurrentThreads:0}),/1–8/);
});
test('local diagnostics distinguish rejection, missing observations and reply/route failures without bodies',async t=>{
  const f=await setup(t,{confirmReply:async()=>{throw new Error('secret-auth-details');}});
  const noAt=event('om_noat');noAt.message.mentions=[];
  assert.equal(messageDecision(noAt,f.options.config,'ou_bot').reason,'BOT_NOT_MENTIONED');
  await f.receiver.handle(noAt);
  await f.receiver.handle(event('om_reply'));await f.receiver.stop();
  assert.equal((await f.diag('om_noat')).admission.reason,'BOT_NOT_MENTIONED');
  const d=await f.diag('om_reply');assert.equal(d.reply.state,'confirmed');
  assert.equal(d.task.failure.stage,'route_confirmation');
  const unknown=await f.diag('om_missing');assert.equal(unknown.admission.state,'not_observed');
  const files=await readdir(path.join(f.options.stateDir,'feishu',digest('cli_test'),'messages'));
  for(const name of files) {
    const text=await readFile(path.join(f.options.stateDir,'feishu',digest('cli_test'),'messages',name),'utf8');
    assert.ok(!text.includes('private-body') && !text.includes('secret-auth'));
  }
  assert.equal(d.readOnly,true);
});
test('Codex submission evidence and uncertain reply remain independently inspectable',async t=>{
  const f=await setup(t,{send:async()=>({status:'unconfirmed',submitted:true,error:{code:'COMPLETION_UNCONFIRMED'}}),
    reply:async()=>{const e=new Error('sensitive');e.apiCode=123;e.httpStatus=500;throw e;}});
  await f.receiver.handle(event('om_lost'));await f.receiver.stop();
  const d=await f.diag('om_lost');assert.equal(d.codex.submitted,true);
  assert.equal(d.codex.code,'COMPLETION_UNCONFIRMED');assert.equal(d.reply.state,'unknown');
  assert.deepEqual(d.task.failure,{stage:'reply',code:'OPERATION_UNCONFIRMED',apiCode:123,httpStatus:500});
});
