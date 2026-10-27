import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTurn } from '../scripts/turn-observer.mjs';
import { finalTexts } from '../scripts/codex.mjs';

const final=(text='final')=>({id:'turn',status:'completed',completedAt:123,
  items:[{type:'agentMessage',phase:'final_answer',text}]});
const record=()=>({requestId:'request',threadId:'thread',turnId:'turn',status:'running',answers:[],answer:null});
function client() {return {events:[],unsupportedRequests:[],stopped:false,
  async waitFor() {await new Promise(r=>setTimeout(r,1));const e=new Error('poll');e.code='WAIT_TIMEOUT';throw e;}};}

test('silent active task and incomplete final snapshots do not terminate observation',async()=>{
  const r=record(),states=[],snapshots=[
    {id:'turn',status:'inProgress',completedAt:null,items:[]},
    {id:'turn',status:'inProgress',completedAt:null,items:[]},
    {...final('old'),status:'interrupted',completedAt:null},
    {...final('old'),completedAt:null},final(''),final('answer'),
  ];
  await observeTurn({client:client(),record:r,rpcTimeoutMs:50,pollMs:1,finalTexts,
    findTurn:async()=>snapshots.shift(),save:async()=>states.push(r.observationState)});
  assert.deepEqual(states,['running','running','unknown','awaiting_final','awaiting_final','completed']);
  assert.equal(r.answer,'answer');
});

test('individual query timeout and irrelevant completion events do not cancel the task',async()=>{
  const r=record(),c=client(),deadlines=[];let calls=0;
  c.events=[{method:'turn/completed',params:{threadId:'other',turn:final('wrong')}}];
  await observeTurn({client:c,record:r,rpcTimeoutMs:50,pollMs:1,finalTexts,
    findTurn:async(_c,_r,deadline)=>{
      deadlines.push(deadline());calls++;
      if(calls===1) {const e=new Error('query expired');e.code='RPC_TIMEOUT';throw e;}
      return final('correct');
    },save:async()=>{}});
  assert.equal(r.answer,'correct');assert.ok(deadlines[1]>deadlines[0]);
  assert.equal(r.lastObservationError,undefined);
});

test('only persisted terminal timestamps end failed/interrupted turns; partial text is cleared',async()=>{
  for(const status of ['failed','interrupted']) {
    const r=record();let count=0;
    await observeTurn({client:client(),record:r,rpcTimeoutMs:50,pollMs:1,finalTexts,
      findTurn:async()=>({...final('partial'),status,completedAt:++count===1 ? null : 123}),save:async()=>{}});
    assert.equal(r.status,status);assert.equal(r.answer,null);assert.deepEqual(r.answers,[]);assert.equal(count,2);
  }
});

test('completed turn without usable final text ends as terminal failure after a grace period',async()=>{
  const leaked='reasoning echo';
  const stuck={id:'turn',status:'completed',completedAt:123,items:[
    {type:'reasoning',summary:[leaked]},{type:'agentMessage',phase:null,text:leaked}]};
  const r=record(),states=[];
  await observeTurn({client:client(),record:r,rpcTimeoutMs:50,pollMs:1,noFinalTextPolls:2,finalTexts,
    findTurn:async()=>stuck,save:async()=>states.push(r.observationState)});
  assert.equal(r.status,'failed');assert.equal(r.error.code,'TURN_NO_FINAL_TEXT');
  assert.equal(r.answer,null);assert.deepEqual(r.answers,[]);
  assert.deepEqual(states,['awaiting_final','failed']);
});

test('reasoning echo is never accepted as an unphased final answer',async()=>{
  const leaked='Now I understand the root cause.';
  const echoed={id:'turn',status:'completed',completedAt:123,items:[
    {type:'reasoning',summary:[leaked]},{type:'agentMessage',phase:null,text:leaked}]};
  assert.deepEqual(finalTexts(echoed),[]);
  const clean={id:'turn',status:'completed',completedAt:123,items:[
    {type:'reasoning',summary:[leaked]},{type:'agentMessage',phase:null,text:'干净回答'}]};
  const r=record(),states=[];
  await observeTurn({client:client(),record:r,rpcTimeoutMs:50,pollMs:1,finalTexts,
    findTurn:async()=>clean,save:async()=>states.push(r.observationState)});
  assert.equal(r.status,'completed');assert.equal(r.answer,'干净回答');
});

test('broken transport or unsupported host request ends observation as an error, not success',async()=>{
  for(const c of [{...client(),failure:new Error('connection lost')},{...client(),unsupportedRequests:['item/tool/call']}]) {
    const r=record();
    await assert.rejects(observeTurn({client:c,record:r,rpcTimeoutMs:50,finalTexts,
      findTurn:async()=>assert.fail('no status read after terminal transport error'),save:async()=>{}}));
    assert.equal(r.status,'running');assert.equal(r.answer,null);
  }
});
