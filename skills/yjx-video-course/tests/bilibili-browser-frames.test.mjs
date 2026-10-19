import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureBilibiliFramesFromBrowser } from '../scripts/bilibili-browser-frames.mjs';

// Exercise the real page callback and native protocol envelope, with a
// deterministic media clock. This tests executable code, not agent dialogue.
function mediaTab({ native = true, nativeAvailable = true, rejectEvaluate = false,
  deliveredFps = 30, manifestFps = 30, elapsedSeconds = 1.5, quality = 80, afterCapture, nativeException = false } = {}) {
  const calls = { quality: [], native: 0, timeout: null };
  const location = { href: 'https://www.bilibili.com/video/BVtest?p=2' };
  let time = 0, counters = 0;
  const listeners = new Map();
  const video = {
    duration: 60, videoWidth: 1920, videoHeight: 1080, clientWidth: 732, clientHeight: 412,
    readyState: 4, seeking: false, paused: true, muted: false,
    get currentTime() { return time; },
    set currentTime(value) { time = value; listeners.get('seeked')?.(); },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    pause() { this.paused = true; },
    async play() { this.paused = false; time += elapsedSeconds; },
    getVideoPlaybackQuality() { return { totalVideoFrames: counters++ * deliveredFps * elapsedSeconds }; },
  };
  const canvas = { getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,aW1hZ2U=' };
  const context = {
    URL, URLSearchParams, AbortSignal, location,
    performance: { now: () => 0 }, setTimeout: (fn, milliseconds) => { if (milliseconds < 10000) fn(); return 1; }, clearTimeout() {},
    window: {
      devicePixelRatio: 2,
      __INITIAL_STATE__: { bvid: 'BVtest', videoData: { bvid: 'BVtest', pages: [{ page: 2, cid: 222, duration: 60 }] } },
      player: { getQuality: () => ({ nowQ: quality }), async requestQuality(id) { calls.quality.push(id); } },
    },
    document: {
      title: 'series', querySelector: (selector) => selector === 'video' ? video : { innerText: 'series' },
      createElement: () => canvas,
    },
    fetch: async () => ({ ok: true, json: async () => ({ code: 0, data: { dash: { video: [
      { id: 80, width: 1920, height: 1080, frameRate: manifestFps },
    ] } } }) }),
  };
  const tab = {
    playwright: { async evaluate(fn, arg) {
      if (arg?.times && rejectEvaluate) throw Error('host exposes read-only evaluation');
      return vm.runInNewContext(`(${fn.toString()})(arg)`, { ...context, fetch: native ? undefined : context.fetch, arg });
    } },
    capabilities: { async get() {
      if (!nativeAvailable) throw Error('native execution unsupported');
      return { async send(method, args, options) {
        assert.equal(method, 'Runtime.evaluate');
        assert.equal(args.awaitPromise, true);
        assert.equal(args.returnByValue, true);
        calls.native++;
        calls.timeout = options.timeoutMs;
        if (nativeException) return { exceptionDetails: { text: 'page error' } };
        const value = await vm.runInNewContext(args.expression, context);
        afterCapture?.(location, video, value);
        return { result: { value } };
      } };
    } },
  };
  return { tab, calls, video };
}

async function outputFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-browser-frames-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'frames');
}

test('read-only DOM falls back to native execution and writes distinct timed frame bytes', async (t) => {
  const { tab, calls, video } = mediaTab();
  const outputDir = await outputFor(t);
  const result = await captureBilibiliFramesFromBrowser(tab, { times: [20.1, 20.2], outputDir });
  assert.equal(result.status, 'captured');
  assert.equal(result.execution_backend, 'native_cdp');
  assert.equal(result.capture_surface, 'video_decoded_frame');
  assert.equal(result.cid, '222');
  assert.equal(calls.native, 1);
  assert.ok(calls.timeout > 3000);
  assert.deepEqual(calls.quality, []); // Requesting the current quality can reject in the real player.
  assert.equal(video.paused, true);
  assert.equal(video.muted, false);
  assert.notEqual(result.frames[0].path, result.frames[1].path);
  for (const frame of result.frames) {
    assert.equal(frame.current_time, frame.time);
    assert.equal(await fs.readFile(frame.path, 'utf8'), 'image');
  }
});

