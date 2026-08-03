/**
 * Ticket 04 — fullscreen startup feature/runtime prompts.
 *
 * Seams under test:
 * 1. mapStartupSelectKey / applyStartupSelectKey — pure list nav + confirm/cancel
 * 2. renderStartupSelectFrame — title + items + highlight (no real terminal)
 * 3. resolveFeatureOrPrompt / resolveRuntimeOrPrompt — selectItems over ask;
 *    nonInteractive never calls selectItems
 * 4. runFullscreenSelect — injected stdin confirm/cancel exits (no hang);
 *    alternate-screen leave on exit
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  resolveFeatureOrPrompt,
  resolveRuntimeOrPrompt,
} from '../scripts/interactive-prompts.mjs';
import {
  applyStartupSelectKey,
  mapStartupSelectKey,
  renderStartupSelectFrame,
  runFullscreenSelect,
  shouldUseFullscreenStartupPrompt,
  StartupSelectShell,
} from '../scripts/startup-select.mjs';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { runChain } from '../scripts/cli.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('shouldUseFullscreenStartupPrompt: dual-TTY only; never --once / non-TTY', () => {
  const ttyIn = { isTTY: true };
  const ttyOut = { isTTY: true };
  const pipeIn = { isTTY: false };
  const pipeOut = { isTTY: false };

  assert.equal(shouldUseFullscreenStartupPrompt({ input: ttyIn, output: ttyOut }), true);
  assert.equal(
    shouldUseFullscreenStartupPrompt({ input: ttyIn, output: ttyOut, once: true }),
    false,
  );
  assert.equal(
    shouldUseFullscreenStartupPrompt({ input: ttyIn, output: ttyOut, nonInteractive: true }),
    false,
  );
  assert.equal(shouldUseFullscreenStartupPrompt({ input: pipeIn, output: ttyOut }), false);
  assert.equal(shouldUseFullscreenStartupPrompt({ input: ttyIn, output: pipeOut }), false);
});

test('mapStartupSelectKey: j/k/digits/enter/q', () => {
  assert.deepEqual(mapStartupSelectKey('j'), { type: 'next' });
  assert.deepEqual(mapStartupSelectKey('k'), { type: 'prev' });
  assert.deepEqual(mapStartupSelectKey('1'), { type: 'index', arg: 0 });
  assert.deepEqual(mapStartupSelectKey('2'), { type: 'index', arg: 1 });
  assert.deepEqual(mapStartupSelectKey('\r'), { type: 'confirm' });
  assert.deepEqual(mapStartupSelectKey('\n'), { type: 'confirm' });
  assert.deepEqual(mapStartupSelectKey('q'), { type: 'cancel' });
  assert.equal(mapStartupSelectKey('x'), null);
  assert.equal(mapStartupSelectKey('ab'), null);
});

test('applyStartupSelectKey: navigate, confirm, cancel', () => {
  const items = [
    { value: 'alpha', label: 'alpha' },
    { value: 'beta', label: 'beta' },
    { value: 'gamma', label: 'gamma' },
  ];

  let state = { selectedIndex: 0, done: false, cancelled: false, value: null };

  state = applyStartupSelectKey(state, mapStartupSelectKey('j'), items);
  assert.equal(state.selectedIndex, 1);
  assert.equal(state.done, false);

  state = applyStartupSelectKey(state, mapStartupSelectKey('j'), items);
  assert.equal(state.selectedIndex, 2);

  state = applyStartupSelectKey(state, mapStartupSelectKey('j'), items);
  assert.equal(state.selectedIndex, 0);

  state = applyStartupSelectKey(state, mapStartupSelectKey('2'), items);
  assert.equal(state.selectedIndex, 1);

  state = applyStartupSelectKey(state, mapStartupSelectKey('\r'), items);
  assert.equal(state.done, true);
  assert.equal(state.cancelled, false);
  assert.equal(state.value, 'beta');

  const cancelState = applyStartupSelectKey(
    { selectedIndex: 0, done: false, cancelled: false, value: null },
    mapStartupSelectKey('q'),
    items,
  );
  assert.equal(cancelState.done, true);
  assert.equal(cancelState.cancelled, true);
  assert.equal(cancelState.value, null);
});

test('renderStartupSelectFrame lists title, items, highlight, and key hints', () => {
  const text = renderStartupSelectFrame({
    title: '请选择 feature',
    items: [
      { value: 'alpha', label: 'alpha' },
      { value: 'beta', label: 'beta' },
    ],
    selectedIndex: 1,
  });
  assert.match(text, /请选择 feature/);
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.match(text, /◀|选中|›|>/);
  assert.match(text, /\[j\].*\[k\]|上下|移动/);
  assert.match(text, /确认|Enter|回车/);
  assert.match(text, /\[q\].*取消|退出/);
});

test('StartupSelectShell renderToString exposes title and items', () => {
  const text = renderToString(createElement(StartupSelectShell, {
    title: '请选择 Worker 运行时',
    items: [
      { value: 'grok', label: 'grok (Grok Build)' },
      { value: 'claude', label: 'claude (Claude Code)' },
    ],
    selectedIndex: 0,
  }));
  assert.match(text, /请选择 Worker 运行时/);
  assert.match(text, /grok/);
  assert.match(text, /claude/);
  assert.doesNotMatch(text, /^>\s*$/m);
});

test('resolveFeatureOrPrompt uses selectItems instead of ask', async () => {
  let asked = false;
  let selectCalls = 0;
  const feature = await resolveFeatureOrPrompt({
    projectRoot: '/tmp',
    listFeatures: async () => ['alpha', 'beta'],
    ask: async () => {
      asked = true;
      return '1';
    },
    selectItems: async ({ title, items }) => {
      selectCalls += 1;
      assert.match(title, /feature/i);
      assert.deepEqual(items.map((i) => i.value), ['alpha', 'beta']);
      return 'beta';
    },
    output: { write() {} },
  });
  assert.equal(feature, 'beta');
  assert.equal(selectCalls, 1);
  assert.equal(asked, false);
});

test('resolveFeatureOrPrompt selectItems cancel throws', async () => {
  await assert.rejects(
    () => resolveFeatureOrPrompt({
      projectRoot: '/tmp',
      listFeatures: async () => ['alpha', 'beta'],
      selectItems: async () => null,
      output: { write() {} },
    }),
    /取消/,
  );
});

test('resolveRuntimeOrPrompt uses selectItems for grok/claude set', async () => {
  const runtime = await resolveRuntimeOrPrompt({
    selectItems: async ({ title, items }) => {
      assert.match(title, /runtime|运行时/i);
      assert.deepEqual(items.map((i) => i.value), ['grok', 'claude']);
      return 'claude';
    },
    output: { write() {} },
  });
  assert.equal(runtime, 'claude');
});

test('resolveRuntimeOrPrompt nonInteractive never calls selectItems', async () => {
  let called = false;
  await assert.rejects(
    () => resolveRuntimeOrPrompt({
      nonInteractive: true,
      selectItems: async () => {
        called = true;
        return 'grok';
      },
    }),
    /runtime/,
  );
  assert.equal(called, false);
});

test('resolveFeatureOrPrompt nonInteractive never calls selectItems', async () => {
  let called = false;
  await assert.rejects(
    () => resolveFeatureOrPrompt({
      projectRoot: '/tmp',
      listFeatures: async () => ['a', 'b'],
      nonInteractive: true,
      selectItems: async () => {
        called = true;
        return 'a';
      },
    }),
    /多个 feature|请指定/,
  );
  assert.equal(called, false);
});

test('runFullscreenSelect confirms with enter (no hang)', async () => {
  const stdin = fakeStdin();
  const stdout = fakeTtyStream();
  let out = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    out += chunk;
  });

  const runPromise = runFullscreenSelect({
    title: '请选择 feature',
    items: [
      { value: 'alpha', label: 'alpha' },
      { value: 'beta', label: 'beta' },
    ],
    input: stdin,
    output: stdout,
    alternateScreen: false,
  });

  await new Promise((r) => setTimeout(r, 60));
  stdin.write('j');
  await new Promise((r) => setTimeout(r, 40));
  stdin.write('\r');

  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('startup select did not exit after enter')), 3000);
    }),
  ]);

  assert.equal(result.cancelled, false);
  assert.equal(result.value, 'beta');
  assert.match(out, /请选择 feature|alpha|beta/);
});

test('runFullscreenSelect cancel with q exits cleanly', async () => {
  const stdin = fakeStdin();
  const stdout = fakeTtyStream();

  const runPromise = runFullscreenSelect({
    title: '请选择 Worker 运行时',
    items: [
      { value: 'grok', label: 'grok' },
      { value: 'claude', label: 'claude' },
    ],
    input: stdin,
    output: stdout,
    alternateScreen: false,
  });

  await new Promise((r) => setTimeout(r, 60));
  stdin.write('q');

  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('startup select did not exit after q')), 3000);
    }),
  ]);

  assert.equal(result.cancelled, true);
  assert.equal(result.value, null);
});

test('runFullscreenSelect restores alternate screen on exit', async () => {
  const stdin = fakeStdin();
  const stdout = fakeTtyStream();
  let out = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    out += chunk;
  });

  const runPromise = runFullscreenSelect({
    title: '请选择',
    items: [{ value: 'only', label: 'only' }],
    input: stdin,
    output: stdout,
    alternateScreen: true,
  });

  await new Promise((r) => setTimeout(r, 60));
  stdin.write('\r');
  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('startup select hang on alt-screen path')), 3000);
    }),
  ]);

  // DECSET alternate screen on, then off (leave) so terminal is not left broken.
  assert.match(out, /\u001b\[\?1049h/);
  assert.match(out, /\u001b\[\?1049l/);
});

test('runChain --once / non-TTY never calls selectItems (multi-feature errors)', async () => {
  const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = path.join(skillDir, 'fixtures', 'empty-frontier');
  const calls = [];

  await assert.rejects(
    () => runChain({
      cwd: fixture,
      projectRoot: fixture,
      feature: null,
      runtime: null,
      fakeLauncher: true,
      once: true,
      selectItems: async () => {
        calls.push('select');
        return 'demo';
      },
      listFeatures: async () => ['alpha', 'beta'],
      output: { write() {} },
      input: { isTTY: false },
    }),
    /多个 feature|请指定/,
  );
  assert.equal(calls.length, 0);
});

test('runChain uses selectItems for feature+runtime then quits dispatch cleanly', async () => {
  const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = path.join(skillDir, 'fixtures', 'empty-frontier');
  const titles = [];
  const stdin = fakeStdin();
  const stdout = fakeTtyStream();
  let out = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    out += chunk;
  });

  const runPromise = runChain({
    cwd: fixture,
    projectRoot: fixture,
    feature: null,
    runtime: null,
    // fakeLauncher would skip runtime prompt; real launcher is fine on empty frontier.
    fakeLauncher: false,
    once: false,
    input: stdin,
    output: stdout,
    selectItems: async ({ title, items }) => {
      titles.push(title);
      if (/feature/i.test(title)) return 'demo';
      if (/runtime|运行时/i.test(title)) return 'claude';
      return items[0]?.value ?? null;
    },
    listFeatures: async () => ['demo', 'other'],
  });

  // Allow selectItems + first dispatch frame, then quit fullscreen shell.
  await new Promise((r) => setTimeout(r, 120));
  stdin.write('q');

  const code = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('runChain did not exit after select + q')), 5000);
    }),
  ]);

  assert.equal(code, 0);
  assert.equal(titles.length, 2);
  assert.match(titles[0], /feature/i);
  assert.match(titles[1], /runtime|运行时/i);
  assert.match(out, /demo|顶栏|调度|claude/);
});
