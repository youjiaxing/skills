import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { resolveBilibiliIdentity } from '../scripts/bilibili-identity.mjs';
import { resolveBilibiliCid } from '../scripts/source-tools.mjs';
import { captureBilibiliFramesFromBrowser } from '../scripts/bilibili-browser-frames.mjs';
import { captureBilibiliSubtitle, classifyBilibiliSubtitleBody, matchesBilibiliSubtitleFile } from '../scripts/browser-adapters.mjs';

const bvid = 'BV1xztt6tEtu';
const identity = { status: 'identity_verified', bvid, episode: '2', page: 2, cid: '222', aid: 100, title: 'series', duration: 60 };
const cue = { from: 0, to: 1, content: 'target' };
const hash = 'a'.repeat(32);
const targetFile = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/100222${hash}`;
const otherFile = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/100111${hash}`;

function pageTab({ initial = {}, duration = 60, url = `https://www.bilibili.com/video/${bvid}?p=2`, lookup, onRead } = {}) {
  const location = { href: url };
  const video = { duration };
  const context = {
    URL, URLSearchParams, location, window: { __INITIAL_STATE__: initial },
    document: { title: 'series', querySelector: (selector) => selector === 'video' ? video : { innerText: 'series' } },
  };
  let reads = 0;
  const tab = {
    location, video, context,
    playwright: { async evaluate(fn, arg) {
      onRead?.(++reads, location, video);
      return vm.runInNewContext(`(${fn.toString()})(arg)`, { ...context, arg });
    } },
    capabilities: { async get() { return { async send(method, options) {
      assert.equal(method, 'Runtime.evaluate');
      return { result: { value: await vm.runInNewContext(options.expression, {
        encodeURIComponent, AbortSignal,
        fetch: async (url, opts) => {
          assert.equal(new URL(url).hostname, 'api.bilibili.com');
          assert.equal(opts.credentials, 'include');
          return { ok: true, json: async () => lookup };
        },
      }) } };
    } }; } },
  };
  return tab;
}

const pages = [{ page: 1, cid: 111, part: 'first', duration: 10 }, { page: 2, cid: 222, part: 'second', duration: 60 }];

test('URL part mapping takes precedence over a stale first-part cid', async () => {
  const tab = pageTab({ initial: { bvid, p: 1, cid: 111, videoData: { bvid, pages } } });
  const result = await resolveBilibiliIdentity(tab);
  assert.equal(result.cid, '222');
  assert.equal(result.part, 'second');
  assert.equal(result.cid_source, 'page_mapping');
});

test('missing or foreign initial state resolves the exact part through the browser API', async () => {
  for (const initial of [{}, { bvid: 'BVother', p: 2, cid: 999 }]) {
    const result = await resolveBilibiliIdentity(pageTab({ initial, lookup: { code: 0, data: { bvid, aid: 100, pages } } }));
    assert.equal(result.cid, '222');
    assert.equal(result.cid_source, 'browser_view');
    assert.equal(result.aid, 100);
  }
});

test('invalid part numbers never fall back to the first part or issue a request', async () => {
  for (const page of ['0', '-1', 'abc', '2.5', '', '9007199254740992']) {
    const result = await resolveBilibiliCid(bvid, page, { fetchImpl: () => { throw Error('must not fetch'); } });
    assert.equal(result.status, 'cid_unresolved');
    const browser = await resolveBilibiliIdentity(pageTab({ url: `https://www.bilibili.com/video/${bvid}?p=${page}` }));
    assert.equal(browser.status, 'identity_unavailable');
    assert.equal(browser.cid, null);
  }
  const foreign = await resolveBilibiliIdentity(pageTab({ url: `https://example.com/video/${bvid}?p=2` }));
  assert.equal(foreign.status, 'identity_unavailable');
});

test('a changed part or mismatched player duration invalidates a resolved CID', async () => {
  const base = { initial: { bvid, videoData: { bvid, pages } } };
  const changed = await resolveBilibiliIdentity(pageTab({ ...base, onRead: (n, location) => {
    if (n === 2) location.href = `https://www.bilibili.com/video/${bvid}?p=1`;
  } }));
  assert.equal(changed.status, 'source_changed');
  assert.equal(changed.cid, null);
  const mismatched = await resolveBilibiliIdentity(pageTab({ ...base, duration: 10 }));
  assert.equal(mismatched.status, 'player_identity_mismatch');
  assert.equal(mismatched.cid, null);
});

test('subtitle file association requires a complete aid/CID/hash path or explicit metadata linkage', () => {
  assert.equal(matchesBilibiliSubtitleFile(targetFile, identity), true);
  for (const url of [otherFile, targetFile.replace('100222', '1002223'), targetFile.replace('aisubtitle.hdslb.com', 'other.example'), targetFile + 'extra']) {
    assert.equal(matchesBilibiliSubtitleFile(url, identity), false);
  }
  const linked = 'https://aisubtitle.hdslb.com/another-format.json?track=chosen';
  assert.equal(matchesBilibiliSubtitleFile(linked, identity), false);
  assert.equal(matchesBilibiliSubtitleFile(linked, identity, [linked]), true);
});

