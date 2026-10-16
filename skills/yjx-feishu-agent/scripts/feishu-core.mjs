import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sendCodex, validateThreadId } from './codex.mjs';

export const digest = (text) => createHash('sha256').update(text).digest('hex');

export function resultText(result, requestId) {
  if (result.status === 'completed') return result.answer;
  if (!result.submitted && result.error?.code === 'TARGET_ARCHIVED') {
    return `绑定的 Codex 聊天已归档，本次消息未提交。请在 Desktop 恢复聊天后发送新消息，或在本机明确重新绑定。请求：${requestId}`;
  }
  if (!result.submitted && ['TARGET_UNAVAILABLE','TARGET_UNKNOWN'].includes(result.error?.code)) {
    return `暂时无法确认绑定的 Codex 聊天可用，本次消息未提交。请在本机检查会话和绑定；不能据此判断聊天已删除。请求：${requestId}`;
  }
  return `本次请求状态：${result.status}。请在本机查看请求 ${requestId}，不要重复发送同一任务。`;
}

export function validateBindings(config) {
  if (config.version !== 1 || !Array.isArray(config.bindings) || !config.bindings.length) throw new Error('No group bindings');
  const groups = new Set();
  for (const binding of config.bindings) {
    if (!/^oc_[\w]+$/.test(binding.chatId) || groups.has(binding.chatId)) throw new Error('Invalid or duplicate group binding');
    groups.add(binding.chatId);
    validateThreadId(binding.threadId);
    if (!Array.isArray(binding.users) || !binding.users.length || binding.users.some((id) => !/^ou_[\w]+$/.test(id))) {
      throw new Error('Each group requires an explicit user allowlist');
    }
  }
  return config;
}

export function acceptedMessage(data, config, botId) {
  const message = data?.message;
  const sender = data?.sender;
  const binding = config.bindings.find((item) => item.chatId === message?.chat_id);
  if (!binding || message.chat_type !== 'group' || message.message_type !== 'text' ||
      sender?.sender_type !== 'user' || !binding.users.includes(sender.sender_id?.open_id) ||
      typeof message.message_id !== 'string' || !message.message_id) return null;
  const mentions = (message.mentions ?? []).filter((mention) => mention.id?.open_id === botId);
  if (!mentions.length) return null;
  let text;
  try { text = JSON.parse(message.content).text; } catch { return null; }
  if (typeof text !== 'string') return null;
  for (const mention of mentions) if (mention.key) text = text.split(mention.key).join('');
  text = text.trim();
  if (!text || text.length > 20000) return null;
  return { binding, messageId: message.message_id, text };
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
export function createReceiver({ appId, botId, config, stateDir, reply, send = sendCodex, log = () => {} }) {
  const directory = path.join(stateDir, 'feishu', digest(appId), 'messages');
  const queue = [];
  let working = false;
  let accepting = true;
  let admission = Promise.resolve();
  let pendingAdmissions = 0;
  let worker = Promise.resolve();

  async function drain() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const { record, file, text, binding } = queue.shift();
        try {
          record.status = 'processing';
          await writeJournal(file, record);
          const result = await send({ threadId: binding.threadId, message: text, requestId: record.requestId,
            stateDir, codex: config.codex, cwd: config.cwd, timeoutMs: 180000 });
          record.codexStatus = result.status;
          // Never present unconfirmed/blocked turns as successfully completed.
          const answer = resultText(result, record.requestId);
          if (typeof answer !== 'string' || !answer.length) throw new Error('No final answer');
          record.status = 'replying';
          await writeJournal(file, record); // A lost API response must not trigger another reply.
          await reply(record.messageId, answer, record.requestId);
          record.status = 'replied';
          await writeJournal(file, record);
          log({ type: 'request', requestId: record.requestId, status: record.status, codexStatus: result.status });
        } catch {
          record.status = 'unconfirmed';
          try { await writeJournal(file, record); } catch { /* Keep the last durable state. */ }
          log({ type: 'request', requestId: record.requestId, status: 'unconfirmed' });
        }
      }
    } finally { working = false; }
  }

  async function admit(data) {
    if (!accepting) throw new Error('Receiver is stopping');
    const item = acceptedMessage(data, config, botId);
    if (!item) return;
    const requestId = `fs-${digest(`${appId}:${item.messageId}`)}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${requestId}.json`);
    try { await readFile(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (queue.length >= 32) throw new Error('Receiver queue is full');
    const record = { version: 1, requestId, messageId: item.messageId, chatId: item.binding.chatId,
      threadId: item.binding.threadId, status: 'accepted', createdAt: new Date().toISOString() };
    await writeJournal(file, record);
    queue.push({ record, file, text: item.text, binding: item.binding });
    if (!working) worker = drain();
  }

  return {
    handle(data) {
      if (pendingAdmissions >= 32) return Promise.reject(new Error('Receiver admission queue is full'));
      pendingAdmissions += 1;
      const result = admission.then(() => admit(data));
      admission = result.catch(() => {});
      return result.finally(() => { pendingAdmissions -= 1; });
    },
    async stop() { accepting = false; await admission; await worker; },
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
