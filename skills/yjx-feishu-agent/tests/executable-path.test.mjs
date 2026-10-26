import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveCodex } from '../scripts/app-server.mjs';
import { reserveRecord, claimThreadRequest, resolveThreadRequest } from '../scripts/state.mjs';

test('missing explicit executable does not fall back to an available PATH binary', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-codex-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(resolveCodex(path.join(root, 'missing-codex.exe'), { PATH: path.dirname(process.execPath) }),
    { code: 'CODEX_NOT_FOUND' });
});

test('missing executable during read-only refresh retains the submitted request gate', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-codex-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prior = { requestId: 'original', threadId: 'fixture', status: 'waiting', submitted: true };
  await reserveRecord(root, prior);
  await claimThreadRequest(root, prior);
  const result = await resolveThreadRequest(root, { ...prior, requestId: 'new-request' }, async () => {
    throw Object.assign(new Error('Native binary unavailable after update'), { code: 'CODEX_NOT_FOUND' });
  });
  assert.equal(result.old.requestId, 'original');
  assert.equal(result.old.submitted, true);
  assert.equal(result.old.status, 'waiting');
});
