import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_PAGES = 40;

const itemTime = item => item.completedAt ?? item.updatedAt ?? item.startedAt ?? null;
const timeValue = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; };

function isTargetUserItem(item, record) {
  if (item?.type !== 'user_message') return false;
  return record.turnId ? item.runId === record.turnId : item.text === record.wireMessage;
}

const HISTORY_CLOCK_SLACK_MS = 10 * 60 * 1000;

// Runs older than the bounded window are not listed with a status. The window
// always includes queued and active runs, so an absent run has ended; infer its
// end state from its last top-level item. Nested or recoverable error items
// (parentItemId set, or followed by more work) do not mark the run failed.
function inferOlderRun(record, runId, items, windowRuns) {
  const own = items.filter(item => item.runId === runId);
  if (!own.length) return null;
  const lastOwn = Math.max(...own.map(item => timeValue(itemTime(item)) ?? 0));
  const later = windowRuns.some(run => {
    const started = timeValue(run.startedAt ?? run.requestedAt);
    return started !== null && started >= lastOwn;
  });
  if (!later) return null;
  const last = own.filter(item => item.parentItemId == null && item.type !== 'checkpoint').at(-1);
  const interrupted = own.some(item => item.type === 'run_interrupt_result' && item.status === 'interrupted') ||
    (last?.type === 'error' && last.status === 'interrupted');
  const failed = last?.type === 'error' && last.status === 'failed';
  return { id: runId, threadId: record.threadId, status: interrupted ? 'interrupted' : failed ? 'failed' : 'completed',
    completedAt: new Date(lastOwn).toISOString(), inferred: true };
}

// T3 hides every item of rolled-back runs and of cancelled queued turns. A
// submitted run absent from the window whose items are missing from all history
// since submission, while a later run has started, was cancelled or rolled back.
function inferHiddenRun(record, runId, windowRuns, historyExhausted) {
  const submitted = timeValue(record.createdAt);
  if (!historyExhausted || submitted === null) return null;
  const later = windowRuns.map(run => timeValue(run.startedAt ?? run.requestedAt)).filter(time => time !== null && time >= submitted);
  if (!later.length) return null;
  return { id: runId, threadId: record.threadId, status: 'cancelled', completedAt: new Date(Math.min(...later)).toISOString(), inferred: true };
}

// Normalize turn items into the run/message shape consumed by applyT3Projection.
// Turn items keep assistant `phase`, which the full snapshot's messages omit.
export function normalizeT3Items(record, windowRuns, items, {historyExhausted = false} = {}) {
  const messages = [];
  items.forEach((item, sequence) => {
    if (item.type !== 'user_message' && item.type !== 'assistant_message') return;
    if (typeof item.text !== 'string') return;
    messages.push({ threadId: item.threadId ?? record.threadId, runId: item.runId,
      role: item.type === 'user_message' ? 'user' : 'assistant', text: item.text,
      streaming: item.streaming === true || item.status === 'running', phase: item.phase,
      createdAt: item.startedAt ?? item.completedAt ?? item.updatedAt, sequence });
  });
  const runs = windowRuns.filter(run => run.threadId === record.threadId);
  const targetRunId = record.turnId ?? items.find(item => isTargetUserItem(item, record))?.runId;
  if (targetRunId && !runs.some(run => run.id === targetRunId)) {
    const inferred = inferOlderRun(record, targetRunId, items, runs) ??
      (record.turnId && !items.some(item => item.runId === targetRunId) ? inferHiddenRun(record, targetRunId, runs, historyExhausted) : null);
    if (inferred) runs.push(inferred);
  }
  return { thread: { id: record.threadId }, runs, messages };
}

