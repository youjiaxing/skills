import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateBindings } from './feishu-core.mjs';
import { routeFile, checkRoute } from './message-routes.mjs';

async function bindingFor(stateDir, chatId) {
  let config;
  try { config = JSON.parse(await readFile(path.join(stateDir,'feishu','bindings.json'),'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return validateBindings(config).bindings.find(binding => binding.chatId === chatId) ?? null;
}

// Applies only to new attempts. Existing request fingerprints remain immutable.
export async function requirePushSource(input, {stateDir, chatId}) {
  if (await bindingFor(stateDir, chatId) && !input.sourceThreadId && input.oneWay !== true) {
    const error = new Error('Connected group requires sourceThreadId or explicit oneWay:true');
    error.code = 'SOURCE_REQUIRED';
    throw error;
  }
}

// Read-only snapshot; delivery receipts and current follow-up routing are independent.
export async function describePush(record, {stateDir, appId, outcome}) {
  const confirmed = outcome === 'sent' || Boolean((record.version === 2 && record.acknowledgement?.messageId) ||
    (record.status === 'sent' && record.messageId));
  const delivery = confirmed ? 'confirmed' : outcome === 'not_submitted' ? 'not_submitted' : 'unknown';
  let followUp;
  try {
    const binding = await bindingFor(stateDir,record.chatId);
    if (!binding || binding.quoteRouting === false) followUp = {state:'unavailable',reason:binding ? 'routing_disabled' : 'group_not_connected'};
    else if (!confirmed) followUp = {state:'unknown',reason:'delivery_unconfirmed'};
    else {
      const messageId = record.acknowledgement?.messageId ?? record.messageId;
      let route;
      try { route = JSON.parse(await readFile(routeFile(stateDir,appId,record.chatId),'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (route && (route.version !== 1 || route.chatId !== record.chatId || !route.messages ||
        typeof route.messages !== 'object' || Array.isArray(route.messages))) throw new Error('Invalid routes');
      const entry = route?.messages[messageId];
      const source = checkRoute(entry);
      followUp = entry?.pending ? {state:'unknown',reason:'route_pending'}
        : !source ? {state:'unavailable',reason:'source_not_registered'}
        : source !== record.sourceThreadId ? {state:'changed',reason:'source_changed'}
        : {state:'ready',sourceThreadId:source};
    }
  } catch { followUp = {state:'unknown',reason:'routing_unreadable'}; }
  return {...record, delivery, followUp, checkedAt:new Date().toISOString()};
}
