import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendT3, requestT3Status, inspectT3Target, applyT3Snapshot, applyT3Projection, selectT3FinalAnswer } from '../scripts/t3.mjs';
import { deliverHarvestedFollowUp, writeJournal, createReceiver, digest } from '../scripts/feishu-core.mjs';
import { targetFor, validateAgentTargets } from '../scripts/agent-targets.mjs';
import { createMessageRouter } from '../scripts/message-routes.mjs';
import { reserveRecord, claimThreadRequest } from '../scripts/state.mjs';

const source='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
async function setup(t) {
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'feishu-t3-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  return {stateDir,threadId:source,agentTarget:{kind:'t3',threadId:target},t3Command:['fictional-t3'],message:'payload',requestId:'r1'};
}
const readable={code:0,data:{thread:{threadId:target,archived:false},messages:[]}};

test('submission is durable, bounded, non-waiting and deduplicated per request',async t=>{
  const input=await setup(t),calls=[];
  const run=async(cmd,args,message,options)=>{
    calls.push(args[1]);
    if(args[1]==='show') return readable;
    const stored=await requestT3Status(input);
    assert.equal(stored.submitted,true);assert.equal(stored.status,'submitted');
    assert.equal(message,stored.wireMessage);
    assert.ok(!args.includes('--wait'));assert.ok(options.timeoutMs>0 && options.timeoutMs<=15000);
    return {code:0,data:{threadId:target,runId:'run-1',delivery:'queued'}};
  };
  const first=await sendT3(input,{run});assert.equal(first.status,'queued');assert.equal(first.turnId,'run-1');
  const duplicate=await sendT3(input,{run});assert.equal(duplicate.deduplicated,true);
  assert.deepEqual(calls,['show','send']);
  await assert.rejects(sendT3({...input,message:'different'},{run}),/different input/);
});

test('an unknown prior and stale target gate cannot stop a fresh request',async t=>{
  const input=await setup(t);let sends=0;
  const run=async(cmd,args)=>{
    if(args[1]==='show') return readable;
    sends++;
    if(sends===1) throw new Error('lost receipt');
    return {code:0,data:{threadId:target,runId:'run-2',delivery:'queued'}};
  };
  const first=await sendT3(input,{run});assert.equal(first.status,'unconfirmed');
  await claimThreadRequest(input.stateDir,{...first,threadId:'t3-'+target});
  await mkdir(path.join(input.stateDir,'locks','t3-'+target),{recursive:true});
  const second=await sendT3({...input,requestId:'r2',message:'next'},{run});
  assert.equal(second.status,'queued');assert.equal(second.turnId,'run-2');assert.equal(sends,2);
  const stored=await requestT3Status(input);assert.equal(stored.status,'unconfirmed');
});

test('wrong receipt remains unknown; archived target is not submitted',async t=>{
  const input=await setup(t);let sends=0;
  const wrong=await sendT3(input,{run:async(cmd,args)=>{
    if(args[1]==='show') return readable;
    sends++;return {code:0,data:{threadId:source,runId:'wrong',status:'completed',reply:'wrong'}};
  }});
  assert.equal(wrong.status,'unconfirmed');assert.equal(wrong.turnId,null);assert.equal(sends,1);
  const blocked=await sendT3({...input,requestId:'archived'},{run:async()=>({code:0,data:{thread:{threadId:target,archived:true}}})});
  assert.equal(blocked.submitted,false);assert.equal(blocked.error.code,'TARGET_ARCHIVED');
});

const baseRecord=()=>({agent:'t3',threadId:target,wireMessage:'unique-marker',turnId:null,status:'unconfirmed',baselineLatestRunId:'old'});
const projection=(runId='run-1',status='completed',text='final')=>({thread:{id:target},
  runs:[{id:runId,threadId:target,status,completedAt:status==='completed'?'2026-11-18T10:00:00Z':null}],
  messages:[{threadId:target,runId,role:'user',text:'unique-marker'},
    {threadId:target,runId,role:'assistant',text,streaming:false,createdAt:'2026-11-18T10:00:00Z'}]});

