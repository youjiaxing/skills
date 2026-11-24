import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readRecord, reserveRecord, saveRecord, validateRequestId } from './state.mjs';
import { validateThreadId } from './codex.mjs';
import { createT3Reader } from './t3-reader.mjs';

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);

// The CLI owns local authentication. Never read, log, or persist its credentials.
export function runT3(command, args, message, {timeoutMs,signal}={}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command[0], [...command.slice(1), ...args], {
      shell:false, windowsHide:true, stdio:['pipe','pipe','pipe'],
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1',T3CODE_DESKTOP_CLI_LAUNCHER:'1'},
    });
    let output='', failed=false;
    const timer=timeoutMs ? setTimeout(()=>{child.kill();reject(new Error('T3 read timeout'));},timeoutMs) : undefined;
    const onAbort = () => {child.kill();reject(new Error('T3 request observation stopped'));};
    signal?.addEventListener('abort',onAbort,{once:true});
    timer?.unref();
    child.on('error', () => {clearTimeout(timer);reject(new Error('T3 CLI unavailable'));});
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stderr.resume(); // Raw CLI errors can include private local state.
    child.stdout.on('data', bytes => {
      output += bytes.toString('utf8');
      if (Buffer.byteLength(output)>16*1024*1024) {failed=true;child.kill();}
    });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort',onAbort);
      if (failed) return reject(new Error('T3 CLI response exceeded limit'));
      try { resolve({code,data:JSON.parse(output)}); }
      catch {
        if (args[0] === 'auth' && args[2] === 'revoke' && code === 0) resolve({code,data:null});
        else reject(new Error('T3 CLI response unavailable'));
      }
    });
    child.stdin.end(message ?? '');
  });
}

function cliArgs(record, args) {
  return [...args,...(record.t3BaseDir ? ['--base-dir',record.t3BaseDir] : [])];
}

function isTerminal(status) {
  return TERMINAL.has(status);
}

function isExplicitFinalMessage(message) {
  return message?.phase === 'final_answer' || message?.phase === 'final' ||
    message?.isFinal === true || message?.final === true || message?.finalAnswer === true;
}

// Callers pass only runs already confirmed completed. Providers that label
// assistant phases (Codex: commentary/final_answer) must supply a final message;
// phased progress alone stays unconfirmed. Providers without phase labels (ACP,
// Claude) persist progress and answer alike, so the last message of the
// completed run is its answer.
export function selectT3FinalAnswer(messages, runId) {
  if (!Array.isArray(messages)) return null;
  const candidates = messages.filter(message =>
    message?.role === 'assistant' && message.runId === runId &&
    (message.streaming === undefined || message.streaming === false) &&
    typeof message.text === 'string' && message.text.trim());
  const order = message => Number.isInteger(message.sequence) ? message.sequence : (Date.parse(message.createdAt) || 0);
  const ordered = [...candidates].sort((a, b) => order(a) - order(b));
  const explicit = ordered.filter(isExplicitFinalMessage);
  if (explicit.length) return explicit.at(-1).text;
  if (ordered.some(message => typeof message.phase === 'string' && message.phase)) return null;
  return ordered.length ? ordered.at(-1).text : null;
}

function harvestFromMessages(record, messages) {
  if (!Array.isArray(messages)) return { matches: 0 };
  const matches = messages.filter(m => m.role === 'user' && m.text === record.wireMessage);
  if (matches.length !== 1 || !matches[0].runId) return { matches: matches.length };
  const runId = matches[0].runId;
  const answer = selectT3FinalAnswer(messages, runId);
  return { matches: 1, runId, answer: typeof answer === 'string' && answer.trim() ? answer : null };
}

