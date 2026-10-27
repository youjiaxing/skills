import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { receiverPaths, receiverStatus, recoverReceiverLock, atomicJson } from '../scripts/receiver-runtime.mjs';
import { recoverManagedReceiver } from '../scripts/receiver-recovery.mjs';
import { taskDefinition, legacyTaskDefinition, previousTaskDefinition, matchesTask, windowsArgument } from '../scripts/receiver.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yjx-receiver-lifecycle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = receiverPaths('cli_fixture', home);
  await mkdir(paths.lock, { recursive: true });
  await mkdir(paths.runtime, { recursive: true });
  const owner = { pid: 987654, token: 'fixture-owner' };
  await writeFile(path.join(paths.lock, 'owner.json'), JSON.stringify(owner));
  return { home, paths, owner };
}

test('status distinguishes dead locks, live heartbeat and mismatched instance', async (t) => {
  const f = await fixture(t);
  assert.equal((await receiverStatus('cli_fixture', { home: f.home, alive: () => false })).state, 'stale_lock');
  await writeFile(path.join(f.paths.runtime, 'status.json'), JSON.stringify({ ...f.owner, connection: 'connected', updatedAt: new Date().toISOString() }));
  const status = await receiverStatus('cli_fixture', { home: f.home, alive: () => true });
  assert.equal(status.state, 'running');
  assert.equal(status.connection, 'connected');
  await writeFile(path.join(f.paths.runtime, 'status.json'), JSON.stringify({ ...f.owner, token: 'different', updatedAt: new Date().toISOString() }));
  assert.equal((await receiverStatus('cli_fixture', { home: f.home, alive: () => true })).state, 'unknown');
});

test('power-loss-corrupted heartbeat does not conceal a dead owner or prevent explicit lock recovery', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.paths.runtime, 'status.json'), Buffer.alloc(181));
  const status = await receiverStatus('cli_fixture', { home: f.home, alive: () => false });
  assert.equal(status.state, 'stale_lock');
  assert.equal(status.runtimeState, 'unreadable');
  assert.equal(await recoverReceiverLock('cli_fixture', { home: f.home, alive: () => false }), true);
  const stopped = await receiverStatus('cli_fixture', { home: f.home });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.runtimeState, 'unreadable');
});

test('a corrupt heartbeat never permits recovery of a live or unknown receiver owner', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.paths.runtime, 'status.json'), Buffer.alloc(181));
  for (const alive of [() => true, () => null]) {
    assert.equal((await receiverStatus('cli_fixture', { home: f.home, alive })).state, 'unknown');
    await assert.rejects(recoverReceiverLock('cli_fixture', { home: f.home, alive }), /may still be alive/);
    await access(f.paths.lock);
  }
});

test('managed logon recovery clears only confirmed-dead receiver ownership after corrupt telemetry', async t => {
  const f = await fixture(t);
  const journal = path.join(f.home, 'submitted-request.json');
  await writeFile(journal, 'preserve execution evidence');
  await writeFile(path.join(f.paths.runtime, 'status.json'), Buffer.alloc(181));
  const result = await recoverManagedReceiver('cli_fixture', { home: f.home, alive: () => false });
  assert.deepEqual(result, { recovered: true, state: 'stopped' });
  assert.equal(await readFile(journal, 'utf8'), 'preserve execution evidence');
});

test('managed recovery leaves live, unknown and malformed owners untouched', async t => {
  const f = await fixture(t);
  for (const alive of [() => true, () => null]) {
    assert.equal((await recoverManagedReceiver('cli_fixture', { home: f.home, alive })).recovered, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.paths.lock, 'owner.json'))), f.owner);
  }
  await writeFile(path.join(f.paths.lock, 'owner.json'), Buffer.alloc(100));
  const result = await recoverManagedReceiver('cli_fixture', { home: f.home, alive: () => false });
  assert.equal(result.state, 'incomplete_lock');
  assert.equal(result.recovered, false);
  await access(f.paths.lock);
});

test('concurrent runtime replacements use independent temporary files and retain complete JSON', async t => {
  const f = await fixture(t);
  const file = path.join(f.paths.runtime, 'snapshot.json');
  const values = Array.from({ length: 6 }, (_, sequence) => ({ sequence, content: '完整'.repeat(1000) }));
  await Promise.all(values.map(value => atomicJson(file, value)));
  const result = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(result, values[result.sequence]);
});

