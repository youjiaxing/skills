import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {deliver,outboundPaths,outboundStatus} from '../scripts/outbound-core.mjs';
import {processOutboundFollowUp,createOutboundFollowUps} from '../scripts/outbound-followup.mjs';
import {routeFile} from '../scripts/message-routes.mjs';
import {createMessageRouter} from '../scripts/message-routes.mjs';
import {bridgeAuthority} from '../scripts/push-contract.mjs';
import {receiverPaths} from '../scripts/receiver-runtime.mjs';
import {createFeishuRateLimiter} from '../scripts/feishu-rate-limit.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
async function setup(t) {
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'followup-core-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const config={version:1,t3Command:['test'],bindings:[{chatId:'oc_test',users:['ou_test'],requireFollowUp:true,
    threadTargets:{[A]:{kind:'t3',threadId:A},[B]:{kind:'t3',threadId:B}},oneWayExceptions:{}}]};
  const configFile=path.join(stateDir,'feishu','bindings.json');
  await mkdir(path.dirname(configFile),{recursive:true});
  const save=()=>writeFile(configFile,JSON.stringify(config));await save();
  let sends=0;
  const options={stateDir,appId:'cli_test',directory:stateDir,transport:{send:async()=>{sends++;return 'om_test';},update:async id=>id}};
  const input={operation:'send',requestId:'test',chatId:'oc_test',sourceThreadId:A,requireFollowUp:true,msgType:'text',content:{text:'notification'}};
  return {stateDir,config,save,options,input,sends:()=>sends};
}
test('wrong state root, unregistered source and unauthorized one-way cannot call transport',async t=>{
  const f=await setup(t),other=path.join(f.stateDir,'other');await mkdir(other);
  await assert.rejects(deliver(f.input,{...f.options,stateDir:other,authorityDir:f.stateDir}),{code:'BRIDGE_STATE_MISMATCH'});
  const {sourceThreadId,...withoutSource}=f.input;
  await assert.rejects(deliver({...withoutSource,oneWay:true},f.options),{code:'ONE_WAY_NOT_AUTHORIZED'});
  delete f.config.bindings[0].threadTargets[A];await f.save();
  await assert.rejects(deliver(f.input,f.options),{code:'SOURCE_NOT_REGISTERED'});
  f.config.bindings[0].chatId='oc_other';await f.save();
  await assert.rejects(deliver(f.input,f.options),{code:'GROUP_NOT_CONNECTED'});
  assert.equal(f.sends(),0);
});
test('one-way exemption requires a named group authorization',async t=>{
  const f=await setup(t);f.config.bindings[0].oneWayExceptions.explicit='Explicitly authorized standalone notice';await f.save();
  const {sourceThreadId,...input}=f.input;
  const sent=await deliver({...input,oneWay:true,oneWayException:'explicit'},f.options);
  assert.equal(sent.status,'sent');assert.equal(f.sends(),1);assert.equal(sent.requireFollowUp,undefined);
});
test('offline notice has one stable identity, recovery changes only routing/health, and restart is idempotent',async t=>{
  const f=await setup(t);await deliver(f.input,f.options);
  const calls=[];const options={stateDir:f.stateDir,appId:'cli_test',requestId:'test',
    health:async()=>({state:'unavailable',reason:'receiver_offline'}),reply:async(parent,text,uuid)=>{calls.push({parent,text,uuid});return {message_id:'om_status'};}};
  await processOutboundFollowUp(options);await processOutboundFollowUp(options);
  assert.equal(calls.length,1);assert.equal(calls[0].parent,'om_test');
  const repeated=await deliver(f.input,f.options);assert.equal(repeated.deduplicated,true);assert.equal(f.sends(),1);
  const before=await outboundStatus({...f.options,requestId:'test'});
  const recovered=await processOutboundFollowUp({...options,health:async()=>({state:'ready'})});
  assert.equal(recovered.followUpPending,false);assert.equal(recovered.fingerprint,before.fingerprint);assert.deepEqual(recovered.content,f.input.content);
  const worker=createOutboundFollowUps({...options,health:async()=>({state:'ready'})});worker.tick();await worker.stop();
  assert.equal(calls.length,1);assert.equal(f.sends(),1);
});
test('lost status receipt retries frozen reply UUID without resending original',async t=>{
  const f=await setup(t);await deliver(f.input,f.options);const uuids=[];
  const options={stateDir:f.stateDir,appId:'cli_test',requestId:'test',health:async()=>({state:'unavailable'}),
    reply:async(_parent,_text,uuid)=>{uuids.push(uuid);throw new Error('lost receipt');}};
  await processOutboundFollowUp(options);await processOutboundFollowUp(options);
  assert.equal(uuids.length,2);assert.equal(uuids[0],uuids[1]);assert.equal(f.sends(),1);
  await processOutboundFollowUp({...options,now:()=>Date.now()+3600001});assert.equal(uuids.length,2);
});

