import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createReceiver, digest, writeJournal} from '../scripts/feishu-core.mjs';
import {reserveRecord} from '../scripts/state.mjs';
import {createDeliveryJobs} from '../scripts/delivery-jobs.mjs';
import {createMessageRouter, withRoutes} from '../scripts/message-routes.mjs';

const appId='cli_test', source='11111111-1111-4111-8111-111111111111', target='22222222-2222-4222-8222-222222222222';
async function fixture(t, overrides={}) {
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'feishu-deliveries-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const directory=path.join(stateDir,'feishu',digest(appId),'messages');
  await mkdir(directory,{recursive:true});
  let clock=100000;
  const calls=[], marks=[], router=createMessageRouter({stateDir,appId});
  const options={directory,stateDir,appId,operationMs:1000,now:()=>clock,
    prepareReply:text=>({msgType:'text',content:{text},mode:'text'}),
    reply:async(id,text,key)=>{calls.push({id,text,key});return {message_id:`om_${calls.length}`};},
    confirmReply:router.rememberReply,feedback:{update:(r,state)=>marks.push(state)},log:()=>{},
    refresh:async()=>({agent:'t3',status:'completed',submitted:true,answer:'final answer'}),...overrides};
  const record={requestId:`fs-${digest('input')}`,messageId:'om_input',chatId:'oc_test',threadId:source,
    agentTarget:{kind:'t3',threadId:target},feedbackVersion:1};
  return {stateDir,directory,calls,marks,options,record,jobs:createDeliveryJobs(options),
    advance:ms=>clock+=ms,read:async()=>JSON.parse(await readFile(path.join(directory,record.requestId+'.json'),'utf8'))};
}

test('placeholder and answer have separate stable identities and both preserve quote routing',async t=>{
  const f=await fixture(t);
  await f.jobs.track(f.record,{binding:{chatId:'oc_test'}},{agent:'t3',status:'queued',submitted:true,delivery:'queued'});
  await f.jobs.drain();
  assert.equal(f.calls.length,1);
  f.jobs.tick();await f.jobs.drain();
  assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].key,f.calls[1].key);
  assert.equal(f.calls[1].text,'final answer');
  const record=await f.read();assert.equal(record.answerMessageId,'om_2');
  const routes=await withRoutes({stateDir:f.stateDir,appId,chatId:'oc_test'},data=>data.messages);
  assert.equal(routes.om_1.sourceThreadId,source);assert.equal(routes.om_2.sourceThreadId,source);
  assert.equal(f.marks.at(-1),'completed');await f.jobs.stop();
});

test('lost answer receipts retry only the frozen delivery within the Feishu dedupe window',async t=>{
  const remote=new Map();let calls=0;
  const f=await fixture(t,{reply:async(id,text,key,rendered)=>{
    calls++;remote.set(key,{message_id:'om_answer',content:structuredClone(rendered)});
    if(calls===1) throw new Error('lost response');
    return remote.get(key);
  }});
  await f.jobs.track(f.record,{binding:{chatId:'oc_test'}},{agent:'t3',status:'completed',submitted:true,answer:'answer'});
  await f.jobs.drain();const pending=await f.read();assert.equal(pending.answerDelivery.state,'unknown');
  f.advance(10000);f.jobs.tick();await f.jobs.drain();
  assert.equal(calls,2);assert.equal(remote.size,1);assert.equal((await f.read()).answerDelivery.state,'confirmed');
  await f.jobs.stop();
});

test('an ambiguous write past the dedupe window is retained and marked, never blindly resent',async t=>{
  let calls=0;
  const f=await fixture(t,{reply:async()=>{calls++;throw new Error('lost');}});
  await f.jobs.track(f.record,{binding:{chatId:'oc_test'}},{agent:'t3',status:'completed',submitted:true,answer:'answer'});
  await f.jobs.drain();f.advance(3600000);f.jobs.tick();await f.jobs.drain();
  assert.equal(calls,1);assert.equal((await f.read()).feedbackFailure.code,'DELIVERY_REQUIRES_RECONCILIATION');
  assert.equal(f.marks.at(-1),'attention');await f.jobs.stop();
});

