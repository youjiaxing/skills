import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readRecord, reserveRecord, saveRecord, lockThread, resolveThreadRequest, claimThreadRequest, validateRequestId } from './state.mjs';
import { validateThreadId } from './codex.mjs';

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

export async function inspectT3Target(options, {run=runT3}={}) {
  try {
    const {code,data}=await run(options.t3Command,cliArgs(options,['thread','show',validateThreadId(options.threadId),'--messages','1','--json']),undefined,{timeoutMs:options.timeoutMs ?? 15000});
    if (code!==0 || data.thread?.threadId!==options.threadId || typeof data.thread.archived!=='boolean') return {state:'unknown'};
    return {state:data.thread.archived ? 'archived':'readable',threadId:options.threadId,transport:'t3'};
  } catch { return {state:'unknown'}; }
}

// Refresh is read-only. Only the latest exact run's terminal state is exposed by
// the CLI; a later run's completed state never proves this request completed.
export async function requestT3Status(options, {run=runT3}={}) {
  const record=await readRecord(options.stateDir,options.requestId);
  if (record.agent!=='t3') throw new Error('Request belongs to another transport');
  if (!options.refresh || !record.submitted || ['completed','failed','interrupted'].includes(record.status)) return record;
  try {
    const {code,data}=await run(record.t3Command,cliArgs(record,['thread','show',record.threadId,'--messages','1000','--json']),undefined,{timeoutMs:options.timeoutMs ?? 15000});
    if(code!==0 || data.thread?.threadId!==record.threadId || !Array.isArray(data.messages)) return record;
    const matches=data.messages.filter(m=>m.role==='user' && m.text===record.wireMessage);
    if(matches.length!==1 || !matches[0].runId) return record;
    const runId=matches[0].runId;
    record.turnId=runId;
    if(data.thread.latestRunId===runId && !data.thread.activeRunId) {
      const state=data.thread.status;
      const answer=data.messages.filter(m=>m.role==='assistant' && m.runId===runId).at(-1)?.text;
      if(state==='completed' && typeof answer==='string' && answer.trim()) {
        record.status='completed';record.answer=answer;record.error=null;
      } else if(['failed','interrupted','cancelled'].includes(state)) record.status=state==='cancelled'?'interrupted':state;
    }
    await saveRecord(options.stateDir,record);
  } catch { /* Unknown remains unknown; no resend. */ }
  return record;
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
    return {...record,deduplicated:true};
  }
  // Alias sources for the same target share one lock and unresolved-request gate.
  const gate={...record,threadId:`t3-${threadId}`};
  let release;
  try {
    release=await lockThread(input.stateDir,gate.threadId,performance.now()+30000);
    if(!release) throw new Error('T3 target busy');
    const prior=await resolveThreadRequest(input.stateDir,gate,id=>requestT3Status({stateDir:input.stateDir,requestId:id,refresh:true},{run}));
    if(prior.old?.submitted && !['completed','failed','interrupted'].includes(prior.old.status)) {
      record.status='blocked';record.error={code:'COMPLETION_UNCONFIRMED'};record.blockedByRequestId=prior.old.requestId;
      await saveRecord(input.stateDir,record);return record;
    }
    const target=await inspectT3Target({...input,threadId},{run});
    if(target.state!=='readable') {
      record.status='blocked';record.error={code:target.state==='archived'?'TARGET_ARCHIVED':'TARGET_UNKNOWN'};
      await saveRecord(input.stateDir,record);return record;
    }
    await claimThreadRequest(input.stateDir,gate);
    // Persist uncertainty BEFORE the non-idempotent CLI call. A lost receipt
    // must block both repeated IDs and new IDs for this target.
    record.submitted=true;record.status='unconfirmed';await saveRecord(input.stateDir,record);
    const {data}=await run(input.t3Command,cliArgs(input,['thread','send',threadId,'-','--wait','--json']),record.wireMessage);
    if(data.threadId!==threadId || typeof data.runId!=='string') throw new Error('T3 receipt identity unavailable');
    record.turnId=data.runId;
    if(data.status==='completed' && typeof data.reply==='string' && data.reply.trim()) {
      record.status='completed';record.answer=data.reply;
    } else if(['failed','interrupted','cancelled'].includes(data.status)) {
      record.status=data.status==='cancelled'?'interrupted':data.status;
      record.error={code:record.status==='failed'?'TURN_FAILED':'TURN_INTERRUPTED'};
    } else record.error={code:'COMPLETION_UNCONFIRMED'};
  } catch {
    record.status=record.submitted?'unconfirmed':'blocked';record.error={code:record.submitted?'COMPLETION_UNCONFIRMED':'NOT_SUBMITTED'};
  } finally { if(release) await release(); }
  await saveRecord(input.stateDir,record);
  return record;
}
