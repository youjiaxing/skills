import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
const MANIFEST_NAME = 'manifest.json';

/**
 * Resolve the cache root. The override is rejected unless it is an absolute,
 * non-UNC, non-symlink path, so a mistyped or hostile value cannot silently
 * redirect plaintext into a working tree or a network share.
 */
export function resolveCacheRoot(env = process.env) {
  const override = env.YJX_DINGTALK_HOME;
  if (override !== undefined && override !== null && String(override).trim() !== '') {
    const value = String(override).trim();
    if (value.startsWith('\\\\') || value.startsWith('//')) {
      throw new Error('YJX_DINGTALK_HOME rejects UNC or network share paths: ' + value);
    }
    if (!path.isAbsolute(value)) {
      throw new Error('YJX_DINGTALK_HOME must be an absolute path: ' + value);
    }
    const resolved = path.resolve(value);
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error('YJX_DINGTALK_HOME must not be a symbolic link: ' + resolved);
    }
    return { root: resolved, source: 'override' };
  }
  const home = os.homedir();
  if (!home || !path.isAbsolute(home)) {
    throw new Error('no usable home directory; set YJX_DINGTALK_HOME to an absolute writable path');
  }
  return { root: path.join(home, '.yjx-dingtalk'), source: 'default' };
}

export function ensureCacheRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
  tightenDirectory(root);
  return root;
}

/** On POSIX, narrow an over-permissive directory instead of refusing outright. */
function tightenDirectory(target) {
  if (process.platform === 'win32') return;
  const stat = fs.statSync(target);
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(target, DIR_MODE);
}

export function readManifest(root) {
  const manifestPath = path.join(root, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { entries: [], missing: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [], corrupt: true };
    return { entries: parsed.entries };
  } catch {
    return { entries: [], corrupt: true };
  }
}

export function writeManifest(root, entries) {
  const manifestPath = path.join(root, MANIFEST_NAME);
  const payload = JSON.stringify({ version: 1, entries }, null, 2);
  fs.writeFileSync(manifestPath, payload, { mode: FILE_MODE });
  if (process.platform !== 'win32') fs.chmodSync(manifestPath, FILE_MODE);
  return manifestPath;
}

export function newTaskId() {
  return crypto.randomUUID();
}

/**
 * Every artifact the skill creates lives under a task directory and is recorded
 * in the manifest, so cleanup never has to guess from a directory listing.
 */
export function taskPaths(root, { taskId, accountId }) {
  const dir = path.join(root, 'tasks', taskId);
  return {
    dir,
    accountDir: path.join(dir, accountId),
    keyFile: path.join(dir, 'key.json'),
    logFile: path.join(dir, 'session.log'),
  };
}

export function registerEntry(entries, entry) {
  const filtered = entries.filter((item) => item.path !== entry.path);
  filtered.push(entry);
  return filtered;
}

export function fileSuffixes(filePath) {
  return [filePath, filePath + '-wal', filePath + '-shm'];
}

/**
 * Remove only manifest-registered artifacts. A missing or corrupt manifest is
 * reported instead of falling back to a recursive delete of the cache root.
 */
export function cleanArtifacts(root, { now = Date.now(), idleMs = 24 * 3600 * 1000, force = false } = {}) {
  const manifest = readManifest(root);
  if (manifest.missing || manifest.corrupt) {
    return { removed: [], kept: manifest.entries.length, skipped: true, reason: manifest.missing ? 'manifest missing' : 'manifest corrupt' };
  }
  const removed = [];
  const kept = [];
  for (const entry of manifest.entries) {
    if (entry.retained && !force) {
      kept.push({ ...entry, keptBecause: 'marked retained' });
      continue;
    }
    const lastUse = entry.lastUsedAt ?? entry.createdAt ?? 0;
    const expired = now - lastUse >= idleMs;
    if (!force && !expired) {
      kept.push({ ...entry, keptBecause: 'active' });
      continue;
    }
    for (const target of fileSuffixes(entry.path)) {
      if (!isInside(root, target)) continue;
      try { fs.rmSync(target, { force: true }); } catch { /* reported below */ }
    }
    removed.push(entry);
  }
  writeManifest(root, kept);
  return { removed, kept: kept.length, skipped: false };
}

/** Path containment check so a stale manifest entry cannot reach outside the cache. */
export function isInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (relative === '' || relative.startsWith('..')) return false;
  if (path.isAbsolute(relative)) return false;
  let current = base;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch { return true; }
  }
  return true;
}

/**
 * Drop directories left empty by cleanup. Only empty directories are removed, and
 * the cache root itself is never a candidate, so this cannot touch retained data.
 */
export function pruneEmptyTaskDirs(root) {
  const tasksRoot = path.join(root, 'tasks');
  if (!fs.existsSync(tasksRoot)) return [];
  const removed = [];
  const prune = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      prune(child);
      if (fs.readdirSync(child).length === 0) { fs.rmdirSync(child); removed.push(child); }
    }
  };
  prune(tasksRoot);
  return removed;
}

export { MANIFEST_NAME };