test('restart resumes observation and delivery, without submitting or losing original source identity',async t=>{
  const f=await fixture(t);
  await f.jobs.track(f.record,{binding:{chatId:'oc_test'}},{agent:'t3',status:'unconfirmed',submitted:true});
  await f.jobs.stop();
  const restarted=createDeliveryJobs(f.options);await restarted.recover();restarted.tick();await restarted.drain();
  assert.equal(f.calls.length,2);assert.equal((await f.read()).answerMessageId,'om_2');
  await restarted.stop();
});

test('recovery covers a crash after submission but before the first notification was scheduled',async t=>{
  const f=await fixture(t);
  await writeJournal(path.join(f.directory,f.record.requestId+'.json'),{...f.record,deliveryVersion:2,status:'processing'});
  await reserveRecord(f.stateDir,{...f.record,agent:'t3',status:'completed',submitted:true,answer:'recovered answer'});
  await f.jobs.recover();f.jobs.tick();await f.jobs.drain();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].text,'recovered answer');
  assert.equal((await f.read()).answerDelivery.state,'confirmed');await f.jobs.stop();
});

test('routing failure retries bookkeeping independently and never sends the answer again',async t=>{
  let routes=0;
  const f=await fixture(t,{confirmReply:async()=>{if(++routes===1) throw new Error('disk unavailable');}});
  await f.jobs.track(f.record,{binding:{chatId:'oc_test'}},{agent:'t3',status:'completed',submitted:true,answer:'answer'});
  await f.jobs.drain();assert.equal(f.calls.length,1);assert.ok((await f.read()).routeConfirmationsPending.length);
  f.advance(20000);f.jobs.tick();await f.jobs.drain();
  assert.equal(f.calls.length,1);assert.equal(routes,2);assert.equal((await f.read()).routeConfirmationsPending.length,0);
  await f.jobs.stop();
});

test('a later rejected retry cannot erase an earlier uncertain write or extend its dedupe window',async t=>{
  let calls=0;
  const f=await fixture(t,{reply:async()=>{
    calls++;
    if(calls===1) throw new Error('lost first receipt');
    throw Object.assign(new Error('retry rejected'),{notSent:true});
  }});
  await f.jobs.track(f.record,{binding:{chatId:'oc_test'}},{agent:'t3',status:'completed',submitted:true,answer:'answer'});
  await f.jobs.drain();const first=(await f.read()).answerDelivery.firstAttemptAt;
  f.advance(10000);f.jobs.tick();await f.jobs.drain();
  assert.equal((await f.read()).answerDelivery.state,'unknown');
  assert.equal((await f.read()).answerDelivery.firstAttemptAt,first);
  f.advance(3600000);f.jobs.tick();await f.jobs.drain();assert.equal(calls,2);await f.jobs.stop();
});

test('answer routing cannot replace the failed placeholder routing obligation',async t=>{
  let allowPlaceholder=false;const routes=[];
  const f=await fixture(t,{confirmReply:async(item,message)=>{
    routes.push(message.message_id);
    if(message.message_id==='om_1' && !allowPlaceholder) throw new Error('placeholder routing unavailable');
  }});
  await f.jobs.track(f.record,{binding:{chatId:'oc_test'}},{agent:'t3',status:'queued',submitted:true});
  await f.jobs.drain();f.jobs.tick();await f.jobs.drain();
  assert.equal(f.calls.length,2);
  assert.deepEqual((await f.read()).routeConfirmationsPending.map(item=>item.message_id),['om_1']);
  allowPlaceholder=true;f.advance(20000);f.jobs.tick();await f.jobs.drain();
  assert.equal((await f.read()).routeConfirmationsPending.length,0);assert.equal(f.calls.length,2);
  assert.ok(routes.filter(id=>id==='om_1').length>=2);await f.jobs.stop();
});

