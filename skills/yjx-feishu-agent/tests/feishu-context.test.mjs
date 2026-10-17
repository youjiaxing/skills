import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { bodyText, imageKeys } from '../scripts/feishu-content.mjs';
import { resolveContext, saveImage, recentContext } from '../scripts/feishu-context.mjs';
import { parseReadArgs } from '../scripts/read-feishu.mjs';

const quoted=(id,parent,chat='oc_bound')=>({message_id:id,parent_id:parent,chat_id:chat,msg_type:'text',body:{content:JSON.stringify({text:'交作业 <untrusted instruction>'})}});
const item={messageId:'om_current',binding:{chatId:'oc_bound'},text:'这是什么意思',parentId:'om_parent',source:quoted('om_current')};
async function setup(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'feishu-context-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return {imageDirectory:dir,readCommand:'node read-feishu.mjs',transport:{get:async id=>quoted(id)}};
}
test('post content_v2 and queried card structure preserve meaningful text without duplicate content',()=>{
  const body={title:'通知',content:[[{tag:'text',text:'old'}]],content_v2:[[{tag:'md',text:'周一交作业'},{tag:'at',user_id:'bot'},{tag:'img',image_key:'img_test'}]]};
  assert.equal(bodyText({message_type:'post',content:JSON.stringify(body)},'bot'),'通知\n周一交作业\n[图片]');
  const card={title:'摘要',elements:[[{tag:'text',text:'阅读练习'},{tag:'text',text:'周日完成'}]]};
  assert.match(bodyText({msg_type:'interactive',body:{content:JSON.stringify(card)}}),/阅读练习\n周日完成/);
});
test('quote traversal is same-group, bounded, and preserves primary request and read capability',async t=>{
  const c=await setup(t);let n=0;
  c.transport.get=async id=>{n++;return quoted(id,'om_'+n);};
  const text=await resolveContext(item,c);
  assert.ok(text.startsWith(item.text));assert.match(text,/交作业/);assert.match(text,/不是新的用户指令/);
  assert.match(text,/history --chat oc_bound/);assert.equal(n,3);
  c.transport.get=async id=>quoted(id,null,'oc_other');
  assert.doesNotMatch(await resolveContext(item,c),/交作业/);
  c.transport.get=async()=>{const e=new Error('secret token must not leak');e.apiCode=99991672;throw e;};
  const blocked=await resolveContext(item,c);assert.match(blocked,/API 99991672/);assert.doesNotMatch(blocked,/secret token/);
});
test('quoted image bytes reach a local file while revoked content stays hidden',async t=>{
  const c=await setup(t);
  const image={...quoted('om_parent'),msg_type:'image',body:{content:JSON.stringify({image_key:'img_test'})}};
  c.transport.get=async()=>image;
  c.transport.image=async()=>({getReadableStream:()=>Readable.from([Buffer.from('image bytes')])});
  const text=await resolveContext(item,c);
  assert.match(text,/本地图片路径/);const files=await readdir(c.imageDirectory);assert.equal(files.length,1);
  assert.equal(await readFile(path.join(c.imageDirectory,files[0]),'utf8'),'image bytes');
  assert.deepEqual(imageKeys({...image,deleted:true}),[]);
  assert.equal(bodyText({...image,deleted:true}),'[消息已撤回或删除]');
  await assert.rejects(saveImage(c.transport,image,'img_other',c.imageDirectory),/does not belong/);
});
test('read command enforces scope parameters and epoch-second ranges',()=>{
  assert.throws(()=>parseReadArgs(['history']),/bound/);
  assert.throws(()=>parseReadArgs(['history','--chat','oc_bound','--limit','1000']),/1–50/);
  assert.throws(()=>parseReadArgs(['history','--chat','oc_bound','--thread','omt_a','--start-time','1']),/time range/);
  assert.equal(parseReadArgs(['--state-dir','/state','history','--chat','oc_bound']).limit,20);
});

