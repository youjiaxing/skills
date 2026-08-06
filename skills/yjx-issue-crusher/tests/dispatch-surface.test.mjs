import assert from 'node:assert/strict';
import test from 'node:test';

import { createChainRun } from '../scripts/chain-run.mjs';
import { createDispatchSurface } from '../scripts/dispatch-surface.mjs';
import { createFakeLauncher } from '../scripts/fake-launcher.mjs';
import { createFakeTracker } from '../scripts/fake-tracker.mjs';
import { createMemoryModeConfig } from '../scripts/mode-config.mjs';
import {
  renderDispatchFrame,
  runDispatchTui,
  snapshotFingerprint,
} from '../scripts/dispatch-tui.mjs';
import { PassThrough } from 'node:stream';

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

test('dispatch snapshot shows effective mode and empty-slot status', async () => {
  const { surface } = makeSurface({ candidates: [] });

  await surface.tick();
  const snap = surface.snapshot();

  assert.equal(snap.feature, 'demo');
  assert.equal(snap.subsequentMode, 'review');
  assert.equal(snap.status, 'idle');
  assert.equal(snap.slot, null);
  assert.equal(snap.stopped, false);
  assert.equal(snap.board.readOnly, true);
  assert.ok(Array.isArray(snap.board.issues));
  assert.equal(snap.actions.forceAdvance.available, false);
  assert.equal(snap.actions.resume.available, false);
  assert.equal(snap.actions.stop.available, true);
});

test('dispatch snapshot updates slot state as chain migrates soft-stuck → await exit → awaiting-session-end', async () => {
  // Closed + live worker: never kill; stay awaiting-worker-exit.
  // Natural exit without session end: awaiting-session-end (no auto next).
  // forceAdvance is the human escape to open next.
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, chain } = makeSurface({
    candidates: [first, second],
  });

  await surface.tick();
  let snap = surface.snapshot();
  assert.equal(snap.status, 'soft-stuck');
  assert.equal(snap.slot?.issueId, '01-first.md');
  assert.equal(snap.slot?.title, 'demo/01-first');
  assert.equal(snap.actions.forceAdvance.available, false);

  const oldPid = snap.slot.pid;
  tracker.setCompletion('01-first.md', true);
  // refresh only: still observable as awaiting-worker-exit, no kill
  await surface.refresh();
  snap = surface.snapshot();
  assert.equal(snap.status, 'awaiting-worker-exit');
  assert.equal(snap.actions.forceAdvance.available, true);
  assert.equal(launcher.isAlive(oldPid), true);

  // Tick while still alive: still wait, never kill.
  await surface.tick();
  snap = surface.snapshot();
  assert.equal(snap.status, 'awaiting-worker-exit');
  assert.equal(snap.slot?.issueId, '01-first.md');
  assert.equal(launcher.isAlive(oldPid), true);
  assert.equal(launcher.kills.length, 0);

  launcher.markExited(oldPid);
  await surface.tick();
  snap = surface.snapshot();
  assert.equal(snap.status, 'awaiting-session-end');
  assert.equal(snap.slot?.issueId, '01-first.md');
  assert.equal(launcher.kills.length, 0);
  assert.equal(launcher.launches.length, 1);

  // Human f opens next without kill.
  await surface.forceAdvance();
  await surface.tick();
  snap = surface.snapshot();
  assert.equal(snap.status, 'soft-stuck');
  assert.equal(snap.slot?.issueId, '02-second.md');
  assert.equal(launcher.kills.length, 0);
});