test('a persistently failing placeholder route cannot starve a later answer route retry',async t=>{
  let answerAttempts=0;
  const f=await fixture(t,{confirmReply:async(item,message)=>{
    if(message.message_id==='om_1') throw new Error('persistent placeholder conflict');
    if(++answerAttempts===1) throw new Error('temporary answer bookkeeping failure');
  }});
  await f.jobs.track(f.record,{binding:{chatId:'oc_test'}},{agent:'t3',status:'queued',submitted:true});
  await f.jobs.drain();f.jobs.tick();await f.jobs.drain();
  for(let i=0;i<2;i++) {f.advance(20000);f.jobs.tick();await f.jobs.drain();}
  assert.equal(answerAttempts,2);assert.equal(f.calls.length,2);
  assert.deepEqual((await f.read()).routeConfirmationsPending.map(item=>item.message_id),['om_1']);
  await f.jobs.stop();
});

test('rejection feedback uses its own durable lane and is deduplicated without a normal request record',async t=>{
  const f=await fixture(t),item={binding:{chatId:'oc_test'},messageId:'om_rejected'};
  await f.jobs.reject(item,'QUEUE_FULL');await f.jobs.drain();
  await f.jobs.reject(item,'QUEUE_FULL');await f.jobs.drain();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].id,'om_rejected');
  const file=path.join(path.dirname(f.directory),'rejections',`fs-${digest(`${appId}:om_rejected`)}.json`);
  assert.equal(JSON.parse(await readFile(file,'utf8')).statusDelivery.state,'confirmed');await f.jobs.stop();
});

const event=id=>({sender:{sender_type:'user',sender_id:{open_id:'ou_user'}},message:{message_id:id,
  chat_id:'oc_test',chat_type:'group',message_type:'text',content:JSON.stringify({text:'@bot input'}),mentions:[{key:'@bot',id:{open_id:'ou_bot'}}]}});
test('old unknown observation and failed feedback do not occupy fresh submission slots',async t=>{
  const f=await fixture(t);let finishObservation,observationStarted,nextSubmitted;
  const observationGate=new Promise(r=>finishObservation=r),started=new Promise(r=>observationStarted=r),next=new Promise(r=>nextSubmitted=r);
  const sent=[];
  const receiver=createReceiver({appId,botId:'ou_bot',stateDir:f.stateDir,operationMs:500,config:{version:1,maxConcurrentThreads:1,
    bindings:[{chatId:'oc_test',threadId:source,users:['ou_user'],threadTargets:{[source]:{kind:'t3',threadId:target}}}]},
    admitRoute:async(item,save)=>save({threadId:source,agentTarget:{kind:'t3',threadId:target}}),
    refresh:async()=>{observationStarted();await observationGate;return {agent:'t3',submitted:true,status:'unconfirmed'};},
    send:async input=>{sent.push(input.requestId);if(sent.length===2) nextSubmitted();return {agent:'t3',submitted:true,status:'unconfirmed'};},
    reply:async()=>{throw new Error('network down');},feedback:{update(){}}});
  await receiver.handle(event('om_first'));await receiver.drain();receiver.tick();await started;
  await receiver.handle(event('om_second'));await next;
  assert.equal(sent.length,2);finishObservation();await receiver.stop();
});

test('one submission timeout releases the same target for the next request and preserves feedback',async t=>{
  const f=await fixture(t);let calls=0,submitted;
  const next=new Promise(resolve=>submitted=resolve);
  const receiver=createReceiver({appId,botId:'ou_bot',stateDir:f.stateDir,operationMs:100,config:{version:1,maxConcurrentThreads:1,
    bindings:[{chatId:'oc_test',threadId:source,users:['ou_user']}]},
    admitRoute:async(item,save)=>save({threadId:source,agentTarget:{kind:'t3',threadId:target}}),
    send:async()=>{if(++calls===1) return new Promise(()=>{});submitted();return {agent:'t3',status:'completed',submitted:true,answer:'next answer'};},
    reply:f.options.reply,feedback:f.options.feedback,refresh:async()=>({agent:'t3',submitted:true,status:'unconfirmed'})});
  await receiver.handle(event('om_timeout'));await receiver.handle(event('om_next'));
  await next;await receiver.drain();
  assert.equal(calls,2);assert.ok(f.calls.some(call=>call.id==='om_timeout'));
  assert.ok(f.calls.some(call=>call.id==='om_next' && call.text==='next answer'));
  await receiver.stop();
});
