import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const repository = 'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
const packageName = /^OpenAI\.Codex_\d+(?:\.\d+){3}_(?:x64|arm64)__2p2nqsd0c76g0$/;
let verifiedCopy;

function unavailable(reason) {
  return Object.assign(new Error(`Codex Desktop executable unavailable (${reason}). Check the current user's Desktop installation.`),
    { code: 'CODEX_NOT_FOUND' });
}

// Query the current user's registered package, never old hash directories or PATH.
// This Windows packaging layout is verified locally, not a public Codex API.
export async function registeredDesktopCodex({ platform = process.platform,
  query = async args => (await execute('reg.exe', args, { windowsHide: true, timeout: 5000,
    maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })).stdout,
  accessible = access,
} = {}) {
  if (platform !== 'win32') throw unavailable('Windows discovery is not supported on this platform');
  let listing;
  try { listing = await query(['query', repository]); }
  catch { throw unavailable('package registry cannot be read'); }
  const names = [...new Set(listing.split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith(`${repository}\\`))
    .map(line => line.slice(repository.length + 1)).filter(name => packageName.test(name)))];
  const candidates = [];
  for (const name of names) {
    let details;
    try { details = await query(['query', `${repository}\\${name}`, '/v', 'PackageRootFolder']); }
    catch { throw unavailable('registered package location cannot be read'); }
    const root = details.match(/^\s*PackageRootFolder\s+REG_SZ\s+(.+?)\s*$/m)?.[1];
    if (!root || !path.win32.isAbsolute(root) || path.win32.basename(root) !== name) {
      throw unavailable('registered package location is invalid');
    }
    const binary = path.win32.join(root, 'app', 'resources', 'codex.exe');
    try { await accessible(binary); candidates.push(binary); }
    catch (error) {
      if (error.code !== 'ENOENT') throw unavailable('registered executable cannot be accessed');
    }
  }
  if (candidates.length !== 1) throw unavailable(candidates.length ? 'multiple registered executables' : 'no registered executable');
  return candidates[0];
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function fingerprint(file) {
  const info = await stat(file);
  if (!info.isFile()) throw unavailable('executable is not a file');
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

// WindowsApps denies direct spawn on this machine. Desktop exports runnable
// copies; identify the correct one by content equality with the registered app.
export async function resolveDesktopCodex({ registered = registeredDesktopCodex,
  directory = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin'),
  list = readdir, inspect = fingerprint, hash = sha256,
} = {}) {
  try {
    const source = await registered();
    const sourceStamp = await inspect(source);
    if (verifiedCopy?.source === source && verifiedCopy.sourceStamp === sourceStamp &&
        verifiedCopy.directory === directory) {
      try { if (await inspect(verifiedCopy.binary) === verifiedCopy.binaryStamp) return verifiedCopy.binary; }
      catch { /* Recheck exported copies below; no task has been submitted. */ }
    }
    const sourceHash = await hash(source);
    const matches = [];
    for (const name of await list(directory)) {
      if (!/^[a-f0-9]{16}$/.test(name)) continue;
      const binary = path.join(directory, name, 'codex.exe');
      let stamp;
      try { stamp = await inspect(binary); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stamp.split(':')[0] !== sourceStamp.split(':')[0]) continue;
      if (await hash(binary) === sourceHash && await inspect(binary) === stamp) matches.push({ binary, binaryStamp: stamp });
    }
    // Ensure an update did not replace the source while hashing its export.
    if (await inspect(source) !== sourceStamp) throw unavailable('installation changed during discovery');
    if (!matches.length) throw unavailable('Desktop has not exported a matching executable; open Desktop first');
    matches.sort((a, b) => a.binary.localeCompare(b.binary));
    verifiedCopy = { source, sourceStamp, directory, ...matches[0] };
    return verifiedCopy.binary;
  } catch (error) {
    if (error.code === 'CODEX_NOT_FOUND') throw error;
    throw unavailable('cannot verify Desktop executable copy');
  }
}