test('read-only board projection exposes dependencies; surface has no graph dispatch action', async () => {
  const ready = candidate('03-ready.md', {
    blockedBy: ['01-wayfinder.md'],
    unlocks: ['04-later.md'],
  });
  const { surface } = makeSurface({
    candidates: [ready],
    boardIssues: [
      {
        id: '01-wayfinder.md',
        title: 'wayfinder',
        closed: false,
        blockedBy: [],
        unlocks: ['03-ready.md'],
        status: 'wayfinder',
      },
      {
        id: '03-ready.md',
        title: 'ready',
        closed: false,
        blockedBy: ['01-wayfinder.md'],
        unlocks: ['04-later.md'],
        status: 'ready-for-agent',
      },
    ],
  });

  await surface.tick();
  const snap = surface.snapshot();
  assert.equal(snap.board.readOnly, true);
  const row = snap.board.issues.find((item) => item.id === '03-ready.md');
  assert.deepEqual(row.blockedBy, ['01-wayfinder.md']);
  assert.deepEqual(row.unlocks, ['04-later.md']);

  // Contract: no graph-driven dispatch / reorder API on the surface.
  assert.equal(typeof surface.dispatchFromGraph, 'undefined');
  assert.equal(typeof surface.claimViaGraph, 'undefined');
  assert.equal(snap.actions.graphDispatch, undefined);
});

test('mode dial writes repo, emits vibe tip, only affects subsequent tickets', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, modeConfig, chain } = makeSurface({
    candidates: [first, second],
    mode: 'review',
  });

  await surface.tick();
  assert.equal(surface.snapshot().slot.mode, 'review');

  const switched = await surface.setMode('vibe');
  assert.equal(switched.ok, true);
  assert.equal(modeConfig.readMode(), 'vibe');

  const snap = surface.snapshot();
  assert.equal(snap.subsequentMode, 'vibe');
  assert.equal(snap.slot.mode, 'review', 'live worker stays pinned');
  assert.ok(
    snap.messages.some((m) => /auto[- ]?commit|Closed|关票/i.test(m.text || m.message || '')),
    'vibe consequence tip must be visible on the surface',
  );

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(snap.slot.pid);
  chain.reportSessionEnded('success');
  await surface.tick();
  assert.equal(surface.snapshot().slot.mode, 'vibe');
});

test('force-advance available only when current issue is Closed', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, surface } = makeSurface({
    candidates: [first, second],
  });

  await surface.tick();
  assert.equal(surface.snapshot().actions.forceAdvance.available, false);
  const denied = await surface.forceAdvance();
  assert.equal(denied.ok, false);

  tracker.setCompletion('01-first.md', true);
  await surface.refresh();
  assert.equal(surface.snapshot().actions.forceAdvance.available, true);

  const forced = await surface.forceAdvance();
  assert.equal(forced.ok, true);
  await surface.tick();
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');
});

test('needs-resume exposes one-click resume that uses recorded session id', async () => {
  const first = candidate('01-first.md');
  const { launcher, surface } = makeSurface({
    candidates: [first],
    launcherOptions: { sessionId: 'sess-resume-tui' },
  });

  await surface.tick();
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();

  const snap = surface.snapshot();
  assert.equal(snap.status, 'needs-resume');
  assert.equal(snap.actions.resume.available, true);
  assert.equal(snap.actions.resume.reason, null);

  const resumed = await surface.resume();
  assert.equal(resumed.ok, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].kind, 'resume');
  assert.equal(launcher.launches[1].sessionId, 'sess-resume-tui');
  assert.equal(launcher.launches[1].initialPrompt, '');
  assert.doesNotMatch(String(launcher.launches[1].initialPrompt || ''), /\/implement\b/);
  assert.doesNotMatch(String(launcher.launches[1].initialPrompt || ''), /\/wayfinder\b/);
});

test('needs-resume without session id keeps r unavailable with explicit reason', async () => {
  const first = candidate('01-first.md');
  const { launcher, surface } = makeSurface({
    candidates: [first],
    launcherOptions: { sessionId: null },
  });

  await surface.tick();
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();

  const snap = surface.snapshot();
  assert.equal(snap.status, 'needs-resume');
  assert.equal(snap.actions.resume.available, false);
  assert.equal(snap.actions.resume.reason, 'no-session-id');

  const resumed = await surface.resume();
  assert.equal(resumed.ok, false);
  assert.equal(resumed.reason, 'no-session-id');
  assert.equal(launcher.launches.length, 1, 'must not spawn a blank worker');
});

