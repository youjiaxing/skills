import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendT3, requestT3Status, inspectT3Target } from '../scripts/t3.mjs';
import { targetFor, validateAgentTargets } from '../scripts/agent-targets.mjs';
import { createMessageRouter } from '../scripts/message-routes.mjs';
import { createReceiver, digest } from '../scripts/feishu-core.mjs';
import { readFile } from 'node:fs/promises';

const source='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
async function setup(t) {
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'feishu-t3-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  return {stateDir,threadId:source,agentTarget:{kind:'t3',threadId:target},t3Command:['fictional-t3'],message:'payload',requestId:'r1'};
}
const readable={code:0,data:{thread:{threadId:target,archived:false},messages:[]}};

test('one durable submission; duplicate ID never invokes CLI again',async t=>{
  const input=await setup(t),calls=[];
  const run=async(cmd,args,message)=>{
    calls.push(args[1]);
    if(args[1]==='show') return readable;
    const stored=await requestT3Status(input);
    assert.equal(stored.submitted,true);assert.equal(stored.status,'unconfirmed');
    assert.equal(message,stored.wireMessage);
    return {code:0,data:{threadId:target,runId:'run-1',status:'completed',reply:'answer'}};
  };
  const first=await sendT3(input,{run});assert.equal(first.answer,'answer');
  const duplicate=await sendT3(input,{run});assert.equal(duplicate.deduplicated,true);
  assert.deepEqual(calls,['show','send']);
  await assert.rejects(sendT3({...input,message:'different'},{run}),/different input/);
});

test('lost CLI receipt blocks fresh IDs and alias sources for same target',async t=>{
  const input=await setup(t);let sends=0;
  const run=async(cmd,args)=>{
    if(args[1]==='show')return readable;
    sends++;throw new Error('lost receipt');
  };
  assert.equal((await sendT3(input,{run})).status,'unconfirmed');
  const second=await sendT3({...input,requestId:'r2',threadId:'33333333-3333-4333-8333-333333333333'},{run});
  assert.equal(second.status,'blocked');assert.equal(second.submitted,false);assert.equal(second.blockedByRequestId,'r1');
  assert.equal(sends,1);
});

test('nonzero CLI exit is not assumed unsubmitted, waiting keeps gate',async t=>{
  const input=await setup(t);
  const run=async(cmd,args)=>args[1]==='show'?readable:{code:2,data:{threadId:target,runId:'run-1',status:'waiting',reply:null}};
  const record=await sendT3(input,{run});assert.equal(record.submitted,true);assert.equal(record.status,'unconfirmed');
});

test('wrong receipt target stays unknown; archived target never submitted',async t=>{
  const input=await setup(t);
  let run=async(cmd,args)=>args[1]==='show'?readable:{code:0,data:{threadId:source,runId:'run-1',status:'completed',reply:'wrong'}};
  assert.equal((await sendT3(input,{run})).status,'unconfirmed');
  const other=await setup(t);other.requestId='archived';
  run=async()=>({code:0,data:{thread:{threadId:target,archived:true}}});
  const blocked=await sendT3(other,{run});assert.equal(blocked.submitted,false);assert.equal(blocked.error.code,'TARGET_ARCHIVED');
});

test('read-only recovery correlates exact marker and latest terminal run',async t=>{
  const input=await setup(t);let sends=0;
  const run=async(cmd,args)=>{if(args[1]==='show')return readable;sends++;throw new Error('lost');};
  const initial=await sendT3(input,{run});
  const messages=[{role:'user',runId:'run-1',text:initial.wireMessage},{role:'assistant',runId:'run-1',text:'answer'}];
  const show=latest=>async()=>({code:0,data:{thread:{threadId:target,latestRunId:latest,status:'completed',activeRunId:null},messages}});
  let record=await requestT3Status({...input,refresh:true},{run:show('later-run')});assert.equal(record.status,'unconfirmed');
  record=await requestT3Status({...input,refresh:true},{run:show('run-1')});assert.equal(record.status,'completed');assert.equal(record.answer,'answer');assert.equal(sends,1);
});

test('mappings are group-scoped and frozen when routing is admitted',async t=>{
  const input=await setup(t),binding={threadId:source,threadTargets:{[source]:{kind:'t3',threadId:target}}};
  validateAgentTargets({bindings:[binding],t3Command:['fictional-t3']});
  assert.equal(targetFor({threadId:source},source),undefined);
  const router=createMessageRouter({stateDir:input.stateDir,appId:'cli_fictional'});let route;
  await router.admit({binding},async selected=>{route=selected;});
  binding.threadTargets[source].threadId=source;
  assert.equal(route.agentTarget.threadId,target);assert.equal(route.threadId,source);
  assert.throws(()=>validateAgentTargets({bindings:[{threadTargets:{[source]:{kind:'unknown',threadId:target}}}],t3Command:['fictional-t3']}));
});


test('receiver persists and forwards the admitted T3 target, leaving source routing intact',async t=>{
  const input=await setup(t),binding={chatId:'oc_test',threadId:source,users:['ou_user'],threadTargets:{[source]:{kind:'t3',threadId:target}}};
  const router=createMessageRouter({stateDir:input.stateDir,appId:'cli_test'});
  const calls=[];
  const receiver=createReceiver({appId:'cli_test',botId:'ou_bot',stateDir:input.stateDir,
    config:{version:1,bindings:[binding],t3Command:['fictional-t3']},admitRoute:router.admit,
    send:async args=>{calls.push(args);return {status:'completed',answer:'response'};},reply:async()=>({message_id:'om_reply'})});
  await receiver.handle({sender:{sender_id:{open_id:'ou_user'},sender_type:'user'},message:{message_id:'om_in',chat_id:'oc_test',chat_type:'group',message_type:'text',content:JSON.stringify({text:'@bot request'}),mentions:[{key:'@bot',id:{open_id:'ou_bot'}}]}});
  await receiver.stop();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].agentTarget,{kind:'t3',threadId:target});assert.equal(calls[0].threadId,source);
  const record=JSON.parse(await readFile(path.join(input.stateDir,'feishu',digest('cli_test'),'messages',`fs-${digest('cli_test:om_in')}.json`),'utf8'));
  assert.deepEqual(record.agentTarget,{kind:'t3',threadId:target});
});

test('hung read-only CLI is bounded without submitting or accepting a result',async()=>{
  const before=performance.now();
  const result=await inspectT3Target({threadId:target,timeoutMs:50,
    t3Command:[process.execPath,'-e','setInterval(()=>{},1000)','--']});
  assert.equal(result.state,'unknown');assert.ok(performance.now()-before<2000);
});
