/**
 * Ticket 01 — Ink fullscreen dispatch shell seams.
 * Ticket 02 — live Dispatch Surface snapshot in regions.
 * Ticket 03 — fullscreen keyboard drives existing dispatch actions.
 *
 * Seams under test:
 * 1. shouldUseFullscreenDispatch — TTY interactive vs --once / non-TTY routing
 * 2. DispatchShell via renderToString — region skeleton (顶栏/中部/当前槽/底栏)
 * 3. runFullscreenDispatch — start + q quit (no hang); surface stop on quit
 * 4. runDispatchTui non-TTY — never enters fullscreen / still returns
 * 5. pure region text / DispatchShell — given snapshot → 中文分区内容
 * 6. poll tick — successive snapshots refresh fullscreen content without retyping
 * 7. mapFullscreenKey — single key → same command types as surface
 * 8. handleFullscreenKey / key sequences — mode/force/resume/HITL/stop/tick/q
 * 9. list selection j/k/↑↓/digits — highlight only; no graph dispatch / no worker embed
 * 10. ticket 04 — arrow keys ≡ j/k; footer labels Enter / arrows / s auto
 * 11. ticket 05 — fullscreen layout polish: stretch middle, hierarchy, no ghost labels
 * 12. 20260804-1006 / 02 — hard layout: numeric terminal height, footer pin, top wrap
 * 13. 20260804-1802 / 02 — fullscreen `o` model→effort transactional menu + top/footer
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createChainRun } from '../scripts/chain-run.mjs';
import { handleDispatchCommand } from '../scripts/dispatch-commands.mjs';
import { createDispatchSurface } from '../scripts/dispatch-surface.mjs';
import {
  ALT_ENTER,
  ALT_LEAVE,
  CLEAR_SCREEN,
  DispatchShell,
  applyModelEffortMenuKey,
  defaultEffortItems,
  defaultModelItems,
  describeShellLayout,
  drainPendingInput,
  enterAlternateScreen,
  handleFullscreenKey,
  leaveAlternateScreen,
  mapFullscreenKey,
  nextListSelection,
  openModelEffortMenu,
  renderFooter,
  renderMiddlePanel,
  renderModelEffortMenuFrame,
  renderNotice,
  renderSlotPanel,
  renderTopBar,
  resolveShellHeight,
  runFullscreenDispatch,
  shouldUseFullscreenDispatch,
  truncateDisplayField,
} from '../scripts/dispatch-fullscreen.mjs';
import { runDispatchTui } from '../scripts/dispatch-tui.mjs';
import { createFakeLauncher } from '../scripts/fake-launcher.mjs';
import { createFakeTracker } from '../scripts/fake-tracker.mjs';
import { createMemoryModeConfig } from '../scripts/mode-config.mjs';
import { createElement } from 'react';
import { renderToString } from 'ink';

function candidate(id, overrides = {}) {
  const number = id.split('-')[0];
  return {
    id,
    number,
    title: overrides.title ?? id.replace(/\.md$/, ''),
    path: overrides.path ?? `.scratch/demo/issues/${id}`,
    ...overrides,
  };
}

function makeSurface(overrides = {}) {
  const {
    candidates = [],
    hitlCandidates = [],
    completions = {},
    boardIssues = null,
    launcherOptions = {},
    modeConfig = createMemoryModeConfig({ mode: null }),
    ...chainOptions
  } = overrides;

  const tracker = createFakeTracker({
    candidates,
    hitlCandidates,
    completions,
    boardIssues,
    feature: chainOptions.feature ?? 'demo',
  });
  const launcher = createFakeLauncher(launcherOptions);
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
    modeConfig,
    ...chainOptions,
  });
  const surface = createDispatchSurface({ chain, tracker });
  return { tracker, launcher, chain, surface, modeConfig };
}

function makeSurfaceOnly(overrides = {}) {
  return makeSurface(overrides).surface;
}

function fakeTtyStream() {
  // High water + always-drain: full-height frames write more than the default
  // 16KB buffer; without a consumer, PassThrough backpressure freezes Ink exit.
  const stream = new PassThrough({ highWaterMark: 1024 * 1024 });
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  stream.on('data', () => {});
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

  // Four regions by content, without debug bracket labels.
  assert.match(text, /Issue Crusher|调度/);
  assert.match(text, /依赖图|现在可执行/);
  assert.match(text, /当前槽/);
  assert.match(text, /\[q\].*退出|退出/);
  assert.doesNotMatch(text, /\[顶栏\]|\[中部\]|\[底栏\]/);
  // Must not look like the old one-page + readline prompt surface.
  assert.doesNotMatch(text, /^>\s*$/m);
});

test('runFullscreenDispatch starts shell and quits cleanly on q', async () => {
  const surface = makeSurfaceOnly();
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
  assert.match(out, /Issue Crusher|调度|\[q\]|退出/);
});

// --- dispatch-tui-start-and-polish / 01: fullscreen default no auto-spawn ---

test('fullscreen mount: autoAdvance off; ready board + multi tick/poll → zero spawn', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  // Default chain autoAdvance is on (once seam); fullscreen mount must force it off.
  const { launcher, surface } = makeSurface({ candidates: [first, second] });

  const stdin = fakeStdin();
  const stdout = fakeTtyStream();

  const runPromise = runFullscreenDispatch({
    surface,
    input: stdin,
    output: stdout,
    autoTick: true,
    pollIntervalMs: 250,
    alternateScreen: false,
  });

  // bootstrap + at least one poll interval of continuous tick
  await new Promise((r) => setTimeout(r, 700));

  let snap = null;
  try {
    snap = surface.snapshot();
  } catch {
    snap = null;
  }
  assert.ok(snap, 'fullscreen bootstrap should produce a snapshot');
  assert.equal(snap.autoAdvance, false, 'fullscreen initial autoAdvance must be off');
  assert.equal(snap.slot, null);
  assert.equal(launcher.launches.length, 0, 'ready board must not auto-spawn under fullscreen');

  // another poll window — still zero
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(launcher.launches.length, 0);
  assert.equal(surface.snapshot().autoAdvance, false);

  stdin.write('q');
  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('fullscreen zero-spawn test did not exit')), 3000);
    }),
  ]);
  assert.equal(result.mode, 'fullscreen');
  assert.equal(launcher.launches.length, 0);
});

// --- 20260804-1006-fix-fullscreen-cold-start / 01: cold start zero slot ---

test('drainPendingInput drops buffered keys so residual Enter cannot reach the app', () => {
  const stdin = fakeStdin();
  stdin.write('\r\n');
  stdin.write('q');
  const n = drainPendingInput(stdin);
  assert.ok(n > 0, 'should report drained bytes/chars');
  assert.equal(stdin.read(), null, 'buffer must be empty after drain');
});

test('fullscreen mount: residual Enter from startup select does not spawn or occupy slot', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  // Runtime already resolved as grok — must not imply spawn.
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    runtime: 'grok',
  });

  const stdin = fakeStdin();
  const stdout = fakeTtyStream();
  // Simulate leftover confirm from feature/runtime fullscreen picker.
  stdin.write('\r');
  stdin.write('\n');

  const runPromise = runFullscreenDispatch({
    surface,
    input: stdin,
    output: stdout,
    autoTick: true,
    pollIntervalMs: 250,
    alternateScreen: false,
  });

  await new Promise((r) => setTimeout(r, 800));

  const snap = surface.snapshot();
  assert.equal(snap.autoAdvance, false, 'residual Enter must not open auto');
  assert.equal(snap.slot, null, 'residual Enter must not occupy slot');
  assert.equal(launcher.launches.length, 0, 'residual Enter must not launch');
  assert.equal(snap.runtime, 'grok');

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(launcher.launches.length, 0);

  stdin.write('q');
  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('residual-enter cold-start test hung')), 3000);
    }),
  ]);
  assert.equal(launcher.launches.length, 0);
});

test('fullscreen cold start then Enter: exactly one launch (default next); highlight path one launch', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    runtime: 'grok',
  });

  const stdin = fakeStdin();
  const stdout = fakeTtyStream();

  const runPromise = runFullscreenDispatch({
    surface,
    input: stdin,
    output: stdout,
    autoTick: true,
    pollIntervalMs: 5000,
    alternateScreen: false,
  });

  // Cold window: multi-tick equivalent settle with auto off / empty slot.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(launcher.launches.length, 0);
  assert.equal(surface.snapshot().slot, null);
  assert.equal(surface.snapshot().autoAdvance, false);

  // No highlight → board default next (01).
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '01-first.md');
  assert.equal(surface.snapshot().slot?.issueId, '01-first.md');

  stdin.write('q');
  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('cold-start Enter default test hung')), 3000);
    }),
  ]);
  assert.equal(launcher.launches.length, 1, 'quit must not spawn more');
});

test('fullscreen cold start: j highlight then Enter launches only the highlighted ticket', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  // Board status must be ready-for-agent so the executable list is non-empty
  // (listExecutableIssueIds ignores non-ready roles like bare "impl").
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    runtime: 'grok',
    boardIssues: [
      {
        id: '01-first.md',
        title: 'first',
        closed: false,
        blockedBy: [],
        unlocks: [],
        status: 'ready-for-agent',
      },
      {
        id: '02-second.md',
        title: 'second',
        closed: false,
        blockedBy: [],
        unlocks: [],
        status: 'ready-for-agent',
      },
    ],
  });

  const stdin = fakeStdin();
  const stdout = fakeTtyStream();

  const runPromise = runFullscreenDispatch({
    surface,
    input: stdin,
    output: stdout,
    autoTick: true,
    pollIntervalMs: 5000,
    alternateScreen: false,
  });

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(launcher.launches.length, 0);
  assert.equal(surface.snapshot().slot, null);

  // From null highlight, first j uses base 0 then next → index 1 (02).
  stdin.write('j');
  await new Promise((r) => setTimeout(r, 100));
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 180));

  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '02-second.md');
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');

  stdin.write('q');
  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('cold-start highlight Enter test hung')), 3000);
    }),
  ]);
  assert.equal(launcher.launches.length, 1);
});

test('runDispatchTui on non-TTY never hangs on Ink and still supports q', async () => {
  const surface = makeSurfaceOnly();
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

test('renderTopBar shows feature / runtime / subsequent mode / autoAdvance / chain status', () => {
  const live = renderTopBar(snapWithBoard({
    status: 'soft-stuck',
    subsequentMode: 'vibe',
    stopped: false,
    autoAdvance: true,
  }));
  assert.match(live, /功能:\s*demo/);
  assert.match(live, /runtime:\s*grok|运行时:\s*grok/);
  assert.match(live, /后续 mode:\s*vibe/);
  assert.match(live, /自动开下一张:\s*开/);
  assert.match(live, /软卡住|soft-stuck/);

  const off = renderTopBar(snapWithBoard({
    status: 'idle',
    stopped: false,
    autoAdvance: false,
  }));
  assert.match(off, /自动开下一张:\s*关/);

  const stopped = renderTopBar(snapWithBoard({
    status: 'stopped',
    stopped: true,
    autoAdvance: false,
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
  assert.match(text, /Issue Crusher|调度/);
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
  assert.doesNotMatch(text, /\[顶栏\]|\[中部\]|\[底栏\]/);
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

// --- Ticket 03: fullscreen keyboard → existing dispatch actions ---

test('mapFullscreenKey maps m/f/r/y/n/s/t/q and list nav to surface command types', () => {
  assert.deepEqual(mapFullscreenKey('q'), { type: 'quit' });
  assert.deepEqual(mapFullscreenKey('Q'), { type: 'quit' });
  // Fullscreen s toggles auto-open-next (not chain stop).
  assert.deepEqual(mapFullscreenKey('s'), { type: 'toggleAutoAdvance' });
  assert.deepEqual(mapFullscreenKey('t'), { type: 'tick' });
  assert.deepEqual(mapFullscreenKey('f'), { type: 'forceAdvance' });
  assert.deepEqual(mapFullscreenKey('r'), { type: 'resume' });
  assert.deepEqual(mapFullscreenKey('y'), { type: 'confirmHitl' });
  assert.deepEqual(mapFullscreenKey('n'), { type: 'rejectHitl' });

  // Mode dial: single `m` toggles subsequent mode (fullscreen has no readline arg).
  assert.deepEqual(
    mapFullscreenKey('m', { subsequentMode: 'review' }),
    { type: 'setMode', arg: 'vibe' },
  );
  assert.deepEqual(
    mapFullscreenKey('m', { subsequentMode: 'vibe' }),
    { type: 'setMode', arg: 'review' },
  );

  assert.deepEqual(mapFullscreenKey('j'), { type: 'selectNext' });
  assert.deepEqual(mapFullscreenKey('k'), { type: 'selectPrev' });
  assert.deepEqual(mapFullscreenKey('1'), { type: 'selectIndex', arg: 0 });
  assert.deepEqual(mapFullscreenKey('3'), { type: 'selectIndex', arg: 2 });
  assert.equal(mapFullscreenKey('x'), null);
  // No graph-dispatch key exists.
  assert.equal(mapFullscreenKey('d'), null);
});

// --- dispatch-tui-start-and-polish / 04: arrow keys + footer labels ---

test('mapFullscreenKey: ↓ 与 j 同向 selectNext；↑ 与 k 同向 selectPrev', () => {
  // Ink passes empty input + key.upArrow / key.downArrow for arrow keys.
  assert.deepEqual(
    mapFullscreenKey('', { key: { downArrow: true } }),
    { type: 'selectNext' },
  );
  assert.deepEqual(
    mapFullscreenKey(null, { key: { downArrow: true } }),
    { type: 'selectNext' },
  );
  assert.deepEqual(
    mapFullscreenKey('', { key: { upArrow: true } }),
    { type: 'selectPrev' },
  );
  assert.deepEqual(
    mapFullscreenKey(null, { key: { upArrow: true } }),
    { type: 'selectPrev' },
  );
  // Same direction lock: j ≡ ↓, k ≡ ↑
  assert.deepEqual(mapFullscreenKey('j'), mapFullscreenKey('', { key: { downArrow: true } }));
  assert.deepEqual(mapFullscreenKey('k'), mapFullscreenKey('', { key: { upArrow: true } }));
});

test('handleFullscreenKey arrow keys only move highlight — never spawn', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });
  await surface.refresh();
  const launchesBefore = launcher.launches.length;

  const down = await handleFullscreenKey(surface, '', {
    key: { downArrow: true },
    selectedIndex: 0,
    executableCount: 2,
  });
  assert.equal(down.selectionOnly, true);
  assert.equal(down.selectedIndex, 1);

  const up = await handleFullscreenKey(surface, '', {
    key: { upArrow: true },
    selectedIndex: 1,
    executableCount: 2,
  });
  assert.equal(up.selectionOnly, true);
  assert.equal(up.selectedIndex, 0);

  assert.equal(launcher.launches.length, launchesBefore);
  assert.equal(surface.snapshot().slot, null);
});

test('handleFullscreenKey m dial switches mode, shows vibe tip, pins live worker', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, modeConfig } = makeSurface({
    candidates: [first, second],
    mode: 'review',
  });

  await surface.tick();
  assert.equal(surface.snapshot().slot.mode, 'review');

  const result = await handleFullscreenKey(surface, 'm', {
    subsequentMode: surface.snapshot().subsequentMode,
  });
  assert.equal(result.quit, undefined);
  assert.match(result.message || '', /vibe|关票|Closed|auto/i);
  assert.equal(modeConfig.readMode(), 'vibe');
  assert.equal(surface.snapshot().subsequentMode, 'vibe');
  assert.equal(surface.snapshot().slot.mode, 'review', 'live worker stays pinned');

  // Dial back to review, then complete first so next spawn takes subsequent mode.
  await handleFullscreenKey(surface, 'm', {
    subsequentMode: surface.snapshot().subsequentMode,
  });
  assert.equal(surface.snapshot().subsequentMode, 'review');
  await handleFullscreenKey(surface, 'm', {
    subsequentMode: surface.snapshot().subsequentMode,
  });
  assert.equal(surface.snapshot().subsequentMode, 'vibe');

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(surface.snapshot().slot.mode, 'vibe');
});

test('handleFullscreenKey f rejects when not Closed; advances when Closed', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, surface } = makeSurface({ candidates: [first, second] });

  await surface.tick();
  const denied = await handleFullscreenKey(surface, 'f');
  assert.match(denied.message || '', /无法强制推进|not-closed|Closed/i);
  assert.equal(surface.snapshot().actions.forceAdvance.available, false);

  tracker.setCompletion('01-first.md', true);
  await surface.refresh();
  assert.equal(surface.snapshot().actions.forceAdvance.available, true);

  const forced = await handleFullscreenKey(surface, 'f');
  assert.match(forced.message || '', /强制推进|接力/);
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');
});

test('handleFullscreenKey r resumes needs-resume with recorded session id', async () => {
  const first = candidate('01-first.md');
  const { launcher, surface } = makeSurface({
    candidates: [first],
    launcherOptions: { sessionId: 'sess-fs-resume' },
  });

  await surface.tick();
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(surface.snapshot().status, 'needs-resume');

  const resumed = await handleFullscreenKey(surface, 'r');
  assert.match(resumed.message || '', /恢复|pid/);
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].kind, 'resume');
  assert.equal(launcher.launches[1].sessionId, 'sess-fs-resume');
});

test('handleFullscreenKey y/n match HITL confirm/reject surface semantics', async () => {
  const wayfinder = candidate('01-wayfinder.md', {
    entryClass: 'wayfinder',
    type: 'research',
  });
  const { launcher, surface } = makeSurface({
    candidates: [],
    hitlCandidates: [wayfinder],
  });

  await surface.tick();
  assert.equal(surface.snapshot().status, 'needs-confirmation');

  const rejected = await handleFullscreenKey(surface, 'n');
  assert.match(rejected.message || '', /拒绝|空/);
  assert.equal(launcher.launches.length, 0);
  assert.equal(surface.snapshot().slot, null);

  await surface.tick();
  const confirmed = await handleFullscreenKey(surface, 'y');
  assert.match(confirmed.message || '', /同意|Worker|开/);
  assert.equal(launcher.launches.length, 1);
  assert.match(launcher.launches[0].initialPrompt, /\/wayfinder\b/);
});

test('handleFullscreenKey s toggles autoAdvance; q stops and signals quit', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });

  await surface.refresh();
  assert.equal(surface.snapshot().autoAdvance, false);

  // s on → empty slot may auto-spawn without Enter
  const turnedOn = await handleFullscreenKey(surface, 's');
  assert.match(turnedOn.message || '', /自动开下一张.*开/);
  assert.equal(surface.snapshot().autoAdvance, true);
  assert.equal(surface.snapshot().stopped, false);

  await surface.tick();
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-first.md');

  // s off → no auto handoff
  const turnedOff = await handleFullscreenKey(surface, 's');
  assert.match(turnedOff.message || '', /自动开下一张.*关/);
  assert.equal(surface.snapshot().autoAdvance, false);

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(launcher.launches.length, 1, 's-off must not auto-spawn next');

  const quit = await handleFullscreenKey(surface, 'q');
  assert.equal(quit.quit, true);
  assert.equal(surface.snapshot().stopped, true);
  assert.equal(surface.snapshot().autoAdvance, false);
});

test('handleFullscreenKey t runs a manual surface tick', async () => {
  const first = candidate('01-first.md');
  const { surface } = makeSurface({ candidates: [first] });
  // No auto bootstrap — tick only via key.
  const before = (() => {
    try {
      return surface.snapshot();
    } catch {
      return null;
    }
  })();
  assert.equal(before, null);

  await handleFullscreenKey(surface, 't');
  assert.equal(surface.snapshot().slot?.issueId, '01-first.md');
});

test('nextListSelection + renderMiddlePanel highlight executable via j/k/digits', () => {
  assert.equal(nextListSelection({ type: 'selectNext' }, 0, 3), 1);
  assert.equal(nextListSelection({ type: 'selectNext' }, 2, 3), 0);
  assert.equal(nextListSelection({ type: 'selectPrev' }, 0, 3), 2);
  assert.equal(nextListSelection({ type: 'selectIndex', arg: 1 }, 0, 3), 1);
  assert.equal(nextListSelection({ type: 'selectIndex', arg: 9 }, 0, 3), null);
  assert.equal(nextListSelection({ type: 'selectNext' }, null, 0), null);

  const middle = renderMiddlePanel(snapWithBoard({
    board: {
      feature: 'demo',
      readOnly: true,
      issues: [
        {
          id: '01-a.md',
          title: 'a',
          closed: false,
          blockedBy: [],
          unlocks: [],
          status: 'ready-for-agent',
        },
        {
          id: '02-b.md',
          title: 'b',
          closed: false,
          blockedBy: [],
          unlocks: [],
          status: 'ready-for-agent',
        },
      ],
    },
  }), { selectedIndex: 1 });

  assert.match(middle, /02-b\.md/);
  assert.match(middle, /◀选中|选中|▶选/);
  // Selection is display-only: still declares read-only / no graph dispatch.
  assert.match(middle, /只读|不可图上派票/);
});

test('list selection keys never spawn or claim — display-only, no graph dispatch', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
  });
  await surface.tick();
  const launchesBefore = launcher.launches.length;
  const slotBefore = surface.snapshot().slot?.issueId;

  const j = await handleFullscreenKey(surface, 'j', {
    selectedIndex: 0,
    executableCount: 2,
  });
  assert.equal(j.selectionOnly, true);
  assert.equal(j.selectedIndex, 1);

  const digit = await handleFullscreenKey(surface, '1', {
    selectedIndex: 1,
    executableCount: 2,
  });
  assert.equal(digit.selectionOnly, true);
  assert.equal(digit.selectedIndex, 0);

  assert.equal(launcher.launches.length, launchesBefore);
  assert.equal(surface.snapshot().slot?.issueId, slotBefore);
  assert.equal(typeof surface.dispatchFromGraph, 'undefined');
  assert.equal(typeof surface.claimViaGraph, 'undefined');
});

test('renderFooter lists surface keys; shell has no mouse / worker embed / graph dispatch', () => {
  const footer = renderFooter(snapWithBoard({
    status: 'needs-confirmation',
    autoAdvance: false,
    actions: {
      setMode: { available: true },
      forceAdvance: { available: false },
      resume: { available: false },
      confirmHitl: { available: true },
      rejectHitl: { available: true },
    },
    pendingHitl: {
      issueId: '01-wayfinder.md',
      entryClass: 'wayfinder',
    },
  }));

  assert.match(footer, /\[m\]/);
  assert.match(footer, /\[y\]/);
  assert.match(footer, /\[n\]/);
  assert.match(footer, /\[s\].*自动/);
  assert.doesNotMatch(footer, /\[s\] 停链/);
  assert.match(footer, /\[t\]/);
  assert.match(footer, /\[q\].*退出/);
  assert.doesNotMatch(footer, /\[q\] 退出并停链/);
  // Navigation + start labels: j/k + arrows + digits, Enter start, s auto dial.
  assert.match(footer, /j\/k/);
  assert.match(footer, /↑|↓|方向键/);
  assert.match(footer, /数字/);
  assert.match(footer, /\[Enter\].*开始|Enter.*开始/);
  assert.match(footer, /\[s\].*自动/);
  // Must not claim selection never starts / is display-only forever.
  assert.doesNotMatch(footer, /只影响显示|永不派票|永不开票|不派票/);

  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard(),
    notice: 'mode → vibe。后果提示',
    selectedIndex: 0,
  }));
  assert.match(text, /mode → vibe|后果提示/);
  assert.doesNotMatch(text, /鼠标|mouse|embed worker|内嵌 Worker|graph dispatch|图上派票\s*开/i);
  assert.match(text, /不可图上派票|只读/);
});

test('runFullscreenDispatch m then q: mode dial + stop-and-exit via keys', async () => {
  const { surface, modeConfig } = makeSurface({
    candidates: [candidate('01-first.md')],
    mode: 'review',
  });
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
    pollIntervalMs: 5000,
    alternateScreen: false,
  });

  await new Promise((r) => setTimeout(r, 100));
  stdin.write('m');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(modeConfig.readMode(), 'vibe');
  stdin.write('q');

  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('fullscreen key integration did not exit')), 3000);
    }),
  ]);

  assert.equal(result.stopped, true);
  assert.match(out, /vibe|关票|mode|提示/i);
});

// Shared handleDispatchCommand still the single apply path for surface commands.
test('mapFullscreenKey commands are accepted by handleDispatchCommand', async () => {
  const { surface } = makeSurface({ candidates: [], autoAdvance: false });
  await surface.refresh();
  const cmd = mapFullscreenKey('s');
  const result = await handleDispatchCommand(surface, cmd);
  assert.match(result.message || '', /自动开下一张.*开/);
  assert.equal(surface.snapshot().autoAdvance, true);
  assert.equal(surface.snapshot().stopped, false);
});

// --- dispatch-tui-start-and-polish / 02: Enter start + auto handoff ---

test('mapFullscreenKey Enter / return maps to start', () => {
  assert.deepEqual(mapFullscreenKey('\r'), { type: 'start' });
  assert.deepEqual(mapFullscreenKey('\n'), { type: 'start' });
  assert.deepEqual(mapFullscreenKey('', { key: { return: true } }), { type: 'start' });
  assert.deepEqual(mapFullscreenKey(null, { key: { return: true } }), { type: 'start' });
});

test('handleFullscreenKey Enter with selectedIssueId spawns that ticket', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });
  await surface.refresh();

  const result = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: '02-second.md',
  });
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '02-second.md');
  assert.equal(surface.snapshot().autoAdvance, true);
});

test('handleFullscreenKey Enter without selection spawns board default next', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });
  await surface.refresh();

  const result = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: null,
  });
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches[0].issue.id, '01-first.md');
});

test('first Enter opens auto; Closed∧exit + tick auto-spawns board next ignoring highlight', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const third = candidate('03-third.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second, third],
    autoAdvance: false,
  });
  await surface.refresh();

  // Enter starts first (no highlight)
  await handleFullscreenKey(surface, '\r', { selectedIssueId: null });
  assert.equal(launcher.launches[0].issue.id, '01-first.md');
  assert.equal(surface.snapshot().autoAdvance, true);

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);

  // Highlight deliberately parked on third; auto path must still take board next (02)
  await surface.tick();
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');
  assert.notEqual(launcher.launches[1].issue.id, '03-third.md');
});

test('Enter while slot occupied does not double-spawn', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });
  await surface.refresh();

  await handleFullscreenKey(surface, '\r', { selectedIssueId: '01-first.md' });
  const blocked = await handleFullscreenKey(surface, '\r', { selectedIssueId: '02-second.md' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'slot-occupied');
  assert.equal(launcher.launches.length, 1);
});

test('slot empty + auto on + highlight + Enter can cut in on highlighted ticket', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const third = candidate('03-third.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second, third],
    autoAdvance: false,
  });
  await surface.refresh();

  // First Enter opens auto and occupies slot with first
  await handleFullscreenKey(surface, '\r', { selectedIssueId: '01-first.md' });
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  // Release slot without auto-spawning by stepping once with... wait, auto is on so tick would spawn.
  // Simulate: close+exit then manual Enter on third before poll — need empty slot first.
  // Force release via tick would auto-spawn 02. Instead: turn auto off temporarily? Spec says
  // auto on + empty slot + highlight + Enter cuts in. So clear slot without auto fire:
  await surface.setAutoAdvance(false);
  await surface.tick(); // release only
  assert.equal(surface.snapshot().slot, null);
  await surface.setAutoAdvance(true);

  const cutIn = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: '03-third.md',
  });
  assert.equal(cutIn.spawned, true);
  assert.equal(launcher.launches[launcher.launches.length - 1].issue.id, '03-third.md');
});

// --- dispatch-tui-start-and-polish / 03: s toggle + Enter does not reopen ---

test('after s-off, Enter opens one ticket but does not reopen autoAdvance', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });
  await surface.refresh();

  await handleFullscreenKey(surface, '\r', { selectedIssueId: '01-first.md' });
  assert.equal(surface.snapshot().autoAdvance, true);

  await handleFullscreenKey(surface, 's');
  assert.equal(surface.snapshot().autoAdvance, false);

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(surface.snapshot().slot, null);

  const started = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: '02-second.md',
  });
  assert.equal(started.spawned, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(surface.snapshot().autoAdvance, false, 'Enter after s-off must not reopen auto');
});

test('s on with empty slot auto-spawns on tick without Enter', async () => {
  const only = candidate('01-ready.md');
  const { launcher, surface } = makeSurface({
    candidates: [only],
    autoAdvance: false,
  });
  await surface.refresh();
  assert.equal(launcher.launches.length, 0);

  await handleFullscreenKey(surface, 's');
  assert.equal(surface.snapshot().autoAdvance, true);

  await surface.tick();
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-ready.md');
});

// --- dispatch-tui-start-and-polish / 05: fullscreen layout + visual hierarchy ---

test('describeShellLayout: four stable regions; middle is stretch main', () => {
  const layout = describeShellLayout();
  assert.deepEqual(layout.regions, ['top', 'middle', 'slot', 'footer']);
  assert.equal(layout.root.height, '100%');
  assert.equal(layout.root.width, '100%');
  assert.equal(layout.root.flexDirection, 'column');
  assert.equal(layout.middle.flexGrow, 1);
  assert.equal(layout.middle.stretch, true);
  assert.equal(layout.top.flexGrow, 0);
  assert.equal(layout.slot.flexGrow, 0);
  assert.equal(layout.footer.flexGrow, 0);
  // No heavy animation contract — layout is static structure only.
  assert.equal(layout.animation, false);
});

test('region pure text drops debug bracket labels; keeps product copy', () => {
  const top = renderTopBar(snapWithBoard({ autoAdvance: false }));
  const middle = renderMiddlePanel(snapWithBoard());
  const slot = renderSlotPanel(snapWithBoard());
  const footer = renderFooter(snapWithBoard({ autoAdvance: false }));
  const notice = renderNotice(snapWithBoard(), '已切换自动开下一张：开');

  assert.doesNotMatch(top, /\[顶栏\]/);
  assert.doesNotMatch(middle, /\[中部\]/);
  assert.doesNotMatch(slot, /\[当前槽\]/);
  assert.doesNotMatch(footer, /\[底栏\]/);
  assert.doesNotMatch(notice, /\[提示\]/);

  assert.match(top, /Issue Crusher|调度/);
  assert.match(top, /功能:\s*demo/);
  assert.match(middle, /依赖图/);
  assert.match(middle, /现在可执行/);
  assert.match(slot, /当前槽/);
  assert.match(footer, /\[q\].*退出|退出/);
  assert.match(notice, /已切换自动开下一张：开/);
});

test('single shell frame has no duplicate top-bar product line (ghost proxy)', () => {
  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard({ autoAdvance: false, status: 'idle' }),
  }));
  // Unframed bare top copy must not sit beside the same framed product line twice.
  const productHits = text.match(/Issue Crusher · 调度/g) || [];
  assert.ok(productHits.length <= 1, `expected ≤1 product title, got ${productHits.length}: ${text}`);
  const featureHits = text.match(/功能:\s*demo/g) || [];
  assert.ok(featureHits.length <= 1, `expected ≤1 feature line, got ${featureHits.length}`);
  assert.doesNotMatch(text, /\[顶栏\].*\[顶栏\]/s);
});

test('selected row and current-slot marks are distinguishable; session is secondary', () => {
  const middle = renderMiddlePanel(snapWithBoard({
    board: {
      feature: 'demo',
      readOnly: true,
      issues: [
        {
          id: '01-a.md',
          title: 'a',
          closed: false,
          blockedBy: [],
          unlocks: [],
          status: 'ready-for-agent',
        },
        {
          id: '02-b.md',
          title: 'b',
          closed: false,
          blockedBy: [],
          unlocks: [],
          status: 'ready-for-agent',
        },
      ],
    },
    slot: {
      issueId: '01-a.md',
      title: 'a',
      pid: 11,
      mode: 'review',
      closed: false,
      sessionId: 'sess-very-long-secondary-field',
    },
  }), { selectedIndex: 1 });

  assert.match(middle, /01-a\.md.*◀当前槽|01-a\.md.*当前槽/);
  assert.match(middle, /02-b\.md.*◀选中|02-b\.md.*选中/);
  // Marks must not be identical tokens for both roles on the same row vocabulary.
  assert.match(middle, /当前槽/);
  assert.match(middle, /选中/);
  assert.notEqual(
    (middle.match(/当前槽/g) || [])[0],
    (middle.match(/选中/g) || [])[0],
  );

  const slot = renderSlotPanel(snapWithBoard({
    slot: {
      issueId: '02-ready.md',
      title: '可执行票',
      pid: 99,
      mode: 'vibe',
      closed: false,
      sessionId: 'sess-secondary-only',
    },
  }));
  // Primary slot fields stay on the main line; session is a secondary line.
  assert.match(slot, /票:\s*02-ready\.md/);
  assert.match(slot, /pid:\s*99/);
  assert.match(slot, /^\s+session:/m);
  const mainLine = slot.split('\n')[0];
  assert.doesNotMatch(mainLine, /session:/);
});

test('truncateDisplayField keeps readable head and does not explode long slot lines', () => {
  const longTitle = `超长标题-${'x'.repeat(80)}`;
  const longSession = `sess-${'a'.repeat(100)}`;
  const longIssueId = `99-${'very-long-ticket-slug-'.repeat(6)}.md`;
  const title = truncateDisplayField(longTitle, 24);
  const session = truncateDisplayField(longSession, 28);

  assert.ok(title.length <= 24);
  assert.ok(session.length <= 28);
  assert.match(title, /…|\.\.\./);
  assert.match(session, /…|\.\.\./);

  const slot = renderSlotPanel(snapWithBoard({
    slot: {
      issueId: longIssueId,
      title: longTitle,
      pid: 1,
      mode: 'review',
      closed: false,
      sessionId: longSession,
    },
  }), { maxFieldWidth: 32 });

  for (const line of slot.split('\n')) {
    // Slot region lines stay bounded so the panel does not fully collapse layout.
    assert.ok(line.length <= 120, `slot line too long (${line.length}): ${line}`);
  }
  // Issue id / title / session all truncate; pid + closed remain on primary row.
  assert.match(slot, /票:.*…|票:.*\.\.\./);
  assert.match(slot, /pid:\s*1/);
  assert.match(slot, /已关票:\s*否/);
  assert.match(slot, /…|\.\.\./);
});

test('alternate-screen enter/leave clears residual glyphs (cleanup proxy)', async () => {
  // Pure contract: enter = ALT_ENTER + clear; leave = clear + ALT_LEAVE.
  const chunks = [];
  const fakeOut = {
    write(s) {
      chunks.push(String(s));
    },
  };
  assert.equal(enterAlternateScreen(fakeOut), true);
  assert.equal(leaveAlternateScreen(fakeOut), true);
  const pure = chunks.join('');
  assert.ok(pure.startsWith(ALT_ENTER + CLEAR_SCREEN));
  assert.ok(pure.endsWith(CLEAR_SCREEN + ALT_LEAVE));
  assert.ok(pure.includes(CLEAR_SCREEN), 'refresh/exit clear must be present');

  const surface = makeSurfaceOnly();
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
    alternateScreen: true,
  });

  await new Promise((r) => setTimeout(r, 80));
  stdin.write('q');
  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('alt-screen exit cleanup test hung')), 3000);
    }),
  ]);

  assert.ok(out.includes(ALT_ENTER), 'should enter alternate screen');
  assert.ok(out.includes(ALT_LEAVE), 'should leave alternate screen on exit');
  assert.ok(out.includes(CLEAR_SCREEN), 'should clear screen to drop residual bare text');
  // Leave must appear after enter in the stream (exit cleanup order).
  assert.ok(out.lastIndexOf(ALT_LEAVE) > out.indexOf(ALT_ENTER));
  // Clear should appear both near enter and near leave (enter/refresh + exit).
  const firstClear = out.indexOf(CLEAR_SCREEN);
  const lastClear = out.lastIndexOf(CLEAR_SCREEN);
  assert.ok(firstClear >= 0 && lastClear > firstClear, 'clear on enter and again on leave');
});

// --- 20260804-1006-fix-fullscreen-cold-start / 02: layout hard fixes ---

test('resolveShellHeight: numeric terminal rows with safe floor (not percent-of-content)', () => {
  assert.equal(resolveShellHeight(24), 24);
  assert.equal(resolveShellHeight(12), 12);
  // Pathological / missing rows still yield a usable column height.
  assert.equal(resolveShellHeight(0), 12);
  assert.equal(resolveShellHeight(null), 12);
  assert.equal(resolveShellHeight(undefined), 12);
  assert.equal(resolveShellHeight(3), 12);
  assert.equal(resolveShellHeight(99.7), 99);
});

test('describeShellLayout with rows: root height is terminal lines; middle still stretch', () => {
  const layout = describeShellLayout({ rows: 30 });
  assert.deepEqual(layout.regions, ['top', 'middle', 'slot', 'footer']);
  assert.equal(layout.root.height, 30);
  assert.equal(layout.root.width, '100%');
  assert.equal(layout.root.flexDirection, 'column');
  assert.equal(layout.middle.flexGrow, 1);
  assert.equal(layout.middle.stretch, true);
  assert.equal(layout.top.flexGrow, 0);
  assert.equal(layout.slot.flexGrow, 0);
  assert.equal(layout.footer.flexGrow, 0);
  assert.equal(layout.animation, false);
  // Without rows, keep declarative 100% for callers that only need region names.
  const bare = describeShellLayout();
  assert.equal(bare.root.height, '100%');
  assert.equal(bare.middle.flexGrow, 1);
});

test('DispatchShell with terminalRows fills height; middle grows; footer not mid-screen', () => {
  const rows = 22;
  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard({ autoAdvance: false, status: 'idle', slot: null }),
    terminalRows: rows,
  }));
  const lines = text.split('\n');
  // Root must consume the terminal row budget (Ink numeric height), not content-shrink.
  assert.ok(
    lines.length >= rows - 1 && lines.length <= rows + 1,
    `expected ~${rows} lines, got ${lines.length}`,
  );
  assert.match(text, /Issue Crusher|调度/);
  assert.match(text, /当前槽/);
  assert.match(text, /\[q\].*退出|退出/);
  assert.match(text, /自动开下一张:\s*关/);

  // Footer key help lives near the bottom of the frame (not hovering mid-screen).
  const footerIdx = lines.findIndex((line) => /\[q\].*退出|退出/.test(line));
  assert.ok(footerIdx >= 0, 'footer key line must render');
  assert.ok(
    footerIdx >= Math.floor(lines.length * 0.55),
    `footer should pin near bottom (idx=${footerIdx}, lines=${lines.length})`,
  );

  // Four region content still present; no debug bracket labels.
  assert.match(text, /依赖图|现在可执行/);
  assert.doesNotMatch(text, /\[顶栏\]|\[中部\]|\[底栏\]/);
});

test('renderTopBar keeps auto + status discoverable after wrap / multi-line', () => {
  const longFeature = `very-long-feature-slug-${'x'.repeat(48)}`;
  const top = renderTopBar(snapWithBoard({
    feature: longFeature,
    autoAdvance: false,
    status: 'idle',
    subsequentMode: 'review',
  }));

  // Critical operator fields must appear as whole tokens (not mid-field chopped).
  assert.match(top, /自动开下一张:\s*关/);
  assert.match(top, /状态:/);
  assert.match(top, /Issue Crusher|调度/);
  assert.match(top, /runtime:\s*grok|运行时:\s*grok/);

  // Multi-line structure: auto/status not glued only into an ultra-long single line
  // that narrow terminals bury after wrap mid-token.
  const lines = top.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.length >= 2, `expected multi-line top bar, got ${lines.length}: ${top}`);
  const autoLine = lines.find((l) => /自动开下一张/.test(l));
  assert.ok(autoLine, 'auto dial must occupy its own discoverable line');
  assert.match(autoLine, /自动开下一张:\s*关/);
  // Auto line should stay short enough to survive typical narrow widths.
  assert.ok(autoLine.length <= 72, `auto line too long to stay discoverable: ${autoLine.length}`);
});

test('narrow top bar still exposes auto dial and chain status in shell frame', () => {
  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard({
      feature: `narrow-wrap-${'z'.repeat(60)}`,
      autoAdvance: false,
      status: 'idle',
      slot: null,
    }),
    terminalRows: 18,
  }));
  assert.match(text, /自动开下一张:\s*关/);
  assert.match(text, /状态:/);
  assert.match(text, /当前槽\s*（空）|当前槽 \(空\)|当前槽/);
});

// --- 20260804-1006-fix-fullscreen-cold-start / 03: start-model + single-slot regression ---

test('regression 03: s toggle; Enter after s-off keeps auto off; s-on restores AFK', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const third = candidate('03-third.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second, third],
    autoAdvance: false,
  });
  await surface.refresh();

  // Clean Enter opens auto (AFK contract preserved).
  await handleFullscreenKey(surface, '\r', { selectedIssueId: '01-first.md' });
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().autoAdvance, true);

  // s off while soft-stuck; complete first so slot can clear without auto handoff.
  await handleFullscreenKey(surface, 's');
  assert.equal(surface.snapshot().autoAdvance, false);
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(surface.snapshot().slot, null);
  assert.equal(launcher.launches.length, 1, 's-off must block auto handoff');

  // Enter opens exactly one and must not reopen auto.
  const started = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: '02-second.md',
  });
  assert.equal(started.spawned, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(surface.snapshot().autoAdvance, false);

  // s on again restores AFK: after release, tick auto-spawns remaining ready (03).
  tracker.setCompletion('02-second.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await handleFullscreenKey(surface, 's');
  assert.equal(surface.snapshot().autoAdvance, true);
  await surface.tick();
  assert.equal(launcher.launches.length, 3, 's-on must restore auto-spawn of board next');
  assert.equal(surface.snapshot().slot?.issueId, '03-third.md');
});

test('regression 03: soft-stuck Enter rejects second; cold mount stays empty until Enter', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    // Simulate pre-fullscreen chain default (on); mount must force off.
  });

  const stdin = fakeStdin();
  const stdout = fakeTtyStream();
  const runPromise = runFullscreenDispatch({
    surface,
    input: stdin,
    output: stdout,
    autoTick: true,
    pollIntervalMs: 200,
    alternateScreen: false,
  });

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(surface.snapshot().autoAdvance, false);
  assert.equal(surface.snapshot().slot, null);
  assert.equal(launcher.launches.length, 0, 'cold mount must not occupy a slot');

  // First Enter occupies; second Enter on other ticket is single-slot reject.
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-first.md');

  const blocked = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: '02-second.md',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'slot-occupied');
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-first.md');

  stdin.write('q');
  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('regression 03 soft-stuck dual-path hung')), 3000);
    }),
  ]);
});

test('regression 03: m/f/r/y/n/t/q still map and drive surface without weakening', async () => {
  assert.deepEqual(
    mapFullscreenKey('m', { subsequentMode: 'review' }),
    { type: 'setMode', arg: 'vibe' },
  );
  assert.deepEqual(mapFullscreenKey('f'), { type: 'forceAdvance' });
  assert.deepEqual(mapFullscreenKey('r'), { type: 'resume' });
  assert.deepEqual(mapFullscreenKey('y'), { type: 'confirmHitl' });
  assert.deepEqual(mapFullscreenKey('n'), { type: 'rejectHitl' });
  assert.deepEqual(mapFullscreenKey('t'), { type: 'tick' });
  assert.deepEqual(mapFullscreenKey('q'), { type: 'quit' });
  assert.deepEqual(mapFullscreenKey('s'), { type: 'toggleAutoAdvance' });
  assert.deepEqual(mapFullscreenKey('\r'), { type: 'start' });

  const { surface, launcher } = makeSurface({
    candidates: [candidate('01-ready.md')],
    autoAdvance: false,
  });
  await surface.refresh();

  await handleFullscreenKey(surface, 't');
  assert.equal(launcher.launches.length, 0, 't alone must not bypass auto gate');
  assert.equal(surface.snapshot().slot, null);

  const quit = await handleFullscreenKey(surface, 'q');
  assert.equal(quit.quit, true);
  assert.equal(surface.snapshot().stopped, true);
  assert.equal(surface.snapshot().autoAdvance, false);
});

// --- 20260804-1802-tui-model-effort / 02: fullscreen o model→effort menu ---

test('mapFullscreenKey o opens model/effort flow; m still only toggles mode', () => {
  assert.deepEqual(mapFullscreenKey('o'), { type: 'openModelEffort' });
  assert.deepEqual(mapFullscreenKey('O'), { type: 'openModelEffort' });
  assert.deepEqual(
    mapFullscreenKey('m', { subsequentMode: 'review' }),
    { type: 'setMode', arg: 'vibe' },
  );
  assert.notEqual(mapFullscreenKey('m', { subsequentMode: 'review' })?.type, 'openModelEffort');
});

test('renderTopBar shows subsequent model/effort or 运行时默认', () => {
  const defaults = renderTopBar(snapWithBoard({
    subsequentModel: null,
    subsequentEffort: null,
  }));
  assert.match(defaults, /后续 model:\s*运行时默认/);
  assert.match(defaults, /后续 effort:\s*运行时默认/);

  const set = renderTopBar(snapWithBoard({
    subsequentModel: 'grok-3.5',
    subsequentEffort: 'high',
  }));
  assert.match(set, /后续 model:\s*grok-3\.5/);
  assert.match(set, /后续 effort:\s*high/);
  // Still distinguishable from mode / auto / status.
  assert.match(set, /后续 mode:/);
  assert.match(set, /自动开下一张:/);
});

test('renderFooter includes [o] model/effort when action available', () => {
  const footer = renderFooter(snapWithBoard({
    actions: {
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));
  assert.match(footer, /\[o\].*model|\[o\].*effort|\[o\].*model\/effort/i);
  assert.match(footer, /\[m\].*mode/);
});

test('model→effort menu: both confirms submit; cancel leaves subsequent+repo unchanged', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, modeConfig } = makeSurface({
    candidates: [first, second],
  });
  await surface.tick();
  const slotBefore = {
    issueId: surface.snapshot().slot?.issueId,
    model: surface.snapshot().slot?.model ?? null,
    effort: surface.snapshot().slot?.effort ?? null,
  };
  assert.equal(surface.snapshot().subsequentModel, null);
  assert.equal(modeConfig.readModelEffort('grok').model, null);

  // Cancel at model stage: no write.
  let menu = openModelEffortMenu({ runtime: 'grok' });
  menu = applyModelEffortMenuKey(menu, 'q');
  assert.equal(menu.done, true);
  assert.equal(menu.cancelled, true);
  assert.equal(menu.submitted, null);
  assert.equal(surface.snapshot().subsequentModel, null);
  assert.equal(modeConfig.readModelEffort('grok').model, null);

  // Cancel at effort stage after model pick: still no write (transactional).
  menu = openModelEffortMenu({ runtime: 'grok' });
  menu = applyModelEffortMenuKey(menu, 'j'); // move off 运行时默认 if possible
  menu = applyModelEffortMenuKey(menu, '\r');
  assert.equal(menu.stage, 'effort');
  assert.equal(menu.done, false);
  menu = applyModelEffortMenuKey(menu, 'q');
  assert.equal(menu.cancelled, true);
  assert.equal(menu.submitted, null);
  assert.equal(surface.snapshot().subsequentModel, null);
  assert.deepEqual(modeConfig.readModelEffort('grok'), { model: null, effort: null });

  // Full confirm: model then effort → setModelEffort.
  menu = openModelEffortMenu({
    runtime: 'grok',
    modelItems: [
      { value: null, label: '运行时默认' },
      { value: 'grok-3.5', label: 'grok-3.5' },
    ],
    effortItems: [
      { value: null, label: '运行时默认' },
      { value: 'high', label: 'high' },
    ],
  });
  menu = applyModelEffortMenuKey(menu, '2'); // index 1 → grok-3.5
  menu = applyModelEffortMenuKey(menu, '\r');
  assert.equal(menu.stage, 'effort');
  menu = applyModelEffortMenuKey(menu, '2'); // high
  menu = applyModelEffortMenuKey(menu, '\r');
  assert.equal(menu.done, true);
  assert.equal(menu.cancelled, false);
  assert.deepEqual(menu.submitted, { model: 'grok-3.5', effort: 'high' });

  const submitted = await surface.setModelEffort(menu.submitted);
  assert.equal(submitted.ok, true);
  assert.equal(surface.snapshot().subsequentModel, 'grok-3.5');
  assert.equal(surface.snapshot().subsequentEffort, 'high');
  assert.deepEqual(modeConfig.readModelEffort('grok'), { model: 'grok-3.5', effort: 'high' });
  // Live slot not hot-switched.
  assert.equal(surface.snapshot().slot?.issueId, slotBefore.issueId);
  assert.equal(surface.snapshot().slot?.model ?? null, slotBefore.model);
  assert.equal(surface.snapshot().slot?.effort ?? null, slotBefore.effort);

  // Next spawn carries subsequent contract.
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');
  assert.equal(surface.snapshot().slot?.model, 'grok-3.5');
  assert.equal(surface.snapshot().slot?.effort, 'high');
  assert.equal(launcher.launches[1].model, 'grok-3.5');
  assert.equal(launcher.launches[1].effort, 'high');
});

test('handleFullscreenKey o returns openModelEffort without mutating subsequent', async () => {
  const { surface, modeConfig } = makeSurface({
    candidates: [candidate('01-first.md')],
  });
  await surface.tick();
  const result = await handleFullscreenKey(surface, 'o');
  assert.equal(result.openModelEffort, true);
  assert.equal(surface.snapshot().subsequentModel, null);
  assert.equal(modeConfig.readModelEffort('grok').model, null);
});

test('default model/effort lists lead with 运行时默认; no free-text path', () => {
  // Sync Grok fallback is degrade-only; async discovery fills the real list.
  const models = defaultModelItems('grok');
  const efforts = defaultEffortItems();
  assert.equal(models.length, 1);
  assert.equal(models[0].value, null);
  assert.match(models[0].label, /运行时默认/);
  assert.equal(efforts[0].value, null);
  assert.match(efforts[0].label, /运行时默认/);
  assert.deepEqual(
    efforts.slice(1).map((item) => item.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
  // Claude sync path keeps alias hints.
  const claude = defaultModelItems('claude');
  assert.equal(claude[0].value, null);
  assert.ok(claude.some((item) => item.value === 'sonnet'));
  assert.ok(claude.some((item) => item.value === 'opus'));
  assert.ok(claude.some((item) => item.value === 'haiku'));
});

test('model→effort menu Esc cancels whole transaction like q', () => {
  let menu = openModelEffortMenu({
    runtime: 'grok',
    modelItems: [
      { value: null, label: '运行时默认' },
      { value: 'grok-4', label: 'grok-4' },
    ],
  });
  menu = applyModelEffortMenuKey(menu, 'j');
  menu = applyModelEffortMenuKey(menu, '\r');
  assert.equal(menu.stage, 'effort');
  menu = applyModelEffortMenuKey(menu, '', { escape: true });
  assert.equal(menu.done, true);
  assert.equal(menu.cancelled, true);
  assert.equal(menu.submitted, null);
});

test('DispatchShell modelEffortMenu overlay reuses frame without second alt-screen path', () => {
  const menu = openModelEffortMenu({
    runtime: 'grok',
    modelItems: [
      { value: null, label: '运行时默认' },
      { value: 'grok-3.5', label: 'grok-3.5' },
    ],
  });
  const frame = renderModelEffortMenuFrame(menu);
  assert.match(frame, /model\/effort|subsequent model/i);
  assert.match(frame, /运行时默认/);
  assert.doesNotMatch(frame, /\[启动选单\]/);

  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard({
      subsequentModel: null,
      subsequentEffort: null,
      actions: { setModelEffort: { available: true }, setMode: { available: true } },
    }),
    modelEffortMenu: menu,
    terminalRows: 24,
  }));
  assert.match(text, /运行时默认|subsequent model|model\/effort/i);
  assert.match(text, /后续 model:\s*运行时默认/);
  // Overlay is in-shell — no DECSET sequences from pure renderToString path.
  assert.doesNotMatch(text, /\u001b\[\?1049h/);
  assert.doesNotMatch(text, /\u001b\[\?1049l/);
});

test('runFullscreenDispatch o then q: opens overlay then cancel; subsequent unchanged', async () => {
  const { surface, modeConfig } = makeSurface({
    candidates: [candidate('01-first.md')],
    mode: 'review',
  });
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
    pollIntervalMs: 5000,
    alternateScreen: false,
    // Inject discovery so CI never calls real `grok models`.
    discoverModels: async () => ['inject-model-a', 'inject-model-b'],
  });

  await new Promise((r) => setTimeout(r, 120));
  stdin.write('o');
  await new Promise((r) => setTimeout(r, 150));
  assert.match(out, /model\/effort|subsequent model|运行时默认/i);
  assert.match(out, /inject-model-a/);
  // Cancel menu (q while overlay open), then quit dispatch.
  stdin.write('q');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(surface.snapshot().subsequentModel, null);
  assert.equal(modeConfig.readModelEffort('grok').model, null);
  stdin.write('q');

  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('fullscreen o cancel integration did not exit')), 3000);
    }),
  ]);
  assert.equal(result.stopped, true);
  assert.equal(surface.snapshot().subsequentModel, null);
  // alternateScreen:false path must never emit nested DECSET.
  assert.doesNotMatch(out, /\u001b\[\?1049h/);
});

test('runFullscreenDispatch o: discovery failure still opens menu with 运行时默认 only', async () => {
  const { surface } = makeSurface({
    candidates: [candidate('01-first.md')],
    mode: 'review',
  });
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
    pollIntervalMs: 5000,
    alternateScreen: false,
    discoverModels: async () => {
      throw new Error('not logged in');
    },
  });

  await new Promise((r) => setTimeout(r, 120));
  stdin.write('o');
  await new Promise((r) => setTimeout(r, 150));
  assert.match(out, /运行时默认/);
  assert.doesNotMatch(out, /inject-model|not logged in/);
  stdin.write('q'); // cancel menu
  await new Promise((r) => setTimeout(r, 80));
  stdin.write('q'); // quit

  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('discovery-fail o path did not exit')), 3000);
    }),
  ]);
});