// Marker identity only. A later run's reply never becomes this request's answer.
export function applyT3Snapshot(record, data) {
  if (!data?.thread || data.thread.threadId !== record.threadId) return record;
  const harvest = harvestFromMessages(record, data.messages);
  if (harvest.matches === 1 && (!record.turnId || record.turnId === harvest.runId)) record.turnId = harvest.runId;
  const identityMatches = harvest.matches === 1 && (!record.turnId || record.turnId === harvest.runId);
  const latestIsThisRun = data.thread.latestRunId === record.turnId;
  const runIsIdle = !data.thread.activeRunId;
  const runIsComplete = data.thread.status === 'completed' && latestIsThisRun && runIsIdle;
  if (identityMatches && harvest.answer && runIsComplete) {
    record.status = 'completed';
    record.answer = harvest.answer;
    record.error = null;
    return record;
  }
  if (identityMatches && latestIsThisRun && runIsIdle) {
    if (['failed', 'interrupted', 'cancelled'].includes(data.thread.status)) {
      record.status = data.thread.status === 'cancelled' ? 'interrupted' : data.thread.status;
      record.error = { code: record.status === 'failed' ? 'TURN_FAILED' : 'TURN_INTERRUPTED' };
      return record;
    }
    // A completed thread without a matching final answer is still ambiguous.
    // Keep it observable and recoverable instead of inventing a failure.
  }
  return record;
}

async function showThread(run, record, { messages = 1000, timeoutMs = 15000 } = {}) {
  const { code, data } = await run(record.t3Command, cliArgs(record, ['thread', 'show', record.threadId, '--messages', String(messages), '--json']), undefined, { timeoutMs });
  if (code !== 0 || data.thread?.threadId !== record.threadId) return null;
  return data;
}

export async function inspectT3Target(options, {run=runT3}={}) {
  try {
    const data = await showThread(run, { t3Command: options.t3Command, t3BaseDir: options.t3BaseDir, threadId: validateThreadId(options.threadId) }, { messages: 1, timeoutMs: options.timeoutMs ?? 15000 });
    if (!data || typeof data.thread.archived !== 'boolean') return { state: 'unknown' };
    return { state: data.thread.archived ? 'archived' : 'readable', threadId: options.threadId, transport: 't3', latestRunId: data.thread.latestRunId ?? null };
  } catch { return { state: 'unknown' }; }
}

const readProjection = createT3Reader({run:runT3});

export function applyT3Projection(record, projection) {
  if (projection?.thread?.id !== record.threadId) return record;
  const matches = projection.messages.filter(m => m.role === 'user' && m.text === record.wireMessage);
  if (!record.turnId && matches.length === 1 && matches[0].runId) record.turnId = matches[0].runId;
  if (!record.turnId) { record.observationState = 'unknown'; return record; }
  if (matches.length && !matches.some(m => m.runId === record.turnId)) {
    record.observationState = 'identity_conflict'; return record;
  }
  const run = projection.runs.find(run => run.id === record.turnId && run.threadId === record.threadId);
  if (!run) { record.observationState = 'unknown'; return record; }
  const ended = Number.isFinite(Date.parse(run.completedAt));
  if (ended && ['failed','interrupted','cancelled','rolled_back'].includes(run.status)) {
    record.status = run.status === 'failed' ? 'failed' : 'interrupted';
    record.error = {code:record.status === 'failed' ? 'TURN_FAILED' : 'TURN_INTERRUPTED'};
  } else if (ended && run.status === 'completed') {
    const answer = selectT3FinalAnswer(
      projection.messages.filter(m => m.threadId === record.threadId), run.id);
    if (typeof answer === 'string' && answer.trim()) {
      record.status = 'completed'; record.answer = answer; record.error = null;
    } else { record.status = 'unconfirmed'; record.observationState = 'awaiting_final'; return record; }
  } else {
    record.status = ['queued','preparing','starting'].includes(run.status) ? 'queued' : ['running','waiting'].includes(run.status) ? run.status : 'unconfirmed';
    if (record.status !== 'unconfirmed') record.error = record.status === 'waiting' ? {code:'HOST_INTERACTION_REQUIRED'} : null;
  }
  record.observationState = record.status;
  return record;
}

