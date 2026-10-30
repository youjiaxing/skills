import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const repository = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const names = new Set(['config.json', 'state.json', 'lock.json', 'lock.reclaim']);
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const isNetwork = p => /^(\\\\|\/\/)/.test(p) || /^\\\\\?\\/i.test(p);

function projectedRealPath(target) {
  const tail = [];
  let base = target;
  while (!fs.existsSync(base)) {
    // A dangling link must not become a new directory.
    try { fs.lstatSync(base); throw new Error('私有目录存在失效链接'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    tail.unshift(path.basename(base));
    const parent = path.dirname(base);
    if (parent === base) throw new Error('无法定位已有祖先目录');
    base = parent;
  }
  return path.join(fs.realpathSync(base), ...tail);
}

export function privateRoot(input = process.env.YJX_TASK_HUB_HOME ?? path.join(os.homedir(), '.yjx-task-hub'), create = false) {
  if (!path.isAbsolute(input) || isNetwork(input) || input.split(/[\\/]/).includes('..')) throw new Error('私有根目录需要无穿越的本地绝对路径');
  const root = projectedRealPath(input);
  if (isNetwork(root) || inside(repository, root)) throw new Error('私有目录必须位于公开 skill 仓库之外');
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) throw new Error('私有运行数据应存于 Git 工作树之外');
    if (dir === path.dirname(dir)) break;
  }
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

export function safeFile(root, name) {
  if (!names.has(name)) throw new Error('不支持的私有文件');
  if (fs.realpathSync(root) !== root) throw new Error('私有根路径已变更');
  const file = path.join(root, name);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !inside(root, fs.realpathSync(file))) throw new Error('拒绝私有文件链接/硬链接或非普通文件');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return file;
}

export function readJson(root, name, fallback) {
  try { return JSON.parse(fs.readFileSync(safeFile(root, name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw e; }
}

export function atomicJson(root, name, value) {
  const dest = safeFile(root, name);
  const temp = path.join(root, `.${name}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    safeFile(root, name);
    fs.renameSync(temp, dest);
    if (process.platform !== 'win32') {
      const dirFd = fs.openSync(root, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function validateConfig(c) {
  if (!c || c.version !== 1 || !/^[a-f0-9-]{32,36}$/i.test(c.notionDatabaseId) || !/^collection:\/\/[a-f0-9-]{36}$/i.test(c.notionDataSourceId) || !/^[a-f0-9]{24}$/.test(c.tbUserId)) throw new Error('配置缺少已核实的 Notion/TB 绑定');
  if (!Number.isInteger(c.activeWindowDays) || c.activeWindowDays < 1) throw new Error('activeWindowDays 必须为正整数');
  for (const name of ['watchedTasks', 'ignoredTaskIds']) if (!Array.isArray(c[name]) || c[name].some(x => !/^[a-f0-9]{24}$/.test(x))) throw new Error(`${name} 必须是 taskId 数组`);
  if (c.watchedTasks.some(x => c.ignoredTaskIds.includes(x))) throw new Error('显式跟进不能同时被忽略');
  return c;
}

export function acquireLock(root) {
  const lock = { lockId: randomUUID(), pid: process.pid, processStartTime: new Date().toISOString(), createdAt: new Date().toISOString() };
  const writeLock = () => {
    const fd = fs.openSync(safeFile(root, 'lock.json'), 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(lock)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  try { writeLock(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const old = readJson(root, 'lock.json');
    if (!Number.isInteger(old.pid) || old.pid <= 0 || !old.lockId) throw new Error('锁内容不完整，需人工核查');
    try { process.kill(old.pid, 0); throw new Error('已有同步会话持锁，先结束原会话'); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
    const reclaim = safeFile(root, 'lock.reclaim');
    let fd;
    try { fd = fs.openSync(reclaim, 'wx', 0o600); } catch { throw new Error('恢复锁被占用，需等待或核查持有者'); }
    try {
      fs.writeFileSync(fd, JSON.stringify(lock)); fs.fsyncSync(fd);
      const current = readJson(root, 'lock.json');
      if (current.lockId !== old.lockId) throw new Error('主锁已经换代，本次放弃接管');
      fs.unlinkSync(safeFile(root, 'lock.json'));
      writeLock();
    } finally { fs.closeSync(fd); fs.unlinkSync(reclaim); }
  }
  return {
    ...lock,
    release() {
      if (readJson(root, 'lock.json').lockId !== lock.lockId) throw new Error('锁归属不符，拒绝释放');
      fs.unlinkSync(safeFile(root, 'lock.json'));
    },
  };
}
