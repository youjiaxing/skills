import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { receiverPaths, receiverStatus, recoverReceiverLock } from '../scripts/receiver-runtime.mjs';
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
  assert.equal(matchesTask(normalized, definition), true);
  for (const change of [
    definition.replace('S-1-5-21-123', 'S-1-5-21-456'),
    definition.replace('<Arguments>', '<Arguments>extra '),
    definition.replace('<Command>', '<Command>other'),
    definition.replace('<UserId>S-1-5-21-123</UserId>', '<UserId>S-1-5-21-456</UserId>'),
    definition.replace('</Actions>', '<ComHandler/></Actions>'),
    definition.replace('PT0S', 'PT72H'),
    definition.replace('<StopIfGoingOnBatteries>false', '<StopIfGoingOnBatteries>true'),
    definition.replace('<AllowStartOnDemand>true', '<AllowStartOnDemand>false'),
  ]) assert.equal(matchesTask(change, definition), false);
  assert.equal(matchesTask(legacyTaskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe', args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' }), legacyTaskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe', args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' })), true);
  assert.equal(matchesTask(previousTaskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe', args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' }), previousTaskDefinition({ sid: 'S-1-5-21-123', node: 'C:\\Program Files\\node.exe', args: ['C:\\含空格 path\\feishu.mjs', 'serve', '--state-dir', 'D:\\a & b\\'].map(windowsArgument).join(' '), cwd: 'D:\\a & b' })), true);
});
