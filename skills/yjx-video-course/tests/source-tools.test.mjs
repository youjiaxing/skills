import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectSourceUrl } from '../scripts/source-tools.mjs';
import { normalizeTranscript } from '../scripts/normalize-transcript.mjs';
import {
  captureBilibiliSubtitle,
  classifyBilibiliSubtitleBody,
} from '../scripts/browser-adapters.mjs';

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

test('classifies an empty Bilibili binary subtitle response without calling it missing', () => {
  assert.deepEqual(classifyBilibiliSubtitleBody({ base64Encoded: true, body: 'CgA=' }), {
    status: 'subtitle_empty_response',
    bytes: 2,
  });
});

test('classifies a real Bilibili subtitle JSON payload as exported text', () => {
  const payload = {
    type: 'AIsubtitle',
    lang: 'zh',
    body: [
      { from: 0.22, to: 3.06, content: '所以我们现在了解了规格和工单' },
    ],
  };
  assert.deepEqual(classifyBilibiliSubtitleBody({
    base64Encoded: false,
    body: JSON.stringify(payload),
  }), {
    status: 'subtitle_exported',
    format: 'json',
    value: payload,
  });
});

test('captures and classifies an observed empty Bilibili subtitle response end to end', async () => {
  const calls = [];
  const cdp = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Network.getResponseBody') {
        return { base64Encoded: true, body: 'CgA=' };
      }
      return {};
    },
    async readEvents(options) {
      if (!options.afterSequence) return { cursor: 'before', events: [] };
      return {
        cursor: 'after',
        events: [
          {
            params: {
              requestId: 'request-1',
              response: {
                url: 'https://api.bilibili.com/x/v2/subtitle/web/view?aid=1&cid=2',
                status: 200,
              },
            },
          },
          {
            params: {
              requestId: 'ignored',
              response: {
                url: 'https://api.bilibili.com/x/v2/subtitle/web/list',
                status: 200,
              },
            },
          },
        ],
      };
    },
  };
  const tab = {
    capabilities: { async get(name) {
      assert.equal(name, 'cdp');
      return cdp;
    } },
    async reload() {
      calls.push({ method: 'tab.reload' });
    },
    playwright: {
      async waitForTimeout(ms) {
        assert.equal(ms, 1);
      },
    },
  };

  const result = await captureBilibiliSubtitle(tab, { waitMs: 1 });

  assert.deepEqual(result, {
    status: 'subtitle_empty_response',
    bytes: 2,
    source_url: 'https://api.bilibili.com/x/v2/subtitle/web/view',
    http_status: 200,
  });
  assert.equal(calls.some((call) => call.method === 'Network.getResponseBody'), true);
});
