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

export function routeState(route) {
  if (!route) return {state:'missing'};
  if (typeof route !== 'object' || Array.isArray(route)) return {state:'invalid'};
  if (route.pending) return {state:'pending'};
  if (!Object.hasOwn(route, 'sourceThreadId') || route.sourceThreadId === '') return {state:'invalid'};
  if (route.sourceThreadId === null) return {state:'unregistered'};
  try { return {state:'quoted',threadId:validateThreadId(route.sourceThreadId)}; }
  catch { return {state:'invalid'}; }
}

export function checkRoute(route) {
  const result=routeState(route);
  return result.state==='quoted' ? result.threadId : null;
}

export function createMessageRouter(options) {
  return {
    async admit(item, persist) {
      const useDefault=routeMode => item.binding.threadId
        ? {threadId:item.binding.threadId,autoUnarchive:false,routeMode}
        : {code:'DEFAULT_UNCONFIGURED',routeMode:'blocked',
          error:'本群尚未设置默认 Codex 会话，请引用一条已登记的推送消息并 @机器人。'};
      if (item.binding.quoteRouting === false) return persist(useDefault('quote-disabled'));
      if (!item.parentId) return persist(useDefault('default'));
      return withRoutes({...options,chatId:item.binding.chatId}, async data => {
        // Only the directly quoted message is authoritative. A later owner of
        // its root card must not steal replies belonging to the earlier owner.
        const route=routeState(data.messages[item.parentId]);
        if (route.state==='quoted') return persist({threadId:route.threadId,autoUnarchive:true,
          quotedMessageId:item.parentId,routeMode:'quoted'});
        if (['missing','unregistered'].includes(route.state)) return persist(useDefault('binding-fallback'));
        return persist({code:'QUOTE_SOURCE_UNAVAILABLE',routeMode:'blocked',
          error:'引用消息的来源记录仍在更新或已损坏，本次未提交给 Codex；请在本机核查来源。'});
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
