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
  return {imageDirectory:dir,transport:{get:async id=>quoted(id)}};
}
test('post content_v2 and queried card structure preserve meaningful text without duplicate content',()=>{
  const body={title:'通知',content:[[{tag:'text',text:'old'}]],content_v2:[[{tag:'md',text:'周一交作业'},{tag:'at',user_id:'bot'},{tag:'img',image_key:'img_test'}]]};
  assert.equal(bodyText({message_type:'post',content:JSON.stringify(body)},'bot'),'通知\n周一交作业\n[图片]');
  const card={title:'摘要',elements:[[{tag:'text',text:'阅读练习'},{tag:'text',text:'周日完成'}]]};
  assert.match(bodyText({msg_type:'interactive',body:{content:JSON.stringify(card)}}),/阅读练习\n周日完成/);
});
test('quote traversal is bounded, preserves cross-group source metadata and read capability',async t=>{
  const c=await setup(t);let n=0;
  c.transport.get=async id=>{n++;return quoted(id,'om_'+n);};
  const text=await resolveContext(item,c);
  assert.ok(text.startsWith(item.text));assert.match(text,/交作业/);assert.match(text,/非新指令/);
  assert.equal(n,3);
  c.transport.get=async id=>quoted(id,null,'oc_other');
  const cross=await resolveContext(item,c);assert.match(cross,/交作业/);
  assert.equal(JSON.parse(cross.split('\n')[3]).quotedMessages[0].sourceChatId,'oc_other');
  c.transport.get=async()=>{const e=new Error('secret token must not leak');e.apiCode=99991672;throw e;};
  const blocked=await resolveContext(item,c);assert.match(blocked,/API 99991672/);
  assert.match(blocked,/read-feishu\.mjs message --chat <来源群ID>/);assert.doesNotMatch(blocked,/secret token/);
});
test('quoted image bytes reach a local file while revoked content stays hidden',async t=>{
  const failed=await setup(t);
  failed.transport.get=async parent=>({...quoted(parent),msg_type:'image',body:{content:JSON.stringify({image_key:'img_test'})}});
  failed.transport.image=async()=>{const e=new Error('denied');e.apiCode=99991672;throw e;};
  const fallback=await resolveContext(item,failed);
  assert.match(fallback,/补读目标/);assert.match(fallback,/img_test/);assert.match(fallback,/read-feishu\.mjs image/);
  const c=await setup(t);
  const image={...quoted('om_parent'),msg_type:'image',body:{content:JSON.stringify({image_key:'img_test'})}};
  c.transport.get=async()=>image;
  c.transport.image=async()=>({getReadableStream:()=>Readable.from([Buffer.from('image bytes')])});
  const text=await resolveContext(item,c);
  const files=await readdir(c.imageDirectory);assert.equal(files.length,1);
  const context=JSON.parse(text.split('\n')[3]);
  assert.equal(context.quotedMessages[0].images[0],path.join(c.imageDirectory,files[0]));
  assert.equal(await readFile(path.join(c.imageDirectory,files[0]),'utf8'),'image bytes');
  assert.deepEqual(imageKeys({...image,deleted:true}),[]);
  assert.equal(bodyText({...image,deleted:true}),'[消息已撤回或删除]');
  await assert.rejects(saveImage(c.transport,image,'img_other',c.imageDirectory),/does not belong/);
});

test('context without quotes contains only source metadata',async t=>{
  const c=await setup(t);
  c.transport.list=async()=>{assert.fail('Automatic history must not be read');};
  const incoming={...item,parentId:undefined,source:{...item.source,create_time:'1700000000000'}};
  const text=await resolveContext(incoming,c);
  const context=JSON.parse(text.split('\n')[3]);
  assert.deepEqual(context,{chatId:'oc_bound',messageId:'om_current'});
  const custom=JSON.parse((await resolveContext(incoming,{...c,contextStateDir:c.imageDirectory})).split('\n')[3]);
  assert.equal(custom.stateDir,c.imageDirectory);
});

test('compact message entries preserve query identifiers, quote text, truncation and actual warnings',async t=>{
  const c=await setup(t);
  const full={...quoted('om_parent'),create_time:'1699999999999',parent_id:undefined,
    sender:{id:'ou_teacher',tenant_key:'unneeded'},body:{content:JSON.stringify({text:'原文'.repeat(3000)})}};
  c.transport.get=async()=>full;
  c.transport.list=async()=>{assert.fail('Automatic history must not be read');};
  const incoming={...item,source:{...item.source,create_time:'1700000000000'}};
  const context=JSON.parse((await resolveContext(incoming,c)).split('\n')[3]);
  const quote=context.quotedMessages[0];
  assert.equal(quote.messageId,'om_parent');assert.equal(quote.sender,'ou_teacher');
  assert.equal(quote.text,'原文'.repeat(2000));assert.equal(quote.truncated,true);
  assert.equal(quote.sourceChatId,'oc_bound');assert.equal(quote.deleted,undefined);
  assert.equal(quote.images,undefined);assert.equal(quote.imageKeys,undefined);
  assert.equal(context.recentHistory,undefined);

});
test('read command enforces scope parameters and epoch-second ranges',()=>{
  assert.throws(()=>parseReadArgs(['history']),/bound/);
  assert.throws(()=>parseReadArgs(['history','--chat','oc_bound','--limit','1000']),/1–50/);
  assert.throws(()=>parseReadArgs(['history','--chat','oc_bound','--thread','omt_a','--start-time','1']),/time range/);
  assert.equal(parseReadArgs(['--state-dir','/state','history','--chat','oc_bound']).limit,20);
});
