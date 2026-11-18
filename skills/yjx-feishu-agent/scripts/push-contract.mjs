import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateBindings } from './feishu-core.mjs';
import { routeFile, checkRoute } from './message-routes.mjs';
import { inspectAgentTarget, targetFor } from './agent-targets.mjs';
import { receiverPaths, receiverStatus } from './receiver-runtime.mjs';

export const configurationDigest = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; error.submitted = false; throw error; };

export async function bridgeAuthority(credentialsDir, appId, {home}={}) {
  const file = path.join(receiverPaths(appId,home).runtime, 'task-registration.json');
  let text;
  try { text=await readFile(file,'utf8'); }
  catch(error) { if(error.code!=='ENOENT') throw error;return realpath(credentialsDir); }
  const registration=JSON.parse(text);
  if (!path.isAbsolute(registration.stateDir ?? '')) fail('BRIDGE_REGISTRATION_INVALID');
  // An installed bridge whose state is missing must never become an ungoverned sender.
  return realpath(registration.stateDir);
}

export async function pushConfiguration(stateDir) {
  try { return validateBindings(JSON.parse(await readFile(path.join(stateDir,'feishu','bindings.json'),'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function bindingFor(stateDir, chatId) {
  return (await pushConfiguration(stateDir))?.bindings.find(binding => binding.chatId === chatId) ?? null;
}

// Applies only to new attempts. Existing request fingerprints remain immutable.
export async function requirePushSource(input, {stateDir, authorityDir = stateDir, chatId}) {
  const config = await pushConfiguration(authorityDir);
  const binding = config?.bindings.find(binding => binding.chatId === chatId);
  const required = binding?.requireFollowUp === true || input.requireFollowUp === true;
  if (required && !binding) fail('GROUP_NOT_CONNECTED');
  if (required && await realpath(stateDir) !== await realpath(authorityDir)) fail('BRIDGE_STATE_MISMATCH');
  if (required && binding.quoteRouting === false) fail('QUOTE_ROUTING_DISABLED');
  if (required && input.oneWay === true) {
    const exception = input.oneWayException;
    if (typeof exception !== 'string' || !Object.hasOwn(binding.oneWayExceptions ?? {}, exception)) fail('ONE_WAY_NOT_AUTHORIZED');
    return {required:false, exception};
  }
  if ((binding || required) && !input.sourceThreadId && input.oneWay !== true) fail('SOURCE_REQUIRED');
  if (required && !targetFor(binding,input.sourceThreadId)) fail('SOURCE_NOT_REGISTERED');
  return {required, config, binding};
}

export async function pushHealth({stateDir, appId, chatId, sourceThreadId}, {inspect = inspectAgentTarget, status = receiverStatus} = {}) {
  const config = await pushConfiguration(stateDir);
  const binding = config?.bindings.find(binding => binding.chatId === chatId);
  if (!binding || binding.quoteRouting === false) return {state:'unavailable',reason:'group_not_connected'};
  const target = targetFor(binding,sourceThreadId);
  if (!target && (binding.requireFollowUp || binding.threadId !== sourceThreadId)) return {state:'unavailable',reason:'source_not_registered'};
  const runtime = await status(appId);
  if (runtime.state !== 'running' || runtime.connection !== 'connected') return {state:'unavailable',reason:'receiver_offline'};
  if (path.resolve(runtime.stateDir ?? '') !== path.resolve(stateDir) || runtime.configDigest !== configurationDigest(config)) {
    return {state:'unavailable',reason:'receiver_configuration_not_loaded'};
  }
  const observed = await inspect({threadId:sourceThreadId,agentTarget:target,t3Command:config.t3Command,
    t3BaseDir:config.t3BaseDir,codex:config.codex,cwd:config.cwd,timeoutMs:5000});
  return observed.state === 'readable' ? {state:'ready'} : {state:'unavailable',reason:'target_unavailable'};
}

// Read-only snapshot; delivery receipts and current follow-up routing are independent.
export async function describePush(record, {stateDir, appId, outcome, health=pushHealth}) {
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
      if(record.requireFollowUp && followUp.state==='ready') {
        const runtime=await health({stateDir,appId,chatId:record.chatId,sourceThreadId:source});
        if(runtime.state!=='ready') followUp={state:'unavailable',reason:runtime.reason ?? 'health_unknown',sourceThreadId:source};
      }
    }
  } catch { followUp = {state:'unknown',reason:'routing_unreadable'}; }
  return {...record, delivery, followUp, checkedAt:new Date().toISOString()};
}
