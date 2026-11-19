import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { validateThreadId } from './codex.mjs';
import { sendAgent, validateAgentTargets } from './agent-targets.mjs';
import { bodyText, decodeBody } from './feishu-content.mjs';
import { recordAdmission, safeFailure } from './message-diagnostics.mjs';
import { createDeliveryJobs, bounded } from './delivery-jobs.mjs';
import { requestT3Status } from './t3.mjs';

export const digest = (text) => createHash('sha256').update(text).digest('hex');

export function resultText(result, _requestId) {
  if (result.status === 'completed') return result.answer;
  if (['failed', 'interrupted', 'blocked'].includes(result.status) || result.submitted === false) {
    return '这次没答上。';
  }
  if (result.status === 'waiting') return '还在等补充信息或授权，有结果会再回。可以继续发新消息。';
  return '还在处理，有结果会再回。可以继续发新消息。';
}

export function validateBindings(config) {
  if (config.version !== 1 || !Array.isArray(config.bindings) || !config.bindings.length) throw new Error('No group bindings');
  if (config.maxConcurrentThreads !== undefined && (!Number.isInteger(config.maxConcurrentThreads) ||
      config.maxConcurrentThreads<1 || config.maxConcurrentThreads>8)) throw new Error('maxConcurrentThreads must be 1–8');
  if (config.codexTimeoutMs !== undefined && (!Number.isSafeInteger(config.codexTimeoutMs) ||
    config.codexTimeoutMs<60000 || config.codexTimeoutMs>3600000)) throw new Error('codexTimeoutMs must be 60000–3600000');
  if (config.codexRpcTimeoutMs !== undefined && (!Number.isSafeInteger(config.codexRpcTimeoutMs) ||
    config.codexRpcTimeoutMs<1000 || config.codexRpcTimeoutMs>120000)) throw new Error('codexRpcTimeoutMs must be 1000–120000');
  validateAgentTargets(config);
  const groups = new Set();
  for (const binding of config.bindings) {
    if (!/^oc_[\w]+$/.test(binding.chatId) || groups.has(binding.chatId)) throw new Error('Invalid or duplicate group binding');
    groups.add(binding.chatId);
    if (binding.threadId !== undefined) validateThreadId(binding.threadId);
    if (binding.quoteRouting !== undefined && typeof binding.quoteRouting !== 'boolean') throw new Error('quoteRouting must be boolean');
    if (binding.requireMention !== undefined && typeof binding.requireMention !== 'boolean') throw new Error('requireMention must be boolean');
    if (binding.requireFollowUp !== undefined && typeof binding.requireFollowUp !== 'boolean') throw new Error('requireFollowUp must be boolean');
    if (binding.legacyOutboundDirs !== undefined && (!Array.isArray(binding.legacyOutboundDirs) ||
      binding.legacyOutboundDirs.some(directory=>typeof directory!=='string' || !path.isAbsolute(directory)))) throw new Error('Invalid legacy outbound directories');
    if (binding.oneWayExceptions !== undefined && (!binding.oneWayExceptions || typeof binding.oneWayExceptions !== 'object' ||
      Array.isArray(binding.oneWayExceptions) || Object.entries(binding.oneWayExceptions).some(([id,reason]) =>
        !/^[a-zA-Z0-9._-]{1,100}$/.test(id) || typeof reason !== 'string' || !reason.trim()))) throw new Error('Invalid one-way exceptions');
    if (!Array.isArray(binding.users) || !binding.users.length || binding.users.some((id) => !/^ou_[\w]+$/.test(id))) {
      throw new Error('Each group requires an explicit user allowlist');
    }
  }
  return config;
}

export function messageDecision(data, config, botId) {
  const message = data?.message;
  const sender = data?.sender;
  const binding = config.bindings.find((item) => item.chatId === message?.chat_id);
  if (!binding) return {reason:'GROUP_NOT_BOUND'};
  if (typeof message.message_id !== 'string' || !message.message_id || message.message_id.length>200) return {reason:'INVALID_MESSAGE_ID'};
  if (message.chat_type !== 'group') return {reason:'NOT_GROUP'};
  if (sender?.sender_type !== 'user') return {reason:'NOT_HUMAN'};
  if (!binding.users.includes(sender.sender_id?.open_id)) return {reason:'USER_NOT_ALLOWED'};
  const mentions = (message.mentions ?? []).filter((mention) => mention.id?.open_id === botId);
  if (binding.requireMention !== false && !mentions.length) return {reason:'BOT_NOT_MENTIONED'};
  if (!['text','post'].includes(message.message_type)) return {reason:'UNSUPPORTED_MESSAGE_TYPE'};
  if (!decodeBody(message)) return {reason:'INVALID_BODY'};
  let text = bodyText(message, botId);
  if (typeof text !== 'string') return {reason:'INVALID_BODY'};
  for (const mention of mentions) if (mention.key) text = text.split(mention.key).join('');
  text = text.trim();
  if (!text || text.length > 20000) return {reason:!text ? 'EMPTY_BODY' : 'BODY_TOO_LONG'};
  return {reason:'ACCEPTED',item:{ binding, messageId: message.message_id, text, parentId:message.parent_id,
    rootId:message.root_id, threadId:message.thread_id, source:message }};
}

