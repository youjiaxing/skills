import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function terminalSnapshot(turn,finalTexts) {
  if(!Number.isSafeInteger(turn?.completedAt) || turn.completedAt<=0) return null;
  if(turn.status==='completed') {
    const answers=finalTexts(turn).filter(text=>typeof text==='string' && text.trim());
    return answers.length ? {status:'completed',answers,answer:answers.join('\n\n'),error:null} : null;
  }
  if(['failed','interrupted'].includes(turn.status)) return {status:turn.status,answers:[],answer:null,
    error:{code:turn.status==='failed' ? 'TURN_FAILED' : 'TURN_INTERRUPTED',message:'Persisted terminal task status'}};
  return null;
}

// Observation has no total execution deadline. RPC and polling deadlines only
// bound individual checks; silence is never evidence of task failure.
export async function observeTurn({client,record,rpcTimeoutMs,pollMs=30000,findTurn,finalTexts,save}) {
  let fingerprint;
  for (;;) {
    if (client.unsupportedRequests.length) throw new Error('Host interaction required');
    if (client.failure) throw client.failure;
    if (client.stopped) throw new Error('App Server stopped');
    let turn;
    try {
      turn=await findTurn(client,record,()=>performance.now()+rpcTimeoutMs);
      delete record.lastObservationError;
    } catch(error) {
      if(error.code!=='RPC_TIMEOUT' || client.failure || client.stopped) throw error;
      record.lastObservationError='STATUS_QUERY_TIMEOUT';
    }
    if(client.unsupportedRequests.length) throw new Error('Host interaction required');
    record.lastObservedAt=new Date().toISOString();
    if(turn) {
      if(record.turnId && turn.id!==record.turnId) throw new Error('Turn identity mismatch');
      record.turnId=turn.id;
      const next=createHash('sha256').update(JSON.stringify(turn)).digest('hex');
      if(next!==fingerprint) {fingerprint=next;record.lastProgressAt=record.lastObservedAt;}
      record.observedTurnStatus=['completed','failed','interrupted','inProgress','running','pending'].includes(turn.status)
        ? turn.status : 'unknown';
      const terminal=terminalSnapshot(turn,finalTexts);
      if(terminal) {
        Object.assign(record,terminal);
        record.observationState=terminal.status;record.terminalConfirmedAt=record.lastObservedAt;
        await save();return;
      }
      record.observationState=turn.status==='completed' ? 'awaiting_final'
        : ['inProgress','running'].includes(turn.status) ? 'running' : 'unknown';
      record.status='waiting';
    } else record.observationState=record.turnId ? 'unknown' : 'queued';
    await save();
    // A completion event accelerates the next durable-state check. It never
    // substitutes for final text or permits an unrelated turn's response.
    const matches=event=>event.method==='turn/completed' && record.turnId &&
      event.params?.threadId===record.threadId && event.params?.turn?.id===record.turnId;
    if(record.turnId && !client.events.some(matches)) {
      try {await client.waitFor(matches,performance.now()+pollMs);}
      catch(error) {if(error.code!=='WAIT_TIMEOUT') throw error;}
    } else await delay(pollMs);
  }
}
