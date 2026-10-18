import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createContextManager, commitVersions, ledgerPath } from '../scripts/context-ledger.mjs';
import { messageVersion, versionReceipt } from '../scripts/feishu-content.mjs';

const message=(id,text='正文')=>({message_id:id,chat_id:'oc_test',msg_type:'text',
  create_time:'1700000000000',body:{content:JSON.stringify({text})}});
const incoming={messageId:'om_current',text:'本次请求',binding:{chatId:'oc_test',threadId:'codex_a'},
  source:{...message('om_current','本次请求'),create_time:'1700000001000'}};
const recent=text=>JSON.parse(text.split('\n')[3]).recentHistory?.messages ?? [];
async function fixture(t) {
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'feishu-ledger-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  let messages=[message('om_push')];
  const options={stateDir,appId:'cli_test',imageDirectory:path.join(stateDir,'images'),
    transport:{list:async()=>({items:messages}),get:async id=>messages.find(m=>m.message_id===id)}};
  return {options,manager:createContextManager(options),setMessages:value=>{messages=value;}};
}

test('prepare does not acknowledge; confirmed versions survive restart and edits appear again',async t=>{
  const f=await fixture(t);
  const first=await f.manager.prepare(incoming);
  assert.equal(recent(first.text).length,1);
  assert.equal(recent((await f.manager.prepare(incoming)).text).length,1);
  await f.manager.confirm(first);
  const restarted=createContextManager(f.options);
  assert.equal(recent((await restarted.prepare(incoming)).text).length,0);
  f.setMessages([message('om_push','编辑后的正文')]);
  const edited=await restarted.prepare(incoming);
  assert.equal(recent(edited.text)[0].text,'编辑后的正文');
  await restarted.confirm(edited);
  assert.equal(recent((await restarted.prepare(incoming)).text).length,0);
  const stored=await readFile(first.file,'utf8');
  assert.doesNotMatch(stored,/正文|本次请求/);
});

test('explicit quote always expands, while current request and confirmed reply are omitted later',async t=>{
  const f=await fixture(t),quoted={...incoming,parentId:'om_push'};
  await f.manager.confirm(await f.manager.prepare(incoming));
  const again=await f.manager.prepare(quoted);
  const expanded=JSON.parse(again.text.split('\n')[3]);
  assert.equal(expanded.quotedMessages[0].text,'正文');
  assert.equal(expanded.recentHistory,undefined);
  const reply=message('om_reply','回复正文');
  await f.manager.confirmReply(incoming,reply);
  f.setMessages([incoming.source,reply,{...message('om_new','新背景'),create_time:'1700000001500'}]);
  const next={...incoming,messageId:'om_next',source:{...message('om_next'),create_time:'1700000002000'}};
  assert.deepEqual(recent((await f.manager.prepare(next)).text).map(m=>m.messageId),['om_new']);
});

test('ledgers isolate app, group and Codex target; switching back reuses prior state',async t=>{
  const f=await fixture(t);
  await f.manager.confirm(await f.manager.prepare(incoming));
  const rebound={...incoming,binding:{...incoming.binding,threadId:'codex_b'}};
  assert.equal(recent((await f.manager.prepare(rebound)).text).length,1);
  assert.equal(recent((await createContextManager({...f.options,appId:'cli_other'}).prepare(incoming)).text).length,1);
  assert.notEqual(ledgerPath(f.options.stateDir,'cli_test',incoming),
    ledgerPath(f.options.stateDir,'cli_test',{binding:{...incoming.binding,chatId:'oc_other'}}));
  assert.equal(recent((await f.manager.prepare(incoming)).text).length,0);
});

test('concurrent commits merge under lock and stale observations cannot overwrite newer versions',async t=>{
  const f=await fixture(t),file=ledgerPath(f.options.stateDir,'cli_test',incoming);
  const old={...versionReceipt(message('om_edit','old')),observedAt:1};
  const newer={...versionReceipt(message('om_edit','new')),observedAt:2};
  await Promise.all([commitVersions(file,[newer]),commitVersions(file,[versionReceipt(message('om_other'))])]);
  await commitVersions(file,[old]);
  const ledger=JSON.parse(await readFile(file,'utf8'));
  assert.equal(Object.keys(ledger.messages).length,2);
  assert.equal(ledger.messages.om_edit.version,newer.version);
});