test('baseline/latest changes and running assistant text are not terminal evidence',()=>{
  for(const turnId of [null,'queued-run']) {
    const record={...baseRecord(),turnId};
    applyT3Snapshot(record,{thread:{threadId:target,latestRunId:'old',activeRunId:'old',status:'running'},messages:[]});
    assert.equal(record.status,'unconfirmed');
  }
  const record=baseRecord();applyT3Projection(record,projection('run-1','running','progress'));
  assert.equal(record.status,'running');assert.equal(record.answer,undefined);
  const waiting=applyT3Projection(baseRecord(),projection('run-1','waiting','prompt'));
  assert.equal(waiting.status,'waiting');assert.equal(waiting.error.code,'HOST_INTERACTION_REQUIRED');
});

test('completed unphased runs deliver their last assistant message; phased progress needs a final answer',()=>{
  const data=projection();
  data.messages.push({threadId:target,runId:'run-1',role:'assistant',text:'最终结论',streaming:false,createdAt:'2026-11-18T10:00:01Z'});
  assert.equal(selectT3FinalAnswer(data.messages,'run-1'),'最终结论');
  const record=applyT3Projection(baseRecord(),data);
  assert.equal(record.status,'completed');
  assert.equal(record.answer,'最终结论');

  const ordered=[{runId:'run-1',role:'assistant',text:'later',sequence:2,createdAt:'2026-11-18T09:00:00Z'},
    {runId:'run-1',role:'assistant',text:'earlier',sequence:1,createdAt:'2026-11-18T11:00:00Z'}];
  assert.equal(selectT3FinalAnswer(ordered,'run-1'),'later');

  const phased=data.messages.map(message=>message.role==='assistant'?{...message,phase:'commentary'}:message);
  assert.equal(selectT3FinalAnswer(phased,'run-1'),null);
  assert.equal(applyT3Projection(baseRecord(),{...data,messages:phased}).status,'unconfirmed');
  const explicit={...phased[1],phase:'final_answer'};
  assert.equal(selectT3FinalAnswer([phased[0],explicit,phased[2]],'run-1'),explicit.text);
});

test('snapshot fallback delivers only for the completed original run',()=>{
  const record={...baseRecord(),turnId:null};
  const data={thread:{threadId:target,latestRunId:'run-1',activeRunId:null,status:'completed'},messages:[
    {role:'user',text:'unique-marker',runId:'run-1'},
    {role:'assistant',text:'正在检查实现。',runId:'run-1'},
    {role:'assistant',text:'最终结论',runId:'run-1'},
  ]};
  applyT3Snapshot(record,data);
  assert.equal(record.status,'completed');
  assert.equal(record.answer,'最终结论');
  const running={...baseRecord(),turnId:null};
  applyT3Snapshot(running,{...data,thread:{...data.thread,activeRunId:'run-1',status:'running'}});
  assert.equal(running.status,'unconfirmed');
  assert.equal(running.answer,undefined);
});

test('original run result is recovered after later runs without accepting conflicting identity',()=>{
  const data=projection();data.thread.latestRunId='later';
  const record=applyT3Projection(baseRecord(),data);
  assert.equal(record.status,'completed');assert.equal(record.answer,'final');assert.equal(record.turnId,'run-1');
  const conflict=applyT3Projection({...baseRecord(),turnId:'original'},projection('copy'));
  assert.equal(conflict.status,'unconfirmed');assert.equal(conflict.turnId,'original');assert.equal(conflict.answer,undefined);
  const streaming=projection();streaming.messages[1].streaming=true;
  assert.equal(applyT3Projection(baseRecord(),streaming).status,'unconfirmed');
});