test('HITL ask on surface is for human/unknown; wayfinder starts via Enter', async () => {
  const human = candidate('05-human.md', {
    entryClass: 'human',
    statusRole: 'ready-for-human',
  });
  const { launcher, surface } = makeSurface({
    candidates: [],
    hitlCandidates: [human],
  });

  await surface.tick();
  let snap = surface.snapshot();
  assert.equal(snap.status, 'needs-confirmation');
  assert.equal(snap.actions.confirmHitl.available, true);
  assert.equal(snap.actions.rejectHitl.available, true);
  assert.equal(snap.pendingHitl?.issueId, '05-human.md');
  assert.equal(snap.pendingHitl?.entryClass, 'human');
  assert.deepEqual(launcher.launches, []);

  const rejected = await surface.rejectHitl();
  assert.equal(rejected.ok, true);
  assert.equal(launcher.launches.length, 0);
  assert.equal(surface.snapshot().slot, null);

  await surface.tick();
  const confirmed = await surface.confirmHitl();
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.spawned, true);
  assert.doesNotMatch(launcher.launches[0].initialPrompt, /\/wayfinder\b/);
  assert.doesNotMatch(launcher.launches[0].initialPrompt, /\/implement\b/);
});

test('surface start opens wayfinder with /wayfinder without confirmHitl', async () => {
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
  assert.equal(surface.snapshot().pendingHitl, null);

  const started = await surface.start('01-wayfinder.md');
  assert.equal(started.ok, true);
  assert.equal(started.spawned, true);
  assert.match(launcher.launches[0].initialPrompt, /\/wayfinder\b/);
  assert.equal(launcher.launches[0].issue.id, '01-wayfinder.md');
});

test('stop freezes auto spawn; surface reports stopped', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second],
  });

  await surface.tick();
  await surface.stop();
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();

  const snap = surface.snapshot();
  assert.equal(snap.stopped, true);
  assert.equal(snap.status, 'stopped');
  assert.equal(launcher.launches.length, 1);
  assert.equal(snap.actions.stop.available, false);
});

test('renderDispatchFrame includes Chinese UI, dependency graph, and executable list', async () => {
  const first = candidate('01-first.md');
  const { surface } = makeSurface({
    candidates: [first],
    boardIssues: [
      {
        id: '01-first.md',
        title: 'first',
        closed: false,
        blockedBy: [],
        unlocks: ['02-second.md'],
        status: 'ready-for-agent',
      },
      {
        id: '02-second.md',
        title: 'second',
        closed: false,
        blockedBy: ['01-first.md'],
        unlocks: [],
        status: 'ready-for-agent',
      },
    ],
  });

  await surface.tick();
  const text = renderDispatchFrame(surface.snapshot());
  assert.match(text, /后续 mode:\s*review|mode: review/i);
  assert.match(text, /软卡住|当前槽/);
  assert.match(text, /01-first\.md/);
  assert.match(text, /依赖图|现在可执行/);
  assert.match(text, /──►|▶01|★01/);
  assert.match(text, /不可图上派票/);
  assert.doesNotMatch(text, /\bdrag\b|reassign via graph|dispatch via graph/i);
});

test('interactive TUI auto-poll advances after dual-gate without manual tick', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, chain } = makeSurface({
    candidates: [first, second],
  });

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
    pollIntervalMs: 80,
  });

  // Wait until first ticket occupies the slot.
  let firstReady = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      if (surface.snapshot().slot?.issueId === '01-first.md') {
        firstReady = true;
        break;
      }
    } catch {
      // snapshot not ready yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(firstReady, true, 'initial autoTick should occupy first slot');

  // Dual-gate (Closed + session end success) without typing `t`.
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  chain.reportSessionEnded('success');

  // Wait for auto-poll to open second ticket.
  let advanced = false;
  for (let i = 0; i < 80; i += 1) {
    try {
      if (surface.snapshot().slot?.issueId === '02-second.md') {
        advanced = true;
        break;
      }
    } catch {
      // snapshot not ready yet
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(advanced, true, 'auto-poll must spawn next after dual-gate');
  assert.equal(launcher.launches.length, 2);

  input.write('q\n');
  const result = await runPromise;
  assert.equal(result.stopped, true);
  assert.match(out, /02-second\.md|soft-stuck/);
});

test('snapshotFingerprint changes when slot migrates', async () => {
  const first = candidate('01-first.md');
  const { surface } = makeSurface({ candidates: [first] });
  await surface.tick();
  const a = snapshotFingerprint(surface.snapshot());
  await surface.stop();
  const b = snapshotFingerprint(surface.snapshot());
  assert.notEqual(a, b);
});

// --- dispatch-tui-start-and-polish / 01: autoAdvance projection + gate ---

test('surface projects autoAdvance; off blocks tick spawn with ready board', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });

  await surface.tick();
  let snap = surface.snapshot();
  assert.equal(snap.autoAdvance, false);
  assert.equal(snap.slot, null);
  assert.equal(launcher.launches.length, 0);

  await surface.tick();
  await surface.tick();
  snap = surface.snapshot();
  assert.equal(snap.autoAdvance, false);
  assert.equal(launcher.launches.length, 0, 'tick must not auto-spawn while autoAdvance is off');
});