test('corrupt state degrades to a small window and is never overwritten as empty state',async t=>{
  const f=await fixture(t),file=ledgerPath(f.options.stateDir,'cli_test',incoming);
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'broken');
  const prepared=await f.manager.prepare(incoming);
  assert.equal(recent(prepared.text).length,1);assert.match(prepared.text,/去重状态不可用/);
  await assert.rejects(f.manager.confirm(prepared));
  assert.equal(await readFile(file,'utf8'),'broken');
});

test('content versions normalize event/query shapes and mentions, but retain edits and deletion',()=>{
  const event={message_type:'post',content:JSON.stringify({content:[[{tag:'at',user_id:'@_user_1'},{tag:'text',text:'hi'}]]}),
    mentions:[{key:'@_user_1',name:'Bot',id:{open_id:'ou_bot'}}]};
  const queried={msg_type:'post',body:{content:JSON.stringify({content:[[{tag:'at',user_id:'ou_bot',user_name:'Bot'},{tag:'text',text:'hi'}]]})}};
  assert.equal(messageVersion(event),messageVersion(queried));
  const textEvent={message_type:'text',content:JSON.stringify({text:'@_user_1 hi'}),mentions:event.mentions};
  const textQuery={msg_type:'text',body:{content:textEvent.content},mentions:[{key:'@_user_1',id:'ou_bot'}]};
  assert.equal(messageVersion(textEvent),messageVersion(textQuery));
  assert.notEqual(messageVersion(message('om_a')),messageVersion(message('om_a','changed')));
  assert.notEqual(messageVersion(message('om_a')),messageVersion({...message('om_a'),deleted:true}));
});

test('retained message hashes are bounded at one thousand entries',async t=>{
  const f=await fixture(t),file=ledgerPath(f.options.stateDir,'cli_test',incoming);
  await commitVersions(file,Array.from({length:1005},(_,i)=>({...versionReceipt(message('om_'+i)),observedAt:i})));
  const ledger=JSON.parse(await readFile(file,'utf8'));
  assert.equal(Object.keys(ledger.messages).length,1000);
  assert.equal(ledger.messages.om_0,undefined);assert.ok(ledger.messages.om_1004);
});

test('first-success baseline prevents older backfill but retains unsent new messages and known edits',async t=>{
  const f=await fixture(t);
  f.setMessages(Array.from({length:9},(_,i)=>({...message('om_old_'+i),create_time:String(1699999999999-i)})));
  const first=await f.manager.prepare(incoming);
  assert.equal(recent(first.text).length,5);
  await f.manager.confirm(first);
  assert.equal(recent((await f.manager.prepare(incoming)).text).length,0);
  const next={...incoming,messageId:'om_next',source:{...message('om_next'),create_time:'1700000010000'}};
  const newer=Array.from({length:8},(_,i)=>({...message('om_new_'+i),create_time:String(1700000001100+i)}));
  f.setMessages(newer);
  const batch=await f.manager.prepare(next);
  assert.equal(recent(batch.text).length,5);await f.manager.confirm(batch);
  const remaining=await f.manager.prepare(next);
  assert.equal(recent(remaining.text).length,3);await f.manager.confirm(remaining);
  const knownEdit={...message('om_old_0','changed without timestamp'),create_time:'1699999999999'};
  const unseenEdit={...message('om_old_8','changed with timestamp'),create_time:'1699999999991',update_time:'1700000002000'};
  const unknownOld={...message('om_unknown'),create_time:'1699999999000'};
  f.setMessages([knownEdit,unseenEdit,unknownOld]);
  assert.deepEqual(new Set(recent((await f.manager.prepare(next)).text).map(m=>m.messageId)),new Set(['om_old_0','om_old_8']));
  const ledger=JSON.parse(await readFile(first.file,'utf8'));
  assert.equal(ledger.bootstrapCutoff,1700000001000);
});
