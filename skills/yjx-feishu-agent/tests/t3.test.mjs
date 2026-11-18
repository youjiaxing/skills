import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendT3, requestT3Status, inspectT3Target, applyT3Snapshot } from '../scripts/t3.mjs';
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

test('lost CLI receipt waits until later work starts before a fresh ID may send',async t=>{
  const input=await setup(t);let sends=0,shows=0;
  const run=async(cmd,args)=>{
    if(args[1]==='show'){
      shows++;
      if(shows===1) return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'old-run'},messages:[]}};
      return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'digest-run',status:'completed',activeRunId:null},messages:[]}};
    }
    sends++;
    if(sends===1) throw new Error('lost receipt');
    return {code:0,data:{threadId:target,runId:'run-2',status:'completed',reply:'next'}};
  };
  const first=await sendT3({...input,pollMs:1},{run});
  assert.equal(first.status,'failed');assert.equal(first.error.code,'NO_FINAL_REPLY');assert.equal(first.submitted,true);
  const second=await sendT3({...input,requestId:'r2',threadId:'33333333-3333-4333-8333-333333333333',pollMs:1,message:'next'},{run});
  assert.equal(second.status,'completed');assert.equal(second.submitted,true);assert.equal(second.answer,'next');assert.equal(sends,2);
  assert.equal(second.blockedByRequestId,undefined);
});

test('waiting send receipt keeps observing until the marker harvests an answer',async t=>{
  const input=await setup(t);let shows=0;
  const run=async(cmd,args)=>{
    if(args[1]==='show'){
      shows++;
      const rec=await requestT3Status(input);
      const text=rec.wireMessage;
      if(!text) return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:null},messages:[]}};
      if(shows<4) return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'run-1',activeRunId:'run-1',status:'running'},messages:[{role:'user',runId:'run-1',text}]}};
      return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'run-1',activeRunId:null,status:'completed'},messages:[{role:'user',runId:'run-1',text},{role:'assistant',runId:'run-1',text:'answer'}]}};
    }
    return {code:2,data:{threadId:target,runId:'run-1',status:'waiting',reply:null}};
  };
  const record=await sendT3({...input,pollMs:1},{run});
  assert.equal(record.submitted,true);assert.equal(record.status,'completed');assert.equal(record.answer,'answer');
});

test('wrong receipt target stays unknown until later work ends the gate; archived target never submitted',async t=>{
  const input=await setup(t);let shows=0;
  let run=async(cmd,args)=>{
    if(args[1]==='show'){
      shows++;
      if(shows===1) return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'old-run'},messages:[]}};
      return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'other-run',status:'completed',activeRunId:null},messages:[]}};
    }
    return {code:0,data:{threadId:source,runId:'run-1',status:'completed',reply:'wrong'}};
  };
  const unknown=await sendT3({...input,pollMs:1},{run});
  assert.equal(unknown.submitted,true);assert.equal(unknown.status,'failed');assert.equal(unknown.error.code,'NO_FINAL_REPLY');
  const other=await setup(t);other.requestId='archived';
  run=async()=>({code:0,data:{thread:{threadId:target,archived:true}}});
  const blocked=await sendT3(other,{run});assert.equal(blocked.submitted,false);assert.equal(blocked.error.code,'TARGET_ARCHIVED');
});

