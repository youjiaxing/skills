import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { privateRoot, atomicJson, safeFile, acquireLock } from '../scripts/storage.mjs';

const cli = fileURLToPath(new URL('../scripts/hub.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yjx-task-hub-ipc-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, YJX_TASK_HUB_HOME: root };
  const run = (args, data) => {
    try { return JSON.parse(execFileSync(process.execPath, [cli, ...args], { env, input: data ? JSON.stringify(data) : undefined, encoding: 'utf8', windowsHide: true, timeout: 20000 })); }
    catch (e) { throw new Error(String(e.stdout || e.message)); }
  };
  return { root, run };
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

test('a second owner cannot acquire a live lock', t => {
  const { root } = fixture(t);
  const lock = acquireLock(root);
  try { assert.throws(() => acquireLock(root), /持锁/); }
  finally { lock.release(); }
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
