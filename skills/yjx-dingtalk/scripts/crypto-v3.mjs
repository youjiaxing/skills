import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PBKDF2_SALT = Buffer.from('666DingT', 'ascii');
const PAGE_SIZE = 4096;
const CONFIG_MAX_BYTES = 65536;
const LOG_TAIL_BYTES = 1048576;
const MAX_UID_CANDIDATES = 20;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');

/**
 * V3 layout: the account's user_config holds a base64 JSON document with a
 * salt; the real uid comes from the client's own log files. Neither value is
 * secret on its own, so nothing here is persisted.
 */
export function readSalt(accountDir) {
  const configPath = path.join(accountDir, 'user_config');
  const stat = fs.statSync(configPath);
  if (stat.size < 1 || stat.size > CONFIG_MAX_BYTES) {
    throw new Error('unexpected V3 configuration size: ' + stat.size + ' bytes');
  }
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new Error('V3 configuration is not base64-encoded JSON');
  }
  const salt = decoded && decoded.salt;
  if (typeof salt !== 'string' || salt.length === 0) throw new Error('V3 salt is absent');
  return salt;
}

/** Read a bounded tail of each recent log file and collect numeric uid candidates. */
export function collectUidCandidates(dataRoot, { logNames = [/^(gaea|cef_debug)\.log/], maxFiles = 3 } = {}) {
  const logDir = path.join(dataRoot, 'log');
  let entries;
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch (error) {
    throw new Error('log directory is unreadable: ' + logDir + ' (' + error.code + ')');
  }
  const files = entries
    .filter((entry) => entry.isFile() && logNames.some((pattern) => pattern.test(entry.name)))
    .map((entry) => {
      const file = path.join(logDir, entry.name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles);

  const candidates = [];
  for (const { file } of files) {
    const fd = fs.openSync(file, 'r');
    let buffer = null;
    try {
      const length = fs.fstatSync(fd).size;
      const size = Math.min(length, LOG_TAIL_BYTES);
      buffer = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const chunk = fs.readSync(fd, buffer, read, size - read, length - size + read);
        if (chunk === 0) break;
        read += chunk;
      }
      const text = buffer.subarray(0, read).toString('utf8');
      for (const match of text.matchAll(/(?:real_uid|myOpenId)\s*=\s*["']?(\d+)/g)) {
        if (!candidates.includes(match[1])) candidates.push(match[1]);
        if (candidates.length > MAX_UID_CANDIDATES) throw new Error('uid candidate limit reached');
      }
    } finally {
      fs.closeSync(fd);
      if (buffer) buffer.fill(0);
    }
  }
  return candidates;
}

export function deriveKey(uid, salt) {
  const password = Buffer.from(uid + salt, 'utf8');
  const derived = crypto.pbkdf2Sync(password, PBKDF2_SALT, 1000, 32, 'sha1');
  const hex = crypto.createHash('md5').update(derived).digest('hex');
  const key = Buffer.from(hex.slice(0, 16), 'ascii');
  password.fill(0);
  derived.fill(0);
  return key;
}

export function looksLikeSqlitePage(page) {
  if (page.length < 100) return false;
  if (!page.subarray(0, 16).equals(SQLITE_MAGIC)) return false;
  const pageSize = page.readUInt16BE(16) === 1 ? 65536 : page.readUInt16BE(16);
  if (pageSize !== PAGE_SIZE) return false;
  if (page[21] !== 64 || page[22] !== 32 || page[23] !== 32) return false;
  return (page[18] === 1 || page[18] === 2) && (page[19] === 1 || page[19] === 2);
}

/** Resolve the AES key by testing uid candidates against the database's first page. */
export function resolveDatabaseKey({ dataRoot, accountDir, dbPath }) {
  const salt = readSalt(accountDir);
  const candidates = collectUidCandidates(dataRoot);
  if (candidates.length === 0) throw new Error('no uid candidate found in recent client logs');
  const fd = fs.openSync(dbPath, 'r');
  const first = Buffer.alloc(PAGE_SIZE);
  try {
    let read = 0;
    while (read < PAGE_SIZE) {
      const chunk = fs.readSync(fd, first, read, PAGE_SIZE - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    if (read !== PAGE_SIZE) throw new Error('short read on database first page');
  } finally {
    fs.closeSync(fd);
  }
  try {
    for (const uid of candidates) {
      const key = deriveKey(uid, salt);
      const page = decryptPages(first, key);
      const valid = looksLikeSqlitePage(page);
      page.fill(0);
      if (valid) return { key, uid, candidatesTried: candidates.length };
      key.fill(0);
    }
    throw new Error('no uid candidate produced a valid SQLite header (' + candidates.length + ' tried)');
  } finally {
    first.fill(0);
  }
}

export function decryptPages(buffer, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

export { PAGE_SIZE, SQLITE_MAGIC };
