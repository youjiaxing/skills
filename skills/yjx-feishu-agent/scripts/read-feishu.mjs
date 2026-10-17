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

export async function main(argv) {
  const options=parseReadArgs(argv);
  if (options.help) {
    console.log('Usage: node read-feishu.mjs history|message|image --chat oc_ID [options]\nhistory: --limit 1..50 --page-token TOKEN --start-time SECONDS --end-time SECONDS; or --thread omt_ID\nmessage: --message om_ID\nimage: --message om_ID --image-key img_KEY\nAll commands: --state-dir PATH; reads only explicitly bound groups. No messages sent.'); return;
  }
  const stateDir=path.resolve(options.stateDir ?? defaultStateDir());
  const config=validateBindings(JSON.parse(await readFile(path.join(stateDir,'feishu/bindings.json'),'utf8')));
  if (!config.bindings.some(b=>b.chatId===options.chatId)) throw new Error('Group is not bound');
  const credentials=await loadCredentials(stateDir), transport=readTransport(credentials);
  if (options.command === 'history') {
    const data=await transport.list(options);
    const items=(data.items ?? []).map(m=>messageView(verifyChat(m,options.chatId)));
    console.log(JSON.stringify({ chatId:options.chatId, order:'newest_first', items,
      hasMore:Boolean(data.has_more), nextPageToken:data.page_token ?? null,
      note:options.threadId ? '话题历史' : '单页群历史；完整话题回复需用 thread ID 另查' }));
  } else {
    const message=verifyChat(await transport.get(options.messageId),options.chatId);
    if (options.command === 'message') console.log(JSON.stringify(messageView(message)));
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
