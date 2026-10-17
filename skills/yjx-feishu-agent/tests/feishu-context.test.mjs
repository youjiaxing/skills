import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { bodyText, imageKeys } from '../scripts/feishu-content.mjs';
import { resolveContext, saveImage } from '../scripts/feishu-context.mjs';
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
