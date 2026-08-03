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

test('dispatch snapshot updates slot state as chain migrates soft-stuck → awaiting-exit → next', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface } = makeSurface({
    candidates: [first, second],
  });

  await surface.tick();
  let snap = surface.snapshot();
  assert.equal(snap.status, 'soft-stuck');
  assert.equal(snap.slot?.issueId, '01-first.md');
  assert.equal(snap.slot?.title, 'demo/01-first');
  assert.equal(snap.actions.forceAdvance.available, false);

  tracker.setCompletion('01-first.md', true);
  await surface.tick();
  snap = surface.snapshot();
  assert.equal(snap.status, 'awaiting-worker-exit');
  assert.equal(snap.actions.forceAdvance.available, true);

  launcher.markExited(snap.slot.pid);
  await surface.tick();
  snap = surface.snapshot();
  assert.equal(snap.status, 'soft-stuck');
  assert.equal(snap.slot?.issueId, '02-second.md');
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
  const { tracker, launcher, surface, modeConfig } = makeSurface({
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

  const resumed = await surface.resume();
  assert.equal(resumed.ok, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].kind, 'resume');
  assert.equal(launcher.launches[1].sessionId, 'sess-resume-tui');
  if (launcher.launches[1].initialPrompt) {
    assert.doesNotMatch(launcher.launches[1].initialPrompt, /\/implement\b/);
  }
});

test('HITL ask appears on surface; confirm/reject match ticket 11', async () => {
  const wayfinder = candidate('01-wayfinder.md', {
    entryClass: 'wayfinder',
    type: 'research',
  });
  const { launcher, surface } = makeSurface({
    candidates: [],
    hitlCandidates: [wayfinder],
  });

  await surface.tick();
  let snap = surface.snapshot();
  assert.equal(snap.status, 'needs-confirmation');
  assert.equal(snap.actions.confirmHitl.available, true);
  assert.equal(snap.actions.rejectHitl.available, true);
  assert.equal(snap.pendingHitl?.issueId, '01-wayfinder.md');
  assert.equal(snap.pendingHitl?.entryClass, 'wayfinder');
  assert.deepEqual(launcher.launches, []);

  // Reject path: zero spawn, empty slot.
  const rejected = await surface.rejectHitl();
  assert.equal(rejected.ok, true);
  assert.equal(launcher.launches.length, 0);
  assert.equal(surface.snapshot().slot, null);

  // Re-offer and confirm.
  await surface.tick();
  const confirmed = await surface.confirmHitl();
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.spawned, true);
  assert.match(launcher.launches[0].initialPrompt, /\/wayfinder\b/);
  assert.doesNotMatch(launcher.launches[0].initialPrompt, /\/implement\b/);
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

test('interactive TUI auto-poll advances after Closed + exit without manual tick', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, surface } = makeSurface({
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

  // Dual conditions without typing `t`.
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(surface.snapshot().slot.pid);

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
  assert.equal(advanced, true, 'auto-poll must spawn next after Closed+exit');
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
