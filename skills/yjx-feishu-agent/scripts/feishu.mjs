#!/usr/bin/env node
import * as Lark from '@larksuiteoapi/node-sdk';
import { realpathSync } from 'node:fs';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadCredentials } from './feishu-credentials.mjs';
import { defaultStateDir } from './codex.mjs';
import { lockThread } from './state.mjs';
import { createReceiver, digest, validateBindings, writeJournal } from './feishu-core.mjs';
import { receiverPaths, readJson, atomicJson } from './receiver-runtime.mjs';
import { readTransport, resolveContext } from './feishu-context.mjs';
import { createMessageRouter } from './message-routes.mjs';
import { createProcessingFeedback } from './processing-feedback.mjs';
import { reactionTransport } from './reaction-transport.mjs';

const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function args(argv) {
  const command = argv.shift();
  if (!command || command === '--help') return { help: true };
  if (!['diagnose', 'discover', 'bind', 'serve'].includes(command)) throw new Error('Unknown command');
  const result = { command };
  const keys = { '--state-dir': 'stateDir', '--chat': 'chatId', '--user': 'user', '--thread': 'threadId', '--codex': 'codex', '--cwd': 'cwd' };
  while (argv.length) {
    const key = keys[argv.shift()];
    const value = argv.shift();
    if (!key || !value || result[key]) throw new Error('Invalid command arguments');
    result[key] = value;
  }
  return result;
}

async function api(operation) {
  try {
    const response = await operation();
    if (response?.code !== 0) {
      const code = Number.isSafeInteger(response?.code) ? response.code : 'missing';
      const failure = new Error(`Feishu API rejected request (code ${code})`);
      failure.safe = true;
      failure.apiCode = code;
      throw failure;
    }
    return response;
  } catch (error) {
    if (error.safe) throw error;
    const status = Number.isSafeInteger(error.response?.status) ? error.response.status : 'unavailable';
    // TokenManager converts HTTP-200 token failures into a message. Extract
    // only its numeric code, never the raw message or request configuration.
    const tokenCode = /^failed to get \w+, code: (\d+),/.exec(error.message ?? '')?.[1];
    const code = Number.isSafeInteger(error.response?.data?.code) ? error.response.data.code : (tokenCode ?? 'unavailable');
    const failure = new Error(`Feishu API failed (HTTP ${status}, code ${code})`);
    failure.safe = true;
    failure.apiCode = Number(code);
    throw failure;
  }
}

async function pages(operation) {
  const items = [];
  let token;
  const seen = new Set();
  do {
    const response = await api(() => operation(token));
    items.push(...(response.data?.items ?? []));
    if (!response.data?.has_more) return items;
    token = response.data.page_token;
    if (!token || seen.has(token)) throw new Error('Feishu pagination did not advance');
    seen.add(token);
  } while (seen.size < 100);
  throw new Error('Feishu pagination limit');
}