test('dead receiver recovery leaves Codex journals untouched and refuses live owners', async (t) => {
  const f = await fixture(t);
  const journal = path.join(f.home, 'request-record.json');
  await writeFile(journal, 'submitted-request-remains');
  await assert.rejects(recoverReceiverLock('cli_fixture', { home: f.home, alive: () => true }), /may still be alive/);
  await assert.rejects(recoverReceiverLock('cli_fixture', { home: f.home, alive: () => null }), /may still be alive/);
  assert.equal(await recoverReceiverLock('cli_fixture', { home: f.home, alive: () => false }), true);
  await assert.rejects(access(f.paths.lock), { code: 'ENOENT' });
  assert.equal(await readFile(journal, 'utf8'), 'submitted-request-remains');
});

test('stopped receiver retains last explicit stop reason without claiming an active process',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.paths.runtime,'status.json'),JSON.stringify({...f.owner,
    connection:'stopped',stopReason:'control',updatedAt:'2026-10-18T00:00:00.000Z'}));
  await rm(f.paths.lock,{recursive:true});
  const status=await receiverStatus('cli_fixture',{home:f.home});
  assert.equal(status.state,'stopped');assert.equal(status.stopReason,'control');assert.equal(status.pid,undefined);
});

test('recovery mutex prevents concurrent recovery from touching a replacement lock', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.paths.runtime, 'recover.lock'));
  await assert.rejects(recoverReceiverLock('cli_fixture', { home: f.home, alive: () => false }), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.paths.lock, 'owner.json'), 'utf8')), f.owner);
});

test('ownerless lock is incomplete rather than stopped and is never automatically removed', async (t) => {
  const f = await fixture(t);
  await unlink(path.join(f.paths.lock, 'owner.json'));
  assert.equal((await receiverStatus('cli_fixture', { home: f.home })).state, 'incomplete_lock');
  await assert.rejects(recoverReceiverLock('cli_fixture', { home: f.home, alive: () => false }), /no owner/);
  await access(f.paths.lock);
});

test('scheduled task ownership includes current-user logon trigger', () => {
  const definition = taskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe',
    args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' });
  assert.equal(matchesTask(definition, definition), true);
  assert.equal(matchesTask(definition.replace('<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>',
    '<RestartOnFailure>\n<Count>3</Count>\n<Interval>PT1M</Interval>\n</RestartOnFailure>'), definition), true);
  assert.match(definition, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>3<\/Count><\/RestartOnFailure>/);
  assert.match(definition, /<LogonTrigger><Enabled>true<\/Enabled><UserId>S-1-5-21-123<\/UserId><\/LogonTrigger>/);
  // Task Scheduler exports omit these schema defaults and unescape quote text.
  const normalized = definition.replace('<RunLevel>LeastPrivilege</RunLevel>', '')
    .replace('<AllowStartOnDemand>true</AllowStartOnDemand>', '')
    .replaceAll('&quot;', '"')
    .replace('<UserId>S-1-5-21-123</UserId></LogonTrigger>', '<UserId>FIXTURE\\TestUser</UserId></LogonTrigger>');
  assert.equal(matchesTask(normalized, definition, { logonUser: 'FIXTURE\\TestUser' }), true);
  assert.equal(matchesTask(normalized, definition), false);
  for (const change of [
    definition.replace('S-1-5-21-123', 'S-1-5-21-456'),
    definition.replace('<Arguments>', '<Arguments>extra '),
    definition.replace('<Command>', '<Command>other'),
    definition.replace('<UserId>S-1-5-21-123</UserId>', '<UserId>S-1-5-21-456</UserId>'),
    definition.replace('</Actions>', '<ComHandler/></Actions>'),
    definition.replace('PT0S', 'PT72H'),
    definition.replace('<StopIfGoingOnBatteries>false', '<StopIfGoingOnBatteries>true'),
    definition.replace('<AllowStartOnDemand>true', '<AllowStartOnDemand>false'),
    definition.replace('</Exec>', '</Exec><SendEmail/>'),
    definition.replace('</LogonTrigger>', '</LogonTrigger><LogonTrigger/>'),
    definition.replace('<Enabled>true</Enabled><UserId>S-1-5-21-123</UserId></LogonTrigger>', '<Enabled>false</Enabled><UserId>S-1-5-21-123</UserId></LogonTrigger>'),
    definition.replace('<UserId>S-1-5-21-123</UserId></LogonTrigger>', '<UserId>S-1-5-21-999</UserId></LogonTrigger>'),
  ]) assert.equal(matchesTask(change, definition), false);
  assert.equal(matchesTask(legacyTaskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe', args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' }), legacyTaskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe', args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' })), true);
  assert.equal(matchesTask(previousTaskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe', args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' }), previousTaskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe', args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' })), true);
});