test('read-only recovery harvests the marker even after a later run starts',async t=>{
  const input=await setup(t);let sends=0,shows=0;
  const run=async(cmd,args)=>{
    if(args[1]==='show'){
      shows++;
      if(shows===1) return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'old-run'},messages:[]}};
      return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'digest-run',status:'completed',activeRunId:null},messages:[]}};
    }
    sends++;throw new Error('lost');
  };
  const initial=await sendT3({...input,pollMs:1},{run});
  assert.equal(initial.status,'failed');
  const harvested=applyT3Snapshot({...initial,status:'unconfirmed',threadId:target,error:{code:'COMPLETION_UNCONFIRMED'}}, {thread:{threadId:target,latestRunId:'later-run',status:'completed',activeRunId:null},messages:[{role:'user',runId:'run-1',text:initial.wireMessage},{role:'assistant',runId:'run-1',text:'answer'}]});
  assert.equal(harvested.status,'completed');assert.equal(harvested.answer,'answer');
  const noAnswer=applyT3Snapshot({agent:'t3',threadId:target,wireMessage:initial.wireMessage,turnId:'run-1',status:'unconfirmed',baselineLatestRunId:'old-run'}, {thread:{threadId:target,latestRunId:'later-run',status:'completed',activeRunId:null},messages:[{role:'user',runId:'run-1',text:initial.wireMessage}]});
  assert.equal(noAnswer.status,'failed');assert.equal(noAnswer.error.code,'NO_FINAL_REPLY');
  assert.equal(sends,1);
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

test('in-flight prior does not block a later ID after it completes',async t=>{
  const input=await setup(t);let sends=0;
  const firstRun=async(cmd,args)=>{
    if(args[1]==='show') return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:null},messages:[]}};
    sends++;
    return {code:0,data:{threadId:target,runId:'run-1',status:'completed',reply:'first'}};
  };
  const first=await sendT3({...input,pollMs:1},{run:firstRun});
  assert.equal(first.status,'completed');
  const second=await sendT3({...input,requestId:'r2',pollMs:1,message:'next'},{run:async(cmd,args)=>{
    if(args[1]==='show') return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'run-1',activeRunId:null,status:'completed'},messages:[]}};
    sends++;
    return {code:0,data:{threadId:target,runId:'run-2',status:'completed',reply:'second'}};
  }});
  assert.equal(second.status,'completed');assert.equal(second.answer,'second');assert.equal(sends,2);
});

test('later ID waits for an unconfirmed prior, then sends and releases the harvested answer',async t=>{
  const input=await setup(t);
  const marker='[yjx-feishu-agent:prior]';
  const wire=marker + '\n' + 'prior';
  const reserved=await reserveRecord(input.stateDir,{
    version:1,agent:'t3',requestId:'r1',threadId:target,inputHash:'prior-hash',marker,
    wireMessage:wire,t3Command:input.t3Command,status:'unconfirmed',submitted:true,route:'t3',
    turnId:'run-1',answer:null,baselineLatestRunId:'old-run',createdAt:new Date().toISOString(),
  });
  await claimThreadRequest(input.stateDir,{...reserved.record,threadId:'t3-' + target});
  let shows=0,sends=0;
  const run=async(cmd,args)=>{
    if(args[1]==='show'){
      shows++;
      if(shows<3) return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'run-1',activeRunId:'run-1',status:'running'},messages:[{role:'user',runId:'run-1',text:wire}]}};
      if(shows===3) return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'run-1',activeRunId:null,status:'completed'},messages:[{role:'user',runId:'run-1',text:wire},{role:'assistant',runId:'run-1',text:'first'}]}};
      return {code:0,data:{thread:{threadId:target,archived:false,latestRunId:'run-1',activeRunId:null,status:'completed'},messages:[]}};
    }
    sends++;
    return {code:0,data:{threadId:target,runId:'run-2',status:'completed',reply:'second'}};
  };
  const second=await sendT3({...input,requestId:'r2',pollMs:1,message:'next'},{run});
  assert.equal(second.status,'completed');assert.equal(second.answer,'second');assert.equal(sends,1);
  assert.equal(second.blockedByRequestId,undefined);
  assert.equal(second.releasedPriors.length,1);
  assert.equal(second.releasedPriors[0].requestId,'r1');
  assert.equal(second.releasedPriors[0].answer,'first');
  const prior=await requestT3Status({...input,requestId:'r1'});
  assert.equal(prior.status,'completed');assert.equal(prior.answer,'first');
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
