import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readRecord, reserveRecord, saveRecord, lockThread, resolveThreadRequest, claimThreadRequest, validateRequestId } from './state.mjs';
import { validateThreadId } from './codex.mjs';

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);

// The CLI owns local authentication. Never read, log, or persist its credentials.
export function runT3(command, args, message, {timeoutMs}={}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      shell:false, windowsHide:true, stdio:['pipe','pipe','pipe'],
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1',T3CODE_DESKTOP_CLI_LAUNCHER:'1'},
    });
    let output='', failed=false;
    const timer=timeoutMs ? setTimeout(()=>{child.kill();reject(new Error('T3 read timeout'));},timeoutMs) : undefined;
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
      if (failed) return reject(new Error('T3 CLI response exceeded limit'));
      try { resolve({code,data:JSON.parse(output)}); }
      catch { reject(new Error('T3 CLI response unavailable')); }
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

function laterWorkStarted(record, thread) {
  const latest = thread?.latestRunId ?? null;
  if (record.turnId) return Boolean(latest && latest !== record.turnId);
  if (!latest || record.baselineLatestRunId == null) return false;
  return latest !== record.baselineLatestRunId;
}

function harvestFromMessages(record, messages) {
  if (!Array.isArray(messages)) return { matches: 0 };
  const matches = messages.filter(m => m.role === 'user' && m.text === record.wireMessage);
  if (matches.length !== 1 || !matches[0].runId) return { matches: matches.length };
  const runId = matches[0].runId;
  const answer = messages.filter(m => m.role === 'assistant' && m.runId === runId).at(-1)?.text;
  return { matches: 1, runId, answer: typeof answer === 'string' && answer.trim() ? answer : null };
}

function failWithoutReply(record) {
  record.status = 'failed';
  record.error = { code: 'NO_FINAL_REPLY' };
  return record;
}

function rememberReleased(list, prior) {
  if (!prior?.requestId || prior.status !== 'completed' || typeof prior.answer !== 'string' || !prior.answer.trim()) return;
  if (list.some(item => item.requestId === prior.requestId)) return;
  list.push({ requestId: prior.requestId, status: prior.status, answer: prior.answer });
}

// Marker identity only. A later run's reply never becomes this request's answer.
export function applyT3Snapshot(record, data) {
  if (!data?.thread || data.thread.threadId !== record.threadId) return record;
  const harvest = harvestFromMessages(record, data.messages);
  if (harvest.matches === 1) record.turnId = harvest.runId;
  if (harvest.matches === 1 && harvest.answer) {
    record.status = 'completed';
    record.answer = harvest.answer;
    record.error = null;
    return record;
  }
  const latest = data.thread.latestRunId ?? null;
  const active = data.thread.activeRunId ?? null;
  const state = data.thread.status;
  if (harvest.matches === 1 && latest === harvest.runId && !active) {
    if (['failed', 'interrupted', 'cancelled'].includes(state)) {
      record.status = state === 'cancelled' ? 'interrupted' : state;
      record.error = { code: record.status === 'failed' ? 'TURN_FAILED' : 'TURN_INTERRUPTED' };
      return record;
    }
    if (state === 'completed') return failWithoutReply(record);
  }
  if (laterWorkStarted(record, data.thread)) return failWithoutReply(record);
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

export async function requestT3Status(options, {run=runT3}={}) {
  const record=await readRecord(options.stateDir,options.requestId);
  if (record.agent!=='t3') throw new Error('Request belongs to another transport');
  if (!options.refresh || !record.submitted || isTerminal(record.status)) return record;
  try {
    const data = await showThread(run, record, { timeoutMs: options.timeoutMs ?? 15000 });
    if (!data || !Array.isArray(data.messages)) return record;
    applyT3Snapshot(record, data);
    await saveRecord(options.stateDir, record);
  } catch { /* Unknown remains unknown; no resend. */ }
  return record;
}

async function observeUntilTerminal(stateDir, record, run, { pollMs, timeoutMs } = {}) {
  const interval = Number.isSafeInteger(pollMs) && pollMs >= 0 ? pollMs : 1000;
  while (!isTerminal(record.status)) {
    try {
      const data = await showThread(run, record, { timeoutMs: timeoutMs ?? 15000 });
      if (data && Array.isArray(data.messages)) {
        applyT3Snapshot(record, data);
        await saveRecord(stateDir, record);
      }
    } catch { /* Keep observing; a failed show is not a terminal state. */ }
    if (isTerminal(record.status)) break;
    if (interval > 0) await delay(interval);
  }
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
    record.error = { code: 'COMPLETION_UNCONFIRMED' };
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
  const gate={...record,threadId:`t3-${threadId}`};
  const releasedPriors=[];
  const pollMs=input.pollMs;
  const timeoutMs=input.timeoutMs ?? 15000;
  for (;;) {
    let release;
    try {
      release=await lockThread(input.stateDir,gate.threadId,performance.now()+30000);
      if(!release) throw new Error('T3 target busy');
      const prior=await resolveThreadRequest(input.stateDir,gate,id=>requestT3Status({stateDir:input.stateDir,requestId:id,refresh:true,timeoutMs},{run}));
      rememberReleased(releasedPriors, prior.old);
      if(prior.old?.submitted && !isTerminal(prior.old.status)) {
        await release();
        release=undefined;
        await observeUntilTerminal(input.stateDir, prior.old, run, { pollMs, timeoutMs });
        rememberReleased(releasedPriors, prior.old);
        continue;
      }
      const target=await inspectT3Target({...input,threadId,timeoutMs},{run});
      if(target.state!=='readable') {
        record.status='blocked';record.error={code:target.state==='archived'?'TARGET_ARCHIVED':'TARGET_UNKNOWN'};
        await saveRecord(input.stateDir,record);
        return {...record,releasedPriors};
      }
      record.baselineLatestRunId = target.latestRunId ?? null;
      await claimThreadRequest(input.stateDir,gate);
      record.submitted=true;record.status='unconfirmed';await saveRecord(input.stateDir,record);
      try {
        const {data}=await run(input.t3Command,cliArgs(input,['thread','send',threadId,'-','--wait','--json']),record.wireMessage);
        applySendReceipt(record, data, threadId);
      } catch {
        record.status=record.submitted?'unconfirmed':'blocked';
        record.error={code:record.submitted?'COMPLETION_UNCONFIRMED':'NOT_SUBMITTED'};
      }
      await saveRecord(input.stateDir,record);
      await release();
      release=undefined;
      if (!isTerminal(record.status) && record.submitted) {
        await observeUntilTerminal(input.stateDir, record, run, { pollMs, timeoutMs });
      }
      return {...record,releasedPriors};
    } catch (error) {
      if (record.submitted && !isTerminal(record.status)) {
        if (release) { await release(); release=undefined; }
        await observeUntilTerminal(input.stateDir, record, run, { pollMs, timeoutMs });
        if (isTerminal(record.status)) return {...record,releasedPriors};
      }
      record.status=record.submitted?'unconfirmed':'blocked';
      record.error={code:record.submitted?'COMPLETION_UNCONFIRMED':'NOT_SUBMITTED', ...(error?.message ? { message: error.message } : {})};
      await saveRecord(input.stateDir,record);
      return {...record,releasedPriors};
    } finally {
      if (release) await release();
    }
  }
}
