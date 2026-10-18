// Executable state/transport tests, no model calls or prompt-behavior evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMessageRouter,withRoutes,routeFile} from '../scripts/message-routes.mjs';
import {deliver,outboundPaths,reconcileOutbound} from '../scripts/outbound-core.mjs';
import {createReceiver,digest} from '../scripts/feishu-core.mjs';
import {resolveContext} from '../scripts/feishu-context.mjs';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const binding={chatId:'oc_test',threadId:A,users:['ou_owner'],quoteRouting:true};
const event=(id,parent)=>({sender:{sender_type:'user',sender_id:{open_id:'ou_owner'}},message:{message_id:id,parent_id:parent,
  chat_id:'oc_test',chat_type:'group',message_type:'text',content:JSON.stringify({text:'@bot question'}),mentions:[{key:'@bot',id:{open_id:'ou_bot'}}]}});
async function setup(t){
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'feishu-route-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const calls=[],config={version:1,bindings:[structuredClone(binding)]};
  const options={stateDir,appId:'cli_test',transport:{send:async()=>{calls.push('send');return 'om_card';},
    update:async id=>{calls.push('update');return id;},upload:async()=>assert.fail('no image expected')}};
  const initial={operation:'send',requestId:'first',chatId:'oc_test',msgType:'interactive',sourceThreadId:A,content:{elements:[]}};
  const update={operation:'update',requestId:'change',targetRequestId:'first',expectedRevision:1,msgType:'interactive',sourceThreadId:B,content:{elements:[]}};
  const router=createMessageRouter(options);
  const selected=[];
  const receiverOptions={...options,botId:'ou_bot',config,admitRoute:router.admit,confirmReply:router.rememberReply,
    send:async input=>{selected.push(input);return {status:'completed',answer:'result'};},
    reply:async id=>({message_id:`${id}_reply`})};
  return {options,initial,update,calls,router,selected,receiverOptions};
}
test('direct quotes pick the latest confirmed card owner, old replies retain their owner across restart',async t=>{
  const c=await setup(t);await deliver(c.initial,c.options);
  let receiver=createReceiver(c.receiverOptions);
  await receiver.handle(event('om_q1','om_card'));await receiver.stop();
  assert.equal(c.selected[0].threadId,A);assert.equal(c.selected[0].autoUnarchive,true);
  await deliver(c.update,c.options);
  receiver=createReceiver(c.receiverOptions);
  await receiver.handle(event('om_q2','om_card'));
  await receiver.handle(event('om_q3','om_q1_reply'));
  await receiver.handle(event('om_q4'));await receiver.stop();
  assert.deepEqual(c.selected.map(x=>x.threadId),[A,B,A,A]);
  assert.equal(c.selected[3].autoUnarchive,false);
  const journal=JSON.parse(await readFile(path.join(c.options.stateDir,'feishu',digest('cli_test'),'messages',
    `fs-${digest('cli_test:om_q2')}.json`),'utf8'));
  assert.equal(journal.threadId,B);assert.equal(journal.replyMessageId,'om_q2_reply');
  receiver=createReceiver(c.receiverOptions);await receiver.handle(event('om_q2','om_card'));await receiver.stop();
  assert.equal(c.selected.length,4);
});
test('admission waits for an in-flight update and persists the committed new owner',async t=>{
  const c=await setup(t);await deliver(c.initial,c.options);
  let finish,started;const wait=new Promise(r=>{finish=r;}),entered=new Promise(r=>{started=r;});
  c.options.transport.update=async()=>{started();await wait;return 'om_card';};
  const update=deliver(c.update,c.options);await entered;
  const receiver=createReceiver(c.receiverOptions),admission=receiver.handle(event('om_concurrent','om_card'));
  await new Promise(r=>setImmediate(r));assert.equal(c.selected.length,0);
  finish();await update;await admission;await receiver.stop();
  assert.equal(c.selected[0].threadId,B);
});
test('unknown update blocks new quotes while already admitted requests keep their target',async t=>{
  const c=await setup(t);await deliver(c.initial,c.options);
  let finish;const waiting=new Promise(r=>{finish=r;});
  const receiver=createReceiver({...c.receiverOptions,send:async input=>{c.selected.push(input);await waiting;return {status:'completed',answer:'result'};}});
  await receiver.handle(event('om_before','om_card'));
  c.options.transport.update=async()=>{c.calls.push('update');throw Error('ack lost');};
  assert.equal((await deliver(c.update,c.options)).status,'unconfirmed');
  await receiver.handle(event('om_after','om_card'));finish();await receiver.stop();
  assert.equal(c.selected.length,1);assert.equal(c.selected[0].threadId,A);
  const route=JSON.parse(await readFile(routeFile(c.options.stateDir,'cli_test','oc_test'),'utf8'));
  assert.equal(route.messages.om_card.pending,'change');
  await assert.rejects(reconcileOutbound({...c.options,requestId:'change'}),/No durable/);
});
test('missing source, cross-group/application quote, and route corruption never fall back to the default target',async t=>{
  const c=await setup(t);await deliver({...c.initial,chatId:'oc_other'},c.options);
  let receiver=createReceiver(c.receiverOptions);
  await receiver.handle(event('om_cross','om_card'));await receiver.stop();assert.equal(c.selected.length,0);
  await deliver({...c.initial,requestId:'local'},c.options);
  const otherRouter=createMessageRouter({...c.options,appId:'cli_other'});
  await otherRouter.admit({binding,parentId:'om_card'},route=>assert.ok(route.error));
  receiver=createReceiver(c.receiverOptions);const denied=event('om_denied','om_card');denied.sender.sender_id.open_id='ou_not_allowed';
  await receiver.handle(denied);await receiver.stop();assert.equal(c.selected.length,0);
  await writeFile(routeFile(c.options.stateDir,'cli_test','oc_test'),'broken');
  await assert.rejects(createReceiver(c.receiverOptions).handle(event('om_corrupt','om_card')));
  assert.equal(c.selected.length,0);
});
test('legacy sends remain usable but have no inferred owner; missing source on later update invalidates old ownership',async t=>{
  const c=await setup(t);const legacy={...c.initial};delete legacy.sourceThreadId;
  await deliver(legacy,c.options);
  await c.router.admit({binding,parentId:'om_card'},route=>assert.ok(route.error));
  await deliver(c.update,c.options);
  await c.router.admit({binding,parentId:'om_card'},route=>assert.equal(route.threadId,B));
  const next={...c.update,requestId:'next',expectedRevision:2};delete next.sourceThreadId;
  await deliver(next,c.options);
  await c.router.admit({binding,parentId:'om_card'},route=>assert.ok(route.error));
});
test('definitive provider rejection restores the prior route instead of transferring ownership',async t=>{
  const c=await setup(t);await deliver(c.initial,c.options);
  c.options.transport.update=async()=>{throw Object.assign(Error('rejected'),{apiCode:230099});};
  assert.equal((await deliver(c.update,c.options)).status,'blocked');
  await c.router.admit({binding,parentId:'om_card'},route=>assert.equal(route.threadId,A));
});
test('durable acknowledgement repairs pending ownership locally without a second transport call',async t=>{
  const c=await setup(t);await deliver(c.initial,c.options);const changed=await deliver(c.update,c.options);
  const paths=outboundPaths(c.options.stateDir,'cli_test');
  const crashed={...changed,status:'submitting'};delete crashed.messageId;delete crashed.revision;
  await writeFile(paths.request('change'),JSON.stringify(crashed));
  const head=JSON.parse(await readFile(paths.target('first'),'utf8'));head.pending='change';await writeFile(paths.target('first'),JSON.stringify(head));
  await withRoutes({...c.options,chatId:'oc_test'},async(data,save)=>{data.messages.om_card.pending='change';await save();});
  assert.equal((await reconcileOutbound({...c.options,requestId:'change'})).reconciled,true);
  await c.router.admit({binding,parentId:'om_card'},route=>assert.equal(route.threadId,B));
  assert.equal((await reconcileOutbound({...c.options,requestId:'change'})).reconciled,false);
  assert.deepEqual(c.calls,['send','update']);
});
test('ownership storage failures retain reply receipt and do not resend after receiver restart',async t=>{
  const c=await setup(t);await deliver(c.initial,c.options);let replies=0;
  const options={...c.receiverOptions,reply:async()=>{replies++;return {message_id:'om_reply_receipt'};},confirmReply:async()=>{throw Error('disk unavailable');}};
  let receiver=createReceiver(options);await receiver.handle(event('om_failure','om_card'));await receiver.stop();
  assert.equal((await receiver.unsettled())[0].status,'unconfirmed');
  receiver=createReceiver(options);await receiver.handle(event('om_failure','om_card'));await receiver.stop();
  assert.equal(replies,1);assert.equal(c.selected.length,1);
});
test('context never reads historical pages or touches old incremental journals',async t=>{
  const c=await setup(t),old=path.join(c.options.stateDir,'feishu','old-app','context','old.json');
  await mkdir(path.dirname(old),{recursive:true});await writeFile(old,'old state unchanged');
  const result=await resolveContext({text:'request',messageId:'om_current',binding,source:{message_type:'text',content:'{"text":"request"}'}},
    {transport:{list:async()=>assert.fail('must not list'),get:async()=>assert.fail('no quote')},imageDirectory:path.join(c.options.stateDir,'images')});
  assert.doesNotMatch(result,/recentHistory/);assert.equal(await readFile(old,'utf8'),'old state unchanged');
});
