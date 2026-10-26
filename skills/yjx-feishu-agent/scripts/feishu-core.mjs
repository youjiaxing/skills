import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sendCodex, validateThreadId } from './codex.mjs';
import { bodyText, decodeBody } from './feishu-content.mjs';
import { recordAdmission, safeFailure } from './message-diagnostics.mjs';

export const digest = (text) => createHash('sha256').update(text).digest('hex');

export function resultText(result, requestId) {
  if (result.status === 'completed') return result.answer;
  if (result.status==='interrupted') return `本次 Codex 执行已中断，未取得最终回复；不会自动重跑。请在原会话核查。请求：${requestId}`;
  if (result.status==='failed') return `本次 Codex 执行已失败，未取得最终回复；请在原会话查看原因。请求：${requestId}`;
  if (result.waitTimedOut && result.submitted) {
    const duration=Number.isSafeInteger(result.timeoutMs) ? `（${Number((result.timeoutMs/60000).toFixed(2))} 分钟）` : '';
    return `等待 Codex 已超时${duration}，尚未取得最终回复。${result.interruptRequested
      ? '已请求中断本次执行，中断结果请在 Codex 核对。'
      : '任务可能仍在 Codex 中处理，请查看进度。'}不要重复发送同一任务。请求：${requestId}`;
  }
  if (!result.submitted && result.error?.code === 'TARGET_ARCHIVED') {
    return `绑定的 Codex 聊天已归档，本次消息未提交。请在 Desktop 恢复聊天后发送新消息，或在本机明确重新绑定。请求：${requestId}`;
  }
  if (!result.submitted && ['TARGET_UNAVAILABLE','TARGET_UNKNOWN'].includes(result.error?.code)) {
    return `暂时无法确认绑定的 Codex 聊天可用，本次消息未提交。请在本机检查会话和绑定；不能据此判断聊天已删除。请求：${requestId}`;
  }
  if (!result.submitted && result.error?.code === 'CODEX_NOT_FOUND') {
    return `本机找不到可用的 Codex 程序，本次消息未提交。请在本机检查 Desktop 安装或桥接程序配置，修复后重新发送。请求：${requestId}`;
  }
  if (!result.submitted && result.error?.code === 'NOT_SUBMITTED') {
    return `本次消息未提交给 Codex，未产生执行或重复发送。可以根据提示修正后重新发送。请求：${requestId}`;
  }
  return `本次请求状态：${result.status}。请在本机查看请求 ${requestId}，不要重复发送同一任务。`;
}

