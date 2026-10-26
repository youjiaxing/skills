import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServer, resolveCodex, RpcError, runQueue, timeLeft } from './app-server.mjs';
import { claimThreadRequest, lockThread, readRecord, reserveRecord, resolveThreadRequest, saveRecord, validateRequestId } from './state.mjs';
import { readTarget } from './target.mjs';
import { observeTurn, terminalSnapshot } from './turn-observer.mjs';

export function validateThreadId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '')) {
    throw new Error('thread must be an existing Codex chat UUID');
  }
  return value.toLowerCase();
}

export function defaultStateDir(env = process.env) {
  return path.resolve(env.YJX_FEISHU_AGENT_HOME || path.join(os.homedir(), '.yjx-feishu-agent'));
}

function inputHash(threadId, message) {
  return createHash('sha256').update(JSON.stringify({ agent: 'codex', threadId, message })).digest('hex');
}

export function finalTexts(turn) {
  const items = turn.items ?? [];
  const explicit = items.filter((item) => item.type === 'agentMessage' && item.phase === 'final_answer')
    .map((item) => item.text ?? '');
  if (explicit.length) return explicit;
  // Desktop persisted history can omit phase. Never infer completion from text alone.
  const last = items.at(-1);
  if (turn.status === 'completed' && turn.completedAt != null &&
      last?.type === 'agentMessage' && last.phase == null &&
      typeof last.text === 'string' && last.text.trim()) return [last.text];
  return [];
}

function hasMarker(turn, marker) {
  return (turn.items ?? []).some((item) => item.type === 'userMessage' &&
    (item.content ?? []).some((part) => part.type === 'text' && part.text?.includes(marker)));
}

async function findTurn(client, record, deadline) {
  let cursor;
  const matches = [];
  const seen = new Set();
  for (let page = 0; page < 100; page += 1) {
    const params = { threadId: record.threadId, limit: 100, sortDirection: 'desc', itemsView: 'full' };
    if (cursor) params.cursor = cursor;
    const result = await client.call('thread/turns/list', params, typeof deadline==='function' ? deadline() : deadline);
    for (const turn of result.data) {
      if (record.turnId ? turn.id === record.turnId : hasMarker(turn, record.marker)) matches.push(turn);
      if (matches.length > 1) throw new Error('Ambiguous correlation: more than one turn matches this request');
    }
    const reachedBaseline = !record.turnId && record.baselineTurnId && result.data.some((turn) => turn.id === record.baselineTurnId);
    if (record.turnId && matches.length) return matches[0];
    if (reachedBaseline || !result.nextCursor) return matches[0] ?? null;
    if (seen.has(result.nextCursor)) throw new Error('History cursor did not advance');
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error('History pagination limit reached; completion remains unconfirmed');
}

function applyPersistedTurn(record, turn) {
  if (!turn) return;
  const knownTurnId=record.turnId;
  record.turnId = turn.id;
  const texts = finalTexts(turn);
  if (record.unsupportedInteractions?.length) {
    record.status = 'blocked';
    record.answers = texts;
    record.answer = texts.length ? texts.join('\n\n') : null;
    return; // A later assistant response does not supply the rejected host capability.
  }
  if(record.waitMode==='state') {
    const terminal=terminalSnapshot(turn,finalTexts);
    if(terminal) {
      Object.assign(record,terminal);
      record.observationState=terminal.status;record.terminalConfirmedAt=new Date().toISOString();
    }
    return;
  }
  // Our interrupt acknowledgement alone is not terminal proof. Require a
  // matching persisted turn with an explicit completion timestamp as well.
  if (record.route==='app-server' && record.interruptRequested===true && knownTurnId===turn.id &&
    turn.status==='interrupted' && Number.isSafeInteger(turn.completedAt) && turn.completedAt>0) {
    record.status='interrupted';
    record.answer=null;record.answers=[];
    record.terminalConfirmedAt=new Date().toISOString();
    return;
  }
  // An independent reader can transiently see interrupted + completedAt=null.
  if (turn.status === 'completed' && turn.completedAt != null && texts.length) {
    record.status = 'completed';
    record.answers = texts;
    record.answer = texts.join('\n\n');
    record.error = null;
  }
}

function optionsFor(input) {
  const timeoutMs = input.timeoutMs ?? 180000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) {
    throw new Error('timeout-ms must be an integer between 1 and 86400000');
  }
  const waitMode=input.waitMode ?? 'deadline';
  if(!['deadline','state'].includes(waitMode)) throw new Error('Unknown waitMode');
  return { ...input,waitMode, timeoutMs, cwd: path.resolve(input.cwd ?? process.cwd()),
    stateDir: path.resolve(input.stateDir ?? defaultStateDir()),
    codex: input.codex ?? process.env.CODEX_CLI_PATH ?? 'codex' };
}