test('status refresh repairs inferred NO_FINAL_REPLY without resending; true failures stay terminal',async t=>{
  const input=await setup(t),record={...baseRecord(),requestId:input.requestId,submitted:true,status:'failed',error:{code:'NO_FINAL_REPLY'}};
  await reserveRecord(input.stateDir,record);
  let reads=0;
  const refreshed=await requestT3Status({...input,refresh:true},{run:async()=>{throw new Error('must not invoke CLI');},projectionReader:async()=>{reads++;return projection();}});
  assert.equal(refreshed.status,'completed');assert.equal(refreshed.answer,'final');assert.equal(reads,1);
  const other=await setup(t);other.requestId='true-failure';
  await reserveRecord(other.stateDir,{...record,requestId:other.requestId,error:{code:'TURN_FAILED'}});
  const failed=await requestT3Status({...other,refresh:true},{projectionReader:async()=>{throw new Error('must not query');}});
  assert.equal(failed.error.code,'TURN_FAILED');
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

test('placeholder Feishu reply is followed up once after harvest',async t=>{
  const input=await setup(t);
  const directory=path.join(input.stateDir,'messages');
  await mkdir(directory,{recursive:true});
  const requestId='fs-old';
  await writeJournal(path.join(directory,requestId+'.json'),{
    requestId, messageId:'om_old', codexStatus:'unconfirmed', replyMessageId:'om_placeholder', replyAttempted:true,
  });
  const replies=[];
  const sent=await deliverHarvestedFollowUp({
    directory, requestId, answer:'real answer',
    reply:async(id,text)=>{replies.push({id,text});return {message_id:'om_follow'};},
    prepareReply:answer=>({msgType:'text',content:{text:answer},mode:'text'}),
  });
  assert.equal(sent.message_id,'om_follow');
  assert.deepEqual(replies,[{id:'om_old',text:'real answer'}]);
  const again=await deliverHarvestedFollowUp({
    directory, requestId, answer:'real answer',
    reply:async()=>{throw new Error('should not retry');},
    prepareReply:answer=>({msgType:'text',content:{text:answer},mode:'text'}),
  });
  assert.equal(again,null);
});

test('receiver delivers a harvested prior follow-up before the current reply',async t=>{
  const input=await setup(t),binding={chatId:'oc_test',threadId:source,users:['ou_user'],threadTargets:{[source]:{kind:'t3',threadId:target}}};
  const directory=path.join(input.stateDir,'feishu',digest('cli_follow'),'messages');
  await mkdir(directory,{recursive:true});
  const priorId='fs-old';
  await writeJournal(path.join(directory,priorId + '.json'),{
    requestId:priorId, messageId:'om_old', codexStatus:'unconfirmed', replyMessageId:'om_placeholder', replyAttempted:true,
  });
  const router=createMessageRouter({stateDir:input.stateDir,appId:'cli_follow'});
  const replies=[];
  const receiver=createReceiver({appId:'cli_follow',botId:'ou_bot',stateDir:input.stateDir,
    config:{version:1,bindings:[binding],t3Command:['fictional-t3']},admitRoute:router.admit,
    send:async()=>({status:'completed',answer:'new answer',releasedPriors:[{requestId:priorId,status:'completed',answer:'old answer'}]}),
    reply:async(id,text)=>{replies.push({id,text});return {message_id:'om_' + String(replies.length)};}});
  await receiver.handle({sender:{sender_id:{open_id:'ou_user'},sender_type:'user'},message:{message_id:'om_in',chat_id:'oc_test',chat_type:'group',message_type:'text',content:JSON.stringify({text:'@bot request'}),mentions:[{key:'@bot',id:{open_id:'ou_bot'}}]}});
  await receiver.stop();
  assert.deepEqual(replies,[{id:'om_old',text:'old answer'},{id:'om_in',text:'new answer'}]);
  const prior=JSON.parse(await readFile(path.join(directory,priorId + '.json'),'utf8'));
  assert.equal(prior.codexStatus,'completed');assert.equal(prior.answerFollowUpAttempted,true);
});
