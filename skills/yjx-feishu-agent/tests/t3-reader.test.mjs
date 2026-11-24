import test from 'node:test';
import assert from 'node:assert/strict';
import {createT3Reader} from '../scripts/t3-reader.mjs';
import {applyT3Projection} from '../scripts/t3.mjs';

const threadId='thread';
const record={t3Command:['test-cli'],t3BaseDir:'/fixture',threadId,turnId:'run-2',wireMessage:'marker-2'};
const item=(runId,type,extra={})=>({id:`${runId}-${type}-${extra.n ?? 0}`,threadId,runId,type,status:'completed',
  startedAt:extra.at ?? '2026-11-20T00:00:00Z',completedAt:extra.at ?? '2026-11-20T00:00:00Z',...extra});
const runRecord=(id,status,startedAt,completedAt=status==='running'?null:startedAt)=>({id,threadId,status,startedAt,completedAt});

function fixture({bounded,pages=[],...overrides}={}) {
  const calls=[],paths=[];
  return {calls,paths,reader:createT3Reader({readRuntime:async()=>({origin:'http://127.0.0.1:3773'}),
    run:async(command,args)=>{calls.push(args);return {code:0,data:args[2]==='issue'?{sessionId:'session',token:'private-token'}:null};},
    fetchImpl:async(url,options)=>{
      const parsed=new URL(url);paths.push(parsed.pathname+parsed.search);
      assert.equal(options.headers.Authorization,'Bearer private-token');
      assert.equal(options.headers['x-t3-orchestration-protocol'],'2');
      if(parsed.pathname===`/api/orchestration/threads/${threadId}/bounded`) return new Response(JSON.stringify(bounded));
      assert.equal(parsed.pathname,`/api/orchestration/threads/${threadId}/history`);
      const index=Number(parsed.searchParams.get('cursor'));
      return new Response(JSON.stringify(pages[index]));
    },...overrides})};
}
const windowOnly=(turnItems,runs,hasMoreHistory=false)=>({projection:{thread:{id:threadId},runs,turnItems,messages:[]},historyCursor:hasMoreHistory?'0':null,hasMoreHistory});

test('read-only session is revoked after a bounded read; concurrent observers share one read',async()=>{
  const f=fixture({bounded:windowOnly([item('run-2','user_message',{text:'marker-2'}),item('run-2','assistant_message',{text:'answer',n:1})],
    [runRecord('run-2','completed','2026-11-20T00:00:00Z')])});
  const [projection]=await Promise.all([f.reader(record),f.reader(record)]);
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0].slice(0,7),['auth','session','issue','--scope','orchestration:read','--ttl','1m']);
  assert.deepEqual(f.calls[1].slice(0,4),['auth','session','revoke','session']);
  assert.deepEqual(f.paths,[`/api/orchestration/threads/${threadId}/bounded`]);
  assert.equal(applyT3Projection({...record,status:'unconfirmed'},projection).answer,'answer');
});

test('pages history backwards only until the target user message, keeping assistant phases',async()=>{
  const bounded=windowOnly([item('run-3','user_message',{text:'marker-3',at:'2026-11-20T02:00:00Z'})],
    [runRecord('run-2','completed','2026-11-20T01:00:00Z'),runRecord('run-3','running','2026-11-20T02:00:00Z')],true);
  const pages=[
    {items:[{item:item('run-2','assistant_message',{text:'progress',phase:'commentary',n:1})},{item:item('run-2','assistant_message',{text:'answer',phase:'final_answer',n:2})}],hasMoreHistory:true,nextCursor:'1'},
    {items:[{item:item('run-2','user_message',{text:'marker-2'})}],hasMoreHistory:true,nextCursor:'2'},
    {items:[{item:item('run-1','user_message',{text:'marker-1'})}],hasMoreHistory:false},
  ];
  const f=fixture({bounded,pages});
  const projection=await f.reader(record);
  assert.equal(f.paths.length,3);
  const updated=applyT3Projection({...record,status:'unconfirmed'},projection);
  assert.equal(updated.status,'completed');assert.equal(updated.answer,'answer');
});