async function observeQueued(client, record, options, deadline) {
  while (performance.now() < deadline) {
    applyPersistedTurn(record, await findTurn(client, record, deadline));
    await saveRecord(options.stateDir, record);
    if (record.status === 'completed') return;
    await delay(Math.min(options.pollMs ?? 500, timeLeft(deadline)));
  }
  throw new Error('Queued request completion remains unconfirmed');
}

async function execute(client, record, message, options, deadline, dependencies) {
  const rpcDeadline=()=>options.waitMode==='state' ? performance.now()+options.timeoutMs : deadline;
  record.target = await readTarget(client, record.threadId, rpcDeadline());
  if (record.target.state === 'archived' && options.autoUnarchive === true) {
    // The durable request is already reserved and the exact thread is locked.
    // A lost restore response never becomes permission to submit or replay.
    record.restoreStatus = 'restoring';
    await saveRecord(options.stateDir,record);
    const restored = await client.call('thread/unarchive', {threadId:record.threadId}, rpcDeadline());
    if (restored.thread?.id !== record.threadId) throw new Error('Unarchive returned a different thread');
    record.target = await readTarget(client,record.threadId,rpcDeadline());
    if (record.target.state !== 'readable') throw new Error('Restored target is not confirmed active');
    record.restoreStatus = 'restored';
    await saveRecord(options.stateDir,record);
  }
  if (record.target.state !== 'readable') {
    record.status = 'blocked';
    record.error = { code: `TARGET_${record.target.state.toUpperCase()}`, message: 'Target is not confirmed active; no message submitted' };
    return;
  }
  const wireMessage = `${record.marker}\n${message}`;
  try {
    const resumed = await client.call('thread/resume', { threadId: record.threadId, excludeTurns: true }, rpcDeadline());
    if (resumed.thread.id !== record.threadId) throw new Error('Resume returned a different thread ID');
    record.route = 'app-server';
  } catch (error) {
    if (!(error instanceof RpcError) || !/already has an active writer/i.test(error.message)) throw error;
    record.route = 'queue';
  }
  if (record.route === 'queue') {
    const history = await client.call('thread/turns/list', {
      threadId: record.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    }, rpcDeadline());
    record.baselineTurnId = history.data[0]?.id ?? null;
    record.status = 'submitting';
    record.submitted = true; // Conservative: a lost acknowledgement must never cause a retry.
    await saveRecord(options.stateDir, record);
    record.queueReceipt = await dependencies.queue(record.binary, record.threadId, wireMessage, rpcDeadline(), options.cwd);
    record.status = 'waiting';
    await saveRecord(options.stateDir, record);
    if(options.waitMode==='state') await observeState(client,record,options);
    else await observeQueued(client, record, options, deadline);
    return;
  }
  record.status = 'submitting';
  record.submitted = true;
  await saveRecord(options.stateDir, record);
  const started = await client.call('turn/start', {
    threadId: record.threadId, input: [{ type: 'text', text: wireMessage }],
  }, rpcDeadline());
  record.turnId = started.turn.id;
  record.status = 'running';
  await saveRecord(options.stateDir, record);
  if(options.waitMode==='state') {await observeState(client,record,options);return;}
  const event = await client.waitFor((event) => event.method === 'turn/completed' &&
    event.params?.threadId === record.threadId && event.params?.turn?.id === record.turnId, deadline);
  const turn = event.params.turn;
  record.status = turn.status;
  record.error = turn.error ?? null;
  if (client.unsupportedRequests.length) {
    record.status = 'blocked';
    record.error = { code: 'HOST_INTERACTION_REQUIRED', message: 'This client could not supply a host interaction' };
    record.unsupportedInteractions = [...new Set(client.unsupportedRequests)];
    return;
  }
  if (turn.status === 'completed') {
    while (performance.now() < deadline) {
      const persisted = await findTurn(client, record, deadline);
      record.answers = finalTexts(persisted ?? turn);
      if (record.answers.length) {
        record.answer = record.answers.join('\n\n');
        return;
      }
      await delay(Math.min(options.pollMs ?? 500, timeLeft(deadline)));
    }
    throw new Error('Turn completed but no supported final response text was found');
  }
}