export async function main(argv) {
  const options = args([...argv]);
  if (options.help) {
    process.stdout.write('Usage: node feishu.mjs diagnose|discover|bind|serve [--state-dir PATH]\nBind: --chat oc_... --user ou_... [--thread DEFAULT_UUID] [--codex PATH] [--cwd PATH]\nQuote routing is on by default. Omitting --thread authorizes quote-only access without choosing a default chat.\nOnly bound groups and users with an explicit @bot text message are forwarded.\n');
    return;
  }
  const stateDir = path.resolve(options.stateDir ?? defaultStateDir());
  const configFile = path.join(stateDir, 'feishu', 'bindings.json');
  if (options.command === 'bind') {
    const credentials = await loadCredentials(stateDir);
    const releaseConfig = await lockThread(path.join(os.homedir(), '.yjx-feishu-agent-receivers'), digest(credentials.appId), performance.now());
    if (!releaseConfig) throw new Error('Stop receiver before changing bindings');
    try {
    let config;
    try { config = JSON.parse(await readFile(configFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read group bindings'); config = { version: 1, bindings: [] }; }
    if (config.bindings.some((binding) => binding.chatId === options.chatId)) throw new Error('Group already bound; edit bindings.json intentionally to change it');
    config.bindings.push({ chatId: options.chatId, users: [options.user], threadId: options.threadId });
    if (options.codex) config.codex = path.resolve(options.codex);
    if (options.cwd) config.cwd = path.resolve(options.cwd);
    validateBindings(config);
    await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
    await writeJournal(configFile, config);
    print({ status: 'bound', chatId: options.chatId, threadId: options.threadId });
    return;
    } finally { await releaseConfig(); }
  }
  const credentials = await loadCredentials(stateDir);
  if (options.command === 'diagnose') {
    let response;
    let body;
    try {
      response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
        signal: AbortSignal.timeout(15000),
      });
      body = await response.json();
    } catch { throw new Error('Token diagnostic request failed'); }
    const available = body.code === 0 && typeof body.tenant_access_token === 'string';
    print({ type: 'diagnosis', httpStatus: response.status, code: Number.isSafeInteger(body.code) ? body.code : null,
      tokenAvailable: available, logId: response.headers.get('x-tt-logid'),
      category: body.code === 21001 ? 'access_control_denied' : (available ? 'ok' : 'token_unavailable') });
    if (!available) process.exitCode = 2;
    return;
  }
  // The SDK's exported default transport otherwise has no request deadline.
  Lark.defaultHttpInstance.defaults.timeout = 15000;
  const client = new Lark.Client({ ...credentials, logger });
  const identity = await api(() => client.request({ url: '/open-apis/bot/v3/info', method: 'GET' }));
  const botId = identity.bot?.open_id;
  if (!botId) throw new Error('Bot identity is unavailable');
  if (options.command === 'discover') {
    const groups = await pages((page_token) => client.im.v1.chat.list({ params: { page_size: 100, page_token, user_id_type: 'open_id' } }));
    const result = [];
    for (const group of groups) {
      const item = { chatId: group.chat_id, name: group.name, ownerId: group.owner_id,
        ownerIdType: group.owner_id_type, members: [] };
      try {
        const members = await pages((page_token) => client.im.v1.chatMembers.get({
          path: { chat_id: group.chat_id }, params: { member_id_type: 'open_id', page_size: 100, page_token },
        }));
        item.members = members.map((member) => ({ id: member.member_id, name: member.name, type: member.member_id_type }));
      } catch (error) {
        if (error.apiCode !== 99991672) throw error;
        item.memberQuery = 'permission_required';
      }
      result.push(item);
    }
    print({ botId, groups: result });
    return;
  }
  // Stable per-account/app lock, regardless of custom journal directories.
  const lockHome = path.join(os.homedir(), '.yjx-feishu-agent-receivers');
  const release = await lockThread(lockHome, digest(credentials.appId), performance.now());
  if (!release) throw new Error('Another receiver or leftover receiver lock exists; inspect before recovery');
  let config;
  try { config = validateBindings(JSON.parse(await readFile(configFile, 'utf8'))); }
  catch { await release(); throw new Error('Missing or invalid bindings.json; bind a group first'); }
  const runtimePaths = receiverPaths(credentials.appId);
  const owner = await readJson(path.join(runtimePaths.lock, 'owner.json'));
  let lastPublishedConnection;
  const publish = async (connection) => {
    const updatedAt = new Date().toISOString();
    await atomicJson(path.join(runtimePaths.runtime, 'status.json'), {
      pid: process.pid, token: owner.token, stateDir, connection, updatedAt,
    });
    if (connection !== lastPublishedConnection) {
      await appendFile(path.join(runtimePaths.runtime, 'connection-events.ndjson'),
        `${JSON.stringify({ pid: process.pid, connection, updatedAt })}\n`, { mode: 0o600 });
      lastPublishedConnection = connection;
    }
  };
  const ws = new Lark.WSClient({ ...credentials, logger });
  const contextTransport = readTransport(credentials);
  const contextOptions = {transport:contextTransport,
    imageDirectory:path.join(stateDir,'feishu',digest(credentials.appId),'images'),
    contextStateDir:path.resolve(stateDir)===defaultStateDir({}) ? undefined : stateDir,
  };
  const router = createMessageRouter({stateDir,appId:credentials.appId});
  const feedback = createProcessingFeedback({stateDir, appId:credentials.appId,
    transport:reactionTransport(credentials), log:print});
  const receiver = createReceiver({ appId: credentials.appId, botId, config, stateDir, log: print,
    feedback,
    context:item => resolveContext(item,contextOptions), admitRoute:router.admit, confirmReply:router.rememberReply,
    async reply(messageId, answer, requestId) {
      // One bounded text response; keep UUID stable for Feishu deduplication.
      const text = answer.length > 6000 ? `${answer.slice(0, 6000)}\n\n（回答过长，完整内容请在 Codex 查看。）` : answer;
      const response = await api(() => client.im.v1.message.reply({ path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }), uuid: digest(requestId).slice(0, 32) } }));
      return {message_id:response.data?.message_id,msg_type:'text',body:{content:JSON.stringify({text})}};
    },
  });
  let stopping = false;
  const stop = () => { stopping = true; ws.close({ force: true }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await publish('starting');
    await feedback.recover();
    const unsettled = await receiver.unsettled();
    if (unsettled.length) print({ type: 'unsettled', requests: unsettled });
    await ws.start({ eventDispatcher: new Lark.EventDispatcher({ logger }).register({
      'im.message.receive_v1': (data) => receiver.handle(data),
    }) });
    let previous;
    const deadline = Date.now() + 30000;
    let connected = false;
    let heartbeatAt = 0;
    while (!stopping) {
      const state = ws.getConnectionStatus().state;
      if (state !== previous) { print({ type: 'connection', state }); previous = state; }
      if (Date.now() - heartbeatAt > 1000) { await publish(state); heartbeatAt = Date.now(); }
      const control = await readJson(path.join(runtimePaths.runtime, 'stop.json'));
      if (control?.pid === process.pid && control?.token === owner.token) { stop(); break; }
      if (state === 'connected') connected = true;
      if (state === 'failed' || (!connected && Date.now() > deadline)) throw new Error('Feishu long connection could not be established');
      await delay(500);
    }
  } finally {
    ws.close({ force: true });
    try { await receiver.stop(); await feedback.stop(); }
    finally {
      try { await publish('stopped'); }
      finally {
        await release();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    }
  }
}

try {
  if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).catch((error) => {
      // Never serialize SDK/Axios errors: they can contain credentials and tokens.
      process.stderr.write(error.safe ? `${error.message}\n` : 'Feishu command failed. Check permissions, network, local bindings and receiver locks.\n');
      process.exitCode = 1;
    });
  }
} catch { /* Import only. */ }
