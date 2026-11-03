import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {captureDecodedVideoFrame} from '../scripts/browser-frame-capture.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const frame = {dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  decodedFrameSize: {width: 1, height: 1}, renderedPlayerSize: {width: 1, height: 1},
  devicePixelRatio: 1, currentTime: 1, wasPaused: true};

async function output(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'decoded-frame-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return path.join(dir, 'frame.png');
}

test('restricted page scope falls back once to the bound native capability and returns only metadata', async t => {
  const outputPath = await output(t);
  let nativeCalls = 0;
  const tab = {playwright: {evaluate: async () => ({status:'frame_capture_capability_unavailable'})},
    capabilities: {get: async name => {
      assert.equal(name, 'cdp');
      return {send: async (method, params) => {
        nativeCalls++;
        assert.equal(method, 'Runtime.evaluate');
        assert.equal(params.awaitPromise, true);
        assert.equal(params.returnByValue, true);
        return {result: {value: frame}};
      }};
    }}};
  const result = await captureDecodedVideoFrame(tab, {timeSeconds:1, outputPath});
  assert.equal(nativeCalls, 1);
  assert.deepEqual(await readFile(outputPath), png);
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.executionBackend, 'native_cdp');
  assert.equal(result.dataUrl, undefined);
  assert.equal(result.bytes, png.length);
});

test('existing evidence is not overwritten', async t => {
  const outputPath = await output(t);
  await writeFile(outputPath, 'existing evidence');
  await assert.rejects(captureDecodedVideoFrame({playwright:{evaluate:async()=>frame}},
    {timeSeconds:1, outputPath}), {code:'EEXIST'});
  assert.equal(await readFile(outputPath, 'utf8'), 'existing evidence');
});

test('unavailable or failed native execution publishes no image', async t => {
  const outputPath = await output(t);
  await assert.rejects(captureDecodedVideoFrame({playwright:{evaluate:async()=>{throw new TypeError('restricted');}}},
    {timeSeconds:1, outputPath}), /capability unavailable/);
  const tab = {capabilities:{get:async()=>({send:async()=>({exceptionDetails:{text:'failed'}})})}};
  await assert.rejects(captureDecodedVideoFrame(tab, {timeSeconds:1, outputPath}), /did not complete/);
  await assert.rejects(readFile(outputPath), {code:'ENOENT'});
});
