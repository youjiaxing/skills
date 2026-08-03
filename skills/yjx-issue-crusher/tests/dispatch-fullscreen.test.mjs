/**
 * Ticket 01 — Ink fullscreen dispatch shell seams.
 *
 * Seams under test:
 * 1. shouldUseFullscreenDispatch — TTY interactive vs --once / non-TTY routing
 * 2. DispatchShell via renderToString — region skeleton (顶栏/中部/当前槽/底栏)
 * 3. runFullscreenDispatch — start + q quit (no hang); surface stop on quit
 * 4. runDispatchTui non-TTY — never enters fullscreen / still returns
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createChainRun } from '../scripts/chain-run.mjs';
import { createDispatchSurface } from '../scripts/dispatch-surface.mjs';
import {
  DispatchShell,
  runFullscreenDispatch,
  shouldUseFullscreenDispatch,
} from '../scripts/dispatch-fullscreen.mjs';
import { runDispatchTui } from '../scripts/dispatch-tui.mjs';
import { createFakeLauncher } from '../scripts/fake-launcher.mjs';
import { createFakeTracker } from '../scripts/fake-tracker.mjs';
import { createMemoryModeConfig } from '../scripts/mode-config.mjs';
import { createElement } from 'react';
import { renderToString } from 'ink';

function makeSurface(overrides = {}) {
  const tracker = createFakeTracker({
    candidates: overrides.candidates ?? [],
    feature: 'demo',
  });
  const launcher = createFakeLauncher();
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
    modeConfig: createMemoryModeConfig({ mode: null }),
  });
  return createDispatchSurface({ chain, tracker });
}

function fakeTtyStream() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return stream;
}

function fakeStdin() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return stdin;
}

test('shouldUseFullscreenDispatch: only interactive dual-TTY, never --once / non-TTY', () => {
  const ttyIn = { isTTY: true };
  const ttyOut = { isTTY: true };
  const pipeIn = { isTTY: false };
  const pipeOut = { isTTY: false };

  assert.equal(shouldUseFullscreenDispatch({ input: ttyIn, output: ttyOut }), true);
  assert.equal(shouldUseFullscreenDispatch({ input: ttyIn, output: ttyOut, once: true }), false);
  assert.equal(shouldUseFullscreenDispatch({ input: pipeIn, output: ttyOut }), false);
  assert.equal(shouldUseFullscreenDispatch({ input: ttyIn, output: pipeOut }), false);
  assert.equal(shouldUseFullscreenDispatch({ input: pipeIn, output: pipeOut }), false);
});

test('DispatchShell skeleton exposes 顶栏 / 中部 / 当前槽 / 底栏 regions', () => {
  const text = renderToString(createElement(DispatchShell, {
    snap: {
      feature: 'demo',
      runtime: 'grok',
      subsequentMode: 'review',
      status: 'idle',
      stopped: false,
      slot: null,
      cwd: '/tmp/project',
    },
  }));

  assert.match(text, /\[顶栏\]/);
  assert.match(text, /\[中部\]/);
  assert.match(text, /\[当前槽\]/);
  assert.match(text, /\[底栏\]/);
  assert.match(text, /\[q\].*退出|退出/);
  // Must not look like the old one-page + readline prompt surface.
  assert.doesNotMatch(text, /^>\s*$/m);
});

test('runFullscreenDispatch starts shell and quits cleanly on q', async () => {
  const surface = makeSurface();
  const stdin = fakeStdin();
  const stdout = fakeTtyStream();
  let out = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    out += chunk;
  });

  const runPromise = runFullscreenDispatch({
    surface,
    input: stdin,
    output: stdout,
    autoTick: true,
    // Tests: skip alt-screen so PassThrough stays simple.
    alternateScreen: false,
  });

  // Allow first render + initial tick, then quit.
  await new Promise((r) => setTimeout(r, 80));
  stdin.write('q');

  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('fullscreen did not exit after q')), 3000);
    }),
  ]);

  assert.equal(result.stopped, true);
  assert.ok(result.ticks >= 1);
  assert.match(out, /\[顶栏\]|\[底栏\]|Issue Crusher/);
});

test('runDispatchTui on non-TTY never hangs on Ink and still supports q', async () => {
  const surface = makeSurface();
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  let out = '';
  output.on('data', (chunk) => {
    out += chunk;
  });

  const runPromise = runDispatchTui({
    surface,
    input,
    output,
    autoTick: true,
    pollIntervalMs: 5000,
  });

  await new Promise((r) => setTimeout(r, 40));
  input.write('q\n');

  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('non-TTY TUI hung')), 3000);
    }),
  ]);

  assert.equal(result.stopped, true);
  // Legacy printable frame path (not Ink region markers required).
  assert.match(out, /Issue Crusher|调度|当前槽/);
  assert.doesNotMatch(out, /\[顶栏\]/);
});
