import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectFrameTools, parseFfprobeFrameRate } from '../scripts/capture-bilibili-frames.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/capture-bilibili-frames.mjs');

test('prefers ffmpeg+ffprobe, then OpenCV', async () => {
  assert.equal((await detectFrameTools({ check: async () => true })).backend, 'ffmpeg');
  const cvOnly = await detectFrameTools({ check: async (cmd) => cmd === 'python3' });
  assert.equal(cvOnly.backend, 'opencv');
  const ffmpegWithoutProbe = await detectFrameTools({ check: async (cmd) => cmd === 'ffmpeg' || cmd === 'python3' });
  assert.equal(ffmpegWithoutProbe.backend, 'opencv');
});

test('reports frame_tools_missing when no backend exists', async () => {
  const result = await detectFrameTools({ check: async () => false });
  assert.equal(result.status, 'frame_tools_missing');
  assert.equal(result.blocked, true);
  assert.deepEqual(result.checked, { ffmpeg: false, ffprobe: false, opencv: false });
});

test('parses ffprobe rational frame rates', () => {
  assert.equal(parseFfprobeFrameRate('30/1'), 30);
  assert.equal(parseFfprobeFrameRate('30000/1001').toFixed(2), '29.97');
  assert.equal(parseFfprobeFrameRate(''), null);
});

test('CLI stops before any network download when no frame tool is on PATH', async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'yjx-frames-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, '--bvid', 'BVtest', '--cid', '1', '--quality', '64', '--times', '1', '--output-dir', out], {
    encoding: 'utf8',
    env: { PATH: path.join(out, 'empty-bin') },
  });
  assert.equal(result.status, 4, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'frame_tools_missing');
  assert.deepEqual(await readdir(out), []);
});
