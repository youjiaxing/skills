import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendCodex, requestStatus, finalTexts } from '../scripts/codex.mjs';
import { AppServer } from '../scripts/app-server.mjs';
import { lockThread, validateRequestId, claimThreadRequest } from '../scripts/state.mjs';
import { parseArgs } from '../scripts/agent.mjs';

const THREAD = '12345678-1234-1234-1234-123456789abc';
const fixture = fileURLToPath(new URL('./fixtures/protocol-peer.mjs', import.meta.url));

test('explicit quote target restores its exact archived thread before one submission', async t => {
  const c=await context(t,'restore-ok');
  const result=await sendCodex({...c.input,autoUnarchive:true},c.dependencies);
  assert.equal(result.status,'completed');assert.equal(result.restoreStatus,'restored');
  const calls=(await readFile(path.join(c.directory,'calls.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x).method);
  assert.ok(calls.indexOf('thread/unarchive')<calls.indexOf('thread/resume'));
  assert.equal(calls.filter(x=>x==='thread/read').length,2);
  assert.equal(calls.filter(x=>x==='turn/start').length,1);
  await sendCodex({...c.input,autoUnarchive:true},c.dependencies);
  assert.equal(c.counts().clients,1);
});

test('uncertain or mismatched restoration never starts a turn or queues and is not replayed',async t=>{
  for (const mode of ['restore-error','restore-wrong-id','restore-still-archived']) {
    const c=await context(t,mode);
    const result=await sendCodex({...c.input,autoUnarchive:true},c.dependencies);
    assert.equal(result.submitted,false);assert.equal(result.status,'blocked');
    assert.equal(c.counts().queueCalls,0);
    const calls=await readFile(path.join(c.directory,'calls.jsonl'),'utf8');
    assert.doesNotMatch(calls,/turn\/start|thread\/resume/);
    assert.equal((await sendCodex({...c.input,autoUnarchive:true},c.dependencies)).deduplicated,true);
  }
});

test('completed persisted turns accept only terminal unphased text as fallback', () => {
  const terminal = { type: 'agentMessage', phase: null, text: 'persisted-result' };
  const turn = { status: 'completed', completedAt: 123, items: [terminal] };
  assert.deepEqual(finalTexts(turn), ['persisted-result']);
  assert.deepEqual(finalTexts({ ...turn, items: [{ ...terminal, phase: undefined }] }), ['persisted-result']);
  for (const status of ['inProgress', 'interrupted', 'failed']) {
    assert.deepEqual(finalTexts({ ...turn, status }), []);
  }
  assert.deepEqual(finalTexts({ ...turn, completedAt: null }), []);
  assert.deepEqual(finalTexts({ ...turn, items: [terminal, { type: 'reasoning' }] }), []);
  assert.deepEqual(finalTexts({ ...turn, items: [{ ...terminal, phase: 'commentary' }] }), []);
  assert.deepEqual(finalTexts({ ...turn, items: [{ ...terminal, text: ' ' }] }), []);
  assert.deepEqual(finalTexts({ ...turn, items: [{ ...terminal, text: 'earlier' }, terminal] }), ['persisted-result']);
  assert.deepEqual(finalTexts({ ...turn, items: [{ ...terminal, phase: 'final_answer', text: 'explicit' }, terminal] }), ['explicit']);
});

test('queued completion with null phase is recovered without a second submission', async (t) => {
  const c = await context(t, 'queue-null-phase');
  const result = await sendCodex({ ...c.input, timeoutMs: 1000 }, c.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'protocol-result-✓');
  await requestStatus({ ...c.input, refresh: true }, c.dependencies);
  assert.equal(c.counts().queueCalls, 1);
});

async function context(t, mode = 'direct') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yjx-feishu-protocol-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clients = 0;
  let queueCalls = 0;
  const dependencies = {
    createClient: () => {
      clients += 1;
      return new AppServer(process.execPath, directory, { prefixArgs: [fixture],
        env: { ...process.env, PEER_DIRECTORY: directory, PEER_MODE: mode, PEER_THREAD: THREAD } });
    },
    queue: async (binary, threadId, message) => {
      queueCalls += 1;
      await writeFile(path.join(directory, 'queue.json'), JSON.stringify({ threadId, message }));
      return 'fixture-queue-receipt';
    },
  };
  const input = { threadId: THREAD, message: 'transport payload', requestId: 'request-1',
    codex: process.execPath, stateDir: path.join(directory, 'state'), cwd: directory, timeoutMs: 10000, pollMs: 10 };
  return { directory, input, dependencies, counts: () => ({ clients, queueCalls }) };
}

test('external resume correlates completion arriving before its RPC acknowledgement', async (t) => {
  const c = await context(t, 'before-ack');
  const record = await sendCodex(c.input, c.dependencies);
  assert.equal(record.status, 'completed');
  assert.equal(record.route, 'app-server');
  assert.equal(record.turnId, 'protocol-turn-1');
  assert.equal(record.answer, 'protocol-result-✓');
  assert.equal(c.counts().queueCalls, 0);
});

test('state observation outlives individual RPC budget without interrupting or resubmitting',async t=>{
  const c=await context(t,'state-long-running');
  const record=await sendCodex({...c.input,waitMode:'state',timeoutMs:1000},c.dependencies);
  assert.equal(record.status,'completed');assert.equal(record.waitMode,'state');
  assert.equal(record.answer,'protocol-result-✓');assert.equal(record.interruptRequested,undefined);
  const calls=(await readFile(path.join(c.directory,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
  assert.equal(calls.filter(c=>c.method==='turn/interrupt').length,0);
  const replay=await sendCodex({...c.input,waitMode:'state'},c.dependencies);
  assert.equal(replay.deduplicated,true);
});

test('state observer recovers missing completion event and handles queue correlation',async t=>{
  for(const mode of ['state-missing-event','queue-pages','queue-null-phase']) {
    const c=await context(t,mode);
    const record=await sendCodex({...c.input,waitMode:'state',timeoutMs:1000},c.dependencies);
    assert.equal(record.status,'completed');assert.equal(record.answer,'protocol-result-✓');
  }
});

test('state host interaction failure leaves an uncertain task without issuing interrupt',async t=>{
  const c=await context(t,'state-host-request');
  const record=await sendCodex({...c.input,waitMode:'state',timeoutMs:1000},c.dependencies);
  assert.equal(record.status,'blocked');assert.equal(record.error.code,'HOST_INTERACTION_REQUIRED');
  const calls=(await readFile(path.join(c.directory,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(c=>c.method==='turn/interrupt').length,0);
});

test('refresh retries only when persisted binary is unavailable and uses the current executable',async t=>{
  const c=await context(t,'direct');
  const original=await sendCodex({...c.input,waitMode:'state',timeoutMs:1000},c.dependencies);
  const requestFile=path.join(c.input.stateDir,'requests',original.requestId,'record.json');
  await writeFile(requestFile,JSON.stringify({...original,binary:path.join(c.directory,'missing-codex.exe'),
    status:'unconfirmed',answer:null,answers:[]}));
  await writeFile(path.join(c.directory,'turn.json'),JSON.stringify({id:original.turnId,status:'completed',
    completedAt:123,items:[{type:'agentMessage',phase:'final_answer',text:'recovered'}]}));
  const refreshed=await requestStatus({...c.input,refresh:true},c.dependencies);
  assert.equal(refreshed.status,'completed');assert.equal(refreshed.answer,'recovered');
});

test('refresh does not retry a configured binary that the caller explicitly selected',async t=>{
  const c=await context(t,'direct');
  const original=await sendCodex({...c.input,waitMode:'state',timeoutMs:1000},c.dependencies);
  const requestFile=path.join(c.input.stateDir,'requests',original.requestId,'record.json');
  const explicit=path.join(c.directory,'explicit-missing.exe');
  await writeFile(requestFile,JSON.stringify({...original,binary:explicit,status:'unconfirmed'}));
  await assert.rejects(requestStatus({...c.input,refresh:true,codex:explicit},c.dependencies),/Codex executable not found/);
});

test('state refresh applies the same terminal proof as live observation without restarting a turn',async t=>{
  const c=await context(t,'direct');
  const original=await sendCodex({...c.input,waitMode:'state',timeoutMs:1000},c.dependencies);
  const requestFile=path.join(c.input.stateDir,'requests',original.requestId,'record.json');
  const turnFile=path.join(c.directory,'turn.json');
  for(const [status,completedAt,text,expected] of [
    ['completed',0,'text','unconfirmed'],['completed','123','text','unconfirmed'],
    ['completed',123,'','unconfirmed'],['interrupted',null,'partial','unconfirmed'],
    ['interrupted',123,'partial','interrupted'],['failed',123,'partial','failed'],
    ['completed',123,'confirmed-final','completed'],
  ]) {
    await writeFile(requestFile,JSON.stringify({...original,status:'unconfirmed',answer:null,answers:[]}));
    await writeFile(turnFile,JSON.stringify({id:original.turnId,status,completedAt,
      items:[{type:'agentMessage',phase:'final_answer',text}]}));
    const refreshed=await requestStatus({...c.input,refresh:true},c.dependencies);
    assert.equal(refreshed.status,expected);
    assert.equal(refreshed.answer,expected==='completed' ? 'confirmed-final' : null);
  }
  const calls=(await readFile(path.join(c.directory,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(calls.filter(call=>call.method==='turn/interrupt').length,0);
});

test('new input refreshes an unresolved prior request before evaluating the thread gate',async t=>{
  const c=await context(t,'no-completion');
  const first=await sendCodex({...c.input,requestId:'first',timeoutMs:1000},c.dependencies);
  await writeFile(path.join(c.input.stateDir,'requests',first.requestId,'record.json'),
    JSON.stringify({...first,status:'unconfirmed',answer:null,answers:[]}));
  const guard=await sendCodex({...c.input,requestId:'second'},c.dependencies);
  assert.equal(guard.status,'blocked');assert.equal(guard.submitted,false);
  assert.equal(guard.oldThreadRequest.requestId,first.requestId);
});

test('archived, unavailable and unknown targets never resume, queue or submit', async t => {
  for (const state of ['archived','unavailable','unknown']) {
    const c = await context(t, `target-${state}`);
    const record = await sendCodex(c.input, c.dependencies);
    assert.equal(record.status, 'blocked');
    assert.equal(record.submitted, false);
    assert.equal(record.error.code, `TARGET_${state.toUpperCase()}`);
    const calls = (await readFile(path.join(c.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(!calls.some(c => ['thread/resume','turn/start'].includes(c.method)));
    assert.equal(c.counts().queueCalls, 0);
  }
});

test('messages retain Unicode, quotes, newlines and shell metacharacters as text', async (t) => {
  const c = await context(t);
  const message = '中文 “引号”\n$(not-a-command) `literal` & %PATH%';
  const record = await sendCodex({ ...c.input, message }, c.dependencies);
  const sent = JSON.parse(await readFile(path.join(c.directory, 'input.json'), 'utf8'));
  assert.equal(sent.input[0].text, `${record.marker}\n${message}`);
  assert.equal(record.status, 'completed');
});

test('same request/input is not sent twice; changed input conflicts', async (t) => {
  const c = await context(t);
  await sendCodex(c.input, c.dependencies);
  const repeated = await sendCodex(c.input, c.dependencies);
  assert.equal(repeated.deduplicated, true);
  assert.equal(c.counts().clients, 1);
  await assert.rejects(sendCodex({ ...c.input, message: 'different' }, c.dependencies), /different input/);
  assert.equal(c.counts().clients, 1);
});

test('only an active-writer rejection falls back to queue', async (t) => {
  const c = await context(t, 'denied');
  const result = await sendCodex(c.input, c.dependencies);
  assert.equal(result.status, 'blocked');
  assert.equal(result.submitted, false);
  assert.equal(c.counts().queueCalls, 0);
});

test('queue history is paginated and transient interrupted is not terminal', async (t) => {
  const c = await context(t, 'queue-pages');
  const result = await sendCodex(c.input, c.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.route, 'queue');
  assert.equal(result.answer, 'protocol-result-✓');
  const calls = (await readFile(path.join(c.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.filter((call) => call.method === 'thread/turns/list').length >= 5);
  assert.equal(c.counts().queueCalls, 1);
});

test('ambiguous correlation remains unconfirmed and never resubmits', async (t) => {
  const c = await context(t, 'queue-ambiguous');
  const result = await sendCodex(c.input, c.dependencies);
  assert.equal(result.status, 'unconfirmed');
  assert.match(result.error.message, /Ambiguous/);
  await sendCodex(c.input, c.dependencies);
  assert.equal(c.counts().queueCalls, 1);
});

test('queue-empty refresh ends a request only after its own turn is proven transiently interrupted',async t=>{
  const c=await context(t,'queue-late');
  const record=await sendCodex({...c.input,timeoutMs:1000},c.dependencies);
  assert.equal(record.status,'unconfirmed');
  assert.ok(record.turnId);
  const originalTurnId=record.turnId;
  const requestFile=path.join(c.input.stateDir,'requests',record.requestId,'record.json');
  await writeFile(requestFile,JSON.stringify({...record,status:'unconfirmed',answer:null,answers:[]}));
  await writeFile(path.join(c.directory,'turn.json'),JSON.stringify({id:originalTurnId,status:'interrupted',completedAt:null,
    items:[{type:'userMessage',content:[{type:'text',text:record.marker}]}]}));
  const refreshed=await requestStatus({...c.input,refresh:true},c.dependencies);
  assert.equal(refreshed.status,'interrupted');assert.equal(refreshed.queueState,'empty');
  assert.equal(refreshed.turnId,originalTurnId);
  assert.equal(refreshed.error,null);assert.deepEqual(refreshed.answers,[]);
});

test('new input proceeds after an unresolved prior request refreshes to a terminal state',async t=>{
  const c=await context(t,'queue-empty-newer-turn');
  const first=await sendCodex({...c.input,requestId:'first',timeoutMs:1000},c.dependencies);
  assert.equal(first.status,'unconfirmed');assert.ok(first.turnId);
  await writeFile(path.join(c.input.stateDir,'requests',first.requestId,'record.json'),
    JSON.stringify({...first,status:'unconfirmed',answer:null,answers:[]}));
  const second=await sendCodex({...c.input,requestId:'second',timeoutMs:1000},c.dependencies);
  const heldByPrevious=second.error?.code==='REQUEST_HELD';
  assert.equal(heldByPrevious,false,
    JSON.stringify({error:second.error,oldThreadRequest:second.oldThreadRequest}));
  assert.equal(second.oldThreadRequest.requestId,'first');
  assert.equal(second.oldThreadRequest.status,'interrupted');
  const prior=JSON.parse(await readFile(path.join(c.input.stateDir,'requests',first.requestId,'record.json'),'utf8'));
  assert.equal(prior.status,'interrupted');assert.equal(prior.turnId,first.turnId);
  assert.notEqual(prior.turnId,'unrelated-later-turn');
});
test('queue-empty refresh ignores a newer unrelated interrupted turn',async t=>{
  const c=await context(t,'queue-empty-newer-turn');
  const record=await sendCodex({...c.input,timeoutMs:1000},c.dependencies);
  assert.equal(record.status,'unconfirmed');assert.ok(record.turnId);
  const originalTurnId=record.turnId;
  const requestFile=path.join(c.input.stateDir,'requests',record.requestId,'record.json');
  await writeFile(requestFile,JSON.stringify({...record,status:'unconfirmed',answer:null,answers:[]}));
  await writeFile(path.join(c.directory,'turn.json'),JSON.stringify({id:originalTurnId,status:'interrupted',completedAt:null,
    items:[{type:'userMessage',content:[{type:'text',text:record.marker}]}]}));
  const refreshed=await requestStatus({...c.input,refresh:true},c.dependencies);
  assert.equal(refreshed.status,'interrupted');assert.equal(refreshed.turnId,originalTurnId);
  assert.notEqual(refreshed.turnId,'unrelated-later-turn');
});

test('late queued completion can be refreshed without submitting again', async (t) => {
  const c = await context(t, 'queue-late');
  const result = await sendCodex({ ...c.input, timeoutMs: 5000 }, c.dependencies);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.submitted, true);
  await sendCodex(c.input, c.dependencies);
  assert.equal(c.counts().queueCalls, 1);
  await writeFile(path.join(c.directory, 'complete.flag'), 'ready');
  const refreshed = await requestStatus({ ...c.input, refresh: true }, c.dependencies);
  assert.equal(refreshed.status, 'completed');
  assert.equal(refreshed.answer, 'protocol-result-✓');
  assert.equal(c.counts().queueCalls, 1);
});

test('external timeout interrupts only its own turn, without resending', async (t) => {
  const c = await context(t, 'no-completion');
  const record = await sendCodex({ ...c.input, timeoutMs: 5000 }, c.dependencies);
  assert.equal(record.status, 'unconfirmed');
  assert.equal(record.interruptRequested, true);
  assert.equal(record.waitTimedOut,true);
  assert.equal(record.timeoutMs,5000);
  const calls = (await readFile(path.join(c.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.equal(calls.filter((call) => call.method === 'turn/interrupt').length, 1);
  const saved=path.join(c.directory,'turn.json');
  const interrupted={id:record.turnId,status:'interrupted',completedAt:null,
    items:[{type:'agentMessage',phase:'commentary',text:'unfinished progress'}]};
  await writeFile(saved,JSON.stringify(interrupted));
  assert.equal((await requestStatus({...c.input,refresh:true},c.dependencies)).status,'unconfirmed');
  await assert.rejects(claimThreadRequest(c.input.stateDir,{threadId:THREAD,requestId:'next'}),/unresolved/);
  const requestFile=path.join(c.input.stateDir,'requests',record.requestId,'record.json');
  for(const changes of [
    {route:'queue'}, {interruptRequested:false}, {turnId:'other-turn'},
  ]) {
    await writeFile(requestFile,JSON.stringify({...record,...changes}));
    await writeFile(saved,JSON.stringify({...interrupted,completedAt:123}));
    assert.equal((await requestStatus({...c.input,refresh:true},c.dependencies)).status,'unconfirmed');
  }
  for(const completedAt of [null,0,'123',-1]) {
    await writeFile(requestFile,JSON.stringify(record));
    await writeFile(saved,JSON.stringify({...interrupted,completedAt}));
    assert.equal((await requestStatus({...c.input,refresh:true},c.dependencies)).status,'unconfirmed');
  }
  await writeFile(requestFile,JSON.stringify({...record,unsupportedInteractions:['item/tool/call']}));
  await writeFile(saved,JSON.stringify({...interrupted,completedAt:123}));
  assert.equal((await requestStatus({...c.input,refresh:true},c.dependencies)).status,'blocked');
  await writeFile(requestFile,JSON.stringify(record));
  await writeFile(saved,JSON.stringify({...interrupted,completedAt:123}));
  const confirmed=await requestStatus({...c.input,refresh:true},c.dependencies);
  assert.equal(confirmed.status,'interrupted');assert.equal(confirmed.answer,null);assert.deepEqual(confirmed.answers,[]);
  await claimThreadRequest(c.input.stateDir,{threadId:THREAD,requestId:'next'});
  const repeated=await sendCodex(c.input,c.dependencies);
  assert.equal(repeated.status,'interrupted');assert.equal(repeated.deduplicated,true);
  const laterCalls=(await readFile(path.join(c.directory,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(laterCalls.filter(call=>call.method==='turn/start').length,1);
  assert.equal(laterCalls.filter(call=>call.method==='turn/interrupt').length,1);
});

test('unsupported host requests cannot produce a successful result', async (t) => {
  const c = await context(t, 'host-request');
  const record = await sendCodex(c.input, c.dependencies);
  assert.equal(record.status, 'blocked');
  assert.equal(record.submitted, true);
  assert.deepEqual(record.unsupportedInteractions, ['item/tool/call']);
  await writeFile(path.join(c.directory, 'turn.json'), JSON.stringify({ id: record.turnId,
    status: 'completed', completedAt: 123,
    items: [{ type: 'agentMessage', phase: 'final_answer', text: 'late response' }] }));
  const refreshed = await requestStatus({ ...c.input, refresh: true }, c.dependencies);
  assert.equal(refreshed.status, 'blocked');
  assert.equal(refreshed.error.code, 'HOST_INTERACTION_REQUIRED');
  assert.deepEqual(refreshed.unsupportedInteractions, ['item/tool/call']);
  assert.equal(refreshed.answer, 'late response');
});

test('malformed transport and initialization timeout are blocked before submission', async (t) => {
  for (const mode of ['malformed', 'no-initialize']) {
    const c = await context(t, mode);
    const record = await sendCodex({ ...c.input, timeoutMs: 120 }, c.dependencies);
    assert.equal(record.status, 'blocked');
    assert.equal(record.submitted, false);
  }
});

test('thread lock is exclusive, released explicitly, and not stolen', async (t) => {
  const c = await context(t);
  const release = await lockThread(c.input.stateDir, THREAD, performance.now() + 1000);
  assert.equal(await lockThread(c.input.stateDir, THREAD, performance.now() + 20), null);
  await release();
  const second = await lockThread(c.input.stateDir, THREAD, performance.now() + 1000);
  assert.equal(typeof second, 'function');
  await second();
});

test('concurrent identical requests reserve at most one sender', async (t) => {
  const c = await context(t);
  const results = await Promise.allSettled([sendCodex(c.input, c.dependencies), sendCodex(c.input, c.dependencies)]);
  assert.ok(results.some((result) => result.status === 'fulfilled' && result.value.status === 'completed'));
  assert.equal(c.counts().clients, 1);
});

test('different request IDs for one chat execute serially', async (t) => {
  const c = await context(t);
  const results = await Promise.all([
    sendCodex(c.input, c.dependencies),
    sendCodex({ ...c.input, requestId: 'request-2' }, c.dependencies),
  ]);
  assert.ok(results.every((record) => record.status === 'completed'));
  const methods = (await readFile(path.join(c.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).map((call) => call.method);
  const starts = methods.flatMap((method, index) => method === 'turn/start' ? [index] : []);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] > methods.indexOf('fixture/completed'));
});

test('CLI and filename validation reject ambiguous or unsafe input', () => {
  assert.throws(() => validateRequestId('../outside'), /request-id/);
  assert.throws(() => validateRequestId('CON.txt'), /reserved/);
  assert.throws(() => parseArgs(['send', '--thread', THREAD, '--thread', THREAD]), /Repeated/);
  assert.throws(() => parseArgs(['status', '--request-id', 'a', '--message', 'b']), /does not accept/);
  assert.equal(parseArgs(['send', '--thread', THREAD]).command, 'send');
});