test('a host that rejects mutable evaluate still uses the bound native tab', async (t) => {
  const { tab } = mediaTab({ rejectEvaluate: true });
  assert.equal((await captureBilibiliFramesFromBrowser(tab, { times: [20], outputDir: await outputFor(t) })).status, 'captured');
});

test('a mutable host captures directly and selects quality only when it differs', async (t) => {
  const { tab, calls } = mediaTab({ native: false, quality: 64 });
  const result = await captureBilibiliFramesFromBrowser(tab, { times: [20], outputDir: await outputFor(t) });
  assert.equal(result.status, 'captured');
  assert.equal(result.execution_backend, 'page_evaluate');
  assert.equal(calls.native, 0);
  assert.deepEqual(calls.quality, [80]);
});

test('missing native support and native page exceptions return distinct failures without writing', async (t) => {
  for (const [options, status] of [
    [{ nativeAvailable: false }, 'frame_capture_capability_unavailable'],
    [{ nativeException: true }, 'frame_capture_failed'],
  ]) {
    const outputDir = await outputFor(t);
    assert.equal((await captureBilibiliFramesFromBrowser(mediaTab(options).tab, { times: [20], outputDir })).status, status);
    await assert.rejects(fs.access(outputDir));
  }
});

test('a post-capture part change discards images before creating an output directory', async (t) => {
  const { tab } = mediaTab({ afterCapture: (location) => { location.href = 'https://www.bilibili.com/video/BVtest?p=1'; } });
  const outputDir = await outputFor(t);
  const result = await captureBilibiliFramesFromBrowser(tab, { times: [20], outputDir });
  assert.equal(result.status, 'source_changed');
  await assert.rejects(fs.access(outputDir));
});

test('short sample counter rounding accepts 29.97fps but rejects 30fps for a 60fps variant', async (t) => {
  const accepted = await captureBilibiliFramesFromBrowser(mediaTab({ deliveredFps: 29.97 }).tab, { times: [20], outputDir: await outputFor(t) });
  assert.equal(accepted.status, 'captured');
  const { tab, calls } = mediaTab({ manifestFps: 60 });
  const rejected = await captureBilibiliFramesFromBrowser(tab, { times: [20], outputDir: await outputFor(t) });
  assert.equal(rejected.status, 'frame_rate_not_honored');
  assert.equal(calls.native, 1); // A semantic failure must not trigger another backend attempt.
});

test('unknown delivered frame rate is not reported as verified capture', async (t) => {
  const { tab, video } = mediaTab();
  video.getVideoPlaybackQuality = undefined;
  assert.equal((await captureBilibiliFramesFromBrowser(tab, { times: [20], outputDir: await outputFor(t) })).status, 'frame_rate_unverified');
});

test('a near-end short sample with no delivered frames cannot pass through rounding tolerance', async (t) => {
  const { tab } = mediaTab({ elapsedSeconds: 0.01, deliveredFps: 0, manifestFps: 60 });
  const outputDir = await outputFor(t);
  assert.equal((await captureBilibiliFramesFromBrowser(tab, { times: [20], outputDir })).status, 'frame_rate_unverified');
  await assert.rejects(fs.access(outputDir));
});

test('invalid or out-of-range target times stop before native media execution', async (t) => {
  const { tab, calls } = mediaTab();
  const outputDir = await outputFor(t);
  for (const times of [[NaN], [Infinity], [-1], ['20']]) {
    await assert.rejects(captureBilibiliFramesFromBrowser(tab, { times, outputDir }), /finite non-negative/);
  }
  assert.equal((await captureBilibiliFramesFromBrowser(tab, { times: [60], outputDir })).status, 'invalid_capture_time');
  assert.equal(calls.native, 0);
});
