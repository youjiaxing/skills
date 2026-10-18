#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultStateDir } from './codex.mjs';
import { loadCredentials } from './feishu-credentials.mjs';
import { diagnoseMessage } from './message-diagnostics.mjs';

export async function main(argv) {
  if (!argv.length || argv.includes('--help')) { console.log('Usage: node diagnose-message.mjs --message om_ID [--state-dir PATH]\nLocal read-only evidence; never replays requests or contacts Feishu.');return; }
  const options={};
  for(let i=0;i<argv.length;i+=2) {
    const key={'--message':'messageId','--state-dir':'stateDir'}[argv[i]];
    if(!key || options[key] || !argv[i+1]) throw new Error('Invalid arguments');
    options[key]=argv[i+1];
  }
  if(!/^om_[\w]+$/.test(options.messageId ?? '')) throw new Error('Explicit message ID required');
  const stateDir=path.resolve(options.stateDir ?? defaultStateDir());
  const {appId}=await loadCredentials(stateDir);
  console.log(JSON.stringify(await diagnoseMessage({stateDir,appId,messageId:options.messageId})));
}
try {
  if(realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2)).catch(()=>{
    console.log('{"status":"error","code":"LOCAL_DIAGNOSTIC_FAILED"}');process.exitCode=2;
  });
} catch { /* Import only. */ }