async function observeState(client,record,options) {
  return observeTurn({client,record,rpcTimeoutMs:options.timeoutMs,pollMs:options.pollMs ?? 30000,
    findTurn,finalTexts,save:()=>saveRecord(options.stateDir,record)});
}

export async function sendCodex(input, overrides = {}) {
  const dependencies = { createClient: (binary, cwd) => new AppServer(binary, cwd), queue: runQueue, ...overrides };
  const options = optionsFor(input);
  const threadId = validateThreadId(input.threadId);
  const requestId = validateRequestId(input.requestId ?? randomUUID());
  if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('message must not be empty');
  const hash = inputHash(threadId, input.message);
  const createdAt = new Date().toISOString();
  const reserved = await reserveRecord(options.stateDir, {
    version: 1, agent: 'codex', requestId, threadId, inputHash: hash,
    marker: `[yjx-feishu-agent:${randomUUID()}]`, createdAt, status: 'waiting',timeoutMs:options.timeoutMs,waitMode:options.waitMode,
    submitted: false, route: null, turnId: null, answer: null, answers: [], error: null,
  });
  const record = reserved.record;
  if (!reserved.fresh) {
    if (record.inputHash !== hash) throw new Error('Request ID already belongs to different input');
    return { ...record, deduplicated: true };
  }
  const deadline = performance.now() + options.timeoutMs;
  let release;
  let client;
  try {
    release = await lockThread(options.stateDir, threadId, deadline);
    if (!release) throw new Error('Thread is busy or a previous sender left a lock; inspect the lock before recovery');
    const prior = await resolveThreadRequest(options.stateDir, record,
      requestId => requestStatus({...options,requestId,refresh:true}, {...dependencies,lockHeld:true}));
    if (prior.old) {
      const unresolved = prior.old.submitted && !['completed','failed','interrupted'].includes(prior.old.status);
      record.oldThreadRequest = { requestId:prior.old.requestId, status:prior.old.status,
        submitted:prior.old.submitted, ...(prior.refreshError ? {refreshError:prior.refreshError} : {}) };
      if (unresolved) throw new Error('Previous request ' + prior.old.requestId + ' is unresolved; refresh its status before sending another request');
    }
    await claimThreadRequest(options.stateDir, record);
    record.binary = await resolveCodex(options.codex);
    record.cwd = options.cwd;
    client = dependencies.createClient(record.binary, options.cwd);
    await client.initialize(options.waitMode==='state' ? performance.now()+options.timeoutMs : deadline);
    await execute(client, record, input.message, options, deadline, dependencies);
  } catch (error) {
    record.status = record.submitted ? 'unconfirmed' : 'blocked';
    if (options.waitMode==='deadline' && performance.now()>=deadline) record.waitTimedOut=true;
    const heldBy = record.oldThreadRequest && !['completed','failed','interrupted'].includes(record.oldThreadRequest.status)
      ? record.oldThreadRequest.requestId : null;
    record.error = { code: !record.submitted && heldBy ? 'REQUEST_HELD' : record.submitted ? 'COMPLETION_UNCONFIRMED'
      : error.code === 'CODEX_NOT_FOUND' ? 'CODEX_NOT_FOUND' : 'NOT_SUBMITTED',
      message: error.message, ...(heldBy ? { blockedByRequestId:heldBy } : {}) };
    if (client?.unsupportedRequests.length) {
      record.status = 'blocked';
      record.unsupportedInteractions = [...new Set(client.unsupportedRequests)];
      record.error = { code: 'HOST_INTERACTION_REQUIRED', message: 'This client could not supply a host interaction' };
    }
    if (options.waitMode!=='state' && record.route === 'app-server' && record.turnId && client && !client.stopped) {
      try {
        await client.call('turn/interrupt', { threadId, turnId: record.turnId }, performance.now() + 2000);
        record.interruptRequested = true;
      } catch { record.interruptRequested = false; }
    }
  } finally {
    try { await saveRecord(options.stateDir, record); }
    finally {
      try { if (client) await client.close(); }
      finally { if (release) await release(); }
    }
  }
  return record;
}

