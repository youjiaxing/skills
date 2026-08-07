/**
 * Ticket 01 — Ink fullscreen dispatch shell seams.
 * Ticket 02 — live Dispatch Surface snapshot in regions.
 * Ticket 03 — fullscreen keyboard drives existing dispatch actions.
 *
 * Seams under test:
 * 1. shouldUseFullscreenDispatch — TTY interactive vs --once / non-TTY routing
 * 2. DispatchShell via renderToString — region skeleton (顶带/中带/底带)
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
 * 13. 20260804-1802 / 02 — fullscreen model→effort transactional menu + top/footer
 * 14. 20260807-fullscreen-tui-ux-impl / 03 — m/v remap + footer groups / hot·dim
 * 15. 20260807-fullscreen-tui-ux-impl / 04 — middle default list+focus neighborhood; global second view
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
  boardDefaultExecutable,
  buildFooterItems,
  renderFooter,
  renderMiddlePanel,
  renderModelEffortMenuFrame,
  renderNotice,
  operatorStatusDisplayName,
  renderMainCta,
  renderReadyMainCta,
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
    handoffCountdownMs: 0,
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

test('DispatchShell skeleton exposes 顶带 / 中带 / 底带 (no empty-slot band)', () => {
  const text = renderToString(createElement(DispatchShell, {
    snap: {
      feature: 'demo',
      runtime: 'grok',
      subsequentMode: 'review',
      status: 'idle',
      stopped: false,
      slot: null,
      cwd: '/tmp/project',
      board: { feature: 'demo', readOnly: true, issues: [] },
    },
  }));

  // Three bands by content, without debug bracket labels or permanent empty slot.
  assert.match(text, /Issue Crusher|调度/);
  assert.match(text, /依赖图|现在可执行/);
  assert.match(text, /\[q\].*退出|退出/);
  assert.doesNotMatch(text, /当前槽\s*（空）|当前槽 \(空\)/);
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
  // Default chain autoAdvance is on (once seam); fullscreen mount applies preference (default off).
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

test('fullscreen mount: repo autoAdvance true restores dial on without idle spawn', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const modeConfig = createMemoryModeConfig({ autoAdvance: true });
  const { launcher, surface, modeConfig: cfg } = makeSurface({
    candidates: [first, second],
    modeConfig,
  });

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

  await new Promise((r) => setTimeout(r, 700));

  assert.equal(surface.snapshot().autoAdvance, true, 'mount must restore repo preference on');
  assert.equal(surface.snapshot().slot, null);
  assert.equal(launcher.launches.length, 0, 'restored on must not cold-spawn');
  assert.equal(cfg.readAutoAdvance(), true, 'quit freeze must not wipe preference during run');

  stdin.write('q');
  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('fullscreen restore-on test did not exit')), 3000);
    }),
  ]);
  // quit freezes session auto off but must not write preference
  assert.equal(cfg.readAutoAdvance(), true, 'q must not persist auto off');
});

test('fullscreen s toggle writes repo preference; survives re-mount', async () => {
  const only = candidate('01-ready.md');
  const modeConfig = createMemoryModeConfig({ autoAdvance: false });
  // Match fullscreen-style start: session auto off before operator dials s.
  const first = makeSurface({ candidates: [only], modeConfig, autoAdvance: false });

  await first.surface.refresh();
  await handleFullscreenKey(first.surface, 's');
  assert.equal(first.surface.snapshot().autoAdvance, true);
  assert.equal(modeConfig.readAutoAdvance(), true);

  // Simulate next process: new chain/surface, same repo config.
  const second = makeSurface({ candidates: [only], modeConfig, autoAdvance: false });
  const applied = await second.surface.applyFullscreenAutoPreference();
  assert.equal(applied.autoAdvance, true);
  assert.equal(second.surface.snapshot().autoAdvance, true);

  await second.surface.tick();
  assert.equal(second.launcher.launches.length, 0, 're-mount on still needs Enter');
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

test('drainPendingInput hands a live TTY stream back to Ink', () => {
  const stdin = fakeStdin();
  drainPendingInput(stdin);
  assert.equal(stdin.isPaused(), false, 'stdin must be readable after residual-key drain');
});

test('drainPendingInput resumes a stream left paused by the previous Ink mount', () => {
  const stdin = fakeStdin();
  stdin.pause();
  drainPendingInput(stdin);
  assert.equal(stdin.isPaused(), false, 'handoff must resume even an already-paused stdin');
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
  // Operator display name (not internal soft-stuck id).
  assert.match(live, /进行中/);
  assert.doesNotMatch(live, /软卡住|soft-stuck/);

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

test('renderMiddlePanel default: 列表+焦点邻域与「现在可执行」(全局图非默认)', () => {
  const middle = renderMiddlePanel(snapWithBoard({
    slot: {
      issueId: '02-ready.md',
      title: '可执行票',
      pid: 4242,
      mode: 'review',
      closed: false,
    },
  }));

  assert.match(middle, /列表 · 全板|现在可执行/);
  assert.match(middle, /只读|不可图上派票/);
  assert.match(middle, /焦点邻域|邻域/);
  assert.match(middle, /现在可执行/);
  assert.match(middle, /02-ready\.md|★\s*02/);
  // Focus neighborhood marks: 01 closed, 02 focus/slot
  assert.match(middle, /✓01|✓\s*01|01-done\.md/);
  assert.match(middle, /02-ready\.md|◀焦点|◀当前槽/);
  assert.match(middle, /上游|下游|──►|├─|└─/);
  // Global overview title is second view only.
  assert.doesNotMatch(middle, /依赖图 · 全局总览|依赖图（只读 · 不可图上派票）/);
});

test('renderSlotPanel: empty slot is blank; occupied/HITL keep ticket/pid/closed/mode', () => {
  const empty = renderSlotPanel(snapWithBoard());
  assert.equal(empty.trim(), '', 'empty slot must not paint a permanent 当前槽（空） block');

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
  assert.match(text, /现在可执行|焦点邻域|列表 · 全板/);
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
  assert.match(topBefore, /可开干|暂无票|空闲|idle/);
  assert.match(topAfter, /进行中/);
  assert.doesNotMatch(topAfter, /软卡住|soft-stuck/);
  assert.notEqual(topBefore, topAfter);

  const slotBefore = renderSlotPanel(before);
  const slotAfter = renderSlotPanel(after);
  assert.equal(slotBefore.trim(), '');
  assert.match(slotAfter, /02-ready\.md/);
  assert.match(slotAfter, /pid:\s*7/);
  assert.notEqual(slotBefore, slotAfter);

  const shellBefore = renderToString(createElement(DispatchShell, { snap: before }));
  const shellAfter = renderToString(createElement(DispatchShell, { snap: after }));
  assert.match(shellBefore, /可开干|暂无票|空闲|idle/);
  assert.match(shellAfter, /进行中/);
  assert.doesNotMatch(shellAfter, /软卡住|soft-stuck/);
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
  assert.match(out, /pid:\s*55|02-ready\.md|进行中/);
});

// --- Ticket 03: fullscreen keyboard → existing dispatch actions ---

test('mapFullscreenKey maps m/v/f/r/y/n/s/t/q and list nav to surface command types', () => {
  assert.deepEqual(mapFullscreenKey('q'), { type: 'quit' });
  assert.deepEqual(mapFullscreenKey('Q'), { type: 'quit' });
  // Fullscreen s toggles auto-open-next (not chain stop).
  assert.deepEqual(mapFullscreenKey('s'), { type: 'toggleAutoAdvance' });
  assert.deepEqual(mapFullscreenKey('t'), { type: 'tick' });
  assert.deepEqual(mapFullscreenKey('f'), { type: 'forceAdvance' });
  assert.deepEqual(mapFullscreenKey('r'), { type: 'resume' });
  assert.deepEqual(mapFullscreenKey('y'), { type: 'confirmHitl' });
  assert.deepEqual(mapFullscreenKey('n'), { type: 'rejectHitl' });

  // Remap: m → model/effort；v → mode 拨杆（原 m）。
  assert.deepEqual(mapFullscreenKey('m'), { type: 'openModelEffort' });
  assert.deepEqual(mapFullscreenKey('M'), { type: 'openModelEffort' });
  assert.deepEqual(
    mapFullscreenKey('v', { subsequentMode: 'review' }),
    { type: 'setMode', arg: 'vibe' },
  );
  assert.deepEqual(
    mapFullscreenKey('v', { subsequentMode: 'vibe' }),
    { type: 'setMode', arg: 'review' },
  );
  // 旧 o 不再作 model 入口（避免双键教学分裂）；旧 m 不再拨 mode。
  assert.equal(mapFullscreenKey('o'), null);
  assert.notEqual(mapFullscreenKey('m')?.type, 'setMode');

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

test('handleFullscreenKey v dial switches mode, shows vibe tip, pins live worker', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, modeConfig, chain } = makeSurface({
    candidates: [first, second],
    mode: 'review',
  });

  await surface.tick();
  assert.equal(surface.snapshot().slot.mode, 'review');

  const result = await handleFullscreenKey(surface, 'v', {
    subsequentMode: surface.snapshot().subsequentMode,
  });
  assert.equal(result.quit, undefined);
  assert.match(result.message || '', /vibe|关票|Closed|auto/i);
  assert.equal(modeConfig.readMode(), 'vibe');
  assert.equal(surface.snapshot().subsequentMode, 'vibe');
  assert.equal(surface.snapshot().slot.mode, 'review', 'live worker stays pinned');

  // Dial back to review, then complete first so next spawn takes subsequent mode.
  await handleFullscreenKey(surface, 'v', {
    subsequentMode: surface.snapshot().subsequentMode,
  });
  assert.equal(surface.snapshot().subsequentMode, 'review');
  await handleFullscreenKey(surface, 'v', {
    subsequentMode: surface.snapshot().subsequentMode,
  });
  assert.equal(surface.snapshot().subsequentMode, 'vibe');

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await chain.reportSessionEnded('success');
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

test('handleFullscreenKey y/n match HITL confirm/reject for human tickets', async () => {
  const human = candidate('05-human.md', {
    entryClass: 'human',
    statusRole: 'ready-for-human',
  });
  const { launcher, surface } = makeSurface({
    candidates: [],
    hitlCandidates: [human],
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
  assert.doesNotMatch(launcher.launches[0].initialPrompt, /\/wayfinder\b/);
  assert.doesNotMatch(launcher.launches[0].initialPrompt, /\/implement\b/);
});

test('handleFullscreenKey Enter starts wayfinder with /wayfinder prompt', async () => {
  const wayfinder = candidate('01-wayfinder.md', {
    entryClass: 'wayfinder',
    type: 'grilling',
  });
  const { launcher, surface } = makeSurface({
    candidates: [],
    hitlCandidates: [wayfinder],
    autoAdvance: false,
  });

  await surface.refresh();
  assert.equal(surface.snapshot().status, 'idle');

  const started = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: '01-wayfinder.md',
  });
  assert.equal(started.ok, true);
  assert.equal(started.spawned, true);
  assert.equal(launcher.launches.length, 1);
  assert.match(launcher.launches[0].initialPrompt, /\/wayfinder\b/);
  assert.equal(launcher.launches[0].issue.id, '01-wayfinder.md');
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

  // s on → dial only; empty slot must not auto-spawn without Enter
  const turnedOn = await handleFullscreenKey(surface, 's');
  assert.match(turnedOn.message || '', /自动开下一张.*开/);
  assert.equal(surface.snapshot().autoAdvance, true);
  assert.equal(surface.snapshot().stopped, false);

  await surface.tick();
  assert.equal(launcher.launches.length, 0, 's-on must not idle-spawn');
  assert.equal(surface.snapshot().slot, null);

  await handleFullscreenKey(surface, '\r', { selectedIssueId: '01-first.md' });
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-first.md');
  assert.equal(surface.snapshot().autoAdvance, true);

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
      setModelEffort: { available: true },
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

  assert.match(footer, /\[m\].*模型/);
  assert.match(footer, /\[v\].*模式/);
  assert.match(footer, /\[y\].*同意/);
  assert.match(footer, /\[n\].*拒绝/);
  assert.match(footer, /\[s\].*自动/);
  assert.doesNotMatch(footer, /\[s\] 停链/);
  assert.match(footer, /\[t\].*刷新/);
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
  // HITL: nav always present; no remap migration notice.
  assert.doesNotMatch(footer, /键位已改|已 remap|迁移/);

  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard(),
    notice: 'mode → vibe。后果提示',
    selectedIndex: 0,
  }));
  assert.match(text, /mode → vibe|后果提示/);
  assert.doesNotMatch(text, /鼠标|mouse|embed worker|内嵌 Worker|graph dispatch|图上派票\s*开/i);
  assert.match(text, /不可图上派票|只读/);
  assert.doesNotMatch(text, /键位已改|已 remap/);
});

test('runFullscreenDispatch v then q: mode dial + stop-and-exit via keys', async () => {
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
  stdin.write('v');
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

test('first Enter opens auto; dual-gate + tick auto-spawns board next ignoring highlight', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const third = candidate('03-third.md');
  const { tracker, launcher, surface, chain } = makeSurface({
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
  await chain.reportSessionEnded('success');

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
  // Freeable completed slot (no session end): Enter frees and cuts in on highlight.
  // Turn auto off so cut-in is explicit Enter, not dual-gate auto fire.
  await surface.setAutoAdvance(false);

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
  // Without session end: no auto free; freeable for Enter.
  assert.equal(surface.snapshot().status, 'session-interrupted');
  assert.equal(launcher.launches.length, 1);

  const started = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: '02-second.md',
  });
  assert.equal(started.spawned, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(surface.snapshot().autoAdvance, false, 'Enter after s-off must not reopen auto');
});

test('s on with empty slot does not auto-spawn on tick (Enter still required)', async () => {
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
  assert.equal(launcher.launches.length, 0, 's is dial only on empty slot');
  assert.equal(surface.snapshot().slot, null);

  await handleFullscreenKey(surface, '\r', { selectedIssueId: '01-ready.md' });
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-ready.md');
});

// --- dispatch-tui-start-and-polish / 05: fullscreen layout + visual hierarchy ---

test('describeShellLayout: three stable bands; middle is stretch main', () => {
  const layout = describeShellLayout();
  assert.deepEqual(layout.regions, ['top', 'middle', 'footer']);
  assert.equal(layout.root.height, '100%');
  assert.equal(layout.root.width, '100%');
  assert.equal(layout.root.flexDirection, 'column');
  assert.equal(layout.middle.flexGrow, 1);
  assert.equal(layout.middle.stretch, true);
  assert.equal(layout.top.flexGrow, 0);
  assert.equal(layout.footer.flexGrow, 0);
  assert.equal(layout.slot, undefined);
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
  assert.match(middle, /现在可执行|焦点邻域|列表 · 全板/);
  assert.match(middle, /现在可执行/);
  // Empty slot: no permanent product block (three-band Ready).
  assert.equal(slot.trim(), '');
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
  assert.deepEqual(layout.regions, ['top', 'middle', 'footer']);
  assert.equal(layout.root.height, 30);
  assert.equal(layout.root.width, '100%');
  assert.equal(layout.root.flexDirection, 'column');
  assert.equal(layout.middle.flexGrow, 1);
  assert.equal(layout.middle.stretch, true);
  assert.equal(layout.top.flexGrow, 0);
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
  assert.doesNotMatch(text, /当前槽\s*（空）|当前槽 \(空\)/);
  assert.match(text, /\[q\].*退出|退出/);
  assert.match(text, /自动开下一张:\s*关/);

  // Footer key help lives near the bottom of the frame (not hovering mid-screen).
  const footerIdx = lines.findIndex((line) => /\[q\].*退出|退出/.test(line));
  assert.ok(footerIdx >= 0, 'footer key line must render');
  assert.ok(
    footerIdx >= Math.floor(lines.length * 0.55),
    `footer should pin near bottom (idx=${footerIdx}, lines=${lines.length})`,
  );

  // Three-band content still present; no debug bracket labels.
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
  assert.doesNotMatch(text, /当前槽\s*（空）|当前槽 \(空\)/);
});

// --- 20260804-1006-fix-fullscreen-cold-start / 03: start-model + single-slot regression ---

test('regression 03: s toggle; Enter after s-off keeps auto off; s-on restores AFK', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const third = candidate('03-third.md');
  const { tracker, launcher, surface, chain } = makeSurface({
    candidates: [first, second, third],
    autoAdvance: false,
  });
  await surface.refresh();

  // Clean Enter opens auto (AFK contract preserved).
  await handleFullscreenKey(surface, '\r', { selectedIssueId: '01-first.md' });
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().autoAdvance, true);

  // s off while soft-stuck; complete first — without end signal, no auto handoff.
  await handleFullscreenKey(surface, 's');
  assert.equal(surface.snapshot().autoAdvance, false);
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(surface.snapshot().status, 'session-interrupted');
  assert.equal(launcher.launches.length, 1, 's-off must block auto handoff');

  // Enter frees freeable slot, opens exactly one and must not reopen auto.
  const started = await handleFullscreenKey(surface, '\r', {
    selectedIssueId: '02-second.md',
  });
  assert.equal(started.spawned, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(surface.snapshot().autoAdvance, false);

  // s on while slot still held, then dual-gate = handoff release + auto-spawn.
  tracker.setCompletion('02-second.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await chain.reportSessionEnded('success');
  await handleFullscreenKey(surface, 's');
  assert.equal(surface.snapshot().autoAdvance, true);
  await surface.tick();
  assert.equal(launcher.launches.length, 3, 'auto on at dual-gate handoff must spawn board next');
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

test('regression 03: v/m/f/r/y/n/t/q still map and drive surface without weakening', async () => {
  assert.deepEqual(
    mapFullscreenKey('v', { subsequentMode: 'review' }),
    { type: 'setMode', arg: 'vibe' },
  );
  assert.deepEqual(mapFullscreenKey('m'), { type: 'openModelEffort' });
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

// --- 20260804-1802-tui-model-effort / 02: fullscreen model→effort menu (key m) ---

test('mapFullscreenKey m opens model/effort flow; v toggles mode; o unbound', () => {
  assert.deepEqual(mapFullscreenKey('m'), { type: 'openModelEffort' });
  assert.deepEqual(mapFullscreenKey('M'), { type: 'openModelEffort' });
  assert.deepEqual(
    mapFullscreenKey('v', { subsequentMode: 'review' }),
    { type: 'setMode', arg: 'vibe' },
  );
  assert.equal(mapFullscreenKey('o'), null);
  assert.notEqual(mapFullscreenKey('v', { subsequentMode: 'review' })?.type, 'openModelEffort');
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

// --- 20260805-1244-vibe-handoff-and-resume / 03: status copy + key regression ---

test('renderTopBar distinguishes awaiting-worker-exit (自动收尾中 vs [f] 待收尾)', () => {
  const autoOn = renderTopBar(snapWithBoard({
    status: 'awaiting-worker-exit',
    autoAdvance: true,
    slot: {
      issueId: '01-first.md',
      pid: 11,
      mode: 'vibe',
      closed: true,
    },
    actions: {
      forceAdvance: { available: true, reason: null },
      resume: { available: false, reason: 'not-needs-resume' },
    },
  }));
  assert.match(autoOn, /状态:\s*自动收尾中/);
  assert.match(autoOn, /下一步：可自动收尾 · 无需手开下一张/);
  assert.doesNotMatch(autoOn, /\[f\] 待收尾/);
  assert.doesNotMatch(autoOn, /按\s*r|恢复会话/);

  const autoOff = renderTopBar(snapWithBoard({
    status: 'awaiting-worker-exit',
    autoAdvance: false,
    slot: {
      issueId: '01-first.md',
      pid: 11,
      mode: 'vibe',
      closed: true,
    },
    actions: {
      forceAdvance: { available: true, reason: null },
      resume: { available: false, reason: 'not-needs-resume' },
    },
  }));
  assert.match(autoOff, /状态:\s*\[f\] 待收尾/);
  assert.match(autoOff, /下一步：Worker 已关票 · 按 f 强制推进/);
  assert.doesNotMatch(autoOff, /状态:\s*自动收尾中/);
});

test('renderTopBar shows handoff-countdown remaining seconds and cancel hint', () => {
  const text = renderTopBar(snapWithBoard({
    status: 'handoff-countdown',
    autoAdvance: true,
    handoffCountdownRemainingMs: 8500,
    handoffCountdownMs: 9000,
    slot: {
      issueId: '01-first.md',
      pid: 11,
      mode: 'vibe',
      closed: true,
    },
    actions: {
      forceAdvance: { available: true, reason: null },
      cancelHandoffCountdown: { available: true, reason: null },
      resume: { available: false, reason: 'not-needs-resume' },
    },
  }));
  assert.match(text, /交接倒计时|倒计时/);
  assert.match(text, /9s|8s|秒/);
  assert.match(text, /按\s*c|取消/);
});

test('renderTopBar distinguishes session-interrupted reason summary from countdown/await exit', () => {
  const text = renderTopBar(snapWithBoard({
    status: 'session-interrupted',
    autoAdvance: true,
    interruptReason: 'API connection reset',
    slot: {
      issueId: '01-first.md',
      pid: 11,
      mode: 'vibe',
      closed: true,
      sessionId: 'sess-x',
    },
    actions: {
      forceAdvance: { available: true, reason: null },
      resume: { available: true, reason: null },
    },
  }));
  assert.match(text, /会话中断|中断/);
  assert.match(text, /API connection reset/);
  assert.match(text, /按\s*f|强制推进/);
  assert.match(text, /按\s*r/);
  assert.doesNotMatch(text, /交接倒计时|按\s*c/);
});

test('renderTopBar distinguishes needs-resume ([r] 需恢复 vs 无法恢复)', () => {
  const withId = renderTopBar(snapWithBoard({
    status: 'needs-resume',
    autoAdvance: false,
    slot: {
      issueId: '01-first.md',
      pid: 11,
      sessionId: 'sess-1',
      mode: 'review',
      closed: false,
    },
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: true, reason: null },
    },
  }));
  assert.match(withId, /状态:\s*\[r\] 需恢复/);
  assert.match(withId, /下一步：按 r 恢复历史会话/);
  assert.doesNotMatch(withId, /无法恢复|无 session|no-session-id/i);
  assert.doesNotMatch(withId, /自动收尾/);

  const noId = renderTopBar(snapWithBoard({
    status: 'needs-resume',
    autoAdvance: false,
    slot: {
      issueId: '01-first.md',
      pid: 11,
      sessionId: null,
      mode: 'review',
      closed: false,
    },
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: false, reason: 'no-session-id' },
    },
  }));
  assert.match(noId, /状态:\s*无法恢复/);
  assert.match(noId, /下一步：无法恢复 · 无 session id/);
  assert.doesNotMatch(noId, /\[r\] 需恢复|按 r 恢复/);
});

test('renderFooter shows f only when forceAdvance available; r only when resume available', () => {
  const neither = renderFooter(snapWithBoard({
    status: 'soft-stuck',
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: false, reason: 'not-needs-resume' },
    },
  }));
  assert.doesNotMatch(neither, /\[f\]/);
  assert.doesNotMatch(neither, /\[r\]/);

  const forceOnly = renderFooter(snapWithBoard({
    status: 'awaiting-worker-exit',
    actions: {
      forceAdvance: { available: true, reason: null },
      resume: { available: false, reason: 'not-needs-resume' },
    },
  }));
  assert.match(forceOnly, /\[f\].*强制推进/);
  assert.doesNotMatch(forceOnly, /\[r\]/);

  const resumeOnly = renderFooter(snapWithBoard({
    status: 'needs-resume',
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: true, reason: null },
    },
  }));
  assert.match(resumeOnly, /\[r\].*恢复/);
  assert.doesNotMatch(resumeOnly, /\[f\]/);

  const noSession = renderFooter(snapWithBoard({
    status: 'needs-resume',
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: false, reason: 'no-session-id' },
    },
  }));
  assert.doesNotMatch(noSession, /\[r\]/);
  assert.doesNotMatch(noSession, /\[f\]/);
});

test('handleFullscreenKey f with autoAdvance on does not double-spawn next ticket', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: true,
  });

  await surface.tick();
  const oldPid = surface.snapshot().slot.pid;
  tracker.setCompletion('01-first.md', true);
  await surface.refresh();
  assert.equal(surface.snapshot().status, 'awaiting-worker-exit');
  assert.equal(surface.snapshot().actions.forceAdvance.available, true);

  // Human f while auto-reap path is also eligible: exactly one next spawn.
  const forced = await handleFullscreenKey(surface, 'f');
  assert.match(forced.message || '', /强制推进|接力/);
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');

  // Extra tick must not open a third worker for the same handoff.
  await surface.tick();
  assert.equal(launcher.launches.length, 2);
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');
  // f default is orphan; auto-reap must not also kill after force-advance.
  assert.equal(launcher.isAlive(oldPid), true);
  assert.equal(launcher.kills.length, 0);
});

test('handleFullscreenKey f never kills when issue is not Closed', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: true,
  });

  await surface.tick();
  const pid = surface.snapshot().slot.pid;
  assert.equal(surface.snapshot().actions.forceAdvance.available, false);

  const denied = await handleFullscreenKey(surface, 'f');
  assert.match(denied.message || '', /无法强制推进|not-closed|Closed/i);
  assert.equal(launcher.isAlive(pid), true);
  assert.equal(launcher.kills.length, 0);
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-first.md');
});

test('renderFooter includes [m] 模型 and [v] 模式 when actions available', () => {
  const footer = renderFooter(snapWithBoard({
    actions: {
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));
  assert.match(footer, /\[m\].*模型/);
  assert.match(footer, /\[v\].*模式/);
  assert.doesNotMatch(footer, /\[o\]/);
  assert.doesNotMatch(footer, /\[m\].*mode 拨杆|\[v\].*model/i);
});

test('model→effort menu: both confirms submit; cancel leaves subsequent+repo unchanged', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, modeConfig, chain } = makeSurface({
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

  // Next spawn carries subsequent contract (dual-gate success required for auto).
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await chain.reportSessionEnded('success');
  await surface.tick();
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');
  assert.equal(surface.snapshot().slot?.model, 'grok-3.5');
  assert.equal(surface.snapshot().slot?.effort, 'high');
  assert.equal(launcher.launches[1].model, 'grok-3.5');
  assert.equal(launcher.launches[1].effort, 'high');
});

test('handleFullscreenKey m returns openModelEffort without mutating subsequent', async () => {
  const { surface, modeConfig } = makeSurface({
    candidates: [candidate('01-first.md')],
  });
  await surface.tick();
  const result = await handleFullscreenKey(surface, 'm');
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

test('runFullscreenDispatch m then q: opens overlay then cancel; subsequent unchanged', async () => {
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
  stdin.write('m');
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
      setTimeout(() => reject(new Error('fullscreen m cancel integration did not exit')), 3000);
    }),
  ]);
  assert.equal(result.stopped, true);
  assert.equal(surface.snapshot().subsequentModel, null);
  // alternateScreen:false path must never emit nested DECSET.
  assert.doesNotMatch(out, /\u001b\[\?1049h/);
});

test('runFullscreenDispatch m can cancel, reopen, and submit without stale-menu crash', async () => {
  const { surface, modeConfig } = makeSurface({
    runtime: 'claude',
    candidates: [candidate('01-first.md')],
    mode: 'review',
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
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  await wait(120);
  // First transaction: cancel at model stage.
  stdin.write('m');
  await wait(150);
  stdin.write('q');
  await wait(120);

  // Second transaction: cancel at effort stage.
  stdin.write('m');
  await wait(150);
  stdin.write('j');
  await wait(120);
  stdin.write('\r');
  await wait(150);
  stdin.write('\u001b');
  await wait(120);

  // Third transaction: confirm Claude sonnet + low.
  stdin.write('m');
  await wait(150);
  stdin.write('j');
  await wait(120);
  stdin.write('\r');
  await wait(150);
  stdin.write('j');
  await wait(120);
  stdin.write('\r');
  await wait(180);

  assert.equal(surface.snapshot().subsequentModel, 'sonnet');
  assert.equal(surface.snapshot().subsequentEffort, 'low');
  assert.deepEqual(modeConfig.readModelEffort('claude'), { model: 'sonnet', effort: 'low' });

  stdin.write('q');
  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('reopen/submit m flow did not exit')), 3000);
    }),
  ]);
  assert.equal(result.stopped, true);
});

test('runFullscreenDispatch m: discovery failure still opens menu with 运行时默认 only', async () => {
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
  stdin.write('m');
  await new Promise((r) => setTimeout(r, 150));
  assert.match(out, /运行时默认/);
  assert.doesNotMatch(out, /inject-model|not logged in/);
  stdin.write('q'); // cancel menu
  await new Promise((r) => setTimeout(r, 80));
  stdin.write('q'); // quit

  await Promise.race([
    runPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('discovery-fail m path did not exit')), 3000);
    }),
  ]);
});

// --- 20260807-fullscreen-tui-ux-impl / 01: Ready 三带壳 + 主 CTA ---

test('Ready 有可执行: 顶带 可开干 + 主 CTA 写清看板默认或高亮并点名 Enter', () => {
  const boardDefault = renderTopBar(snapWithBoard({
    status: 'idle',
    autoAdvance: false,
    slot: null,
  }));
  assert.match(boardDefault, /状态:\s*可开干/);
  assert.match(boardDefault, /下一步：开「看板默认」02-ready\.md · 按 Enter/);
  assert.doesNotMatch(boardDefault, /空闲/);
  assert.doesNotMatch(boardDefault, /无票可开/);

  const highlighted = renderTopBar(snapWithBoard({
    status: 'idle',
    autoAdvance: false,
    slot: null,
  }), { selectedIndex: 0 });
  assert.match(highlighted, /状态:\s*可开干/);
  assert.match(highlighted, /下一步：开 02-ready\.md.* · 按 Enter/);
  assert.doesNotMatch(highlighted, /看板默认/);

  const ctaOnly = renderReadyMainCta(snapWithBoard({
    status: 'idle',
    autoAdvance: false,
    slot: null,
  }));
  assert.match(ctaOnly, /按 Enter/);
  assert.match(ctaOnly, /看板默认/);
});

test('Ready 无可执行: 顶带 暂无票 + 主 CTA 不诱导 Enter', () => {
  const top = renderTopBar(snapWithBoard({
    status: 'idle',
    autoAdvance: false,
    slot: null,
    board: {
      feature: 'demo',
      readOnly: true,
      issues: [
        {
          id: '01-done.md',
          title: '已完成票',
          closed: true,
          blockedBy: [],
          unlocks: [],
          status: 'ready-for-agent',
        },
      ],
    },
  }));
  assert.match(top, /状态:\s*暂无票/);
  assert.match(top, /下一步：无票可开/);
  assert.doesNotMatch(top, /按 Enter/);
  assert.doesNotMatch(top, /可开干/);
  assert.doesNotMatch(top, /空闲/);
});

test('Ready 空槽: 中带不出现常驻大块「当前槽（空）」; 壳为三带', () => {
  const layout = describeShellLayout();
  assert.deepEqual(layout.regions, ['top', 'middle', 'footer']);

  const empty = renderSlotPanel(snapWithBoard({ status: 'idle', slot: null }));
  assert.equal(empty.trim(), '');

  const middle = renderMiddlePanel(snapWithBoard({ status: 'idle', slot: null, autoAdvance: false }));
  assert.doesNotMatch(middle, /当前槽\s*（空）|当前槽 \(空\)/);
  assert.match(middle, /现在可执行/);
  assert.match(middle, /02-ready\.md/);

  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard({ status: 'idle', autoAdvance: false, slot: null }),
    terminalRows: 20,
  }));
  assert.doesNotMatch(text, /当前槽\s*（空）|当前槽 \(空\)/);
  assert.match(text, /可开干/);
  assert.match(text, /下一步：/);
  assert.match(text, /现在可执行/);
  assert.match(text, /\[q\].*退出|退出/);
});

test('Ready 中带: 可执行列表可见; 有高亮可辨, 无高亮默认意图可辨', () => {
  const withDefault = renderMiddlePanel(snapWithBoard({
    status: 'idle',
    slot: null,
  }));
  assert.match(withDefault, /现在可执行/);
  assert.match(withDefault, /★\s*02-ready\.md/);
  assert.match(withDefault, /←看板默认|看板默认/);

  const withSel = renderMiddlePanel(snapWithBoard({
    status: 'idle',
    slot: null,
  }), { selectedIndex: 0 });
  assert.match(withSel, /02-ready\.md.*◀选中|◀选中/);
  assert.doesNotMatch(withSel, /←看板默认/);
});

test('Ready 三带: 铺满高度 / 底栏近底类既有回归不破', () => {
  const rows = 24;
  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard({ autoAdvance: false, status: 'idle', slot: null }),
    terminalRows: rows,
  }));
  const lines = text.split('\n');
  assert.ok(
    lines.length >= rows - 1 && lines.length <= rows + 1,
    `expected ~${rows} lines, got ${lines.length}`,
  );
  const footerIdx = lines.findIndex((line) => /\[q\].*退出|退出/.test(line));
  assert.ok(footerIdx >= 0, 'footer key line must render');
  assert.ok(
    footerIdx >= Math.floor(lines.length * 0.55),
    `footer should pin near bottom (idx=${footerIdx}, lines=${lines.length})`,
  );
  assert.match(text, /状态:\s*可开干/);
  assert.match(text, /下一步：开「看板默认」02-ready\.md · 按 Enter/);
});

test('Ready 自动开=开: 主 CTA 可后缀自动接力开中（忽略高亮）', () => {
  const top = renderTopBar(snapWithBoard({
    status: 'idle',
    autoAdvance: true,
    slot: null,
  }));
  assert.match(top, /下一步：开「看板默认」02-ready\.md · 按 Enter · 自动接力开中（忽略高亮）/);
});

test('Ready 看板默认对齐 Enter: impl 优先于列表中更前的 wayfinder', () => {
  const snap = snapWithBoard({
    status: 'idle',
    autoAdvance: false,
    slot: null,
    board: {
      feature: 'demo',
      readOnly: true,
      issues: [
        {
          id: '01-explore.md',
          title: '探路',
          closed: false,
          blockedBy: [],
          unlocks: [],
          status: 'open',
          entryClass: 'wayfinder',
          type: 'research',
        },
        {
          id: '02-impl.md',
          title: '实现票',
          closed: false,
          blockedBy: [],
          unlocks: [],
          status: 'ready-for-agent',
        },
      ],
    },
  });

  const def = boardDefaultExecutable(snap);
  assert.equal(def?.id, '02-impl.md', 'Enter default must prefer impl over earlier wayfinder');

  const top = renderTopBar(snap);
  assert.match(top, /下一步：开「看板默认」02-impl\.md · 按 Enter/);
  assert.doesNotMatch(top, /看板默认」01-explore/);

  const middle = renderMiddlePanel(snap);
  assert.match(middle, /02-impl\.md.*←看板默认|←看板默认.*02-impl/);
  assert.doesNotMatch(middle, /01-explore\.md.*←看板默认/);
});

// --- 20260807-fullscreen-tui-ux-impl / 02: 边沿态显示名 + 主 CTA 矩阵 ---

const occupiedSlot = {
  issueId: '02-ready.md',
  title: '实现票标题',
  pid: 4242,
  mode: 'vibe',
  closed: false,
  sessionId: 'sess-edge',
};

test('edge soft-stuck: 显示名 进行中；CTA 等 Worker 且勿再 Enter；Enter 仍可见', () => {
  const snap = snapWithBoard({
    status: 'soft-stuck',
    autoAdvance: true,
    slot: { ...occupiedSlot, closed: false },
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: false, reason: 'not-needs-resume' },
    },
  });
  assert.equal(operatorStatusDisplayName(snap), '进行中');
  const top = renderTopBar(snap);
  assert.match(top, /状态:\s*进行中/);
  assert.doesNotMatch(top, /软卡住|soft-stuck/);
  assert.match(top, /下一步：等当前 Worker · 勿再 Enter 开票/);
  assert.match(renderMainCta(snap), /勿再 Enter/);
  // Contract: Enter stays discoverable (not hidden); emphasis is visual/CTA weight only.
  assert.match(renderFooter(snap), /\[Enter\]/);
});

test('edge awaiting + auto off: [f] 待收尾；CTA 主推 f', () => {
  const snap = snapWithBoard({
    status: 'awaiting-worker-exit',
    autoAdvance: false,
    slot: { ...occupiedSlot, closed: true },
    actions: {
      forceAdvance: { available: true, reason: null },
      resume: { available: false, reason: 'not-needs-resume' },
    },
  });
  assert.equal(operatorStatusDisplayName(snap), '[f] 待收尾');
  const top = renderTopBar(snap);
  assert.match(top, /状态:\s*\[f\] 待收尾/);
  assert.match(top, /下一步：Worker 已关票 · 按 f 强制推进/);
  assert.doesNotMatch(top, /自动收尾中|进行中|软卡住/);
  assert.match(renderMainCta(snap), /按 f/);
});

test('edge awaiting + auto on: 自动收尾中；CTA 可自动收尾且与进行中/待收尾可分', () => {
  const snap = snapWithBoard({
    status: 'awaiting-worker-exit',
    autoAdvance: true,
    slot: { ...occupiedSlot, closed: true },
    actions: {
      forceAdvance: { available: true, reason: null },
      resume: { available: false, reason: 'not-needs-resume' },
    },
  });
  assert.equal(operatorStatusDisplayName(snap), '自动收尾中');
  const top = renderTopBar(snap);
  assert.match(top, /状态:\s*自动收尾中/);
  assert.match(top, /下一步：可自动收尾 · 无需手开下一张/);
  assert.doesNotMatch(top, /\[f\] 待收尾/);
  assert.doesNotMatch(top, /状态:\s*进行中/);
  assert.doesNotMatch(top, /勿再 Enter 开票/);
});

test('edge needs-resume with session: [r] 需恢复；CTA 主推 r', () => {
  const snap = snapWithBoard({
    status: 'needs-resume',
    autoAdvance: false,
    slot: { ...occupiedSlot, closed: false, sessionId: 'sess-1' },
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: true, reason: null },
    },
  });
  assert.equal(operatorStatusDisplayName(snap), '[r] 需恢复');
  const top = renderTopBar(snap);
  assert.match(top, /状态:\s*\[r\] 需恢复/);
  assert.match(top, /下一步：按 r 恢复历史会话/);
  assert.doesNotMatch(top, /无法恢复/);
  assert.match(renderMainCta(snap), /按 r/);
});

test('edge needs-resume without session: 无法恢复；不出现可用 r 诱导', () => {
  const snap = snapWithBoard({
    status: 'needs-resume',
    autoAdvance: false,
    slot: { ...occupiedSlot, closed: false, sessionId: null },
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: false, reason: 'no-session-id' },
    },
  });
  assert.equal(operatorStatusDisplayName(snap), '无法恢复');
  const top = renderTopBar(snap);
  assert.match(top, /状态:\s*无法恢复/);
  assert.match(top, /下一步：无法恢复 · 无 session id/);
  assert.doesNotMatch(top, /\[r\] 需恢复/);
  assert.doesNotMatch(top, /按 r 恢复/);
  assert.doesNotMatch(renderFooter(snap), /\[r\]/);
});

test('edge needs-confirmation: [y/n] 待确认；CTA 点名 y/n', () => {
  const snap = snapWithBoard({
    status: 'needs-confirmation',
    autoAdvance: false,
    slot: null,
    pendingHitl: {
      issueId: '03-hitl.md',
      title: '人闸票',
      entryClass: 'human',
      runtime: 'grok',
      mode: 'review',
    },
    actions: {
      confirmHitl: { available: true, reason: null },
      rejectHitl: { available: true, reason: null },
    },
  });
  assert.equal(operatorStatusDisplayName(snap), '[y/n] 待确认');
  const top = renderTopBar(snap);
  assert.match(top, /状态:\s*\[y\/n\] 待确认/);
  assert.match(top, /下一步：按 y 同意 \/ n 拒绝/);
  assert.match(renderMainCta(snap), /按 y|按 n|y 同意/);
});

test('edge stopped: 已停链；主路径指向退出/重新进入', () => {
  const snap = snapWithBoard({
    status: 'stopped',
    stopped: true,
    autoAdvance: false,
    slot: null,
  });
  assert.equal(operatorStatusDisplayName(snap), '已停链');
  const top = renderTopBar(snap);
  assert.match(top, /状态:\s*已停链/);
  assert.match(top, /下一步：链已停 · 按 q 退出或重新进入/);
  assert.match(renderMainCta(snap), /按 q/);
});

test('edge bootstrap error: 启动失败；CTA 看错误 · q', () => {
  const snap = {
    feature: '?',
    status: 'error',
    stopped: false,
    slot: null,
    messages: [{ type: 'error', text: 'boom bootstrap' }],
    actions: {},
  };
  assert.equal(operatorStatusDisplayName(snap), '启动失败');
  const top = renderTopBar(snap);
  assert.match(top, /状态:\s*启动失败/);
  assert.match(top, /下一步：查看错误 · 按 q 退出/);
});

test('edge occupied slot: 中带顶部最小槽摘要 id/标题/已关票/pid', () => {
  const snap = snapWithBoard({
    status: 'soft-stuck',
    slot: {
      issueId: '02-ready.md',
      title: '很长的实现标题用来截断展示',
      pid: 99,
      mode: 'vibe',
      closed: false,
      sessionId: 'sess-x',
    },
  });
  const middle = renderMiddlePanel(snap);
  assert.match(middle, /当前槽/);
  assert.match(middle, /02-ready\.md/);
  assert.match(middle, /pid:\s*99/);
  assert.match(middle, /已关票:\s*否/);
  assert.match(middle, /标题:/);
  // Summary sits above list/neighborhood work object.
  const slotIdx = middle.indexOf('当前槽');
  const workIdx = Math.max(
    middle.indexOf('现在可执行'),
    middle.indexOf('列表 · 全板'),
    middle.indexOf('焦点邻域'),
  );
  assert.ok(slotIdx >= 0 && workIdx > slotIdx, 'slot summary must precede middle list/neighborhood');
});

test('edge matrix: display name + CTA key binding per primary state', () => {
  const cases = [
    {
      name: '进行中',
      snap: snapWithBoard({
        status: 'soft-stuck',
        slot: { ...occupiedSlot, closed: false },
      }),
      display: '进行中',
      ctaKey: /Enter|勿再 Enter/,
    },
    {
      name: '[f] 待收尾',
      snap: snapWithBoard({
        status: 'awaiting-worker-exit',
        autoAdvance: false,
        slot: { ...occupiedSlot, closed: true },
        actions: { forceAdvance: { available: true, reason: null } },
      }),
      display: '[f] 待收尾',
      ctaKey: /按 f/,
    },
    {
      name: '自动收尾中',
      snap: snapWithBoard({
        status: 'awaiting-worker-exit',
        autoAdvance: true,
        slot: { ...occupiedSlot, closed: true },
      }),
      display: '自动收尾中',
      ctaKey: /可自动收尾/,
    },
    {
      name: '[r] 需恢复',
      snap: snapWithBoard({
        status: 'needs-resume',
        slot: { ...occupiedSlot, sessionId: 's1' },
        actions: { resume: { available: true, reason: null } },
      }),
      display: '[r] 需恢复',
      ctaKey: /按 r/,
    },
    {
      name: '无法恢复',
      snap: snapWithBoard({
        status: 'needs-resume',
        slot: { ...occupiedSlot, sessionId: null },
        actions: { resume: { available: false, reason: 'no-session-id' } },
      }),
      display: '无法恢复',
      ctaKey: /无 session id/,
      noR: true,
    },
    {
      name: '[y/n] 待确认',
      snap: snapWithBoard({
        status: 'needs-confirmation',
        slot: null,
        pendingHitl: { issueId: 'h.md', entryClass: 'human' },
        actions: {
          confirmHitl: { available: true, reason: null },
          rejectHitl: { available: true, reason: null },
        },
      }),
      display: '[y/n] 待确认',
      ctaKey: /y 同意|n 拒绝/,
    },
    {
      name: '已停链',
      snap: snapWithBoard({ status: 'stopped', stopped: true, slot: null }),
      display: '已停链',
      ctaKey: /按 q/,
    },
  ];

  for (const c of cases) {
    assert.equal(operatorStatusDisplayName(c.snap), c.display, c.name);
    const top = renderTopBar(c.snap);
    assert.match(top, new RegExp(`状态:\\s*${c.display.replace(/[[\]]/g, '\\$&')}`), c.name);
    assert.match(top, /下一步：/, c.name);
    assert.match(renderMainCta(c.snap) ?? '', c.ctaKey, c.name);
    if (c.noR) {
      assert.doesNotMatch(top, /按 r 恢复/);
      assert.doesNotMatch(renderFooter(c.snap), /\[r\]/);
    }
  }
});

// --- 20260807-fullscreen-tui-ux-impl / 03: 键位 remap + 底栏分组 / 热 dim ---

test('footer groups: 边沿 → 主路径 Enter/s/导航 → m/v → t/g/q；中文短标签', () => {
  const footer = renderFooter(snapWithBoard({
    status: 'needs-confirmation',
    autoAdvance: false,
    actions: {
      forceAdvance: { available: false },
      resume: { available: false },
      confirmHitl: { available: true },
      rejectHitl: { available: true },
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));

  const y = footer.indexOf('[y]');
  const n = footer.indexOf('[n]');
  const enter = footer.indexOf('[Enter]');
  const s = footer.indexOf('[s]');
  const nav = footer.search(/↑↓\/j\/k|导航/);
  const m = footer.indexOf('[m]');
  const v = footer.indexOf('[v]');
  const t = footer.indexOf('[t]');
  const g = footer.indexOf('[g]');
  const q = footer.indexOf('[q]');

  assert.ok(y >= 0 && n >= 0 && enter >= 0 && s >= 0 && nav >= 0);
  assert.ok(m >= 0 && v >= 0 && t >= 0 && g >= 0 && q >= 0);
  // A 边沿 → B 主路径 → C m/v → D t/g/q
  assert.ok(y < enter && n < enter, 'edge keys before Enter');
  assert.ok(enter < s && s < nav, 'main path Enter → s → nav');
  assert.ok(nav < m && m < v, 'nav before m/v');
  assert.ok(v < t && t < g && g < q, 't → g → q last group');

  assert.match(footer, /\[m\] 模型/);
  assert.match(footer, /\[v\] 模式/);
  assert.match(footer, /\[Enter\] 开始/);
  assert.match(footer, /\[s\] 自动开下一张\(关\)/);
  assert.match(footer, /\[y\] 同意/);
  assert.match(footer, /\[n\] 拒绝/);
  assert.match(footer, /\[t\] 刷新/);
  assert.match(footer, /\[g\] 全局总览/);
  assert.match(footer, /\[q\] 退出/);
  assert.doesNotMatch(footer, /\[o\]/);
});

test('footer: edge keys only when available; main path always; stopped hides m/v', () => {
  const idle = renderFooter(snapWithBoard({
    status: 'idle',
    autoAdvance: true,
    actions: {
      forceAdvance: { available: false },
      resume: { available: false },
      confirmHitl: { available: false },
      rejectHitl: { available: false },
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));
  assert.doesNotMatch(idle, /\[f\]|\[r\]|\[y\]|\[n\]/);
  assert.match(idle, /\[Enter\]/);
  assert.match(idle, /\[s\]/);
  assert.match(idle, /导航|j\/k/);
  assert.match(idle, /\[m\] 模型/);
  assert.match(idle, /\[v\] 模式/);

  const force = renderFooter(snapWithBoard({
    status: 'awaiting-worker-exit',
    autoAdvance: false,
    actions: {
      forceAdvance: { available: true },
      resume: { available: false },
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));
  assert.match(force, /\[f\] 强制推进/);
  assert.ok(force.indexOf('[f]') < force.indexOf('[Enter]'));

  const stopped = renderFooter(snapWithBoard({
    status: 'stopped',
    stopped: true,
    actions: {
      setMode: { available: false, reason: 'stopped' },
      setModelEffort: { available: false, reason: 'stopped' },
      forceAdvance: { available: false },
      resume: { available: false },
    },
  }));
  assert.doesNotMatch(stopped, /\[m\]|\[v\]/);
  assert.match(stopped, /\[Enter\]/);
  assert.match(stopped, /\[q\]/);
});

test('footer hot/dim: CTA 键与 available 边沿热；不可开时 Enter dim 仍显示', () => {
  const ready = buildFooterItems(snapWithBoard({
    status: 'idle',
    autoAdvance: false,
    actions: {
      setMode: { available: true },
      setModelEffort: { available: true },
      forceAdvance: { available: false },
      resume: { available: false },
    },
  }));
  const readyEnter = ready.find((i) => i.id === 'Enter');
  assert.equal(readyEnter?.hot, true);
  assert.notEqual(readyEnter?.dim, true);

  const soft = buildFooterItems(snapWithBoard({
    status: 'soft-stuck',
    autoAdvance: true,
    slot: { ...occupiedSlot, closed: false },
    actions: {
      forceAdvance: { available: false, reason: 'not-closed' },
      resume: { available: false },
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));
  const softEnter = soft.find((i) => i.id === 'Enter');
  assert.ok(softEnter, 'Enter still present when in progress');
  assert.equal(softEnter.dim, true);
  assert.notEqual(softEnter.hot, true);

  const noTicket = buildFooterItems(snapWithBoard({
    status: 'idle',
    autoAdvance: false,
    board: { issues: [], executable: [] },
    actions: {
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));
  const emptyEnter = noTicket.find((i) => i.id === 'Enter');
  assert.ok(emptyEnter);
  assert.equal(emptyEnter.dim, true);

  const hitl = buildFooterItems(snapWithBoard({
    status: 'needs-confirmation',
    autoAdvance: false,
    actions: {
      confirmHitl: { available: true },
      rejectHitl: { available: true },
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));
  assert.equal(hitl.find((i) => i.id === 'y')?.hot, true);
  assert.equal(hitl.find((i) => i.id === 'n')?.hot, true);
  assert.ok(hitl.some((i) => i.id === 'nav'), 'HITL keeps nav');
  assert.equal(hitl.find((i) => i.id === 'Enter')?.dim, true);
});

test('HITL: digits still only navigate; nav line stays in footer', async () => {
  const { surface, launcher } = makeSurface({
    candidates: [candidate('01-ready.md'), candidate('02-ready.md')],
    hitlCandidates: [candidate('03-human.md', { entryClass: 'human' })],
  });
  // Force HITL-style selection context: nav keys must not spawn.
  await surface.refresh();
  const launchesBefore = launcher.launches.length;
  const digit = await handleFullscreenKey(surface, '2', {
    selectedIndex: 0,
    executableCount: 2,
  });
  assert.equal(digit.selectionOnly, true);
  assert.equal(digit.selectedIndex, 1);
  assert.equal(launcher.launches.length, launchesBefore);

  const footer = renderFooter(snapWithBoard({
    status: 'needs-confirmation',
    actions: {
      confirmHitl: { available: true },
      rejectHitl: { available: true },
      setMode: { available: true },
      setModelEffort: { available: true },
    },
  }));
  assert.match(footer, /导航|j\/k|数字/);
});

// --- 20260807-fullscreen-tui-ux-impl / 04: middle list + focus neighborhood ---

test('Ready default middle: list + focus neighborhood, not global-graph-only', () => {
  const middle = renderMiddlePanel(snapWithBoard({
    status: 'idle',
    slot: null,
    autoAdvance: false,
  }));
  // Work object: executable list visible with focus/default mark.
  assert.match(middle, /现在可执行/);
  assert.match(middle, /02-ready\.md/);
  assert.match(middle, /◀选中|←看板默认|看板默认/);
  // Full-board remainder stays in the list (not only executables).
  assert.match(middle, /全板其余/);
  assert.match(middle, /01-done\.md/);
  assert.match(middle, /03-blocked\.md/);
  // Focus neighborhood clues (read-only direct up/down).
  assert.match(middle, /焦点邻域|邻域/);
  assert.match(middle, /上游|下游|直接上下游|──►/);
  assert.match(middle, /只读|不可图上派票/);
  // Default is NOT exclusive global overview; list must remain available.
  assert.doesNotMatch(middle, /^依赖图（全局/m);
  // Neighborhood may still mention short ids; the global-only title should be absent by default.
  assert.doesNotMatch(middle, /依赖图 · 全局总览|依赖图（只读 · 不可图上派票）/);
});

test('Ready default shell frame: list usable; not global graph exclusive', () => {
  const text = renderToString(createElement(DispatchShell, {
    snap: snapWithBoard({ status: 'idle', slot: null, autoAdvance: false }),
    terminalRows: 28,
  }));
  assert.match(text, /现在可执行/);
  assert.match(text, /02-ready\.md/);
  assert.match(text, /焦点邻域|邻域|上游|下游/);
  assert.doesNotMatch(text, /依赖图 · 全局总览|依赖图（只读 · 不可图上派票）/);
  // Enter path still discoverable.
  assert.match(text, /\[Enter\].*开始|Enter/);
});

test('middle focus neighborhood follows list highlight when selected', () => {
  // Two unblocked executables so selectedIndex can point at either row.
  const issues = [
    {
      id: '01-a.md',
      title: 'a',
      closed: false,
      blockedBy: [],
      unlocks: ['03-c.md'],
      status: 'ready-for-agent',
    },
    {
      id: '02-b.md',
      title: 'b',
      closed: false,
      blockedBy: [],
      unlocks: ['03-c.md'],
      status: 'ready-for-agent',
    },
    {
      id: '03-c.md',
      title: 'c',
      closed: false,
      blockedBy: ['01-a.md', '02-b.md'],
      unlocks: [],
      status: 'ready-for-agent',
    },
  ];
  const snap = snapWithBoard({
    status: 'idle',
    slot: null,
    board: { feature: 'demo', readOnly: true, issues },
  });
  // selectedIndex 1 → focus 02; neighborhood should mention 03 as downstream of 02.
  const middle = renderMiddlePanel(snap, { selectedIndex: 1 });
  assert.match(middle, /02-b\.md.*◀选中|◀选中/);
  assert.match(middle, /焦点邻域|邻域/);
  // Focus uses short mark (★02◀焦点); full ids appear on list / detail lines.
  assert.match(middle, /02◀焦点|★02.*◀焦点|◀焦点/);
  assert.match(middle, /03-c\.md|·03|03/);
  assert.match(middle, /上游|下游|──►/);
});

test('middleView global: full overview is second view; list nav / Enter contract untouched', async () => {
  const global = renderMiddlePanel(snapWithBoard({
    status: 'idle',
    slot: null,
  }), { middleView: 'global' });
  assert.match(global, /依赖图|全局/);
  assert.match(global, /只读|不可图上派票/);
  assert.match(global, /──►/);
  // Global may still show executable for orientation, but is explicitly second view chrome.
  assert.match(global, /图例|全局总览|依赖图/);
  // List remains present in global frame (not graph-only exclusive).
  assert.match(global, /现在可执行/);
  assert.match(global, /02-ready\.md/);

  assert.deepEqual(mapFullscreenKey('g'), { type: 'toggleMiddleView' });
  const { surface, launcher } = makeSurface({
    candidates: [candidate('01-a.md'), candidate('02-b.md')],
  });
  await surface.refresh();
  const toggled = await handleFullscreenKey(surface, 'g', {});
  assert.equal(toggled.toggleMiddleView, true);
  // No spawn / no graph-dispatch side effect from g.
  assert.equal(toggled.spawned, undefined);
  assert.equal(launcher.launches.length, 0);

  // List nav still highlight-only while second view would be showing.
  const nav = await handleFullscreenKey(surface, 'j', {
    selectedIndex: 0,
    executableCount: 2,
  });
  assert.equal(nav.selectionOnly, true);
  assert.equal(nav.selectedIndex, 1);
  assert.equal(launcher.launches.length, 0);

  // Enter still starts selected ticket (presentation view does not gate start).
  await handleFullscreenKey(surface, '\r', {
    selectedIndex: 1,
    executableCount: 2,
    selectedIssueId: '02-b.md',
  });
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '02-b.md');

  // Footer advertises optional g (secondary).
  const footer = renderFooter(snapWithBoard({ autoAdvance: false }));
  assert.match(footer, /\[g\].*全局/);
});

test('occupied slot middle: list + neighborhood remain; no graph dispatch', () => {
  const middle = renderMiddlePanel(snapWithBoard({
    status: 'soft-stuck',
    slot: {
      issueId: '02-ready.md',
      title: '可执行票',
      pid: 42,
      mode: 'review',
      closed: false,
    },
  }));
  assert.match(middle, /当前槽/);
  assert.match(middle, /现在可执行/);
  assert.match(middle, /焦点邻域|邻域/);
  assert.match(middle, /只读|不可图上派票/);
  // Forbid dispatch affordances; "不可图上派票" is the positive read-only label.
  assert.doesNotMatch(middle, /点击派票|派票入口|从图派票/);
});