export function validateBindings(config) {
  if (config.version !== 1 || !Array.isArray(config.bindings) || !config.bindings.length) throw new Error('No group bindings');
  if (config.maxConcurrentThreads !== undefined && (!Number.isInteger(config.maxConcurrentThreads) ||
      config.maxConcurrentThreads<1 || config.maxConcurrentThreads>8)) throw new Error('maxConcurrentThreads must be 1–8');
  if (config.codexTimeoutMs !== undefined && (!Number.isSafeInteger(config.codexTimeoutMs) ||
    config.codexTimeoutMs<60000 || config.codexTimeoutMs>3600000)) throw new Error('codexTimeoutMs must be 60000–3600000');
  if (config.codexRpcTimeoutMs !== undefined && (!Number.isSafeInteger(config.codexRpcTimeoutMs) ||
    config.codexRpcTimeoutMs<1000 || config.codexRpcTimeoutMs>120000)) throw new Error('codexRpcTimeoutMs must be 1000–120000');
  const groups = new Set();
  for (const binding of config.bindings) {
    if (!/^oc_[\w]+$/.test(binding.chatId) || groups.has(binding.chatId)) throw new Error('Invalid or duplicate group binding');
    groups.add(binding.chatId);
    if (binding.threadId !== undefined) validateThreadId(binding.threadId);
    if (binding.quoteRouting !== undefined && typeof binding.quoteRouting !== 'boolean') throw new Error('quoteRouting must be boolean');
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
  if (!mentions.length) return {reason:'BOT_NOT_MENTIONED'};
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
  const temporary = `${file}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}

// Single receiver owns this directory. ACK waits for admission to be persisted,
// not for the Codex turn. Interrupted journals are retained for human recovery.
export function createReceiver({ appId, botId, config, stateDir, reply, send = sendCodex, context = async item => item.text,
  admitRoute = async (item,persist) => persist({threadId:item.binding.threadId,autoUnarchive:false}),
  confirmReply = async () => {}, prepareReply = answer => ({msgType:'text',content:{text:answer},mode:'text'}),
  feedback = { update() {} }, log = () => {} }) {
  const directory = path.join(stateDir, 'feishu', digest(appId), 'messages');
  const queue = [];
  const active = new Map();
  const concurrency = config.maxConcurrentThreads ?? 2;
  let accepting = true;
  let admission = Promise.resolve();
  let pendingAdmissions = 0;
  async function processJob({record,file,item}) {
    let durableAnswerReceipt = false;
    let stage = 'journal';
    try {
      record.status = 'processing';
      await writeJournal(file, record);
      stage = 'context'; record.stage = stage;
      await writeJournal(file,record);
      const routeNotice=record.routeMode==='binding-fallback'
        ? '引用消息的来源未登记，本次已回退到本群绑定的 Codex 会话处理。' : null;
      const prepared = record.routeError ? null : await context(item);
      const text = typeof prepared==='string' ? prepared : prepared?.text;
      stage = 'codex'; record.stage = stage;
      await writeJournal(file,record);
      const result = record.routeError ? {status:'blocked',submitted:false} : await send({ threadId: record.threadId, message: text, requestId: record.requestId,
        autoUnarchive:record.autoUnarchive, stateDir, codex: config.codex, cwd: config.cwd,
        waitMode:'state',timeoutMs:record.codexRpcTimeoutMs });
      record.codexStatus = result.status;
      record.codexSubmitted = typeof result.submitted === 'boolean' ? result.submitted : null;
      if (result.waitTimedOut) record.waitTimedOut=true;
      if (typeof result.interruptRequested==='boolean') record.interruptRequested=result.interruptRequested;
      if (['TARGET_ARCHIVED','TARGET_UNAVAILABLE','TARGET_UNKNOWN','HOST_INTERACTION_REQUIRED',
        'COMPLETION_UNCONFIRMED','NOT_SUBMITTED','CODEX_NOT_FOUND','TURN_FAILED','TURN_INTERRUPTED'].includes(result.error?.code)) record.codexCode=result.error.code;
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
      const sent = await reply(record.messageId, answer, record.requestId, rendered);
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
              const failureText=`本次请求处理异常，请在本机检查，暂勿重复提交。请求：${record.requestId}`;
              const rendered=prepareReply(failureText);
              record.failureReplyType=rendered.msgType;
              const sent = await reply(record.messageId,failureText,record.requestId,rendered);
          if (sent?.message_id) { record.failureReplyMessageId = sent.message_id; await writeJournal(file, record); }
        } catch { /* An unknown receipt remains unknown; no retries. */ }
      }
      log({ type: 'request', requestId: record.requestId, status: 'unconfirmed', failure:record.failure });
    } finally {
      feedback.update(record, record.codexStatus === 'completed' && durableAnswerReceipt ? 'completed' : 'attention');
    }
  }

  function pump() {
    while (active.size < concurrency) {
      const index=queue.findIndex(job => !active.has(job.record.threadId ?? job.record.requestId));
      if(index<0) break;
      const [job]=queue.splice(index,1),key=job.record.threadId ?? job.record.requestId;
      const task=processJob(job).finally(()=>{active.delete(key);pump();});
      active.set(key,task);
    }
  }

  async function admit(data) {
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
      record.autoUnarchive = route.autoUnarchive === true;
      if (route.error) record.routeError = route.error;
      if (route.code) record.routeCode = route.code;
      if (route.routeMode) record.routeMode = route.routeMode;
      if (route.quotedMessageId) record.quotedMessageId = route.quotedMessageId;
      await writeJournal(file, record);
    });
    feedback.update(record, 'accepted');
    queue.push({ record, file, item });
    pump();
  }

  return {
    handle(data) {
      if (!accepting) return Promise.reject(new Error('Receiver is stopping'));
      if (pendingAdmissions >= 32) {
        log({type:'admission-rejected',code:'ADMISSION_QUEUE_FULL'});
        return Promise.reject(new Error('Receiver admission queue is full'));
      }
      pendingAdmissions += 1;
      const result = admission.then(() => admit(data)).catch(async error=>{
        const decision=messageDecision(data,config,botId);
        if(decision.item) {
          const code=error.code==='QUEUE_FULL' ? 'QUEUE_FULL' : 'ADMISSION_FAILED';
          try { await recordAdmission({stateDir,appId},decision.item.messageId,code); } catch { /* Best effort. */ }
          log({type:'admission-rejected',messageId:decision.item.messageId,code});
        }
        throw error;
      });
      admission = result.catch(() => {});
      return result.finally(() => { pendingAdmissions -= 1; });
    },
    async stop() {
      accepting = false; await admission;
      while(active.size) await Promise.all([...active.values()]);
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
