import { readFile, opendir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { outboundPaths, reconcileOutbound, submissionOutcome } from './outbound-core.mjs';
import { pushHealth, describePush } from './push-contract.mjs';
import { lockThread } from './state.mjs';
import { writeJournal } from './feishu-core.mjs';
import { createMessageRouter } from './message-routes.mjs';
import { routeFile } from './message-routes.mjs';
import { recoverAcknowledgedLock } from './state-recovery.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const read = async file => JSON.parse(await readFile(file,'utf8'));
const NOTICE = '这条通知送达时，追问暂不可用；请稍后再试。';

// Only reconciles durable receipts. It never invokes send/update on the original notification.
export async function processOutboundFollowUp({stateDir,appId,requestId,reply,health=pushHealth,now=Date.now}) {
  const paths=outboundPaths(stateDir,appId), file=paths.request(requestId);
  let record=await read(file);
  if (!record.requireFollowUp || !record.followUpPending || submissionOutcome(record)!=='sent') return record;
  for(const name of [`request-${hash(requestId)}`,`target-${hash(record.targetRequestId)}`]) await recoverAcknowledgedLock(paths.root,name);
  await recoverAcknowledgedLock(path.dirname(routeFile(stateDir,appId,record.chatId)),hash(record.chatId));
  let current;
  try { current=await read(paths.target(record.targetRequestId)); } catch(error) { if(error.code!=='ENOENT') throw error; }
  const revision=record.revision ?? (record.operation==='send' ? 1 : record.expectedRevision+1);
  const obsolete=current && current.lastRequestId!==requestId && current.revision>=revision;
  let repairError;
  if (!obsolete) {
    try { await reconcileOutbound({stateDir,appId,requestId}); }
    catch { repairError=true; }
  }
  const release=await lockThread(paths.root,`request-${hash(requestId)}`,performance.now()+1000);
  if (!release) return record;
  let releaseTarget;
  try {
    releaseTarget=await lockThread(paths.root,`target-${hash(record.targetRequestId)}`,performance.now()+1000);
    if (!releaseTarget) return record;
    record=await read(file);
    try { current=await read(paths.target(record.targetRequestId)); } catch(error) { if(error.code!=='ENOENT') throw error; }
    const superseded=current && current.lastRequestId!==requestId && current.revision>=revision;
    const startedNotice=record.followUpNotice && ['submitting','unknown','confirmed','needs_reconciliation'].includes(record.followUpNotice.state);
    if (superseded && !startedNotice) {
      record.followUpPending=false;record.followUpRecovery='superseded';
      await writeJournal(file,record);return record;
    }
    let runtime;
    try { runtime=await health({stateDir,appId,chatId:record.chatId,sourceThreadId:record.sourceThreadId}); }
    catch { runtime={state:'unavailable',reason:'health_unknown'}; }
    const route=await describePush(record,{stateDir,appId,outcome:'sent',health:async()=>runtime});
    const ready=!superseded && !repairError && runtime.state==='ready' && route.followUp.state==='ready';
    record.followUpHealth={...runtime,route:route.followUp.state,checkedAt:new Date(now()).toISOString()};
    record.followUpNextCheckAt=now()+30000;
    if (ready && !startedNotice) {
      record.followUpPending=false;
      record.followUpRecovery='ready';
      if (record.followUpNotice?.state==='pending') record.followUpNotice.state='cancelled';
      await writeJournal(file,record);return record;
    }
    record.followUpRecovery=repairError ? 'needs_reconciliation' : 'awaiting_availability';
    record.followUpNotice ??= {state:'pending',uuid:hash(`${appId}:${requestId}:followup-unavailable`).slice(0,32),text:NOTICE};
    const notice=record.followUpNotice;
    if (notice.state==='confirmed') {
      await createMessageRouter({stateDir,appId}).rememberReply({binding:{chatId:record.chatId}},
        {message_id:notice.messageId},{threadId:record.sourceThreadId,requestId:`${requestId}:followup-unavailable`});
      if(ready || superseded) { record.followUpPending=false;record.followUpRecovery=superseded?'superseded':'ready'; }
      await writeJournal(file,record);return record;
    }
    // Same frozen reply UUID is retried only inside Feishu's one-hour deduplication window.
    if (notice.firstSubmittedAt && now()-Date.parse(notice.firstSubmittedAt)>=3600000) {
      notice.state='needs_reconciliation';record.followUpRecovery='needs_reconciliation';await writeJournal(file,record);return record;
    }
    if (!reply) { await writeJournal(file,record);return record; }
    notice.firstSubmittedAt ??= new Date(now()).toISOString();
    notice.state='submitting';await writeJournal(file,record);
    try {
      const sent=await reply(record.acknowledgement?.messageId ?? record.messageId,notice.text,notice.uuid);
      if (!sent?.message_id) throw new Error('Missing notice receipt');
      notice.messageId=sent.message_id;notice.state='confirmed';await writeJournal(file,record);
      await createMessageRouter({stateDir,appId}).rememberReply({binding:{chatId:record.chatId}},sent,
        {threadId:record.sourceThreadId,requestId:`${requestId}:followup-unavailable`});
      if(ready || superseded) { record.followUpPending=false;record.followUpRecovery=superseded?'superseded':'ready'; }
    } catch { if (!notice.messageId) notice.state='unknown'; }
    await writeJournal(file,record);return record;
  } finally { if(releaseTarget) await releaseTarget();await release(); }
}

export function createOutboundFollowUps(options) {
  let directory,active,stopped=false,nextOpen=0;
  async function scan() {
    if (Date.now()<nextOpen) return;
    try { directory ??= await opendir(path.join(outboundPaths(options.stateDir,options.appId).root,'requests')); }
    catch(error) { if(error.code==='ENOENT') { nextOpen=Date.now()+5000;return; } throw error; }
    for(let i=0;i<64;i++) {
      const entry=await directory.read();
      if(!entry) { await directory.close();directory=undefined;nextOpen=Date.now()+1000;return; }
      if(!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const record=await read(path.join(outboundPaths(options.stateDir,options.appId).root,'requests',entry.name));
      if(record.followUpPending && (!record.followUpNextCheckAt || record.followUpNextCheckAt<=Date.now()) && submissionOutcome(record)==='sent') {
        await processOutboundFollowUp({...options,requestId:record.requestId});return;
      }
    }
  }
  return {
    tick() {
      if(stopped || active) return;
      active=scan().catch(()=>options.log?.({type:'outbound-followup-pending'})).finally(()=>{active=undefined;});
    },
    async stop() { stopped=true;await active;if(directory) await directory.close(); },
  };
}

export async function outboundFollowUpSummary({stateDir,appId}) {
  const summary={pending:0,needsReconciliation:0,requests:[]};
  let directory;
  try { directory=await opendir(path.join(outboundPaths(stateDir,appId).root,'requests')); }
  catch(error) { if(error.code==='ENOENT') return summary;throw error; }
  for await(const entry of directory) {
    if(!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const record=await read(path.join(outboundPaths(stateDir,appId).root,'requests',entry.name));
    if(!record.followUpPending) continue;
    summary.pending++;
    if(record.followUpRecovery==='needs_reconciliation') summary.needsReconciliation++;
    if(summary.requests.length<5) summary.requests.push({requestId:record.requestId,delivery:submissionOutcome(record),
      recovery:record.followUpRecovery ?? 'pending',notice:record.followUpNotice?.state});
  }
  return summary;
}
