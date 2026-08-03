/**
 * Ticket 01 — Ink fullscreen dispatch shell seams.
 * Ticket 02 — live Dispatch Surface snapshot in regions.
 *
 * Seams under test:
 * 1. shouldUseFullscreenDispatch — TTY interactive vs --once / non-TTY routing
 * 2. DispatchShell via renderToString — region skeleton (顶栏/中部/当前槽/底栏)
 * 3. runFullscreenDispatch — start + q quit (no hang); surface stop on quit
 * 4. runDispatchTui non-TTY — never enters fullscreen / still returns
 * 5. pure region text / DispatchShell — given snapshot → 中文分区内容
 * 6. poll tick — successive snapshots refresh fullscreen content without retyping
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createChainRun } from '../scripts/chain-run.mjs';
import { createDispatchSurface } from '../scripts/dispatch-surface.mjs';
import {
  DispatchShell,
  renderMiddlePanel,
  renderSlotPanel,
  renderTopBar,
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

// --- Ticket 02: live snapshot regions ---

const boardIssues = [
  {
    id: '01-done.md',
    title: '已完成票',
    closed: true,
    blockedBy: [],
    unlocks: ['02-ready.md'],
    status: 'ready-for-agent',
  },
  {
    id: '02-ready.md',
    title: '可执行票',
    closed: false,
    blockedBy: ['01-done.md'],
    unlocks: ['03-blocked.md'],
    status: 'ready-for-agent',
  },
  {
    id: '03-blocked.md',
    title: '阻塞票',
    closed: false,
    blockedBy: ['02-ready.md'],
    unlocks: [],
    status: 'ready-for-agent',
  },
];

function snapWithBoard(overrides = {}) {
  return {
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
    subsequentMode: 'review',
    workerMode: null,
    status: 'idle',
    stopped: false,
    slot: null,
    pendingHitl: null,
    board: { feature: 'demo', readOnly: true, issues: boardIssues },
    messages: [],
    actions: {},
    ...overrides,
  };
}

test('renderTopBar shows feature / runtime / subsequent mode / chain status incl. 停链', () => {
  const live = renderTopBar(snapWithBoard({
    status: 'soft-stuck',
    subsequentMode: 'vibe',
    stopped: false,
  }));
  assert.match(live, /功能:\s*demo/);
  assert.match(live, /runtime:\s*grok|运行时:\s*grok/);
  assert.match(live, /后续 mode:\s*vibe/);
  assert.match(live, /软卡住|soft-stuck/);

  const stopped = renderTopBar(snapWithBoard({
    status: 'stopped',
    stopped: true,
  }));
  assert.match(stopped, /已停链/);
});

test('renderMiddlePanel shows 中文图例、依赖图与「现在可执行」', () => {
  const middle = renderMiddlePanel(snapWithBoard({
    slot: {
      issueId: '02-ready.md',
      title: '可执行票',
      pid: 4242,
      mode: 'review',
      closed: false,
    },
  }));

  assert.match(middle, /依赖图/);
  assert.match(middle, /只读|不可图上派票/);
  assert.match(middle, /图例/);
  assert.match(middle, /★可执行/);
  assert.match(middle, /▶进行中|现在可执行/);
  assert.match(middle, /──►/);
  assert.match(middle, /现在可执行/);
  assert.match(middle, /02-ready\.md|★\s*02/);
  // Graph marks: 01 closed, 02 in slot
  assert.match(middle, /✓01|✓\s*01/);
  assert.match(middle, /▶02|▶\s*02/);
});

test('renderSlotPanel shows empty slot or ticket/pid/closed/mode and pending HITL', () => {
  const empty = renderSlotPanel(snapWithBoard());
  assert.match(empty, /当前槽/);
  assert.match(empty, /（空）|空/);

  const occupied = renderSlotPanel(snapWithBoard({
    status: 'soft-stuck',
    slot: {
      issueId: '02-ready.md',
      title: '可执行票',
      pid: 99,
      sessionId: 'sess-1',
      mode: 'vibe',
      closed: false,
    },
  }));
  assert.match(occupied, /02-ready\.md/);
  assert.match(occupied, /pid:\s*99/);
  assert.match(occupied, /mode:\s*vibe/);
  assert.match(occupied, /已关票:\s*否/);

  const hitl = renderSlotPanel(snapWithBoard({
    status: 'needs-confirmation',
    pendingHitl: {
      issueId: '01-wayfinder.md',
      entryClass: 'wayfinder',
      title: '探路票',
      runtime: 'claude',
      mode: 'review',
      model: null,
      effort: null,
    },
  }));
  assert.match(hitl, /人工确认|HITL|需确认/);
  assert.match(hitl, /01-wayfinder\.md/);
  assert.match(hitl, /wayfinder|探路/);
});

test('DispatchShell given snapshot shows top / middle / slot live content (not placeholders)', () => {
  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard({
      status: 'needs-confirmation',
      subsequentMode: 'review',
      slot: null,
      pendingHitl: {
        issueId: '01-wayfinder.md',
        entryClass: 'wayfinder',
        title: '探路票',
        runtime: 'grok',
        mode: 'review',
      },
    }),
  }));

  // Ink may wrap long top-bar lines; match fields independently.
  assert.match(text, /\[顶栏\]/);
  assert.match(text, /功能:\s*demo/);
  assert.match(text, /runtime:\s*grok|运行时:\s*grok/);
  assert.match(text, /后续 mode:/);
  assert.match(text, /review/);
  assert.match(text, /需人工确认|needs-confirmation/);
  assert.match(text, /依赖图/);
  assert.match(text, /图例/);
  assert.match(text, /现在可执行/);
  assert.match(text, /02-ready\.md|★\s*02/);
  assert.match(text, /人工确认|需确认|HITL/);
  assert.match(text, /01-wayfinder\.md/);
  assert.doesNotMatch(text, /占位/);
});

test('region text updates when snapshot migrates (poll equivalence)', () => {
  const before = snapWithBoard({ status: 'idle', slot: null, stopped: false });
  const after = snapWithBoard({
    status: 'soft-stuck',
    slot: {
      issueId: '02-ready.md',
      title: '可执行票',
      pid: 7,
      mode: 'review',
      closed: false,
    },
    stopped: false,
  });

  const topBefore = renderTopBar(before);
  const topAfter = renderTopBar(after);
  assert.match(topBefore, /空闲|idle/);
  assert.match(topAfter, /软卡住|soft-stuck/);
  assert.notEqual(topBefore, topAfter);

  const slotBefore = renderSlotPanel(before);
  const slotAfter = renderSlotPanel(after);
  assert.match(slotBefore, /（空）|空/);
  assert.match(slotAfter, /02-ready\.md/);
  assert.match(slotAfter, /pid:\s*7/);
  assert.notEqual(slotBefore, slotAfter);

  const shellBefore = renderToString(createElement(DispatchShell, { snap: before }));
  const shellAfter = renderToString(createElement(DispatchShell, { snap: after }));
  assert.match(shellBefore, /空闲|idle/);
  assert.match(shellAfter, /软卡住|soft-stuck/);
  assert.match(shellAfter, /pid:\s*7/);
  assert.notEqual(shellBefore, shellAfter);
});

test('runFullscreenDispatch poll tick refreshes shell from successive snapshots', async () => {
  let n = 0;
  const snaps = [
    snapWithBoard({ status: 'idle', slot: null }),
    snapWithBoard({
      status: 'soft-stuck',
      slot: {
        issueId: '02-ready.md',
        title: '可执行票',
        pid: 55,
        mode: 'review',
        closed: false,
      },
    }),
  ];

  const surface = {
    async tick() {
      const snap = snaps[Math.min(n, snaps.length - 1)];
      n += 1;
      this._last = snap;
      return snap;
    },
    async refresh() {
      return this._last ?? snaps[0];
    },
    snapshot() {
      if (!this._last) throw new Error('no snapshot yet');
      return this._last;
    },
    async stop() {
      this._last = { ...this._last, stopped: true, status: 'stopped' };
      return { ok: true };
    },
  };

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
    // Floor inside runFullscreenDispatch is 250ms; wait past two intervals.
    pollIntervalMs: 250,
    alternateScreen: false,
  });

  // bootstrap tick + at least one poll tick (min interval 250ms)
  await new Promise((r) => setTimeout(r, 700));
  stdin.write('q');

  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('fullscreen poll test did not exit')), 3000);
    }),
  ]);

  assert.ok(result.ticks >= 2, `expected >=2 ticks, got ${result.ticks}`);
  assert.match(out, /pid:\s*55|02-ready\.md|软卡住/);
});
