import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectSourceUrl } from '../scripts/source-tools.mjs';
import { normalizeTranscript } from '../scripts/normalize-transcript.mjs';

test('normalizes YouTube watch URLs', () => {
  const result = inspectSourceUrl('https://www.youtube.com/watch?v=MN9dGgmLyso&t=960s');
  assert.equal(result.platform, 'youtube');
  assert.equal(result.video_id, 'MN9dGgmLyso');
  assert.equal(result.normalized_url, 'https://www.youtube.com/watch?v=MN9dGgmLyso');
});

test('normalizes Bilibili watch-later URLs without losing episode identity', () => {
  const result = inspectSourceUrl('bilibili.com/list/watchlater/?bvid=BV1q9He6SEyX&oid=117376775358202&p=2');
  assert.equal(result.platform, 'bilibili');
  assert.equal(result.bvid, 'BV1q9He6SEyX');
  assert.equal(result.cid, '117376775358202');
  assert.equal(result.episode, '2');
});

test('normalizes timestamped transcript lines and merges repeated timestamps', () => {
  const result = normalizeTranscript(`[0:00] Hello
[0:00] world
[0:02] Next`, { durationSeconds: 5 });
  assert.deepEqual(result.body, [
    { from: 0, to: 2, text: 'Hello world' },
    { from: 2, to: 5, text: 'Next' },
  ]);
});