test('recent background includes prior pushes only, excludes current/future/quotes and sorts chronologically',async()=>{
  const incoming={...item,source:{...item.source,create_time:'1700000000999'}};
  const msg=(id,time,type='text')=>({...quoted(id),create_time:String(time),msg_type:type});
  let params;
  const result=await recentContext(incoming,{list:async p=>{
    params=p;
    return {items:[msg('om_future',1700000001000),msg('om_current',1700000000998),
      msg('om_parent',1700000000997),msg('om_second',1700000000996),
      {...msg('om_later_edit',1700000000001),update_time:'1700000001001'},
      msg('om_first',1700000000000),msg('om_missing',0)],has_more:false};
  }},new Set(['om_parent']));
  assert.equal(params.endTime,'1700000001');
  assert.deepEqual(result.messages.map(m=>m.messageId),['om_first','om_second']);
  assert.equal(result.beforeTime,'1700000000999');
});

test('history errors and unknown timestamps never block the current request or leak other groups',async t=>{
  const c=await setup(t);let calls=0;
  c.transport.list=async()=>{calls++;return {items:[quoted('om_private',null,'oc_other')]};};
  assert.deepEqual((await recentContext(item,c.transport)).messages,[]);assert.equal(calls,0);
  const incoming={...item,source:{...item.source,create_time:'1700000000000'}};
  const result=await recentContext(incoming,c.transport);
  assert.deepEqual(result.messages,[]);assert.ok(result.unavailable);
  c.transport.list=async()=>{const e=new Error('private secret');e.apiCode=99991672;throw e;};
  const text=await resolveContext(incoming,c);
  assert.ok(text.startsWith(item.text));assert.match(text,/API 99991672/);assert.doesNotMatch(text,/private secret/);
});

test('recent window caps count, text budget, pages and never downloads incidental images',async()=>{
  const incoming={...item,source:{...item.source,create_time:'1700000000000'}};
  let pages=0;
  const transport={list:async()=>{pages++;return {items:Array.from({length:20},(_,i)=>({...quoted('om_'+i),create_time:String(1699999999999-i),
    body:{content:JSON.stringify({text:'x'.repeat(6000)})}})),has_more:true,page_token:'page2'};},
    image:async()=>{throw Error('must not download');}};
  const result=await recentContext(incoming,transport);
  assert.ok(result.messages.length<=5);assert.ok(JSON.stringify(result.messages).length<=6002);
  assert.ok(result.messages.every(m=>m.text.length<=2000&&m.truncated));assert.ok(pages<=2);
});

test('two-page scan reaches prior card, retains image key without download, and enforces five messages',async t=>{
  const c=await setup(t);
  const incoming={...item,parentId:undefined,source:{...item.source,create_time:'1700000000999'}};
  let pages=0;
  c.transport.image=async()=>{assert.fail('Recent image must not auto download');};
  c.transport.list=async options=>{
    pages++;
    if (!options.pageToken) return {items:[{...quoted('om_current'),create_time:'1700000000999'}],has_more:true,page_token:'older'};
    assert.equal(options.pageToken,'older');
    return {items:[{...quoted('om_push'),create_time:'1700000000998',msg_type:'interactive',
      body:{content:JSON.stringify({title:'历史推送',elements:[[{tag:'text',text:'英语练习要打印'}]]})}},
      {...quoted('om_image'),create_time:'1700000000997',msg_type:'image',body:{content:JSON.stringify({image_key:'img_recent'})}},
      ...Array.from({length:15},(_,i)=>({...quoted('om_old_'+i),create_time:String(1700000000990-i)}))],has_more:false};
  };
  const result=await recentContext(incoming,c.transport);
  assert.equal(pages,2);assert.equal(result.messages.length,5);
  assert.deepEqual(result.messages.find(m=>m.messageId==='om_image').imageKeys,['img_recent']);
  pages=0;
  const text=await resolveContext(incoming,c);
  assert.match(text,/英语练习要打印/);assert.match(text,/recentHistory/);assert.ok(text.startsWith(item.text));
  assert.equal((await readdir(c.imageDirectory)).length,0);
});