// Use the public read API and a short-lived least-privilege session. Tokens
// stay in memory; compiled application modules and auth databases are not APIs.
// Read only the bounded recent window and page back through history to the
// target run, so the size of the whole thread never limits observation.
export function createT3Reader({run, fetchImpl = fetch, readRuntime = async file => JSON.parse(await readFile(file,'utf8')),
  now = Date.now, maxPages = MAX_HISTORY_PAGES, maxTotalBytes = MAX_TOTAL_BYTES} = {}) {
  const cache = new Map();
  return async function readProjection(record, {timeoutMs = 15000} = {}) {
    const baseDir = record.t3BaseDir ?? process.env.T3CODE_HOME ?? path.join(os.homedir(),'.t3');
    const key = JSON.stringify([record.t3Command,baseDir,record.threadId,record.turnId ?? record.wireMessage ?? null]);
    const previous = cache.get(key);
    if (previous && (previous.pending || previous.expires > now())) return previous.promise;
    const deadline = now() + timeoutMs;
    const remaining = () => Math.max(1,deadline - now());
    const promise = (async () => {
      let session;
      const extra = ['--base-dir',baseDir];
      try {
        const runtime = await readRuntime(path.join(baseDir,'userdata','server-runtime.json'));
        const origin = new URL(runtime.origin);
        if (!['http:','https:'].includes(origin.protocol) || !['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) throw new Error('T3 local runtime unavailable');
        const issued = await run(record.t3Command,
          ['auth','session','issue','--scope','orchestration:read','--ttl','1m','--label','yjx-feishu-observer','--json',...extra], undefined, {timeoutMs:remaining()});
        session = issued.data;
        if (issued.code !== 0 || !session?.token || !session.sessionId) throw new Error('T3 read session unavailable');
        let totalBytes = 0;
        const getJson = async url => {
          if (now() >= deadline) throw new Error('T3 run query deadline exceeded');
          const response = await fetchImpl(url, {
            headers:{Authorization:`Bearer ${session.token}`,'x-t3-orchestration-protocol':'2'},
            signal:AbortSignal.timeout(remaining()), redirect:'error',
          });
          if (!response.ok) throw new Error('T3 run query unavailable');
          let bytes = 0;
          const chunks = [];
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES || totalBytes + bytes > maxTotalBytes) {
              await response.body.cancel?.().catch(()=>{});
              throw new Error('T3 run query exceeded limit');
            }
            chunks.push(Buffer.from(chunk));
          }
          totalBytes += bytes;
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        };
        const threadPath = `/api/orchestration/threads/${encodeURIComponent(record.threadId)}`;
        const bounded = await getJson(new URL(`${threadPath}/bounded`,origin));
        const projection = bounded?.projection;
        if (projection?.thread?.id !== record.threadId || !Array.isArray(projection.runs) || !Array.isArray(projection.turnItems)) throw new Error('T3 run query identity unavailable');
        const windowRuns = projection.runs;
        const target = record.turnId ? windowRuns.find(item => item.id === record.turnId) : null;
        let items = [...projection.turnItems];
        // Items are needed only to identify the request or read a completed run's
        // answer; failed, interrupted, cancelled and rolled-back runs end on status.
        const needsItems = !target || (target.status === 'completed' && Number.isFinite(Date.parse(target.completedAt)));
        // The request's items cannot predate its submission; stop paging there.
        const submitted = timeValue(record.createdAt);
        const floor = submitted === null ? null : submitted - HISTORY_CLOCK_SLACK_MS;
        let cursor = bounded.hasMoreHistory ? bounded.historyCursor : null;
        let pages = 0;
        let historyExhausted = !cursor;
        while (needsItems && !items.some(item => isTargetUserItem(item, record)) && cursor) {
          if (pages >= maxPages) throw new Error('T3 run history budget exhausted');
          const page = await getJson(new URL(`${threadPath}/history?cursor=${encodeURIComponent(cursor)}`,origin));
          pages++;
          if (!Array.isArray(page?.items)) throw new Error('T3 run history unavailable');
          const seen = new Set(items.map(item => item.id));
          const older = page.items.map(entry => entry?.item).filter(item => item && item.threadId === record.threadId && !seen.has(item.id));
          items = [...older, ...items];
          cursor = page.hasMoreHistory ? page.nextCursor : null;
          // Pages prepend the interrupt requests behind their results; those can be far older.
          const oldest = older.filter(item => item.type !== 'run_interrupt_request')
            .map(item => timeValue(item.startedAt ?? itemTime(item))).filter(time => time !== null);
          if (!cursor || (floor !== null && oldest.length && Math.min(...oldest) < floor)) { historyExhausted = true; cursor = null; }
        }
        return normalizeT3Items(record, windowRuns, items, {historyExhausted});
      } finally {
        if (session?.sessionId) {
          try { await run(record.t3Command,['auth','session','revoke',session.sessionId,...extra],undefined,{timeoutMs:3000}); }
          catch { /* The read-only token also expires after one minute. */ }
        }
      }
    })();
    const entry={promise,expires:now()+2000,pending:true};
    cache.set(key,entry);
    try { return await promise; }
    catch { cache.delete(key); throw new Error('T3 run observation unavailable'); }
    finally {
      entry.pending=false; entry.expires=now()+2000;
      for (const [key,value] of cache) if (value.expires < now()) cache.delete(key);
      while(cache.size>16) cache.delete(cache.keys().next().value);
    }
  };
}