export function acceptedMessage(data,config,botId) { return messageDecision(data,config,botId).item ?? null; }

export function withPrefix(text,prefix) {
  const value=String(text ?? '');
  const match=value.match(/^(\s*<!--[ \t]*feishu:(?:text|post|card)[ \t]*-->\s*)/i);
  return match ? match[1]+prefix+'\n\n'+value.slice(match[1].length)
    : prefix+'\n\n'+value;
}

export async function writeJournal(file, record) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}

export function applyBindingsSnapshot(config, next) {
  if (!next || next === config) return config;
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, next);
  return config;
}


const PLACEHOLDER_STATUS = new Set(['blocked', 'unconfirmed', 'failed', 'interrupted']);

export async function deliverHarvestedFollowUp({ directory, requestId, answer, reply, prepareReply, confirmReply = async () => {} }) {
  if (typeof answer !== 'string' || !answer.trim() || typeof requestId !== 'string') return null;
  const file = path.join(directory, `${requestId}.json`);
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
  if (record.codexStatus === 'completed' || record.answerFollowUpAttempted || !record.replyMessageId) return null;
  if (!PLACEHOLDER_STATUS.has(record.codexStatus)) return null;
  record.answerFollowUpAttempted = true;
  await writeJournal(file, record);
  const rendered = prepareReply(answer);
  const sent = await reply(record.messageId, answer, `${requestId}:answer`, rendered);
  if (sent?.message_id) {
    if (sent.message_id === record.replyMessageId) throw new Error('Follow-up reused placeholder receipt');
    record.answerFollowUpMessageId = sent.message_id;
    record.codexStatus = 'completed';
    record.answer = answer;
    await writeJournal(file, record);
    await confirmReply({binding:{chatId:record.chatId}},sent,record);
  }
  return sent;
}

