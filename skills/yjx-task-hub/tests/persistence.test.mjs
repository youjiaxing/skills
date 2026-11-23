import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { privateRoot, atomicJson, safeFile, acquireLock } from '../scripts/storage.mjs';

const cli = fileURLToPath(new URL('../scripts/hub.mjs', import.meta.url));
function fixture(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yjx-task-hub-ipc-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, YJX_TASK_HUB_HOME: root, ...overrides };
  const run = (args, data) => {
    try { return JSON.parse(execFileSync(process.execPath, [cli, ...args], { env, input: data ? JSON.stringify(data) : undefined, encoding: 'utf8', windowsHide: true, timeout: 20000 })); }
    catch (e) { throw new Error(String(e.stdout || e.message)); }
  };
  return { root, run };
}

const config = { notionDatabaseId: '11111111-1111-4111-8111-111111111111', notionDataSourceId: 'collection://22222222-2222-4222-8222-222222222222', tbUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
function connect(root) {
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\yjx-task-hub-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24)}` : path.join(root, 'hub.sock');
  const socket = net.createConnection(address);
  socket.on('error', () => {});
  return socket;
}
async function waitUnlocked(root) {
  for (let i = 0; i < 250 && fs.existsSync(path.join(root, 'lock.json')); i++) await delay(20);
  assert.equal(fs.existsSync(path.join(root, 'lock.json')), false, 'coordinator must release its lock within five seconds');
}
function cleanupHolder(t, root, pid) {
  t.after(() => {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  });
}

test('real coordinator holds exclusive lock across CLI calls, supports --file input, and returns syncCoverage on stop', t => {
  const { root, run } = fixture(t);
  const initFile = path.join(root, 'init-input.json');
  fs.writeFileSync(initFile, JSON.stringify({ notionDatabaseId: '11111111-1111-4111-8111-111111111111', notionDataSourceId: 'collection://22222222-2222-4222-8222-222222222222', tbUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }));
  run(['init', '--file', initFile]);
  fs.unlinkSync(initFile);
  const { session } = run(['start']);
  let stopped;
  try {
    assert.throws(() => run(['start']), /持锁/);
    assert.throws(() => run(['request', '--session', 'different-session'], { action: 'status' }), /令牌/);
    const invFile = path.join(root, 'inv-input.json');
    fs.writeFileSync(invFile, JSON.stringify({ action: 'inventory', complete: true, pages: [] }));
    const response = run(['request', '--session', session, '--file', invFile]);
    fs.unlinkSync(invFile);
    assert.equal(response.pages, 0);
    assert.equal(fs.existsSync(path.join(root, 'lock.json')), true);
  } finally {
    stopped = run(['stop', '--session', session]);
  }
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.syncCoverage, { trackedTotal: 0, plannedCount: 0, unplannedTrackedKeys: [], candidatesChecked: false });
  assert.equal(fs.existsSync(path.join(root, 'lock.json')), false);
});

test('sync record stays incomplete until coverage and external checks are attested', t => {
  const { run, root } = fixture(t);
  run(['init'], { notionDatabaseId: '11111111-1111-4111-8111-111111111111', notionDataSourceId: 'collection://22222222-2222-4222-8222-222222222222', tbUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  let { session } = run(['start', '--sync']);
  assert.equal(run(['status']).lastSync.status, 'running');
  assert.throws(() => run(['request', '--session', session], { action: 'sync-attest', identityVerified: true, paginationVerified: true, iterationsVerified: true, writesVerified: true, candidatesHandled: true }), /覆盖/);
  assert.equal(run(['stop', '--session', session]).syncStatus, 'incomplete');
  assert.equal(run(['status']).lastSync.status, 'incomplete');
  ({ session } = run(['start', '--sync']));
  run(['request', '--session', session], { action: 'inventory', complete: true, pages: [] });
  run(['request', '--session', session], { action: 'candidates', complete: true, tasks: [] });
  assert.throws(() => run(['request', '--session', session], { action: 'sync-attest' }), /核实/);
  run(['request', '--session', session], { action: 'sync-attest', identityVerified: true, paginationVerified: true, iterationsVerified: true, writesVerified: true, candidatesHandled: true });
  assert.throws(() => run(['request', '--session', session], { action: 'sync-attest' }), /核实/);
  run(['request', '--session', session], { action: 'sync-attest', identityVerified: true, paginationVerified: true, iterationsVerified: true, writesVerified: true, candidatesHandled: true });
  assert.equal(run(['stop', '--session', session]).syncStatus, 'verified');
  assert.equal(run(['status']).lastSync.status, 'verified');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'sync-run.json'))).runs.map(x => x.status), ['incomplete', 'verified']);
});

test('idle coordinator self-releases an abandoned sync lock and records an incomplete run', async t => {
  const { root, run } = fixture(t);
  run(['init'], { notionDatabaseId: '11111111-1111-4111-8111-111111111111', notionDataSourceId: 'collection://22222222-2222-4222-8222-222222222222', tbUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  const env = { ...process.env, YJX_TASK_HUB_HOME: root, YJX_TASK_HUB_IDLE_TIMEOUT_MS: '100' };
  const started = JSON.parse(execFileSync(process.execPath, [cli, 'start', '--sync'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 }));
  t.after(() => {
    if (fs.existsSync(path.join(root, 'lock.json'))) {
      try { run(['stop', '--session', started.session]); } catch {}
    }
  });
  for (let i = 0; i < 100 && fs.existsSync(path.join(root, 'lock.json')); i++) await delay(20);
  assert.equal(fs.existsSync(path.join(root, 'lock.json')), false);
  assert.equal(run(['status']).lastSync.status, 'incomplete');
});

test('valid coordinator requests refresh the idle watchdog', async t => {
  const { root, run } = fixture(t);
  run(['init'], { notionDatabaseId: '11111111-1111-4111-8111-111111111111', notionDataSourceId: 'collection://22222222-2222-4222-8222-222222222222', tbUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  const env = { ...process.env, YJX_TASK_HUB_HOME: root, YJX_TASK_HUB_IDLE_TIMEOUT_MS: '1000' };
  const started = JSON.parse(execFileSync(process.execPath, [cli, 'start'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 }));
  t.after(() => {
    if (fs.existsSync(path.join(root, 'lock.json'))) {
      try { run(['stop', '--session', started.session]); } catch {}
    }
  });
  await delay(600);
  assert.deepEqual(run(['request', '--session', started.session], { action: 'status' }).pending, []);
  await delay(600);
  assert.equal(fs.existsSync(path.join(root, 'lock.json')), true);
  run(['stop', '--session', started.session]);
});

test('wrong tokens and continuous partial input cannot keep an abandoned coordinator alive', async t => {
  const { root, run } = fixture(t, { YJX_TASK_HUB_IDLE_TIMEOUT_MS: '700' });
  run(['init'], config);
  const started = run(['start', '--sync']);
  cleanupHolder(t, root, started.pid);
  const fragment = connect(root);
  t.after(() => fragment.destroy());
  const flood = setInterval(() => {
    if (!fragment.destroyed) fragment.write(' ');
    const bad = connect(root);
    bad.on('connect', () => bad.end(JSON.stringify({ action: 'status', session: 'wrong' }) + '\n'));
    bad.resume();
  }, 40);
  try { await waitUnlocked(root); } finally { clearInterval(flood); }
  assert.equal(run(['status']).lastSync.stopReason, 'idle_timeout');
  const next = run(['start', '--sync']);
  run(['stop', '--session', next.session]);
});

test('cancelling the owner leaves a detached coordinator that self-exits before the next run', async t => {
  const { root, run } = fixture(t, { YJX_TASK_HUB_IDLE_TIMEOUT_MS: '900' });
  run(['init'], config);
  const owner = spawn(process.execPath, ['--input-type=module', '-', cli], {
    env: { ...process.env, YJX_TASK_HUB_HOME: root, YJX_TASK_HUB_IDLE_TIMEOUT_MS: '900' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  const ready = new Promise((resolve, reject) => {
    let raw = '';
    owner.stdout.setEncoding('utf8');
    owner.stdout.on('data', chunk => {
      raw += chunk;
      if (raw.includes('\n')) resolve(JSON.parse(raw.split('\n')[0]));
    });
    owner.on('error', reject);
    owner.on('exit', () => reject(new Error('owner exited before launching coordinator')));
  });
  owner.stdin.end("import { execFileSync } from 'node:child_process';\nprocess.stdout.write(execFileSync(process.execPath, [process.argv[2], 'start', '--sync'], {encoding:'utf8',windowsHide:true}));\nsetInterval(() => {}, 1000);\n");
  const started = await ready;
  cleanupHolder(t, root, started.pid);
  const exited = new Promise(resolve => owner.once('exit', resolve));
  owner.kill('SIGKILL');
  await exited;
  assert.doesNotThrow(() => process.kill(started.pid, 0), 'detached service survives owner cancellation');
  await waitUnlocked(root);
  assert.equal(run(['status']).lastSync.stopReason, 'idle_timeout');
  const next = run(['start', '--sync']);
  run(['stop', '--session', next.session]);
});

test('overflow and fractional timeout values use the default instead of exiting immediately', async t => {
  for (const value of ['2147483648', '100.5']) {
    const { root, run } = fixture(t, { YJX_TASK_HUB_IDLE_TIMEOUT_MS: value });
    run(['init'], config);
    const started = run(['start', '--sync']);
    cleanupHolder(t, root, started.pid);
    await delay(250);
    assert.equal(fs.existsSync(path.join(root, 'lock.json')), true);
    run(['stop', '--session', started.session]);
  }
});

test('idle timeout starts after slow initialization has finished', async t => {
  const { root, run } = fixture(t);
  run(['init'], config);
  const preload = "import fs from 'node:fs'; let count=0; const original=fs.fsyncSync; fs.fsyncSync=(...args)=>{ if(++count===2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500); return original(...args); };";
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), cli, '_serve', '--sync'], {
    env: { ...process.env, YJX_TASK_HUB_HOME: root, YJX_TASK_HUB_IDLE_TIMEOUT_MS: '250' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanupHolder(t, root, child.pid);
  const exited = new Promise(resolve => child.once('exit', () => resolve(performance.now())));
  const readyAt = await new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(performance.now()));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('coordinator exited before readiness')));
  });
  assert.ok((await exited) - readyAt >= 150, 'initialization must not consume the first idle interval');
  assert.equal(fs.existsSync(path.join(root, 'lock.json')), false);
});

test('stop closes half packets and rejects subsequent dispatch on an existing connection', async t => {
  const { root, run } = fixture(t);
  run(['init'], config);
  const started = run(['start', '--sync']);
  cleanupHolder(t, root, started.pid);
  const ask = data => run(['request', '--session', started.session], data);
  ask({ action: 'inventory', complete: true, pages: [] });
  const plan = ask({ action: 'plan-personal', properties: { '任务': 'Never dispatch after shutdown' } });
  const op = ask({ action: 'prepare', planId: plan.planId, confirmed: true });
  const half = connect(root);
  half.write('{');
  t.after(() => half.destroy());
  const stopper = connect(root);
  const writer = connect(root);
  t.after(() => { stopper.destroy(); writer.destroy(); });
  let reply = '';
  writer.on('data', chunk => { reply += chunk; });
  await Promise.all([stopper, writer].map(socket => new Promise(resolve => socket.once('connect', resolve))));
  const stopped = new Promise(resolve => stopper.once('data', resolve));
  stopper.end(JSON.stringify({ action: 'stop', session: started.session }) + '\n');
  await stopped;
  writer.end(JSON.stringify({ action: 'dispatch', session: started.session, opId: op.opId }) + '\n');
  await waitUnlocked(root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).entries[op.key].pendingOp.phase, 'prepared');
  assert.doesNotMatch(reply, /permitted.*true/);
});

test('completion record write failure still releases the lock and permits the next run', async t => {
  const { root, run } = fixture(t, { YJX_TASK_HUB_IDLE_TIMEOUT_MS: '500' });
  run(['init'], config);
  const started = run(['start', '--sync']);
  cleanupHolder(t, root, started.pid);
  fs.unlinkSync(path.join(root, 'sync-run.json'));
  fs.mkdirSync(path.join(root, 'sync-run.json'));
  await waitUnlocked(root);
  fs.rmdirSync(path.join(root, 'sync-run.json'));
  const next = run(['start', '--sync']);
  run(['stop', '--session', next.session]);
});

test('lost lock ownership stops the old coordinator without deleting the replacement lock', async t => {
  const { root, run } = fixture(t, { YJX_TASK_HUB_IDLE_TIMEOUT_MS: '500' });
  run(['init'], config);
  const started = run(['start', '--sync']);
  cleanupHolder(t, root, started.pid);
  const replacement = { lockId: 'replacement', pid: process.pid };
  atomicJson(root, 'lock.json', replacement);
  assert.throws(() => run(['request', '--session', started.session], { action: 'status' }), /归属|ECONNRESET|EPIPE|关闭/);
  await delay(1200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'lock.json'))), replacement);
});

test('forced coordinator death recovers prepared, preserves dispatched, and lets unrelated work continue', async t => {
  const { root, run } = fixture(t);
  run(['init'], config);
  const started = run(['start', '--sync']);
  const ask = data => run(['request', '--session', started.session], data);
  ask({ action: 'inventory', complete: true, pages: [] });
  const prepare = title => {
    const plan = ask({ action: 'plan-personal', properties: { '任务': title } });
    return ask({ action: 'prepare', planId: plan.planId, confirmed: true });
  };
  const dispatched = prepare('Unknown external write');
  ask({ action: 'dispatch', opId: dispatched.opId });
  const prepared = prepare('Never dispatched');
  process.kill(started.pid, 'SIGKILL');
  for (let i = 0; i < 100; i++) {
    try { process.kill(started.pid, 0); } catch (e) { if (e.code === 'ESRCH') break; throw e; }
    await delay(20);
  }
  const next = run(['start', '--sync']);
  try {
    assert.deepEqual(next.pending.map(x => x.opId), [dispatched.opId]);
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json')));
    assert.equal(state.entries[prepared.key], undefined);
    assert.equal(state.entries[dispatched.key].pendingOp.phase, 'dispatched');
    const request = data => run(['request', '--session', next.session], data);
    assert.throws(() => request({ action: 'dispatch', opId: dispatched.opId }), /禁止重发/);
    assert.throws(() => request({ action: 'cancel', opId: dispatched.opId }), /对账/);
    request({ action: 'inventory', complete: true, pages: [] });
    const plan = request({ action: 'plan-personal', properties: { '任务': 'Unrelated work' } });
    const op = request({ action: 'prepare', planId: plan.planId, confirmed: true });
    assert.equal(request({ action: 'dispatch', opId: op.opId }).permitted, true);
    request({ action: 'commit', opId: op.opId, apiSucceeded: true, pageId: '33333333-3333-4333-8333-333333333333' });
    assert.deepEqual(request({ action: 'status' }).pending.map(x => x.opId), [dispatched.opId]);
  } finally { run(['stop', '--session', next.session]); }
  const history = JSON.parse(fs.readFileSync(path.join(root, 'sync-run.json'))).runs;
  assert.equal(history[0].status, 'incomplete');
  assert.equal(history[0].stopReason, 'process_restarted');
});

test('POSIX signals use bounded shutdown with partial connections', { skip: process.platform === 'win32' }, async t => {
  const { root, run } = fixture(t);
  run(['init'], config);
  const started = run(['start', '--sync']);
  cleanupHolder(t, root, started.pid);
  const socket = connect(root);
  socket.write('{');
  t.after(() => socket.destroy());
  process.kill(started.pid, 'SIGTERM');
  await waitUnlocked(root);
  assert.equal(run(['status']).lastSync.stopReason, 'signal:SIGTERM');
});

test('a second owner cannot acquire a live lock', t => {
  const { root } = fixture(t);
  const lock = acquireLock(root);
  try { assert.throws(() => acquireLock(root), /持锁/); }
  finally { lock.release(); }
});

test('Windows process birth identity distinguishes a reused PID and fails closed when unavailable', { skip: process.platform !== 'win32' }, t => {
  const { root } = fixture(t);
  const original = acquireLock(root);
  assert.match(original.processIdentity, /^win32:\d+$/);
  original.release();
  const reused = { ...original, processIdentity: `win32:${BigInt(original.processIdentity.slice(6)) - 1n}` };
  atomicJson(root, 'lock.json', reused);
  const systemRoot = process.env.SystemRoot;
  try {
    process.env.SystemRoot = path.join(root, 'unavailable-windows');
    assert.throws(() => acquireLock(root), /持锁/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'lock.json'))).lockId, reused.lockId);
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
  const recovered = acquireLock(root);
  assert.notEqual(recovered.lockId, original.lockId);
  assert.equal(recovered.pid, original.pid);
  recovered.release();
  atomicJson(root, 'lock.json', { lockId: 'legacy-reused-pid', pid: process.pid, createdAt: '2000-01-01T00:00:00.000Z' });
  const legacy = acquireLock(root);
  legacy.release();
});

test('two contenders recovering a killed coordinator still yield exactly one owner', async t => {
  const { root, run } = fixture(t);
  run(['init'], { notionDatabaseId: '11111111-1111-4111-8111-111111111111', notionDataSourceId: 'collection://22222222-2222-4222-8222-222222222222', tbUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  const old = run(['start']);
  process.kill(old.pid, 'SIGKILL');
  let dead = false;
  for (let i = 0; i < 100; i++) {
    try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') { dead = true; break; } throw e; }
    await delay(20);
  }
  assert.equal(dead, true, 'the isolated holder must be dead before exercising stale recovery');
  const launch = () => promisify(execFile)(process.execPath, [cli, 'start'], { env: { ...process.env, YJX_TASK_HUB_HOME: root }, windowsHide: true, timeout: 20000 }).then(r => JSON.parse(r.stdout));
  const outcomes = await Promise.allSettled([launch(), launch()]);
  const owners = outcomes.filter(r => r.status === 'fulfilled').map(r => r.value);
  try { assert.equal(owners.length, 1); }
  finally { for (const owner of owners) run(['stop', '--session', owner.session]); }
});

test('private persistence rejects public worktrees and file hardlinks', t => {
  const { root } = fixture(t);
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  assert.throws(() => privateRoot(path.join(repo, 'private-test')), /公开|工作树/);
  const target = path.join(root, 'outside.json');
  fs.writeFileSync(target, 'untouched');
  fs.linkSync(target, path.join(root, 'state.json'));
  assert.throws(() => atomicJson(root, 'state.json', { broken: true }), /链接/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
  assert.throws(() => safeFile(root, '../outside.json'), /不支持/);
});

test('fragmented UTF-8 survives CLI stdin, coordinator IPC, and response decoding', async t => {
  const { root, run } = fixture(t);
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const { createHash } = await import('node:crypto');
  run(['init'], { notionDatabaseId: '11111111-1111-4111-8111-111111111111', notionDataSourceId: 'collection://22222222-2222-4222-8222-222222222222', tbUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  const { session } = run(['start']);
  try {
    run(['request','--session',session], { action: 'inventory', complete: true, pages: [] });
    const title = '中文' + '任务进度'.repeat(18000);
    const payload = { action: 'plan-personal', properties: { '任务': title } };
    const buffer = Buffer.from(JSON.stringify(payload));
    const cut = buffer.indexOf(Buffer.from('中')) + 1;
    const stdout = await new Promise((resolve,reject) => {
      const child = spawn(process.execPath, [cli,'request','--session',session], { env: { ...process.env,YJX_TASK_HUB_HOME:root }, windowsHide:true, stdio:['pipe','pipe','pipe'] });
      let out='', err='';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data',c=>out+=c); child.stderr.on('data',c=>err+=c);
      child.on('error',reject); child.stdin.on('error',reject);
      child.on('close',code=>code===0?resolve(out):reject(new Error(err||out)));
      child.stdin.write(buffer.subarray(0,cut), () => { delay(30).then(()=>child.stdin.end(buffer.subarray(cut))); });
    });
    assert.equal(JSON.parse(stdout).properties['任务'], title);
    const address = process.platform==='win32' ? `\\\\.\\pipe\\yjx-task-hub-${createHash('sha256').update(fs.realpathSync(root).toLowerCase()).digest('hex').slice(0,24)}` : path.join(root,'hub.sock');
    const wire = Buffer.from(JSON.stringify({ ...payload, session })+'\n');
    const split = wire.indexOf(Buffer.from('中'))+1;
    const response = await new Promise((resolve,reject) => {
      const client=net.createConnection(address); let text=''; client.setEncoding('utf8');
      client.setTimeout(5000,()=>client.destroy(new Error('test IPC timeout')));
      client.on('error',reject);
      client.on('data',c=>{text+=c; if(text.includes('\n')){client.end();resolve(JSON.parse(text.split('\n')[0]));}});
      client.on('connect',()=>client.write(wire.subarray(0,split),()=>{delay(30).then(()=>client.end(wire.subarray(split)));}));
    });
    assert.equal(response.properties['任务'], title);
  } finally { run(['stop','--session',session]); }
});
