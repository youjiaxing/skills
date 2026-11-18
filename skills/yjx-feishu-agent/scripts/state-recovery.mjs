import {readFile,mkdir,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';

function alive(pid) {
  try { process.kill(pid,0);return true; }
  catch(error) { return error.code==='ESRCH' ? false : null; }
}
// For acknowledged outbound recovery only. Pending journals still decide what effects occurred.
export async function recoverAcknowledgedLock(stateDir,name) {
  if(!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid recovery lock');
  const directory=path.join(stateDir,'locks',name),ownerFile=path.join(directory,'owner.json');
  let owner;
  try { owner=JSON.parse(await readFile(ownerFile,'utf8')); }
  catch(error) { if(error.code==='ENOENT') return false;throw error; }
  if(!Number.isSafeInteger(owner.pid) || owner.pid<1 || typeof owner.token!=='string' || !owner.token || alive(owner.pid)!==false) return false;
  const mutex=`${directory}.recovery`;
  try { await mkdir(mutex); }
  catch(error) { if(error.code==='EEXIST') throw new Error('Recovery control lock requires inspection');throw error; }
  try {
    const current=JSON.parse(await readFile(ownerFile,'utf8'));
    if(current.pid!==owner.pid || current.token!==owner.token || alive(current.pid)!==false) return false;
    await unlink(ownerFile);await rmdir(directory);return true;
  } finally { await rmdir(mutex); }
}