test('surface setAutoAdvance(true) restores tick auto-spawn (non-fullscreen / once seam)', async () => {
  const only = candidate('01-ready.md');
  const { launcher, surface } = makeSurface({
    candidates: [only],
    autoAdvance: false,
  });

  await surface.tick();
  assert.equal(launcher.launches.length, 0);
  assert.equal(surface.snapshot().autoAdvance, false);

  const toggled = await surface.setAutoAdvance(true);
  assert.equal(toggled.ok, true);
  assert.equal(surface.snapshot().autoAdvance, true);

  await surface.tick();
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-ready.md');
});

// --- dispatch-tui-start-and-polish / 02: surface start ---

test('surface.start(issueId) spawns that ticket and opens autoAdvance', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });

  await surface.refresh();
  assert.equal(surface.snapshot().autoAdvance, false);

  const result = await surface.start('02-second.md');
  assert.equal(result.ok, true);
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '02-second.md');
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');
  assert.equal(surface.snapshot().autoAdvance, true);
});

test('surface.start() without id spawns board default next', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });

  await surface.refresh();
  const result = await surface.start();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches[0].issue.id, '01-first.md');
  assert.equal(surface.snapshot().autoAdvance, true);
});

test('surface.start while slot occupied rejects without second spawn', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });

  await surface.start('01-first.md');
  const blocked = await surface.start('02-second.md');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'slot-occupied');
  assert.equal(launcher.launches.length, 1);
});

// --- dispatch-tui-start-and-polish / 03: toggle autoAdvance ---

test('surface toggle writes preference; setAutoAdvance and stop do not', async () => {
  const modeConfig = createMemoryModeConfig({ autoAdvance: false });
  const only = candidate('01-ready.md');
  const { surface, modeConfig: cfg } = makeSurface({
    candidates: [only],
    autoAdvance: false,
    modeConfig,
  });
  await surface.refresh();

  const before = cfg.writeCount;
  await surface.setAutoAdvance(true);
  assert.equal(cfg.readAutoAdvance(), false, 'setAutoAdvance must not write repo');
  assert.equal(cfg.writeCount, before);

  await surface.setAutoAdvance(false);
  await surface.toggleAutoAdvance(); // session was false → on + write true
  assert.equal(surface.snapshot().autoAdvance, true);
  assert.equal(cfg.readAutoAdvance(), true);

  await surface.stop();
  assert.equal(cfg.readAutoAdvance(), true, 'stop must not clear preference');
});

test('surface.toggleAutoAdvance flips projection; on alone does not idle-spawn; handoff still works', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, chain } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });

  await surface.refresh();
  assert.equal(surface.snapshot().autoAdvance, false);

  const on = await surface.toggleAutoAdvance();
  assert.equal(on.ok, true);
  assert.equal(surface.snapshot().autoAdvance, true);

  await surface.tick();
  assert.equal(launcher.launches.length, 0, 's-on must not idle-spawn; first needs start/Enter');
  assert.equal(surface.snapshot().slot, null);

  await surface.start('01-first.md');
  assert.equal(launcher.launches.length, 1);
  assert.equal(surface.snapshot().slot?.issueId, '01-first.md');
  assert.equal(surface.snapshot().autoAdvance, true);

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  chain.reportSessionEnded('success');
  await surface.tick();
  assert.equal(launcher.launches.length, 2, 'auto on + dual-gate handoff must spawn next');
  assert.equal(surface.snapshot().slot?.issueId, '02-second.md');

  const off = await surface.toggleAutoAdvance();
  assert.equal(off.ok, true);
  assert.equal(surface.snapshot().autoAdvance, false);

  tracker.setCompletion('02-second.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(launcher.launches.length, 2, 's-off must block auto handoff spawn');
  // Without session end / force: freeable but not auto-released.
  assert.equal(surface.snapshot().status, 'awaiting-session-end');
});