test('runs older than the bounded window are ended only after a later run started; errors stay failures',async()=>{
  const later=[runRecord('run-3','completed','2026-11-20T03:00:00Z')];
  const older=(extra=[])=>({items:[{item:item('run-2','user_message',{text:'marker-2',at:'2026-11-20T01:00:00Z'})},
    {item:item('run-2','assistant_message',{text:'done',n:1,at:'2026-11-20T01:30:00Z'})},...extra],hasMoreHistory:false});
  let projection=await fixture({bounded:windowOnly([],later,true),pages:[older()]}).reader(record);
  assert.equal(projection.runs.find(run=>run.id==='run-2').status,'completed');
  assert.equal(applyT3Projection({...record,status:'unconfirmed'},projection).answer,'done');

  projection=await fixture({bounded:windowOnly([],later,true),pages:[older([{item:item('run-2','error',{status:'failed',n:2,at:'2026-11-20T01:40:00Z'})}])]}).reader(record);
  const failed=applyT3Projection({...record,status:'unconfirmed'},projection);
  assert.equal(failed.status,'failed');assert.equal(failed.answer,undefined);

  projection=await fixture({bounded:windowOnly([],[runRecord('run-3','queued','2026-11-20T00:30:00Z')],true),pages:[older()]}).reader(record);
  assert.equal(projection.runs.some(run=>run.id==='run-2'),false);
  assert.equal(applyT3Projection({...record,status:'unconfirmed'},projection).status,'unconfirmed');

  const nested=item('run-2','error',{status:'failed',n:3,parentItemId:'tool',at:'2026-11-20T01:10:00Z'});
  const recovered=item('run-2','error',{status:'failed',n:4,at:'2026-11-20T01:20:00Z'});
  projection=await fixture({bounded:windowOnly([],later,true),pages:[{...older(),items:[older().items[0],{item:nested},{item:recovered},older().items[1]]}]}).reader(record);
  assert.equal(projection.runs.find(run=>run.id==='run-2').status,'completed');

  const interruptResult=item('run-2','run_interrupt_result',{status:'interrupted',n:5,parentItemId:'request',at:'2026-11-20T01:35:00Z'});
  projection=await fixture({bounded:windowOnly([],later,true),pages:[older([{item:interruptResult}])]}).reader(record);
  assert.equal(applyT3Projection({...record,status:'unconfirmed'},projection).status,'interrupted');
});

test('cancelled or rolled-back requests end without scanning history older than their submission',async()=>{
  const submitted={...record,createdAt:'2026-11-20T05:00:00Z'};
  const bounded=windowOnly([],[runRecord('run-3','completed','2026-11-20T06:00:00Z')],true);
  const pages=[
    {items:[{item:item('run-1','assistant_message',{text:'newer',at:'2026-11-20T05:30:00Z'})}],hasMoreHistory:true,nextCursor:'1'},
    {items:[{item:item('run-0','user_message',{text:'old',at:'2026-11-19T00:00:00Z'})}],hasMoreHistory:true,nextCursor:'2'},
  ];
  const f=fixture({bounded,pages});
  const projection=await f.reader(submitted);
  assert.equal(f.paths.length,3);
  const updated=applyT3Projection({...submitted,status:'unconfirmed'},projection);
  assert.equal(updated.status,'interrupted');assert.equal(updated.answer,undefined);

  const failedInWindow=fixture({bounded:windowOnly([],[runRecord('run-2','failed','2026-11-20T06:00:00Z')],true),pages});
  assert.equal(applyT3Projection({...submitted,status:'unconfirmed'},await failedInWindow.reader(submitted)).status,'failed');
  assert.equal(failedInWindow.paths.length,1);
});

test('history budget, HTTP errors and identity mismatches fail closed and revoke sessions without exposing tokens',async()=>{
  const endless={items:[{item:item('run-9','assistant_message',{text:'x'})}],hasMoreHistory:true,nextCursor:'0'};
  const budget=fixture({bounded:windowOnly([],[runRecord('run-9','running','2026-11-20T09:00:00Z')],true),pages:[endless],maxPages:3});
  await assert.rejects(budget.reader(record));assert.equal(budget.paths.length,4);assert.equal(budget.calls.at(-1)[2],'revoke');
  for(const fetchImpl of [async()=>new Response('',{status:401}),async()=>new Response(JSON.stringify(windowOnly([],[])).replace(`"id":"${threadId}"`,'"id":"other"'))]) {
    const f=fixture({fetchImpl});await assert.rejects(f.reader(record),error=>!error.message.includes('private-token'));
    assert.equal(f.calls.at(-1)[2],'revoke');
  }
});

test('a modified runtime origin cannot receive a locally issued bearer token',async()=>{
  const f=fixture({readRuntime:async()=>({origin:'https://untrusted.invalid'})});
  await assert.rejects(f.reader(record));assert.equal(f.calls.length,0);
});
