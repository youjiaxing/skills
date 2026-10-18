import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deliver, outboundStatus, submissionOutcome } from '../scripts/outbound-core.mjs';
import { describePush } from '../scripts/push-contract.mjs';
import { routeFile } from '../scripts/message-routes.mjs';

const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
async function setup(t) {
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'push-contract-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  let calls=0;
  const options={stateDir,appId:'cli_test',directory:stateDir,
    transport:{send:async()=>{calls++;return 'om_test';},update:async id=>{calls++;return id;}}};
  const input={operation:'send',requestId:'test',chatId:'oc_test',msgType:'interactive',content:{elements:[]}};
  const config={version:1,bindings:[{chatId:'oc_test',users:['ou_user']}]};
  const bindings=path.join(stateDir,'feishu','bindings.json');
  const connect=async()=>{await mkdir(path.dirname(bindings),{recursive:true});await writeFile(bindings,JSON.stringify(config));};
  const describe=async record=>describePush(record,{...options,outcome:submissionOutcome(record)});
  return {options,input,config,bindings,connect,describe,calls:()=>calls};
}
test('new connected-group send/update require explicit source or one-way before remote writes',async t=>{
  const f=await setup(t);await f.connect();
  await assert.rejects(deliver(f.input,f.options),{code:'SOURCE_REQUIRED'});
  await assert.rejects(deliver({...f.input,oneWay:false},f.options),{code:'SOURCE_REQUIRED'});
  assert.equal(f.calls(),0);
  const sent=await deliver({...f.input,sourceThreadId:A},f.options);
  assert.equal((await f.describe(sent)).followUp.state,'ready');
  const update={operation:'update',requestId:'update',targetRequestId:'test',expectedRevision:1,msgType:'interactive',content:{elements:[]}};
  await assert.rejects(deliver(update,f.options),{code:'SOURCE_REQUIRED'});
  assert.equal(f.calls(),1);
  const changed=await deliver({...update,oneWay:true},f.options);
  const status=await f.describe(changed);
  assert.equal(status.delivery,'confirmed');assert.equal(status.followUp.state,'unavailable');
  await assert.rejects(deliver({...f.input,requestId:'conflict',oneWay:true,sourceThreadId:A},f.options),/conflicts/);
});
test('legacy dedup remains immutable after connecting group; read-only summary sees current owner',async t=>{
  const f=await setup(t);const legacy=await deliver(f.input,f.options);
  await f.connect();
  const prior=await outboundStatus({...f.options,requestId:'test'});
  const repeated=await deliver(f.input,f.options);
  assert.ok(repeated.deduplicated);assert.equal(f.calls(),1);
  assert.equal((await f.describe(legacy)).followUp.reason,'source_not_registered');
  assert.deepEqual(await outboundStatus({...f.options,requestId:'test'}),prior);
  const update=await deliver({operation:'update',requestId:'new',targetRequestId:'test',expectedRevision:1,
    msgType:'interactive',sourceThreadId:B,content:{elements:[]}},f.options);
  assert.equal((await f.describe(legacy)).followUp.state,'changed');
  assert.equal((await f.describe(update)).followUp.state,'ready');
});
test('routing pending, corrupt, disabled and unknown receipts cannot appear ready',async t=>{
  const f=await setup(t);await f.connect();
  const record=await deliver({...f.input,sourceThreadId:A},f.options);
  const file=routeFile(f.options.stateDir,f.options.appId,'oc_test');
  const routing=JSON.parse(await readFile(file,'utf8'));
  routing.messages.om_test.pending='pending';await writeFile(file,JSON.stringify(routing));
  assert.equal((await f.describe(record)).followUp.reason,'route_pending');
  await writeFile(file,'broken');
  const corrupt=await f.describe(record);assert.equal(corrupt.delivery,'confirmed');assert.equal(corrupt.followUp.state,'unknown');
  f.config.bindings[0].threadId=A;f.config.bindings[0].quoteRouting=false;
  await writeFile(f.bindings,JSON.stringify(f.config));
  assert.equal((await f.describe(record)).followUp.reason,'routing_disabled');
  assert.equal((await f.describe({status:'unconfirmed',chatId:'oc_test',submitted:true})).delivery,'unknown');
});
