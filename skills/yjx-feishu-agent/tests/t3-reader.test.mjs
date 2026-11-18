import test from 'node:test';
import assert from 'node:assert/strict';
import {createT3Reader} from '../scripts/t3-reader.mjs';

const record={t3Command:['test-cli'],t3BaseDir:'/fixture',threadId:'thread'};
function fixture(overrides={}) {
  const calls=[];
  return {calls,reader:createT3Reader({readRuntime:async()=>({origin:'http://127.0.0.1:3773'}),
    run:async(command,args)=>{calls.push(args);return {code:0,data:args[2]==='issue'?{sessionId:'session',token:'private-token'}:null};},
    fetchImpl:async(url,options)=>{
      assert.equal(new URL(url).pathname,'/api/orchestration/threads/thread');
      assert.equal(options.headers.Authorization,'Bearer private-token');
      assert.equal(options.headers['x-t3-orchestration-protocol'],'2');
      return new Response(JSON.stringify({projection:{thread:{id:'thread'},runs:[],messages:[]}}));
    },...overrides})};
}
test('read-only session is revoked after a real protocol read; concurrent observers share one projection',async()=>{
  const f=fixture();await Promise.all([f.reader(record),f.reader(record)]);
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0].slice(0,7),['auth','session','issue','--scope','orchestration:read','--ttl','1m']);
  assert.deepEqual(f.calls[1].slice(0,4),['auth','session','revoke','session']);
});
test('HTTP errors and identity mismatches revoke sessions without exposing tokens',async()=>{
  for(const fetchImpl of [async()=>new Response('',{status:401}),async()=>new Response(JSON.stringify({projection:{thread:{id:'other'},runs:[],messages:[]}}))]) {
    const f=fixture({fetchImpl});await assert.rejects(f.reader(record),error=>!error.message.includes('private-token'));
    assert.equal(f.calls.at(-1)[2],'revoke');
  }
});
test('a modified runtime origin cannot receive a locally issued bearer token',async()=>{
  const f=fixture({readRuntime:async()=>({origin:'https://untrusted.invalid'})});
  await assert.rejects(f.reader(record));assert.equal(f.calls.length,0);
});
