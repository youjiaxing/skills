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
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createChainRun } from '../scripts/chain-run.mjs';
import { handleDispatchCommand } from '../scripts/dispatch-commands.mjs';
import { createDispatchSurface } from '../scripts/dispatch-surface.mjs';
import {
  DispatchShell,
  handleFullscreenKey,
  mapFullscreenKey,
  nextListSelection,
  renderFooter,
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
  assert.match(out, /\[顶栏\]|\[底栏\]|Issue Crusher/);
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
  assert.match(text, /mode → vibe|后果提示|\[提示\]/);
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