test('surface: after toggle off, start succeeds but autoAdvance stays off', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second],
    autoAdvance: false,
  });

  await surface.refresh();
  await surface.start('01-first.md');
  assert.equal(surface.snapshot().autoAdvance, true);

  await surface.toggleAutoAdvance();
  assert.equal(surface.snapshot().autoAdvance, false);

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);
  await surface.tick();
  assert.equal(surface.snapshot().status, 'awaiting-session-end');

  const result = await surface.start('02-second.md');
  assert.equal(result.ok, true);
  assert.equal(result.spawned, true);
  assert.equal(surface.snapshot().autoAdvance, false);
});

// --- 20260804-1802-tui-model-effort / 01: subsequent model/effort on the surface ---

test('snapshot exposes subsequent model/effort and pinned slot model/effort', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { surface } = makeSurface({
    candidates: [first, second],
    model: 'grok-3.5',
    effort: 'high',
  });

  await surface.tick();
  const snap = surface.snapshot();
  assert.equal(snap.subsequentModel, 'grok-3.5');
  assert.equal(snap.subsequentEffort, 'high');
  assert.equal(snap.slot.model, 'grok-3.5', 'slot exposes the spawn-pinned model');
  assert.equal(snap.slot.effort, 'high');
  assert.equal(snap.actions.setModelEffort.available, true);
});

test('surface setModelEffort writes repo, updates snapshot, next launch carries it, slot pinned', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface, modeConfig, chain } = makeSurface({
    candidates: [first, second],
  });

  await surface.tick();
  assert.equal(surface.snapshot().subsequentModel, null, 'no flag/repo → runtime default');
  assert.equal(surface.snapshot().slot.model, null);

  const submitted = await surface.setModelEffort({ model: 'grok-3.5', effort: 'high' });
  assert.equal(submitted.ok, true);
  assert.deepEqual(modeConfig.readModelEffort('grok'), { model: 'grok-3.5', effort: 'high' });

  const snap = surface.snapshot();
  assert.equal(snap.subsequentModel, 'grok-3.5');
  assert.equal(snap.subsequentEffort, 'high');
  assert.equal(snap.slot.model, null, 'live worker stays pinned');

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(snap.slot.pid);
  chain.reportSessionEnded('success');
  await surface.tick();
  const nextSnap = surface.snapshot();
  assert.equal(nextSnap.slot.issueId, '02-second.md');
  assert.equal(nextSnap.slot.model, 'grok-3.5', 'next spawn carries the submitted model');
  assert.equal(nextSnap.slot.effort, 'high');
  assert.equal(launcher.launches[1].model, 'grok-3.5');
  assert.equal(launcher.launches[1].effort, 'high');
});

test('surface setModelEffort fails cleanly when the chain lacks the port', async () => {
  const stubChain = {
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
    mode: 'review',
    autoAdvance: true,
    stopped: false,
    status: 'idle',
    slot: null,
    pendingHitl: null,
    events: [],
    model: null,
    effort: null,
    step: async () => ({
      spawned: false,
      advanced: true,
      reason: 'empty-slot',
      next: null,
      status: 'idle',
    }),
    refreshStatus: async () => ({ status: 'idle', reason: 'empty-slot' }),
  };
  const surface = createDispatchSurface({ chain: stubChain, tracker: null });
  await surface.tick();
  const result = await surface.setModelEffort({ model: 'grok-4' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-model-effort');
  assert.equal(surface.snapshot().subsequentModel, null);
});
