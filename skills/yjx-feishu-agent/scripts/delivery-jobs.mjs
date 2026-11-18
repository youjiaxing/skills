import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { digest, resultText, writeJournal } from './feishu-core.mjs';
import { safeFailure } from './message-diagnostics.mjs';
import { readRecord } from './state.mjs';

const terminal = status => ['completed','failed','interrupted','blocked'].includes(status);
const HOUR = 60 * 60 * 1000;

// The deadline bounds this caller, not the remote side effect. A lost write
// receipt remains unknown and may only be retried under server deduplication.
export async function bounded(operation, timeoutMs, signal) {
  let timer, onAbort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        if (Number.isFinite(timeoutMs)) timer = setTimeout(() => reject(new Error('Operation deadline exceeded')), timeoutMs);
        if (signal) { onAbort = () => reject(new Error('Receiver is stopping')); signal.addEventListener('abort',onAbort,{once:true}); }
      }),
    ]);
  } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort',onAbort); }
}

// Submission never waits for these lanes. Per-request ownership and round-robin
// scheduling keep old unknown requests from consuming new admission capacity.
export function createDeliveryJobs({directory, stateDir, appId, reply, prepareReply, confirmReply,
  feedback, log, refresh, operationMs = 30000, now = Date.now}) {
  const entries = new Map(), deliveries = new Set(), observations = new Set();
  const rejectionDirectory = path.join(path.dirname(directory), 'rejections');
  let stopped = false;
  const save = entry => writeJournal(entry.file, entry.record);
  const itemFor = record => ({binding:{chatId:record.chatId}});
  const mark = record => feedback.update(record,
    record.codexStatus === 'completed' && record.answerMessageId ? 'completed'
      : ['failed','interrupted','blocked','unconfirmed'].includes(record.codexStatus) || record.feedbackFailure ? 'attention' : 'accepted');

  function entryFor(record, item, file = path.join(directory, `${record.requestId}.json`)) {
    let entry = entries.get(file);
    if (!entry) {
      entry = {record, item, file, busy:false, nextDelivery:0, nextObservation:0};
      entries.set(file, entry);
    }
    return entry;
  }

  async function applyResult(entry, result) {
    const record = entry.record;
    const key = `${result.status}:${result.error?.code ?? ''}:${result.delivery ?? ''}`;
    if (record.outcomeKey !== key) {
      record.outcomeKey = key;
      record.feedbackRevision = (record.feedbackRevision ?? 0) + 1;
      record.statusDelivery = null;
      entry.nextDelivery = 0;
    }
    record.codexStatus = result.status;
    record.codexSubmitted = result.submitted === true;
    record.codexCode = result.error?.code;
    record.awaitingResult = result.submitted === true && !terminal(result.status);
    record.deliveryVersion = 2;
    record.status = 'pending';
    record.stage = record.awaitingResult ? 'observation' : 'delivery';
    record.feedbackText = resultText(result, record.requestId);
    if (result.status === 'completed' && typeof result.answer === 'string' && result.answer.trim()) record.answer = result.answer;
    await save(entry);
    mark(record);
  }

  async function track(record, item, result) {
    if (stopped) return;
    const entry = entryFor(record, item);
    await applyResult(entry, result);
    tick();
  }

  async function reject(item, code) {
    const requestId = `fs-${digest(`${appId}:${item.messageId}`)}`;
    // A duplicate of an admitted message must never claim it was not submitted.
    try { await readFile(path.join(directory, `${requestId}.json`)); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const file = path.join(rejectionDirectory, `${requestId}.json`);
    await mkdir(rejectionDirectory, {recursive:true, mode:0o700});
    let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      record = {version:1, requestId, messageId:item.messageId, chatId:item.binding.chatId,
        threadId:null, rejection:true, feedbackVersion:1, createdAt:new Date(now()).toISOString()};
    }
    const entry = entryFor(record, item, file);
    if (!record.outcomeKey) {
      await applyResult(entry, {status:'blocked',submitted:false,error:{code:'NOT_SUBMITTED'}});
      record.feedbackText = `本次消息未受理（${code === 'RECEIVER_STOPPING' ? '接收器正在停止' : code.includes('QUEUE') ? '当前请求过多' : '受理异常'}），没有提交任务；稍后可以发送新消息。`;
      await save(entry);
    }
    if (record.statusDelivery?.state === 'confirmed') entries.delete(file);
    tick();
  }

  function wantedDelivery(record, entry) {
    const answer = record.codexStatus === 'completed' && record.answer;
    const field = answer ? 'answerDelivery' : 'statusDelivery';
    if (record[field]?.state === 'confirmed') return null;
    // The accepted reaction is the normal acknowledgement. Wait briefly for
    // its result; suppress the text copy when it lands, otherwise fall back to
    // the text after the marker deadline. Final failure text still proceeds.
    if (!answer && entry) {
      // Do not create a status delivery from the pre-submit journal state.
      // The running/failure state is durable only after T3 has been observed.
      if (record.awaitingResult !== true && !terminal(record.codexStatus)) return null;
      if (entry.accepted === undefined && now() >= (entry.acceptDeadline ?? 0)) entry.accepted = false;
      if (entry.accepted !== false && record.awaitingResult === true) return null;
    }
    if (!record[field]) {
      const text = answer ? record.answer : record.feedbackText;
      const rendered = prepareReply(text);
      record[field] = {key:`${record.requestId}:${record.rejection ? 'rejection:' : ''}${answer ? 'answer' : `status:${record.feedbackRevision}`}`,
        rendered, state:'pending', attempts:0, text};
    }
    return {field, delivery:record[field], answer:Boolean(answer)};
  }

  function accept(record, item) {
    // Native Codex replies carry their own result; only T3 runs need the
    // durable observation and status-delivery lanes.
    if (record.agentTarget?.kind !== 't3') {
      const pending = mark(record);
      if (pending?.catch) pending.catch(() => {});
      return;
    }
    const entry = entryFor(record, item);
    entry.acceptDeadline = now() + 8000;
    const pending = mark(record);
    if (!pending?.then) { entry.accepted = false; tick(); return; }
    void pending.then(result => {
      entry.accepted = result?.delivered === true;
      tick();
    }).catch(() => { entry.accepted = false; tick(); });
  }

  function queueRoute(record, sent) {
    const pending = record.routeConfirmationsPending ??= record.routeConfirmationPending ? [record.routeConfirmationPending] : [];
    delete record.routeConfirmationPending;
    if (!pending.some(item => item.message_id === sent.message_id)) pending.push({message_id:sent.message_id});
  }

  async function confirmRoute(entry, sent = entry.record.routeConfirmationsPending?.[0]) {
    const record = entry.record;
    if (!sent || !record.threadId || record.routeError || record.rejection) return;
    queueRoute(record, sent);
    await save(entry);
    try {
      await bounded(() => confirmReply(entry.item ?? itemFor(record), sent, record), operationMs);
      record.routeConfirmationsPending = record.routeConfirmationsPending.filter(item => item.message_id !== sent.message_id);
      if (!record.routeConfirmationsPending.some(item => item.failure)) delete record.routeFailure;
    } catch (error) {
      record.routeFailure = safeFailure(error, 'route_confirmation');
      const pending = record.routeConfirmationsPending.find(item => item.message_id === sent.message_id);
      pending.failure = record.routeFailure;
      record.routeConfirmationsPending = record.routeConfirmationsPending.filter(item => item !== pending);
      record.routeConfirmationsPending.push(pending);
    }
    await save(entry);
  }

  async function deliver(entry) {
    const record = entry.record;
    const desired = wantedDelivery(record, entry);
    if (!desired) {
      if (record.routeConfirmationsPending?.length) await confirmRoute(entry);
      entry.nextDelivery = now() + 15000;
      return;
    }
    const {delivery, answer} = desired;
    // Feishu's uuid window is one hour. Never turn an older ambiguous write
    // into a fresh send. The reaction remains an independent feedback path.
    if ((delivery.unknownSince != null || delivery.state === 'unknown') && now() - (delivery.unknownSince ?? delivery.firstAttemptAt) >= HOUR - 60000) {
      record.feedbackFailure = {code:'DELIVERY_REQUIRES_RECONCILIATION'};
      await save(entry); mark(record);
      entry.nextDelivery = now() + 60000;
      return;
    }
    const hadUnknown = delivery.unknownSince != null || delivery.state === 'unknown';
    delivery.firstAttemptAt ??= now();
    delivery.unknownSince ??= delivery.firstAttemptAt;
    delivery.attempts++;
    delivery.state = 'unknown';
    if (answer) record.answerFollowUpAttempted = true;
    else record.replyAttempted = true;
    await save(entry);
    try {
      const deadlineMs = delivery.unknownSince + HOUR - 60000;
      const sent = await bounded(() => reply(record.messageId, delivery.text, delivery.key, delivery.rendered, {deadlineMs}), operationMs);
      if (!sent?.message_id || (answer && sent.message_id === record.replyMessageId)) throw new Error('Unknown or reused reply receipt');
      delivery.state = 'confirmed';
      delete delivery.unknownSince;
      delivery.messageId = sent.message_id;
      delete record.feedbackFailure;
      if (answer) {
        record.answerMessageId = sent.message_id;
        record.answerFollowUpMessageId = sent.message_id;
      } else record.replyMessageId = sent.message_id;
      if (record.threadId && !record.routeError && !record.rejection) queueRoute(record,sent);
      record.status = record.awaitingResult ? 'pending' : 'replied';
      record.stage = record.awaitingResult ? 'observation' : 'finished';
      await save(entry);
      mark(record);
      await confirmRoute(entry, sent);
    } catch (error) {
      // A definitive API refusal permits a later retry beyond the uuid window;
      // transport failures and missing receipts retain the original identity.
      if (error.notSent === true && !hadUnknown) {
        delivery.state = 'failed'; delete delivery.firstAttemptAt; delete delivery.unknownSince;
      }
      record.feedbackFailure = safeFailure(error, answer ? 'answer_delivery' : 'status_delivery');
      record.status = 'unconfirmed';
      await save(entry);
      feedback.update(record, 'attention');
      log({type:'delivery-pending',requestId:record.requestId,failure:record.feedbackFailure});
    }
    entry.nextDelivery = now() + Math.min(60000, 2000 * 2 ** Math.min(delivery.attempts, 5));
  }

  async function observe(entry) {
    try {
      const latest = await bounded(() => refresh({stateDir,requestId:entry.record.requestId,refresh:true,timeoutMs:Math.min(operationMs,15000)}), operationMs);
      await applyResult(entry, {...latest,agent:'t3'});
    } catch (error) {
      entry.record.observationFailure = safeFailure(error, 'observation');
      await save(entry);
    }
    entry.nextObservation = now() + (entry.record.codexStatus === 'unconfirmed' ? 15000 : 3000);
  }

  function launch(entry, lane, action) {
    entry.busy = true;
    // Rotate before dispatch; repeatedly failing old entries cannot own the head.
    entries.delete(entry.file); entries.set(entry.file, entry);
    const work = action(entry).catch(error => {
      entry.nextDelivery = now() + 15000;
      entry.nextObservation = now() + 15000;
      feedback.update(entry.record,'attention');
      log({type:'background-failed',requestId:entry.record.requestId,failure:safeFailure(error,'background')});
    }).finally(() => {
      entry.busy=false; lane.delete(work);
      if (!entry.record.awaitingResult && !entry.record.routeConfirmationsPending?.length && !wantedDelivery(entry.record, entry)) entries.delete(entry.file);
    });
    lane.add(work);
  }

  function tick({observeResults = true} = {}) {
    if (stopped) return;
    const snapshot = [...entries.values()];
    for (const entry of snapshot) {
      if (entry.busy) continue;
      if (deliveries.size < 2 && entry.nextDelivery <= now() &&
          (wantedDelivery(entry.record, entry) || entry.record.routeConfirmationsPending?.length)) {
        launch(entry, deliveries, deliver);
      } else if (observeResults && observations.size < 2 && entry.record.awaitingResult && entry.nextObservation <= now()) {
        launch(entry, observations, observe);
      }
    }
  }

  async function recover() {
    for (const dir of [directory,rejectionDirectory]) {
      let names;
      try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const name of names.filter(name => /^fs-[a-f0-9]{64}\.json$/.test(name))) {
        try {
          const file = path.join(dir,name), record = JSON.parse(await readFile(file,'utf8'));
          if (record.deliveryVersion !== 2 || name !== `${record.requestId}.json`) continue;
          if (record.routeConfirmationPending) queueRoute(record,record.routeConfirmationPending);
          if (!record.outcomeKey && !record.rejection) {
            const entry=entryFor(record,itemFor(record),file);
            let latest;
            try { latest=await readRecord(stateDir,record.requestId); }
            catch { latest={status:'blocked',submitted:false,error:{code:'NOT_SUBMITTED'}}; }
            // Submission intent is persisted before the host send. A crash in
            // the earlier waiting state is a known non-submission, not a run
            // to observe or replay.
            if (latest.status === 'waiting' && latest.submitted === false) {
              latest={...latest,status:'blocked',error:{code:'NOT_SUBMITTED'}};
            }
            await applyResult(entry,{...latest,agent:'t3'});
            continue;
          }
          if (!record.awaitingResult && !record.routeConfirmationsPending?.length &&
            (record.codexStatus === 'completed' ? record.answerDelivery : record.statusDelivery)?.state === 'confirmed') continue;
          entryFor(record,itemFor(record),file);
        } catch { log({type:'delivery-recovery-warning'}); }
      }
    }
  }

  async function drain() {
    // Flush ready notifications only; pending host runs never extend shutdown.
    for (;;) {
      tick({observeResults:false});
      if (!deliveries.size && !observations.size) break;
      await Promise.all([...deliveries,...observations]);
    }
  }

  async function stop() {
    try { await bounded(drain,10000); } catch { /* Remaining notifications are durable and resume at startup. */ }
    stopped = true;
    await Promise.all([...deliveries,...observations]);
  }

  return {accept,track,reject,tick,recover,drain,stop};
}
