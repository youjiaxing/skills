#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultStateDir } from './codex.mjs';
import { loadCredentials } from './feishu-credentials.mjs';
import { digest, validateBindings } from './feishu-core.mjs';
import { messageView } from './feishu-content.mjs';
import { readTransport, safeApiError, verifyChat, saveImage } from './feishu-context.mjs';

export function parseReadArgs(argv) {
  const args = [...argv], options = {};
  const commands = new Set(['history','message','image']);
  const keys = { '--chat':'chatId', '--message':'messageId', '--image-key':'imageKey', '--thread':'threadId',
    '--limit':'limit', '--page-token':'pageToken', '--start-time':'startTime', '--end-time':'endTime', '--state-dir':'stateDir' };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') return { help:true };
    if (arg === '--concise') { if(options.concise) throw new Error('Repeated concise option');options.concise=true;continue; }
    if (commands.has(arg) && !options.command) { options.command=arg; continue; }
    const key=keys[arg], value=args.shift();
    if (!key || !value || options[key] !== undefined) throw new Error('Invalid arguments');
    options[key] = value;
  }
  if (!options.command) return { help:true };
  if (!/^oc_[\w]+$/.test(options.chatId ?? '')) throw new Error('Explicit bound --chat required');
  options.limit = Number(options.limit ?? 20);
  if (!Number.isInteger(options.limit) || options.limit<1 || options.limit>50) throw new Error('limit must be 1–50');
  if (options.command !== 'history' && !/^om_[\w]+$/.test(options.messageId ?? '')) throw new Error('message required');
  if (options.command === 'image' && !/^img_[\w-]+$/.test(options.imageKey ?? '')) throw new Error('image-key required');
  for (const name of ['startTime','endTime']) if (options[name] && !/^\d{1,11}$/.test(options[name])) throw new Error('Times use epoch seconds');
  if (options.threadId && !/^omt_[\w-]+$/.test(options.threadId)) throw new Error('Invalid thread ID');
  if (options.threadId && (options.startTime || options.endTime)) throw new Error('Thread history does not support time range');
  return options;
}

export function historyView(data,options) {
  if(!Array.isArray(data?.items) || typeof data.has_more !== 'boolean') throw new Error('Invalid history response');
  const hasMore=data.has_more,nextPageToken=data.page_token ?? null;
  return {chatId:options.chatId,order:'newest_first',
    items:data.items.map(message=>messageView(verifyChat(message,options.chatId),{concise:options.concise})),
    hasMore,nextPageToken,complete:!hasMore,completenessScope:'requested_container_and_filters',
    ...(hasMore && !nextPageToken ? {warning:'pagination_incomplete'} : {}),
    note:options.threadId ? '当前话题范围' : '单页群历史；完整话题回复需用 thread ID 另查'};
}

export async function main(argv) {
  const options=parseReadArgs(argv);
  if (options.help) {
    console.log('Usage: node read-feishu.mjs history|message|image --chat oc_ID [options]\nhistory: --limit 1..50 --page-token TOKEN --start-time SECONDS --end-time SECONDS; or --thread omt_ID\nmessage: --message om_ID\nimage: --message om_ID --image-key img_KEY\n--concise: compact JSON, 2000 text characters per message with explicit truncation\nAll commands: --state-dir PATH; history requires a bound group, message/image verify the explicit source group. No messages sent.'); return;
  }
  const stateDir=path.resolve(options.stateDir ?? defaultStateDir());
  const config=validateBindings(JSON.parse(await readFile(path.join(stateDir,'feishu/bindings.json'),'utf8')));
  const credentials=await loadCredentials(stateDir), transport=readTransport(credentials);
  if (options.command === 'history') {
    if (!config.bindings.some(b=>b.chatId===options.chatId)) throw new Error('Group is not bound');
    const data=await transport.list(options);
    console.log(JSON.stringify(historyView(data,options)));
  } else {
    const message=await transport.get(options.messageId);
    if (message.chat_id!==options.chatId) throw new Error('Message belongs to a different or unknown group');
    if (options.command === 'message') console.log(JSON.stringify(messageView(message,{concise:options.concise})));
    else console.log(JSON.stringify({ messageId:message.message_id, localPath:await saveImage(transport,message,options.imageKey,
      path.join(stateDir,'feishu',digest(credentials.appId),'images')) }));
  }
}
try {
  if (realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2)).catch(error=>{
    console.log(JSON.stringify({ status:'error', message:'检查绑定群、参数、消息可见性及读取权限', reason:safeApiError(error) }));
    process.exitCode=2;
  });
} catch { /* Import only. */ }
