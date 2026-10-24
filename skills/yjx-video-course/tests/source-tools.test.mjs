import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectSourceUrl } from '../scripts/source-tools.mjs';
import {
  captureBilibiliSubtitle,
  classifyBilibiliSubtitleBody,
} from '../scripts/browser-adapters.mjs';
import { resolveBilibiliIdentity } from '../scripts/bilibili-browser-frames.mjs';

test('uses an explicit Bilibili cid without confusing it with oid', () => {
  const result = inspectSourceUrl('https://www.bilibili.com/video/BV1q9He6SEyX?p=2&oid=117376775358202&cid=41464826279');
  assert.equal(result.cid, '41464826279');
  assert.equal(result.episode, '2');
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

  const sourceIdentity = { status: 'identity_verified', bvid: 'BV1', page: 2, cid: '2', aid: 1 };
  const result = await captureBilibiliSubtitle(tab, { waitMs: 1, resolveIdentity: async () => sourceIdentity });

  assert.deepEqual(result, {
    status: 'subtitle_empty_response',
    bytes: 2,
    track_activated: false,
    source_identity: { bvid: 'BV1', page: 2, cid: '2', aid: 1 },
    source_url: 'https://api.bilibili.com/x/v2/subtitle/web/view',
    http_status: 200,
  });
  assert.equal(calls.some((call) => call.method === 'Network.getResponseBody'), true);
});

test('preserves verified part identity through the frame module export', async () => {
  const tab = {
    playwright: {
      async evaluate() {
        return {
          bvid: 'BV1xztt6tEtu',
          episode: '63',
          page: 63,
          cid: '41464827714',
          title: '063 执行工单 - 问题_哔哩哔哩_bilibili',
          duration: 373,
          url: 'https://www.bilibili.com/video/BV1xztt6tEtu?p=63',
        };
      },
    },
  };

  const result = await resolveBilibiliIdentity(tab);
  assert.equal(result.bvid, 'BV1xztt6tEtu');
  assert.equal(result.episode, '63');
  assert.equal(result.cid, '41464827714');
});
