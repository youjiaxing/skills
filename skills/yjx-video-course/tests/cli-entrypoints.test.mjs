import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../scripts/is-main.mjs';
import { checkOcrAvailability } from '../scripts/extract-hard-subtitles.mjs';
import { resolveBilibiliCid } from '../scripts/source-tools.mjs';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withSymlinkedSkill(t) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'yjx-video-course-link-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const linked = path.join(work, 'linked-skill');
  await symlink(skillDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  return { work, linked };
}

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('isMainModule compares realpaths', () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMainModule(import.meta.url, self), true);
  assert.equal(isMainModule(import.meta.url, path.join(skillDir, 'scripts', 'nope.mjs')), false);
  assert.equal(isMainModule(import.meta.url, null), false);
});

test('validator CLIs still run main() when invoked through a symlinked skill directory', async (t) => {
  const { work, linked } = await withSymlinkedSkill(t);
  const evidence = path.join(work, 'evidence.json');
  const course = path.join(work, 'course.md');
  const delivery = path.join(work, 'delivery.json');
  await writeFile(evidence, JSON.stringify({
    source: { source_id: 's', duration_seconds: 10 },
    segments: [], claims: [], raw_evidence: [],
    visual_coverage: { embedded_files: [] },
  }));
  await writeFile(course, '# course\n');
  await writeFile(delivery, JSON.stringify({
    source_id: 's', episode_id: '1', state: 'source_verified',
    state_history: [{ state: 'source_verified' }],
  }));

  for (const [script, args] of [
    ['validate-evidence.mjs', [evidence, work]],
    ['validate-course-artifacts.mjs', [evidence, course, work]],
    ['validate-delivery.mjs', [delivery, work]],
  ]) {
    const result = run(path.join(linked, 'scripts', script), args, work);
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { valid: true, errors: [] }, script);
  }

  const transcript = path.join(work, 't.txt');
  await writeFile(transcript, '[0:00] hi\n');
  const normalized = run(path.join(linked, 'scripts', 'normalize-transcript.mjs'), ['--input', transcript], work);
  assert.equal(normalized.status, 0, normalized.stderr);
  assert.notEqual(normalized.stdout.trim(), '');

  const source = run(path.join(linked, 'scripts', 'source-tools.mjs'), ['https://www.bilibili.com/video/BV1xztt6tEtu/?p=58'], work);
  assert.equal(source.status, 0, source.stderr);
  assert.equal(JSON.parse(source.stdout)[0].bvid, 'BV1xztt6tEtu');
});

test('a failing validator exits non-zero through a symlink', async (t) => {
  const { work, linked } = await withSymlinkedSkill(t);
  const delivery = path.join(work, 'delivery.json');
  await writeFile(delivery, JSON.stringify({ state: 'bogus' }));
  const result = run(path.join(linked, 'scripts', 'validate-delivery.mjs'), [delivery, work], work);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).valid, false);
});

test('hard-subtitle OCR reports a structured ocr_unavailable state off macOS', () => {
  assert.deepEqual(
    { status: checkOcrAvailability({ platform: 'linux' }).status, reason: checkOcrAvailability({ platform: 'linux' }).reason },
    { status: 'ocr_unavailable', reason: 'platform_not_macos' },
  );
  const noSwift = checkOcrAvailability({ platform: 'darwin', hasCommand: (name) => name !== 'swiftc' });
  assert.equal(noSwift.reason, 'swiftc_not_found');
  assert.equal(checkOcrAvailability({ platform: 'darwin', hasCommand: () => true }).status, 'ocr_available');
});

test('extract-hard-subtitles CLI prints ocr_unavailable JSON instead of a stack on non-macOS', { skip: process.platform === 'darwin' }, async (t) => {
  const { work, linked } = await withSymlinkedSkill(t);
  const result = run(path.join(linked, 'scripts', 'extract-hard-subtitles.mjs'), ['--video', path.join(work, 'missing.mp4')], work);
  assert.equal(result.status, 3);
  assert.equal(JSON.parse(result.stdout).status, 'ocr_unavailable');
  assert.doesNotMatch(result.stderr, /at .*\(/);
});

function fakeResponse({ status = 200, json = null, cookies = [] }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { getSetCookie: () => cookies, get: () => cookies.join(', ') || null },
    json: async () => json,
  };
}

const viewPayload = {
  code: 0,
  data: {
    title: 'series', aid: 1, owner: { name: 'up' },
    pages: [{ page: 1, cid: 11, part: 'a', duration: 60 }, { page: 58, cid: 41464826279, part: '058', duration: 358 }],
  },
};

test('resolveBilibiliCid retries with an anonymous buvid cookie after HTTP 412', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, cookie: options?.headers?.Cookie ?? null });
    if (url.includes('/view') && calls.length === 1) return fakeResponse({ status: 412 });
    if (url === 'https://www.bilibili.com/') {
      return fakeResponse({ cookies: ['buvid3=abc; Path=/; Domain=.bilibili.com', 'SESSDATA=secret; Path=/'] });
    }
    return fakeResponse({ json: viewPayload });
  };
  const result = await resolveBilibiliCid('BV1xztt6tEtu', '58', { fetchImpl });
  assert.equal(result.status, 'cid_resolved');
  assert.equal(result.cid, '41464826279');
  assert.equal(result.duration_seconds, 358);
  assert.equal(result.used_anonymous_cookie, true);
  assert.equal(result.request_mode, 'anonymous_request');
  assert.equal(calls.at(-1).cookie, 'buvid3=abc');
});

test('resolveBilibiliCid reports a missing page without guessing', async () => {
  const result = await resolveBilibiliCid('BV1', 99, { fetchImpl: async () => fakeResponse({ json: viewPayload }) });
  assert.equal(result.status, 'cid_unresolved');
});
