import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { lockThread } from './state.mjs';
import { writeJournal } from './feishu-core.mjs';
import { versionReceipt } from './feishu-content.mjs';
import { resolveContext } from './feishu-context.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export function ledgerPath(stateDir,appId,item) {
  return path.join(stateDir,'feishu',hash(appId),'context',hash(`${item.binding.chatId}:${item.binding.threadId}`)+'.json');
}
async function readLedger(file) {
  try {
    const data=JSON.parse(await readFile(file,'utf8'));
    if (data.version!==1 || !data.messages || typeof data.messages!=='object' || Array.isArray(data.messages) ||
      Object.values(data.messages).some(m=>!m || !/^[a-f0-9]{64}$/.test(m.version) || !Number.isFinite(m.observedAt)) ||
      (data.bootstrapCutoff!==undefined && (!Number.isSafeInteger(data.bootstrapCutoff) || data.bootstrapCutoff<=0))) {
      throw new Error('Invalid context ledger');
    }
    return data;
  } catch(e) { if(e.code==='ENOENT')return {version:1,messages:{}};throw e; }
}
export async function commitVersions(file,receipts,bootstrapCutoff) {
  const root=path.dirname(file);
  const release=await lockThread(root,path.basename(file,'.json'),performance.now()+5000);
  if(!release)throw new Error('Context ledger busy');
  try {
    const ledger=await readLedger(file);
    if (!ledger.bootstrapCutoff && Number.isSafeInteger(bootstrapCutoff) && bootstrapCutoff>0) {
      ledger.bootstrapCutoff=bootstrapCutoff;
    }
    for(const receipt of receipts) {
      if(!receipt.messageId)continue;
      const previous=ledger.messages[receipt.messageId];
      if(previous && previous.observedAt>receipt.observedAt)continue;
      ledger.messages[receipt.messageId]={version:receipt.version,observedAt:receipt.observedAt,confirmedAt:Date.now()};
    }
    const entries=Object.entries(ledger.messages).sort((a,b)=>b[1].observedAt-a[1].observedAt).slice(0,1000);
    ledger.messages=Object.fromEntries(entries);
    await mkdir(root,{recursive:true,mode:0o700});
    await writeJournal(file,ledger);
  } finally {await release();}
}

export function createContextManager({stateDir,appId,...dependencies}) {
  return {
    async prepare(item) {
      const file=ledgerPath(stateDir,appId,item),receipts=[];
      let ledger={messages:{}},ledgerUnavailable=false;
      try {ledger=await readLedger(file);} catch {ledgerUnavailable=true;}
      const text=await resolveContext(item,{...dependencies,knownVersions:ledger.messages,
        bootstrapCutoff:ledger.bootstrapCutoff,receipts,ledgerUnavailable});
      return {text,receipts,file,bootstrapCutoff:ledger.bootstrapCutoff ?? Number(item.source?.create_time)};
    },
    async confirm(prepared) {await commitVersions(prepared.file,prepared.receipts,prepared.bootstrapCutoff);},
    async confirmReply(item,message) {await commitVersions(ledgerPath(stateDir,appId,item),[versionReceipt(message)]);},
  };
}
