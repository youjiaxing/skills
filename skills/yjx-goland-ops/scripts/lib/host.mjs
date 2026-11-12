import { access, mkdir, readFile, readdir, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class OpsError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function locationIdentity(value) {
  if (value == null) return '';
  const actual = await realpath(value).catch(() => path.resolve(value));
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
}
async function sameLocation(a, b) { return await locationIdentity(a) === await locationIdentity(b); }
export function dataHome(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'yjx-goland-ops');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'yjx-goland-ops');
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'yjx-goland-ops');
}
export async function privateDirectory(p) { await mkdir(p, { recursive: true, mode: 0o700 }); return p; }
export async function atomicText(p, text) {
  await privateDirectory(path.dirname(p));
  const temporary = p + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, p); }
  finally { await rm(temporary, { force: true }); }
}
export async function atomicJSON(p, data) { return atomicText(p, JSON.stringify(data, null, 2) + '\n'); }
export async function jsonFile(p) { return JSON.parse(await readFile(p, 'utf8')); }
export function inside(root, p) {
  const relative = path.relative(path.resolve(root), path.resolve(p));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export async function profilePID(profile) {
  try {
    const contents = (await readFile(path.join(profile, '.lock'), 'utf8')).trim();
    if (!/^[0-9]+$/.test(contents)) return null;
    const pid = Number(contents);
    return processAlive(pid) ? pid : null;
  } catch { return null; }
}
function configBase(platform, env, home) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'JetBrains');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'JetBrains');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'JetBrains');
}
async function directories(parent, pattern) {
  try { return (await readdir(parent, { withFileTypes: true })).filter(e => e.isDirectory() && pattern.test(e.name)).map(e => path.join(parent, e.name)); }
  catch { return []; }
}
export async function discoverLaunchers(platform = process.platform, env = process.env, home = os.homedir()) {
  const candidates = [];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'GoLand', 'bin', 'goland64.exe'));
    for (const dir of await directories(path.join(env.ProgramFiles || 'C:/Program Files', 'JetBrains'), /^GoLand/i)) candidates.push(path.join(dir, 'bin', 'goland64.exe'));
  } else if (platform === 'darwin') {
    for (const parent of ['/Applications', path.join(home, 'Applications')])
      for (const dir of await directories(parent, /^GoLand.*\.app$/)) candidates.push(path.join(dir, 'Contents', 'MacOS', 'goland'));
  } else {
    candidates.push('/opt/goland/bin/goland.sh', '/snap/goland/current/bin/goland.sh');
    for (const dir of await directories('/opt', /^goland/i)) candidates.push(path.join(dir, 'bin', 'goland.sh'));
  }
  for (const dir of (env.PATH || '').split(path.delimiter))
    for (const name of platform === 'win32' ? ['goland64.exe'] : ['goland', 'goland.sh']) candidates.push(path.join(dir, name));
  const found = [];
  for (const candidate of [...new Set(candidates)]) {
    if (await exists(candidate)) {
      const actual = await realpath(candidate);
      if (!found.includes(actual)) found.push(actual);
    }
  }
  return found;
}
function propertyValue(text, key) {
  let value;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!][^=:]*?)\s*[=:]\s*(.*?)\s*$/);
    if (match?.[1] === key) value = match[2];
  }
  return value;
}
export async function resolveTarget(options) {
  const root = await privateDirectory(path.resolve(options.dataDir || dataHome()));
  let launcher = options.ide;
  if (!launcher) {
    const launchers = await discoverLaunchers();
    if (launchers.length !== 1) throw new OpsError('IDE_SELECTION_REQUIRED', '指定 --ide，无法唯一选择 GoLand 启动器', { candidates: launchers });
    launcher = launchers[0];
  }
  launcher = await realpath(path.resolve(launcher)).catch(() => { throw new OpsError('IDE_NOT_FOUND', 'GoLand 启动器不存在'); });
  if (process.platform === 'win32' && !launcher.toLowerCase().endsWith('.exe')) throw new OpsError('UNSUPPORTED_LAUNCHER', 'Windows 请指定官方 goland64.exe；不使用 shell 执行批处理');
  const properties = options.properties ? await realpath(path.resolve(options.properties)) : null;
  const propertiesText = properties ? await readFile(properties, 'utf8') : '';
  const propertiesProfile = propertyValue(propertiesText, 'idea.config.path');
  if (properties && (!propertiesProfile || !path.isAbsolute(propertiesProfile) || propertiesProfile.includes('$') || propertiesProfile.includes('\\')))
    throw new OpsError('INVALID_PROFILE_PROPERTIES', '--properties 中 idea.config.path 必须是已解析的绝对路径，Windows 使用正斜杠；不推测转义或续行');
  let profile = options.profile || propertiesProfile;
  if (!profile) {
    const base = configBase(process.platform, process.env, os.homedir());
    const profiles = await directories(base, /^GoLand[0-9]/);
    const live = [];
    for (const candidate of profiles) if (await profilePID(candidate)) live.push(candidate);
    if (live.length === 1) profile = live[0];
    else if (live.length > 1 || profiles.length !== 1) throw new OpsError('PROFILE_SELECTION_REQUIRED', '指定 --profile；存在多个或没有可识别的配置目录', { candidates: live.length ? live : profiles });
    else profile = profiles[0];
  }
  if (profile.includes('$') || !path.isAbsolute(profile)) throw new OpsError('PROFILE_SELECTION_REQUIRED', '--profile 必须是已解析的绝对路径');
  profile = await realpath(profile).catch(() => path.resolve(profile));
  const pathIdentity = locationIdentity;
  if (propertiesProfile && await pathIdentity(propertiesProfile) !== await pathIdentity(profile))
    throw new OpsError('PROFILE_PROPERTIES_CONFLICT', '--profile 与 --properties 的 idea.config.path 不一致，未启动 IDE');
  for (const name of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'])
    if ((process.env[name] || '').includes('-Didea.config.path'))
      throw new OpsError('UNSUPPORTED_ROUTE_OVERRIDE', name + ' 覆盖 idea.config.path；无法安全路由，未启动 IDE');
  const id = digest(profile).slice(0, 24);
  const targetDir = await privateDirectory(path.join(root, 'targets', id));
  const env = { ...process.env };
  if (properties) env.GOLAND_PROPERTIES = properties;
  else {
    const original = path.join(profile, 'idea.properties');
    const text = await exists(original) ? await readFile(original, 'utf8') : '';
    const content = text + '\nidea.config.path=' + profile.replaceAll('\\', '/') + '\n';
    const generated = path.join(targetDir, 'route-' + digest(content).slice(0, 24) + '.properties');
    if (!(await exists(generated))) {
      try { await atomicText(generated, content); }
      catch (error) {
        // Another process may atomically publish the identical content-addressed file.
        // Windows can deny replacing its open handle; never truncate or replace it in place.
        if (!['EPERM', 'EEXIST', 'EACCES'].includes(error.code) || await readFile(generated, 'utf8').catch(() => null) !== content) throw error;
      }
    }
    env.GOLAND_PROPERTIES = generated;
  }
  if (options.vmOptions) env.GOLAND_VM_OPTIONS = await realpath(path.resolve(options.vmOptions));
  const vmCandidates = [env.GOLAND_VM_OPTIONS, path.join(profile, 'goland64.exe.vmoptions'), path.join(profile, 'goland.vmoptions')].filter(Boolean);
  for (const vmFile of vmCandidates) if (await exists(vmFile)) {
    for (const line of (await readFile(vmFile, 'utf8')).split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const match = line.trim().match(/^-Didea\.config\.path=(.*)$/);
      if (line.includes('-Didea.config.path') && !match) throw new OpsError('UNSUPPORTED_ROUTE_OVERRIDE', 'VM options 中存在无法安全解析的配置路由覆盖');
      if (match && await pathIdentity(match[1].replace(/^"|"$/g, '')) !== await pathIdentity(profile))
        throw new OpsError('PROFILE_VM_CONFLICT', 'VM options 的 idea.config.path 与目标不一致');
    }
  }
  const project = options.project ? await realpath(path.resolve(options.project)).catch(() => { throw new OpsError('PROJECT_NOT_FOUND', '项目目录不存在'); }) : null;
  return { root, launcher, profile, id, targetDir, env, project, pid: await profilePID(profile) };
}
export function launch(target, args) {
  // No shell: project names, JSON, and IDE paths must never become command text.
  const child = spawn(target.launcher, args, { env: target.env, cwd: target.project || os.homedir(), windowsHide: true, stdio: 'ignore' });
  const state = { child, error: null, exitCode: null };
  child.on('error', error => { state.error = error.message; });
  child.on('exit', code => { state.exitCode = code; });
  child.unref();
  return state;
}
export function validateIdentifier(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new OpsError('INVALID_REQUEST_ID', '无效 request ID');
  return id;
}
export function safeFieldExpression(expression) {
  return typeof expression === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(expression);
}
export async function readResult(p, id) {
  try {
    const value = await jsonFile(p);
    if (value.requestId !== id) throw new OpsError('PROTOCOL_ID_MISMATCH', '结果 request ID 不匹配');
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
export async function observeRequest(target, id) {
  validateIdentifier(id);
  const directory = path.join(target.root, 'requests', id);
  const journal = await jsonFile(path.join(directory, 'journal.json'));
  if (journal.requestId !== id || !await sameLocation(journal.profile, target.profile) || !await sameLocation(journal.project, target.project))
    throw new OpsError('REQUEST_TARGET_MISMATCH', '请求不属于此 profile/project，未接受缓存结果');
  const result = await readResult(path.join(directory, 'result.json'), id);
  return { journal, result };
}
async function bootstrapGate(target, action) {
  const gatePath = path.join(target.targetDir, 'bootstrap-gate.lock');
  let gate;
  try { gate = await open(gatePath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new OpsError('BOOTSTRAP_BUSY', '另一个调用正在更新项目打开记录；未派发新的打开动作');
    throw error;
  }
  try { await gate.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
  finally { await gate.close(); await rm(gatePath, { force: true }); }
}
async function releaseBootstrap(target, expectedId) {
  await bootstrapGate(target, async () => {
    const file = path.join(target.targetDir, 'bootstrap.lock');
    const current = await jsonFile(file).catch(() => null);
    if (current?.id === expectedId) await rm(file, { force: true });
  });
}
export class Bridge {
  constructor(target, { timeout = 30000, spawnLauncher = launch } = {}) { this.target = target; this.timeout = timeout; this.spawnLauncher = spawnLauncher; }
  async send(operation, args = {}, { id = randomUUID(), timeout = this.timeout } = {}) {
    validateIdentifier(id);
    const target = this.target;
    const directory = path.join(target.root, 'requests', id);
    // An existing journal is observation-only. Never re-submit an uncertain write.
    if (await exists(directory)) {
      let observed;
      try { observed = await observeRequest(target, id); }
      catch (e) {
        if (e.code === 'ENOENT') return { requestId: id, outcome: 'unknown', code: 'REGISTRATION_PENDING', message: '原请求正在登记；未重放' };
        throw e;
      }
      const { journal, result } = observed;
      if (result) return { ...result, cached: true, historical: true, originalTarget: journal };
      return { requestId: id, outcome: 'unknown', code: 'EXISTING_REQUEST', message: '请求已有记录；使用 attempt show 查询，未重放' };
    }
    const pid = await profilePID(target.profile);
    if (!pid) throw new OpsError('IDE_OFFLINE', '目标 GoLand 未运行；需要启动时使用 project ensure');
    await privateDirectory(path.dirname(directory));
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (e) {
      if (e.code === 'EEXIST') return { requestId: id, outcome: 'unknown', code: 'EXISTING_REQUEST', message: '请求已被另一调用方登记，未重放' };
      throw e;
    }
    const requestPath = path.join(directory, 'request.json');
    const resultPath = path.join(directory, 'result.json');
    let observedBootstrapId = null;
    if (operation === 'project.probe') {
      try {
        await bootstrapGate(target, async () => {
          const prior = await jsonFile(path.join(target.targetDir, 'bootstrap.lock')).catch(() => null);
          if (prior?.id && prior?.project && await sameLocation(prior.project, target.project)) observedBootstrapId = prior.id;
        });
      } catch (error) { if (error.code !== 'BOOTSTRAP_BUSY') throw error; }
    }
    const request = {
      version: 1, requestId: id, operation, args, profile: target.profile, expectedPid: pid,
      project: target.project, dataRoot: target.root, targetId: target.id,
      deadline: Date.now() + timeout,
    };
    await atomicJSON(path.join(directory, 'journal.json'), { requestId: id, operation, profile: target.profile, project: target.project, expectedPid: pid, createdAt: Date.now() });
    await atomicJSON(requestPath, request);
    const template = await readFile(fileURLToPath(new URL('../bridge.groovy', import.meta.url)), 'utf8');
    const wrapper = 'def requestFile = new File(new String(java.util.Base64.decoder.decode(\'' + Buffer.from(requestPath).toString('base64') + '\'), java.nio.charset.StandardCharsets.UTF_8))\n' + template;
    const scriptPath = path.join(directory, 'command.groovy');
    await writeFile(scriptPath, wrapper, { mode: 0o600, flag: 'wx' });
    const observerPath = path.join(directory, 'observe.groovy');
    const observer = await readFile(fileURLToPath(new URL('../observe.groovy', import.meta.url)), 'utf8');
    await writeFile(observerPath, wrapper.slice(0, wrapper.indexOf('\n') + 1) + observer, { mode: 0o600, flag: 'wx' });
    const state = this.spawnLauncher(target, ['ideScript', scriptPath]);
    const end = Date.now() + timeout;
    let nextObservation = 0;
    while (Date.now() < end) {
      const result = await readResult(resultPath, id);
      if (result && !['pending', 'unknown'].includes(result.outcome)) {
        if (!['pending', 'unknown'].includes(result.outcome)) await rm(requestPath, { force: true });
        if (observedBootstrapId && operation === 'project.probe' && result.outcome === 'ok' && result.project?.initialized &&
            await sameLocation(result.project.path, target.project)) {
          try {
            await releaseBootstrap(target, observedBootstrapId);
          } catch (error) {
            if (error.code !== 'BOOTSTRAP_BUSY') throw error;
            result.bootstrapFinalizationPending = true;
          }
        }
        return result;
      }
      if (state.error) throw new OpsError('LAUNCHER_ERROR', state.error, { requestId: id });
      if (Date.now() >= nextObservation && await profilePID(target.profile) === pid) {
        this.spawnLauncher(target, ['ideScript', observerPath]);
        nextObservation = Date.now() + 500;
      }
      await delay(100);
    }
    return { requestId: id, outcome: 'unknown', code: 'RESULT_TIMEOUT', message: '结果尚未确认；动作可能已派发，查询原 request ID，勿重放', profile: target.profile };
  }
  async ensureProject() {
    const target = this.target;
    if (!target.project) throw new OpsError('PROJECT_REQUIRED', 'project ensure 需要 --project');
    const lockPath = path.join(target.targetDir, 'bootstrap.lock');
    let prior;
    let release = false;
    const bootstrapId = randomUUID();
    await bootstrapGate(target, async () => {
      let handle;
      try { handle = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code !== 'EEXIST') throw error; prior = await jsonFile(lockPath).catch(() => ({})); return; }
      try { await handle.writeFile(JSON.stringify({ id: bootstrapId, pid: process.pid, project: target.project, at: Date.now() })); }
      finally { await handle.close(); }
    });
    if (prior) {
      if (typeof prior.project !== 'string' || !await sameLocation(prior.project, target.project))
        throw new OpsError('BOOTSTRAP_BUSY', '该 profile 有其他或未完成登记的项目打开请求，未重复启动');
      if (await profilePID(target.profile)) {
        const current = await this.send('project.probe', {}, { timeout: Math.min(4000, this.timeout) });
        if (current.outcome === 'ok' && current.project?.initialized) await releaseBootstrap(target, prior.id);
        return { ...current, observingBootstrap: prior.id, message: '仅观察原打开请求，未重发启动器' };
      }
      return { outcome: 'unknown', code: 'BOOTSTRAP_PENDING', bootstrapId: prior.id, message: '已有打开请求尚未确认，未重复启动；核实原实例后处理 bootstrap.lock' };
    }
    try {
      if (await profilePID(target.profile)) {
        const current = await this.send('project.probe', {}, { timeout: Math.min(4000, this.timeout) });
        if (current.outcome === 'ok' && current.project?.initialized) { release = true; return { ...current, opened: false }; }
        if (current.code !== 'PROJECT_NOT_OPEN') { release = true; return current; }
      }
      const state = this.spawnLauncher(target, [target.project, 'dontReopenProjects', 'nosplash']);
      const end = Date.now() + this.timeout;
      let last;
      while (Date.now() < end) {
        if (state.error) { release = true; throw new OpsError('LAUNCHER_ERROR', state.error); }
        if (await profilePID(target.profile)) {
          last = await this.send('project.probe', {}, { timeout: Math.min(4000, Math.max(500, end - Date.now())) });
          if (last.outcome === 'ok' && last.project?.initialized) { release = true; return { ...last, opened: true }; }
          if (last.outcome === 'blocked') return { ...last, message: '目标 IDE 有模态对话框；使用 doctor 查看并由用户处理' };
          if (last.outcome === 'failed' && last.code !== 'PROJECT_NOT_OPEN') return last;
        }
        await delay(500);
      }
      return { outcome: 'blocked', code: 'PROJECT_OPEN_BLOCKED', message: '项目尚未可用；检查目标 IDE 的信任、许可、引导弹窗或 SDK 设置', last };
    } finally { if (release) await releaseBootstrap(target, bootstrapId); }
  }
}