export async function requestStatus(input, { createClient = (binary, cwd) => new AppServer(binary, cwd), lockHeld = false } = {}) {
  const options = optionsFor(input);
  let record = await readRecord(options.stateDir, validateRequestId(input.requestId));
  if (!input.refresh || !record.submitted || record.status === 'completed') return record;
  // sendCodex holds this same per-thread lock while refreshing a predecessor.
  // Reuse that exclusive lock; standalone status checks still acquire it.
  const release = lockHeld ? null
    : await lockThread(options.stateDir, validateThreadId(record.threadId), performance.now());
  if (!lockHeld && !release) return { ...record, refreshSkipped: 'sender_lock_held' };
  let client;
  try {
    // A sender may have finished between our initial read and acquiring its lock.
    record = await readRecord(options.stateDir, input.requestId);
    if (['completed', 'failed', 'interrupted'].includes(record.status)) return record;
    let binary;
    try {
      binary = await resolveCodex(input.codex ?? record.binary ?? options.codex);
    } catch (error) {
      // A request journal may outlive a Desktop update that moves the binary.
      // Re-reading history is read-only; retry with the current executor only
      // when the persisted path no longer resolves.
      if (input.codex || !record.binary) throw error;
      binary = await resolveCodex(options.codex);
    }
    record.binary = binary;
    client = createClient(binary, options.cwd);
    const deadline = performance.now() + options.timeoutMs;
    await client.initialize(deadline, { experimental: true });
    if (record.route === 'queue' && record.baselineTurnId) {
      let queue;
      try { queue = await client.call('thread/queue/list', { threadId: record.threadId }, deadline); }
      catch (error) { queue = null; }
      if (queue && Array.isArray(queue.data) && queue.data.length === 0) {
        // Empty queue is meaningful only when no turn followed the one that was
        // active when the durable queue submission began. Otherwise it may have
        // already executed; read the exact turn history before drawing a result.
        const history = await client.call('thread/turns/list', {
          threadId:record.threadId,limit:100,sortDirection:'desc',itemsView:'full'},deadline);
        const baselineIndex = history.data.findIndex(turn => turn.id === record.baselineTurnId);
        if (baselineIndex >= 0) {
          const candidates = history.data.slice(0, baselineIndex);
          const transient = turn => turn.status === 'interrupted' && turn.completedAt == null;
          let turn;
          if (record.turnId) {
            // A known turn proves this request only when that exact turn is still
            // in its transient interrupted state. Never substitute a later turn.
            turn = candidates.find(item => item.id === record.turnId && transient(item));
          } else {
            // Queued submissions may not expose their turn ID in the receipt. The
            // durable marker is the fallback correlation; ambiguity stays blocked.
            const matches = candidates.filter(item => transient(item) && hasMarker(item, record.marker));
            if (matches.length === 1) turn = matches[0];
          }
          if (turn) {
            record.turnId = turn.id;
            record.status = 'interrupted';
            record.answer = null;
            record.answers = [];
            record.error = null;
            record.queueState = 'empty';
            record.terminalConfirmedAt = new Date().toISOString();
            await saveRecord(options.stateDir, record);
            return record;
          }
        }
      }
    }
    applyPersistedTurn(record, await findTurn(client, record, deadline));
    await saveRecord(options.stateDir, record);
    return record;
  } finally {
    try { if (client) await client.close(); }
    finally { if (release) await release(); }
  }
}
