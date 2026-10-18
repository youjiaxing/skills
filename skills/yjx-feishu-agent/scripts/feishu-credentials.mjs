import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { defaultStateDir } from './codex.mjs';

export function credentialsPath(stateDir = defaultStateDir()) {
  return path.join(path.resolve(stateDir), 'secrets', 'feishu.json');
}

export function validateCredentials({ appId, appSecret }) {
  if (typeof appId !== 'string' || !/^cli_[a-zA-Z0-9]+$/.test(appId)) {
    throw new Error('App ID must have the form cli_...');
  }
  if (typeof appSecret !== 'string' || !appSecret.length || appSecret.length > 4096 || /\s/.test(appSecret)) {
    throw new Error('App Secret must contain 1-4096 characters without whitespace');
  }
  return { appId, appSecret };
}

export async function saveCredentials(input, stateDir) {
  const credentials = validateCredentials(input);
  const target = credentialsPath(stateDir);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(target, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Credentials already exist; nothing was overwritten');
    throw new Error('Cannot create credential file');
  }
  try {
    await file.writeFile(`${JSON.stringify({ version: 1, protection: 'file-permissions', ...credentials }, null, 2)}\n`);
    await file.sync();
  } catch {
    await file.close();
    await rm(target, { force: true });
    throw new Error('Cannot save credential file');
  }
  await file.close();
  return target;
}

export async function loadCredentials(stateDir) {
  let document;
  try { document = JSON.parse(await readFile(credentialsPath(stateDir), 'utf8')); }
  catch { throw new Error('Cannot read credentials; run setup-feishu.mjs in your terminal'); }
  if (document.protection === 'windows-dpapi-current-user') {
    throw new Error('Legacy Windows DPAPI credentials are unsupported; move that file aside and run setup-feishu.mjs');
  }
  if (document.version !== 1 || document.protection !== 'file-permissions') {
    throw new Error('Unsupported credential file format');
  }
  return validateCredentials(document);
}
