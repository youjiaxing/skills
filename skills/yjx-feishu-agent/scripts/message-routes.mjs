import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { lockThread } from './state.mjs';
import { validateThreadId } from './codex.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function routeFile(stateDir, appId, chatId) {
  if (!/^oc_[\w]+$/.test(chatId ?? '')) throw new Error('Invalid route group');
  return path.join(stateDir, 'message-routes-v1', hash(appId), `${hash(chatId)}.json`);
}

// Both outbound writes and inbound admission use this boundary. The admitted
// destination is durably frozen before releasing the group lock.
export async function withRoutes({stateDir, appId, chatId}, action) {
  const file = routeFile(stateDir, appId, chatId);
  const release = await lockThread(path.dirname(file), hash(chatId), performance.now() + 30000);
  if (!release) throw new Error('Message routing busy; no destination selected');
  try {
    let data;
    try { data = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; data = {version:1,chatId,messages:{}}; }
    if (data.version !== 1 || data.chatId !== chatId || !data.messages ||
        typeof data.messages !== 'object' || Array.isArray(data.messages)) throw new Error('Invalid message routing journal');
    const save = async () => {
      await mkdir(path.dirname(file), {recursive:true,mode:0o700});
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data,null,2), {mode:0o600,flush:true});
      await rename(temporary,file);
    };
    return await action(data,save);
  } finally { await release(); }
}

export function checkRoute(route) {
  if (!route || route.pending || !route.sourceThreadId) return null;
  try { return validateThreadId(route.sourceThreadId); } catch { return null; }
}

export function createMessageRouter(options) {
  return {
    async admit(item, persist) {
      if (item.binding.quoteRouting === false || !item.parentId) {
        return persist(item.binding.threadId ? {threadId:item.binding.threadId,autoUnarchive:false} :
          {code:'DEFAULT_UNCONFIGURED',error:'本群尚未设置默认 Codex 会话，请引用一条已登记的推送消息并 @机器人。'});
      }
      return withRoutes({...options,chatId:item.binding.chatId}, async data => {
        // Only the directly quoted message is authoritative. A later owner of
        // its root card must not steal replies belonging to the earlier owner.
        const target = checkRoute(data.messages[item.parentId]);
        return persist(target ? {threadId:target,autoUnarchive:true,quotedMessageId:item.parentId} :
          {code:'QUOTE_SOURCE_UNAVAILABLE',error:'引用消息的来源未登记或投递仍待核查，本次未提交给 Codex；请在本机核对来源。'});
      });
    },
    async rememberReply(item, message, record) {
      if (!message?.message_id || !record.threadId || record.routeError) return;
      await withRoutes({...options,chatId:item.binding.chatId}, async (data,save) => {
        const existing=data.messages[message.message_id];
        if (existing && (existing.requestId!==record.requestId || existing.sourceThreadId!==record.threadId)) {
          throw new Error('Reply route conflicts with existing ownership');
        }
        data.messages[message.message_id]={sourceThreadId:record.threadId,requestId:record.requestId,kind:'reply',pending:null};
        await save();
      });
    },
  };
}