test('status retry delayed by the rate-limit gate cannot cross its original deduplication deadline',async t=>{
  const f=await setup(t);await deliver(f.input,f.options);
  let clock=100000,calls=0;
  const limiter=createFeishuRateLimiter({gateDir:f.stateDir,appId:'cli_test',now:()=>clock,
    sleep:async ms=>{clock+=ms+3600000;},minIntervalMs:1});
  const options={stateDir:f.stateDir,appId:'cli_test',requestId:'test',now:()=>clock,
    health:async()=>({state:'unavailable'}),reply:async(_parent,_text,_uuid,{deadlineMs})=>{
      assert.equal(deadlineMs,100000+3540000);
      return limiter.execute(async()=>{calls++;throw new Error('lost receipt');},{deadlineMs});
    }};
  await processOutboundFollowUp(options);
  const record=await processOutboundFollowUp(options);
  assert.equal(calls,1);assert.equal(record.followUpNotice.state,'unknown');
  const expired=await processOutboundFollowUp(options);
  assert.equal(expired.followUpNotice.state,'needs_reconciliation');assert.equal(calls,1);
});
test('acknowledged pending route is recovered but an older revision never steals a newer source',async t=>{
  const f=await setup(t);const card={...f.input,msgType:'interactive',content:{elements:[]}};await deliver(card,f.options);
  const file=routeFile(f.stateDir,'cli_test','oc_test'),routing=JSON.parse(await readFile(file,'utf8'));
  routing.messages.om_test.pending='test';await writeFile(file,JSON.stringify(routing));
  await processOutboundFollowUp({stateDir:f.stateDir,appId:'cli_test',requestId:'test',health:async()=>({state:'ready'})});
  assert.equal(JSON.parse(await readFile(file,'utf8')).messages.om_test.pending,null);
  // Reopen the old recovery intent to simulate a delayed recovery worker.
  const record=await outboundStatus({...f.options,requestId:'test'});record.followUpPending=true;
  await writeFile(outboundPaths(f.stateDir,'cli_test').request('test'),JSON.stringify(record));
  await deliver({operation:'update',requestId:'new',targetRequestId:'test',expectedRevision:1,sourceThreadId:B,requireFollowUp:true,
    msgType:'interactive',content:{elements:[]}},f.options);
  await processOutboundFollowUp({stateDir:f.stateDir,appId:'cli_test',requestId:'test',health:async()=>({state:'ready'}),reply:()=>assert.fail('stale notice')});
  assert.equal(JSON.parse(await readFile(file,'utf8')).messages.om_test.sourceThreadId,B);
});
test('moving to central state does not resend a legacy unknown request with the same event identity',async t=>{
  const f=await setup(t),legacy=path.join(f.stateDir,'legacy');await mkdir(legacy);
  const {sourceThreadId,requireFollowUp,...old}=f.input;
  await deliver({...old,oneWay:true},{...f.options,stateDir:legacy,transport:{send:async()=>{throw new Error('unknown');}}});
  f.config.bindings[0].legacyOutboundDirs=[legacy];await f.save();
  const result=await deliver(f.input,f.options);
  assert.equal(result.status,'unconfirmed');assert.equal(result.legacyStateDir,legacy);assert.equal(f.sends(),0);
});
test('missing installed state never falls back to an ungoverned credentials directory',async t=>{
  const f=await setup(t),home=path.join(f.stateDir,'user');
  const directory=receiverPaths('cli_test',home).runtime;await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'task-registration.json'),JSON.stringify({stateDir:path.join(f.stateDir,'missing')}));
  await assert.rejects(bridgeAuthority(f.stateDir,'cli_test',{home}),{code:'ENOENT'});
  assert.equal(f.sends(),0);
});
test('restarting after a recovery process exits reclaims only confirmed dead owners and never resends original',async t=>{
  const f=await setup(t);await deliver(f.input,f.options);
  const root=outboundPaths(f.stateDir,'cli_test').root;
  const routeRoot=path.dirname(routeFile(f.stateDir,'cli_test','oc_test'));
  const hash=s=>createHash('sha256').update(s).digest('hex');
  const locks=[[root,`request-${hash('test')}`],[root,`target-${hash('test')}`],[routeRoot,hash('oc_test')]];
  const script=`import {lockThread} from ${JSON.stringify(new URL('../scripts/state.mjs',import.meta.url).href)};for(const [root,name] of JSON.parse(process.argv[1])) await lockThread(root,name,performance.now()+1000);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(locks)],{windowsHide:true,timeout:5000,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const record=await processOutboundFollowUp({stateDir:f.stateDir,appId:'cli_test',requestId:'test',health:async()=>({state:'ready'})});
  assert.equal(record.followUpPending,false);assert.equal(f.sends(),1);
});
test('healthy service still finishes a previously submitted unknown status reply and registers its source',async t=>{
  const f=await setup(t);await deliver(f.input,f.options);const ids=[];
  await processOutboundFollowUp({stateDir:f.stateDir,appId:'cli_test',requestId:'test',health:async()=>({state:'unavailable'}),
    reply:async(_parent,_text,id)=>{ids.push(id);throw new Error('receipt lost');}});
  const result=await processOutboundFollowUp({stateDir:f.stateDir,appId:'cli_test',requestId:'test',health:async()=>({state:'ready'}),
    reply:async(_parent,_text,id)=>{ids.push(id);return {message_id:'om_recovered_notice'};}});
  assert.equal(ids[0],ids[1]);assert.equal(result.followUpPending,false);
  assert.equal(JSON.parse(await readFile(routeFile(f.stateDir,'cli_test','oc_test'),'utf8')).messages.om_recovered_notice.sourceThreadId,A);
});
test('removing a T3 mapping blocks admission instead of silently falling back to native Codex',async t=>{
  const f=await setup(t);await deliver(f.input,f.options);
  f.config.bindings[0].threadId=A;
  delete f.config.bindings[0].threadTargets[A];await f.save();
  let admitted;
  await createMessageRouter({stateDir:f.stateDir,appId:'cli_test'}).admit({binding:f.config.bindings[0],parentId:'om_test'},choice=>{admitted=choice;});
  assert.equal(admitted.code,'SOURCE_NOT_REGISTERED');assert.equal(admitted.threadId,undefined);
});
test('superseded notification finishes its existing status receipt without reclaiming the original card',async t=>{
  const f=await setup(t);await deliver({...f.input,msgType:'interactive',content:{elements:[]}},f.options);
  const options={stateDir:f.stateDir,appId:'cli_test',requestId:'test',health:async()=>({state:'unavailable'})};
  let uuid;
  await processOutboundFollowUp({...options,reply:async(_parent,_text,id)=>{uuid=id;throw new Error('receipt lost');}});
  await deliver({operation:'update',requestId:'new',targetRequestId:'test',expectedRevision:1,sourceThreadId:B,requireFollowUp:true,
    msgType:'interactive',content:{elements:[]}},f.options);
  const result=await processOutboundFollowUp({...options,health:async()=>({state:'ready'}),reply:async(_parent,_text,id)=>{
    assert.equal(id,uuid);return {message_id:'om_old_status'};
  }});
  const routes=JSON.parse(await readFile(routeFile(f.stateDir,'cli_test','oc_test'),'utf8')).messages;
  assert.equal(result.followUpPending,false);assert.equal(routes.om_test.sourceThreadId,B);assert.equal(routes.om_old_status.sourceThreadId,A);
});