function subtitleTab({ batches, bodies, after = identity, activation = false }) {
  const readBodies = [];
  let reads = 0, checks = 0;
  const cdp = {
    async send(method, args) {
      if (method === 'Network.getResponseBody') { readBodies.push(args.requestId); return bodies[args.requestId]; }
      return {};
    },
    async readEvents() {
      if (reads++ === 0) return { cursor: 0, events: [] };
      return { cursor: reads, events: batches.shift() ?? [], hasMore: false };
    },
  };
  const language = { async count() { return 1; }, async isVisible() { return true; }, async click() {} };
  const tab = {
    capabilities: { async get() { return cdp; } },
    async reload() {},
    playwright: {
      async waitForTimeout() {},
      locator() { return { async count() { return activation ? 1 : 0; }, async click() {} }; },
      getByText() { return language; },
    },
  };
  return { tab, readBodies, options: { waitMs: 1, resolveIdentity: async () => ++checks === 1 ? identity : after } };
}

const event = (id, url) => ({ params: { requestId: id, response: { url, status: 200 } } });
const jsonBody = (value) => ({ body: JSON.stringify(value), base64Encoded: false });
const metadataUrl = `https://api.bilibili.com/x/v2/subtitle/web/view?aid=100&cid=222`;

test('a late first-part response cannot replace the requested subtitle file', async () => {
  const { tab, readBodies, options } = subtitleTab({
    batches: [[event('target', targetFile), event('wrong', otherFile)]],
    bodies: { target: jsonBody({ body: [cue] }), wrong: jsonBody({ body: [{ ...cue, content: 'wrong part' }] }) },
  });
  const result = await captureBilibiliSubtitle(tab, options);
  assert.equal(result.status, 'subtitle_exported');
  assert.equal(result.value.body[0].content, 'target');
  assert.deepEqual(readBodies, ['target']);
  assert.equal(result.source_identity.cid, '222');
});

test('subtitle output is discarded when the page switches parts during collection', async () => {
  const { tab, options } = subtitleTab({ batches: [[event('target', targetFile)]], bodies: { target: jsonBody({ body: [cue] }) }, after: { ...identity, page: 1, cid: '111' } });
  const result = await captureBilibiliSubtitle(tab, options);
  assert.deepEqual(result, { status: 'source_changed' });
});

test('an empty target metadata response observed only after track activation is classified', async () => {
  const { tab, readBodies, options } = subtitleTab({ batches: [[], [event('empty', metadataUrl)]], bodies: { empty: { body: 'CgA=', base64Encoded: true } }, activation: true });
  const result = await captureBilibiliSubtitle(tab, options);
  assert.equal(result.status, 'subtitle_empty_response');
  assert.equal(result.track_activated, true);
  assert.deepEqual(readBodies, ['empty']);
});

test('metadata first observed after activation can explicitly link a different file layout', async () => {
  const url = 'https://aisubtitle.hdslb.com/custom/selected.json?track=chosen';
  const { tab, readBodies, options } = subtitleTab({
    batches: [[], [event('metadata', metadataUrl), event('file', url)]],
    bodies: { metadata: jsonBody({ subtitle: { subtitles: [{ subtitle_url: url }] } }), file: jsonBody({ body: [cue] }) }, activation: true,
  });
  const result = await captureBilibiliSubtitle(tab, options);
  assert.equal(result.status, 'subtitle_exported');
  assert.deepEqual(readBodies, ['metadata', 'file']);
});

test('arbitrary JSON metadata and malformed segments are not exported as subtitle text', () => {
  for (const value of [{ subtitle: { subtitles: [] } }, [], { body: [{ content: 'no time' }] },
    { body: [{ from: 1, to: 0, content: 'reversed' }] }, { body: [{ from: 0, to: 1, content: ' ' }] },
    { body: [{ from: -1, to: 0, content: 'negative time' }] }]) {
    assert.equal(classifyBilibiliSubtitleBody(jsonBody(value)).status, 'subtitle_response_unparsed');
  }
});

test('frame capture detects a changed BV before quality requests', async () => {
  const initial = { bvid, videoData: { bvid, pages } };
  const tab = pageTab({ initial });
  const evaluate = tab.playwright.evaluate;
  let count = 0;
  tab.playwright.evaluate = async (fn, arg) => {
    if (++count === 3) tab.location.href = 'https://www.bilibili.com/video/BVother?p=2';
    return evaluate(fn, arg);
  };
  const result = await captureBilibiliFramesFromBrowser(tab, { times: [0], outputDir: 'unused' });
  assert.equal(result.status, 'source_changed');
});

test('frame capture rechecks the source after an asynchronous wait and before drawing', async () => {
  const tab = pageTab({ initial: { bvid, videoData: { bvid, pages } } });
  Object.assign(tab.video, { videoWidth: 1920, videoHeight: 1080, currentTime: 0, pause() {}, play: async () => {} });
  tab.context.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { dash: { video: [{ id: 80, width: 1920, height: 1080, frameRate: 30 }] } } }) });
  tab.context.performance = { now: () => 0 };
  tab.context.setTimeout = (callback, milliseconds) => {
    if (milliseconds === 500) tab.location.href = `https://www.bilibili.com/video/${bvid}?p=1`;
    callback();
    return 1;
  };
  const result = await captureBilibiliFramesFromBrowser(tab, { times: [0], outputDir: 'unused', frameRateSampleSeconds: 0.001 });
  assert.equal(result.status, 'source_changed');
});