export async function requestT3Status(options, {run=runT3, projectionReader = run === runT3 ? readProjection : null}={}) {
  const record=await readRecord(options.stateDir,options.requestId);
  if (record.agent!=='t3') throw new Error('Request belongs to another transport');
  const recoverable = record.status === 'failed' && record.error?.code === 'NO_FINAL_REPLY';
  if (!options.refresh || !record.submitted || (isTerminal(record.status) && !recoverable)) return record;
  record.lastObservedAt = new Date().toISOString();
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  try {
    let projection;
    if (projectionReader) {
      try { projection = await projectionReader(record,{timeoutMs:options.timeoutMs ?? 15000}); }
      catch { record.lastObservationError = 'RUN_QUERY_UNAVAILABLE'; }
    }
    if (projection) applyT3Projection(record, projection);
    else if (Date.now() < deadline) {
      const data = await showThread(run, record, { timeoutMs: deadline - Date.now() });
      if (data && Array.isArray(data.messages)) applyT3Snapshot(record, data);
    }
    if (projection) delete record.lastObservationError;
  } catch { record.lastObservationError = 'STATUS_QUERY_UNAVAILABLE'; }
  await saveRecord(options.stateDir, record);
  return record;
}

function applySendReceipt(record, data, threadId) {
  if (data.threadId !== threadId || typeof data.runId !== 'string') throw new Error('T3 receipt identity unavailable');
  record.turnId = data.runId;
  if (data.status === 'completed' && typeof data.reply === 'string' && data.reply.trim()) {
    record.status = 'completed';
    record.answer = data.reply;
    record.error = null;
  } else if (['failed', 'interrupted', 'cancelled'].includes(data.status)) {
    record.status = data.status === 'cancelled' ? 'interrupted' : data.status;
    record.error = { code: record.status === 'failed' ? 'TURN_FAILED' : 'TURN_INTERRUPTED' };
  } else {
    record.status = data.delivery === 'queued' ? 'queued' : 'submitted';
    record.delivery = data.delivery;
    record.error = null;
  }
}

export async function sendT3(input, {run=runT3}={}) {
  const threadId=validateThreadId(input.agentTarget.threadId),requestId=validateRequestId(input.requestId);
  if(typeof input.message!=='string' || !input.message.trim()) throw new Error('Empty message');
  const inputHash=createHash('sha256').update(JSON.stringify({agent:'t3',threadId,message:input.message})).digest('hex');
  const marker=`[yjx-feishu-agent:${randomUUID()}]`;
  const {fresh,record}=await reserveRecord(input.stateDir,{version:1,agent:'t3',requestId,threadId,inputHash,marker,
    wireMessage:`${marker}\n${input.message}`,t3Command:input.t3Command,t3BaseDir:input.t3BaseDir,
    status:'waiting',submitted:false,route:'t3',turnId:null,answer:null,createdAt:new Date().toISOString()});
  if(!fresh) {
    if(record.inputHash!==inputHash || record.agent!=='t3') throw new Error('Request ID belongs to different input');
    return {...record,deduplicated:true,releasedPriors:[]};
  }
  const timeoutMs=input.timeoutMs ?? 15000;
  const deadline = Date.now() + timeoutMs;
  try {
    const target=await inspectT3Target({...input,threadId,timeoutMs},{run});
    if(target.state!=='readable') {
      record.status='blocked';record.error={code:target.state==='archived'?'TARGET_ARCHIVED':'TARGET_UNKNOWN'};
      await saveRecord(input.stateDir,record);
      return {...record,releasedPriors:[]};
    }
    input.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('T3 submission deadline exceeded');
    record.baselineLatestRunId = target.latestRunId ?? null;
    record.submitted=true;record.status='submitted';await saveRecord(input.stateDir,record);
    try {
      const {data}=await run(input.t3Command,cliArgs(input,['thread','send',threadId,'-','--json']),record.wireMessage,{timeoutMs:Math.max(1,deadline-Date.now()),signal:input.signal});
      applySendReceipt(record, data, threadId);
    } catch {
      record.status='unconfirmed';
      record.error={code:'COMPLETION_UNCONFIRMED'};
    }
    await saveRecord(input.stateDir,record);
    return {...record,releasedPriors:[]};
  } catch (error) {
    record.status=record.submitted?'unconfirmed':'blocked';
    record.error={code:record.submitted?'COMPLETION_UNCONFIRMED':'NOT_SUBMITTED'};
    await saveRecord(input.stateDir,record);
    return {...record,releasedPriors:[]};
  }
}