// Single receiver owns this directory. ACK waits for admission to be persisted,
// not for the Codex turn. Interrupted journals are retained for human recovery.
export function createReceiver({ appId, botId, config, stateDir, reply, send = sendAgent, context = async item => item.text,
  admitRoute = async (item,persist) => persist({threadId:item.binding.threadId,autoUnarchive:false}),
  confirmReply = async () => {}, prepareReply = answer => ({msgType:'text',content:{text:answer},mode:'text'}),
  feedback = { update() {} }, log = () => {}, refresh = requestT3Status,
  loadConfig, operationMs = 30000, stopMs = 10000, now = Date.now }) {
  const directory = path.join(stateDir, 'feishu', digest(appId), 'messages');
  const queue = [];
  const active = new Map();
  const concurrency = config.maxConcurrentThreads ?? 2;
  let accepting = true;
  const shutdown = new AbortController();
  const queueKey=job => job.record.agentTarget
    ? `${job.record.agentTarget.kind}:${job.record.agentTarget.threadId}`
    : job.record.threadId ?? job.record.requestId;
  let admission = Promise.resolve();
  let pendingAdmissions = 0;
  const jobs = createDeliveryJobs({directory, stateDir, appId, reply, prepareReply, confirmReply, feedback, log, refresh, operationMs, now});
  async function processJob({record,file,item}) {
    let durableAnswerReceipt = false;
    let stage = 'journal';
    let background = false;
    try {
      record.status = 'processing';
      await writeJournal(file, record);
      stage = 'context'; record.stage = stage;
      await writeJournal(file,record);
      const routeNotice=record.routeMode==='binding-fallback'
        ? '引用消息的来源未登记，本次已回退到本群绑定的 Codex 会话处理。' : null;
      const prepared = record.routeError ? null : await bounded(() => context(item), operationMs, shutdown.signal);
      const text = typeof prepared==='string' ? prepared : prepared?.text;
      stage = 'codex'; record.stage = stage;
      await writeJournal(file,record);
      const sendInput = { threadId: record.threadId, message: text, requestId: record.requestId,
        agentTarget:record.agentTarget, t3Command:config.t3Command,t3BaseDir:config.t3BaseDir,
        autoUnarchive:record.autoUnarchive, stateDir, codex: config.codex, cwd: config.cwd,
        waitMode:'state',timeoutMs:record.codexRpcTimeoutMs,signal:shutdown.signal };
      const result = record.routeError ? {status:'blocked',submitted:false}
        : await bounded(() => send(sendInput), record.agentTarget?.kind === 't3' ? operationMs : Infinity, shutdown.signal);
      if (Array.isArray(result.releasedPriors)) {
        for (const prior of result.releasedPriors) {
          if (prior.status === 'completed' && prior.answer) {
            try { await deliverHarvestedFollowUp({ directory, requestId: prior.requestId, answer: prior.answer, reply, prepareReply }); }
            catch { log({ type: 'follow-up-failed', requestId: prior.requestId }); }
          }
        }
      }
      if (record.agentTarget?.kind === 't3') {
        background = true;
        await jobs.track(record, item, {...result, agent:'t3'});
        return;
      }
      record.codexStatus = result.status;
      record.codexSubmitted = typeof result.submitted === 'boolean' ? result.submitted : null;
      if (result.waitTimedOut) record.waitTimedOut=true;
      if (typeof result.interruptRequested==='boolean') record.interruptRequested=result.interruptRequested;
      if (['TARGET_ARCHIVED','TARGET_UNAVAILABLE','TARGET_UNKNOWN','HOST_INTERACTION_REQUIRED',
        'COMPLETION_UNCONFIRMED','NOT_SUBMITTED','CODEX_NOT_FOUND','TURN_FAILED','TURN_INTERRUPTED','NO_FINAL_REPLY'].includes(result.error?.code)) record.codexCode=result.error.code;
      // Never present unconfirmed/blocked turns as successfully completed.
      const baseAnswer = record.routeError ?? resultText(result, record.requestId);
      if (typeof baseAnswer !== 'string' || !baseAnswer.length) throw new Error('No final answer');
      const answer=routeNotice ? withPrefix(baseAnswer,routeNotice) : baseAnswer;
      record.status = 'replying';
      stage = 'reply'; record.stage = stage;
      const rendered = prepareReply(answer);
      record.replyType = rendered.msgType;
      record.replyMode = rendered.mode;
      record.replyPayloadDigest = digest(JSON.stringify(rendered.content));
      record.replyAttempted = true;
      await writeJournal(file, record); // A lost API response must not trigger another reply.
      const sent = await bounded(() => reply(record.messageId, answer, record.requestId, rendered), operationMs);
      if (sent?.message_id) {
        record.replyMessageId = sent.message_id;
        await writeJournal(file,record);
        durableAnswerReceipt = true;
      }
      if (!record.routeError && sent?.message_id) {
        stage = 'route_confirmation'; record.stage = stage;
        await writeJournal(file,record);
        await confirmReply(item,sent,record);
      }
      record.status = 'replied';
      record.stage = 'finished';
      await writeJournal(file, record);
      log({ type: 'request', requestId: record.requestId, status: record.status, codexStatus: result.status });
    } catch (error) {
      if (record.agentTarget?.kind === 't3') {
        background = true;
        const submitted = stage === 'codex';
        await jobs.track(record, item, {agent:'t3', status:submitted ? 'unconfirmed' : 'blocked', submitted, error:{code:submitted ? 'COMPLETION_UNCONFIRMED' : 'NOT_SUBMITTED'}});
        return;
      }
      record.status = 'unconfirmed';
      record.failure = safeFailure(error,stage);
      try {
        await writeJournal(file, record);
        durableAnswerReceipt ||= Boolean(record.replyMessageId);
      } catch { /* Keep the last durable state. */ }
      if (!record.replyAttempted) {
        // Persist intent first. Never send a second message after an uncertain reply.
        record.replyAttempted = true;
        record.failureReplyAttempted = true;
        try {
          await writeJournal(file, record);
              const failureText='这次没答上。';
              const rendered=prepareReply(failureText);
              record.failureReplyType=rendered.msgType;
              const sent = await bounded(() => reply(record.messageId,failureText,record.requestId,rendered), operationMs);
          if (sent?.message_id) { record.failureReplyMessageId = sent.message_id; await writeJournal(file, record); }
        } catch { /* An unknown receipt remains unknown; no retries. */ }
      }
      log({ type: 'request', requestId: record.requestId, status: 'unconfirmed', failure:record.failure });
    } finally {
      if (!background) feedback.update(record, record.codexStatus === 'completed' && durableAnswerReceipt ? 'completed' : 'attention');
    }
  }

  function pump() {
    while (active.size < concurrency) {
      const index=queue.findIndex(job => !active.has(queueKey(job)));
      if(index<0) break;
      const [job]=queue.splice(index,1),key=queueKey(job);
      const task=processJob(job).catch(error => {log({type:'request-failed',requestId:job.record.requestId,failure:safeFailure(error,'request')});}).finally(()=>{active.delete(key);pump();});
      active.set(key,task);
    }
  }

  async function refreshConfig() {
    if (typeof loadConfig !== 'function') return;
    try {
      const next = await loadConfig();
      if (next) applyBindingsSnapshot(config, validateBindings(next));
    } catch { /* Keep the last valid snapshot if the file is briefly unreadable. */ }
  }

  async function admit(data) {
    await refreshConfig();
    const decision = messageDecision(data, config, botId),item=decision.item;
    if (!item) {
      // Metadata only: make ignored bound-group formats diagnosable without logging message bodies.
      if (config.bindings.some(b => b.chatId === data?.message?.chat_id) && typeof data?.message?.message_id==='string') {
        log({ type:'ignored', messageId:data.message.message_id, reason:decision.reason });
        try { await recordAdmission({stateDir,appId},data.message.message_id,decision.reason); }
        catch { log({type:'diagnostic-warning',code:'ADMISSION_RECORD_FAILED'}); }
      }
      return;
    }
    const requestId = `fs-${digest(`${appId}:${item.messageId}`)}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${requestId}.json`);
    try { await readFile(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (queue.length >= 32) {
      try { await recordAdmission({stateDir,appId},item.messageId,'QUEUE_FULL'); } catch { /* Best effort. */ }
      log({type:'admission-rejected',messageId:item.messageId,code:'QUEUE_FULL'});
      const error=new Error('Receiver queue is full');error.code='QUEUE_FULL';throw error;
    }
    const record = { version: 1, requestId, messageId: item.messageId, chatId: item.binding.chatId,
      waitMode:'state',codexRpcTimeoutMs:config.codexRpcTimeoutMs ?? 30000,
      ...(feedback.enabled ? { feedbackVersion:1 } : {}),
      threadId: item.binding.threadId, parentId:item.parentId, rootId:item.rootId,
      messageType:item.source.message_type, status: 'accepted', createdAt: new Date().toISOString() };
    await admitRoute(item, async route => {
      record.threadId = route.threadId ?? null;
      if (route.agentTarget) record.agentTarget = structuredClone(route.agentTarget);
      if (record.agentTarget?.kind === 't3') record.deliveryVersion = 2;
      record.autoUnarchive = route.autoUnarchive === true;
      if (route.error) record.routeError = route.error;
      if (route.code) record.routeCode = route.code;
      if (route.routeMode) record.routeMode = route.routeMode;
      if (route.quotedMessageId) record.quotedMessageId = route.quotedMessageId;
      await writeJournal(file, record);
    });
    if (record.agentTarget?.kind === 't3') jobs.accept(record, item);
    else {
      const pending = feedback.update(record, 'accepted');
      if (pending?.catch) pending.catch(() => {});
    }
    queue.push({ record, file, item });
    pump();
  }

  async function rejectFeedback(data, code) {
    const item = messageDecision(data, config, botId).item;
    if (!item) return;
    try {
      await jobs.reject(item, code);
    } catch { log({type:'rejection-feedback-pending',messageId:item.messageId,code}); }
  }

  return {
    handle(data) {
      if (!accepting) {
        void admission.then(() => rejectFeedback(data,'RECEIVER_STOPPING'));
        return Promise.reject(new Error('Receiver is stopping'));
      }
      if (pendingAdmissions >= 32) {
        log({type:'admission-rejected',code:'ADMISSION_QUEUE_FULL'});
        void admission.then(() => rejectFeedback(data,'ADMISSION_QUEUE_FULL'));
        return Promise.reject(new Error('Receiver admission queue is full'));
      }
      pendingAdmissions += 1;
      const result = admission.then(() => admit(data)).catch(async error=>{
        const decision=messageDecision(data,config,botId);
        if(decision.item) {
          const code=error.code==='QUEUE_FULL' ? 'QUEUE_FULL' : 'ADMISSION_FAILED';
          try { await recordAdmission({stateDir,appId},decision.item.messageId,code); } catch { /* Best effort. */ }
          log({type:'admission-rejected',messageId:decision.item.messageId,code});
          await rejectFeedback(data,code);
        }
        throw error;
      });
      admission = result.catch(() => {});
      return result.finally(() => { pendingAdmissions -= 1; });
    },
    tick: jobs.tick,
    recover: jobs.recover,
    async drain() {
      await admission;
      while (active.size) await Promise.all([...active.values()]);
      await jobs.drain();
    },
    async stop() {
      accepting = false;
      try {
        await bounded(async () => {
          await admission;
          while (active.size || queue.length) {
            pump();
            if (active.size) await Promise.all([...active.values()]);
          }
        }, stopMs);
      } catch {
        shutdown.abort();
        await admission;
        while (active.size || queue.length) {
          pump();
          if (active.size) await Promise.all([...active.values()]);
        }
        log({type:'stop-pending',pending:active.size});
      }
      await jobs.stop();
    },
    async unsettled() {
      let files;
      try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const records = [];
      for (const name of files.filter((name) => name.endsWith('.json'))) {
        const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
        if (record.status !== 'replied') records.push({ requestId: record.requestId, status: record.status });
      }
      return records;
    },
  };
}
