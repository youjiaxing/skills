import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { credentialsPath, loadCredentials, saveCredentials } from '../scripts/feishu-credentials.mjs';
import { parseSetupArgs, readSecret } from '../scripts/setup-feishu.mjs';

async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-feishu-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => { input.isRaw = mode; };
  const output = new PassThrough();
  output.isTTY = true;
  let displayed = '';
  output.on('data', (chunk) => { displayed += chunk; });
  return { input, output, displayed: () => displayed };
}

test('credentials roundtrip, permissions and refusal to overwrite', async (t) => {
  const root = await directory(t);
  const credentials = { appId: 'cli_fixture', appSecret: 'fixture-only-secret' };
  const target = await saveCredentials(credentials, root);
  assert.equal(target, credentialsPath(root));
  assert.deepEqual(await loadCredentials(root), credentials);
  const prior = await readFile(target, 'utf8');
  await assert.rejects(saveCredentials({ ...credentials, appSecret: 'different' }, root), /already exist/);
  assert.equal(await readFile(target, 'utf8'), prior);
  if (process.platform !== 'win32') {
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  }
});

test('invalid secrets never create credentials; legacy and malformed files fail without leaking contents', async (t) => {
  const root = await directory(t);
  await assert.rejects(saveCredentials({ appId: 'cli_fixture', appSecret: 'secret with space' }, root), /without whitespace/);
  await assert.rejects(readFile(credentialsPath(root)), { code: 'ENOENT' });
  await saveCredentials({ appId: 'cli_fixture', appSecret: 'fixture' }, root);
  await writeFile(credentialsPath(root), JSON.stringify({ protection: 'windows-dpapi-current-user', appSecretDpapi: 'old' }));
  await assert.rejects(loadCredentials(root), /Legacy Windows DPAPI/);
  await writeFile(credentialsPath(root), 'malformed-sensitive-content');
  await assert.rejects(loadCredentials(root), (error) => !error.message.includes('sensitive-content'));
});

test('terminal entry suppresses secret echo and restores raw mode', async () => {
  const io = terminal();
  const result = readSecret(io.input, io.output);
  io.input.write('fixture-only-secret\r');
  assert.equal(await result, 'fixture-only-secret');
  assert.equal(io.displayed(), 'App Secret (hidden): \n');
  assert.equal(io.input.isRaw, false);
  io.input.destroy();
  io.output.destroy();
});

test('Ctrl+C and input EOF cancel entry and restore raw mode', async () => {
  for (const end of ['interrupt', 'eof']) {
    const io = terminal();
    const result = readSecret(io.input, io.output);
    if (end === 'interrupt') io.input.write('\x03');
    else io.input.end();
    await assert.rejects(result, /cancelled|closed/);
    assert.equal(io.input.isRaw, false);
    io.input.destroy();
    io.output.destroy();
  }
});

test('setup requires a terminal and rejects secret command arguments without echoing them', async () => {
  await assert.rejects(readSecret(new PassThrough(), new PassThrough()), /interactive terminal/);
  assert.deepEqual(parseSetupArgs(['--app-id', 'cli_fixture', '--state-dir', '/tmp/state']), {
    appId: 'cli_fixture', stateDir: '/tmp/state',
  });
  assert.throws(() => parseSetupArgs(['--app-id', 'cli_fixture', '--secret', 'sensitive-fixture']),
    (error) => !error.message.includes('sensitive-fixture'));
});
