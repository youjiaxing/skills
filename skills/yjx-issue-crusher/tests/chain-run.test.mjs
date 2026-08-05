import assert from 'node:assert/strict';
import test from 'node:test';

import { createChainRun } from '../scripts/chain-run.mjs';
import { createFakeLauncher } from '../scripts/fake-launcher.mjs';
import { createFakeTracker } from '../scripts/fake-tracker.mjs';
import { createMemoryModeConfig } from '../scripts/mode-config.mjs';

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

function makeChain(overrides = {}) {
  const {
    candidates = [],
    completions = {},
    launcherOptions = {},
    ...chainOptions
  } = overrides;
  const tracker = createFakeTracker({ candidates, completions });
  const launcher = createFakeLauncher(launcherOptions);
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
    ...chainOptions,
  });
  return { tracker, launcher, chain };
}

test('empty frontier: Chain Run spawns nothing and becomes idle', async () => {
  const { launcher, chain } = makeChain({ candidates: [] });

  const result = await chain.step();

  assert.equal(result.spawned, false);
  assert.equal(result.next, null);
  assert.equal(chain.status, 'idle');
  assert.deepEqual(launcher.launches, []);
  assert.equal(chain.nextIssue, null);
});

test('unique ready candidate: Chain Run identifies next issue and spawns once', async () => {
  const only = candidate('03-package-skeleton.md', {
    title: 'package skeleton',
  });
  const { launcher, chain } = makeChain({
    candidates: [only],
    launcherOptions: { pid: 4242, sessionId: 'sess-1' },
    runtime: 'claude',
  });

  const result = await chain.step();

  assert.equal(result.spawned, true);
  assert.equal(result.next?.id, '03-package-skeleton.md');
  assert.equal(chain.nextIssue?.id, '03-package-skeleton.md');
  // Occupied slot with live worker + open issue is soft-stuck (ticket 09).
  assert.equal(chain.status, 'soft-stuck');
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '03-package-skeleton.md');
  assert.equal(launcher.launches[0].feature, 'demo');
  assert.equal(launcher.launches[0].cwd, '/tmp/project');
  assert.equal(launcher.launches[0].runtime, 'claude');
  assert.equal(chain.slot?.pid, 4242);
});

test('ready impl launch contract: required identity, title, implement path, review-safe mode', async () => {
  const only = candidate('05-worker-launch-and-title-contract.md');
  const { launcher, chain } = makeChain({
    candidates: [only],
    runtime: 'grok',
  });

  await chain.step();

  assert.equal(launcher.launches.length, 1);
  const launch = launcher.launches[0];
  assert.equal(launch.runtime, 'grok');
  assert.equal(launch.cwd, '/tmp/project');
  assert.equal(launch.feature, 'demo');
  assert.equal(launch.issue.id, '05-worker-launch-and-title-contract.md');
  assert.equal(launch.title, 'demo/05-worker-launch-and-title-contract');
  assert.equal(launch.mode, 'review');
  assert.match(launch.initialPrompt, /\/implement\s+\.scratch\/demo\/issues\/05-worker-launch-and-title-contract\.md/);
  // Grok title is applied out-of-band (summary.json); prompt must not lead with /rename.
  assert.doesNotMatch(launch.initialPrompt, /\/rename\b/);
  assert.match(launch.initialPrompt, /^\/implement\b/u);
  assert.match(launch.initialPrompt, /review/i);
  assert.match(launch.initialPrompt, /do not auto-commit|禁止自动 commit|禁自动 commit/i);
  assert.doesNotMatch(launch.initialPrompt, /# 05 —/);
});

test('claude launch contract carries title for -n and implement path without requiring /rename line', async () => {
  const only = candidate('08-fake-launch-impl-handoff.md');
  const { launcher, chain } = makeChain({
    candidates: [only],
    runtime: 'claude',
  });

  await chain.step();

  const launch = launcher.launches[0];
  assert.equal(launch.title, 'demo/08-fake-launch-impl-handoff');
  assert.match(launch.initialPrompt, /\/implement\s+\.scratch\/demo\/issues\/08-fake-launch-impl-handoff\.md/);
  assert.doesNotMatch(launch.initialPrompt, /\/rename\s+/);
  assert.equal(launch.mode, 'review');
});

test('vibe mode launch contract allows auto commit/close wording', async () => {
  const only = candidate('02-do-work.md');
  const { launcher, chain } = makeChain({
    candidates: [only],
    mode: 'vibe',
  });

  await chain.step();

  const launch = launcher.launches[0];
  assert.equal(launch.mode, 'vibe');
  assert.match(launch.initialPrompt, /vibe/i);
  assert.match(launch.initialPrompt, /commit/i);
  assert.match(launch.initialPrompt, /Closed:\s*true/i);
});

test('exit without Closed does not spawn the next issue', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '01-first.md');

  launcher.markExited(chain.slot.pid);
  // deliberately leave Closed false
  assert.equal((await tracker.getCompletion('01-first.md')).closed, false);

  const result = await chain.step();
  assert.equal(result.spawned, false);
  assert.equal(launcher.launches.length, 1, 'must not spawn next on exit alone');
});

test('process exit alone is not a success condition for opening the next issue', async () => {
  const first = candidate('01-alpha.md');
  const second = candidate('02-beta.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const firstPid = chain.slot.pid;
  launcher.markExited(firstPid);

  const result = await chain.step();

  // Explicit: exited worker + open issue must not count as handoff success.
  // Ticket 09 names this edge needs-resume (not a success path).
  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'needs-resume');
  assert.equal(chain.status, 'needs-resume');
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.isAlive(firstPid), false);
  assert.equal(chain.slot?.issue.id, '01-alpha.md');
});

test('Closed without exit + autoAdvance on: safe-reaps this slot then spawns next', async () => {
  // 20260805-1244 / 01: AFK handoff must not stick on awaiting-worker-exit forever.
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const oldPid = chain.slot.pid;
  tracker.setCompletion('01-first.md', true);
  assert.equal(launcher.isAlive(oldPid), true);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');
  assert.equal(launcher.isAlive(oldPid), false);
  assert.deepEqual(launcher.kills, [oldPid]);
  assert.equal(chain.slot?.issue?.id, '02-second.md');
});

test('Closed + worker exit opens next ready impl exactly once with correct identity', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  assert.equal(launcher.launches[0].issue.id, '01-first.md');
  assert.equal(launcher.launches[0].title, 'demo/01-first');

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');
  assert.equal(launcher.launches[1].title, 'demo/02-second');
  assert.equal(launcher.launches[1].feature, 'demo');
  assert.match(launcher.launches[1].initialPrompt, /\/implement\s+\.scratch\/demo\/issues\/02-second\.md/);

  // Another step without completing second must not double-spawn.
  const again = await chain.step();
  assert.equal(again.spawned, false);
  assert.equal(launcher.launches.length, 2);
});

test('Closed + force-advance (process still alive) opens next once', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  tracker.setCompletion('01-first.md', true);
  assert.equal(launcher.isAlive(chain.slot.pid), true);

  const forced = await chain.forceAdvance();
  assert.equal(forced.ok, true);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');
});

test('force-advance is rejected when current issue is not Closed', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const forced = await chain.forceAdvance();
  assert.equal(forced.ok, false);

  const result = await chain.step();
  assert.equal(result.spawned, false);
  assert.equal(launcher.launches.length, 1);
});

// --- Ticket 09: edge states, single slot, resume ---

test('soft-stuck: alive and not Closed blocks next spawn and does not kill the worker', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const pid = chain.slot.pid;
  assert.equal(launcher.isAlive(pid), true);
  assert.equal((await tracker.getCompletion('01-first.md')).closed, false);

  const result = await chain.step();

  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'soft-stuck');
  assert.equal(chain.status, 'soft-stuck');
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.isAlive(pid), true);
  assert.equal(launcher.kills.length, 0);
});

test('Closed without exit + autoAdvance off: awaiting-worker-exit, no kill, no next spawn', async () => {
  // Dual gate still holds; auto off must not auto-reap (manual f still available).
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: false,
  });

  await chain.startIssue('01-first.md');
  // startIssue opens auto on clean path — lock it back off like user s-off.
  chain.toggleAutoAdvance();
  assert.equal(chain.autoAdvance, false);

  tracker.setCompletion('01-first.md', true);
  const oldPid = chain.slot.pid;

  const result = await chain.step();

  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'awaiting-worker-exit');
  assert.equal(chain.status, 'awaiting-worker-exit');
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.isAlive(oldPid), true);
  assert.equal(launcher.kills.length, 0);
});

test('refreshStatus still observes awaiting-worker-exit without reaping', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const oldPid = chain.slot.pid;
  tracker.setCompletion('01-first.md', true);

  const refreshed = await chain.refreshStatus();
  assert.equal(refreshed.status, 'awaiting-worker-exit');
  assert.equal(refreshed.reason, 'awaiting-worker-exit');
  assert.equal(launcher.isAlive(oldPid), true);
  assert.equal(launcher.kills.length, 0);
  assert.equal(launcher.launches.length, 1);
});

// --- 20260805-1244-vibe-handoff-and-resume / 01: Closed safe reap + auto next ---

test('not Closed: autoAdvance on still never kills the live worker', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: true,
  });

  await chain.step();
  const pid = chain.slot.pid;

  const result = await chain.step();
  assert.equal(result.reason, 'soft-stuck');
  assert.equal(result.spawned, false);
  assert.equal(launcher.isAlive(pid), true);
  assert.equal(launcher.kills.length, 0);
  assert.equal(launcher.launches.length, 1);
});

test('auto safe-reap does not stomp force-advance default no-kill orphan path', async () => {
  // Human f after Closed: default orphan (no kill). Auto path must not also kill
  // that same old pid when forceAdvanceRequested already opens the dual gate.
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const oldPid = chain.slot.pid;
  tracker.setCompletion('01-first.md', true);

  const forced = await chain.forceAdvance(); // default killWorker: false
  assert.equal(forced.ok, true);
  assert.equal(launcher.kills.length, 0);
  assert.equal(launcher.isAlive(oldPid), true);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');
  // Orphan stays alive; auto-reap must not fire after force-advance.
  assert.equal(launcher.isAlive(oldPid), true);
  assert.equal(launcher.kills.length, 0);
});

test('Closed + auto on + worker already exited: no kill call, still spawns next', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const oldPid = chain.slot.pid;
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(oldPid);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');
  assert.equal(launcher.kills.length, 0, 'already dead → confirm only, no kill');
});

test('force-advance after Closed spawns next and by default does not kill the old worker', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const oldPid = chain.slot.pid;
  tracker.setCompletion('01-first.md', true);

  const forced = await chain.forceAdvance();
  assert.equal(forced.ok, true);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');
  // Default: orphan old process stays alive; no kill.
  assert.equal(launcher.isAlive(oldPid), true);
  assert.equal(launcher.kills.length, 0);
});

test('force-advance opt-in killWorker terminates the old fake process', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  const oldPid = chain.slot.pid;
  tracker.setCompletion('01-first.md', true);

  const forced = await chain.forceAdvance({ killWorker: true });
  assert.equal(forced.ok, true);
  assert.equal(launcher.isAlive(oldPid), false);
  assert.deepEqual(launcher.kills, [oldPid]);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches[1].issue.id, '02-second.md');
});

test('dead process + not Closed enters needs-resume and blocks next spawn', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
    launcherOptions: { sessionId: 'sess-dead-1' },
  });

  await chain.step();
  const deadPid = chain.slot.pid;
  launcher.markExited(deadPid);

  const result = await chain.step();

  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'needs-resume');
  assert.equal(chain.status, 'needs-resume');
  assert.equal(launcher.launches.length, 1);
  assert.equal(chain.slot?.sessionId, 'sess-dead-1');
});

test('resume launch carries recorded session id + runtime/cwd and omits implement/wayfinder entry', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
    runtime: 'claude',
    launcherOptions: { sessionId: 'sess-resume-42', pid: 5000 },
  });

  await chain.step();
  assert.equal(chain.slot.sessionId, 'sess-resume-42');
  launcher.markExited(chain.slot.pid);
  await chain.step();
  assert.equal(chain.status, 'needs-resume');

  const resumed = await chain.resume();
  assert.equal(resumed.ok, true);
  assert.equal(launcher.launches.length, 2);

  const resumeLaunch = launcher.launches[1];
  assert.equal(resumeLaunch.kind, 'resume');
  assert.equal(resumeLaunch.sessionId, 'sess-resume-42');
  assert.equal(resumeLaunch.runtime, 'claude');
  assert.equal(resumeLaunch.cwd, '/tmp/project');
  assert.equal(resumeLaunch.feature, 'demo');
  assert.equal(resumeLaunch.issue.id, '01-first.md');
  assert.equal(resumeLaunch.title, 'demo/01-first');
  // Must not re-inject a fresh ticket skill entry.
  assert.equal(resumeLaunch.initialPrompt, '');
  assert.doesNotMatch(String(resumeLaunch.initialPrompt || ''), /\/implement\b/);
  assert.doesNotMatch(String(resumeLaunch.initialPrompt || ''), /\/wayfinder\b/);
  assert.equal(chain.status, 'soft-stuck');
  assert.equal(chain.slot?.pid, 5001);
  assert.equal(chain.slot?.sessionId, 'sess-resume-42');
});

test('needs-resume without session id refuses resume and does not spawn a blank worker', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
    launcherOptions: { sessionId: null, pid: 7000 },
  });

  await chain.step();
  assert.equal(chain.slot?.sessionId, null);
  launcher.markExited(chain.slot.pid);
  await chain.step();
  assert.equal(chain.status, 'needs-resume');

  const resumed = await chain.resume();
  assert.equal(resumed.ok, false);
  assert.equal(resumed.reason, 'no-session-id');
  assert.equal(launcher.launches.length, 1, 'must not open a fresh blank worker');
  assert.equal(chain.status, 'needs-resume');
  assert.equal(chain.slot?.pid, 7000);
});

test('resume surfaces launcher history probe when present (blank vs non-blank)', async () => {
  const only = candidate('01-first.md');
  const tracker = createFakeTracker({ candidates: [only] });
  const base = createFakeLauncher({ sessionId: 'sess-hist-1', pid: 8100 });
  const launcher = {
    ...base,
    async launch(request) {
      const result = await base.launch(request);
      if (request?.kind === 'resume') {
        result.history = {
          exists: true,
          blank: false,
          hasUserQuery: true,
          hasSkillEntry: true,
          reason: null,
        };
      }
      return result;
    },
  };
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
  });

  await chain.step();
  launcher.markExited(chain.slot.pid);
  await chain.step();
  assert.equal(chain.status, 'needs-resume');

  const resumed = await chain.resume();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.history?.blank, false);
  assert.equal(resumed.history?.hasUserQuery, true);
});

test('single slot: second automatic spawn is rejected while the slot is occupied', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
  });

  const firstStep = await chain.step();
  assert.equal(firstStep.spawned, true);
  assert.equal(launcher.launches.length, 1);
  assert.ok(chain.slot, 'slot must be occupied');

  const secondStep = await chain.step();
  assert.equal(secondStep.spawned, false);
  assert.equal(launcher.launches.length, 1, 'single slot forbids concurrent second spawn');
  assert.ok(
    secondStep.reason === 'soft-stuck' || secondStep.reason === 'slot-occupied',
    `expected soft-stuck or slot-occupied, got ${secondStep.reason}`,
  );
});

// --- Ticket 10: review/vibe mode selection, pin-on-spawn, repo config ---

function makeModeConfig(initialMode = null) {
  return createMemoryModeConfig({ mode: initialMode });
}

test('no repo config and no startup override: effective mode is review with review-safe launch', async () => {
  const only = candidate('01-default-review.md');
  const config = makeModeConfig(null);
  const { launcher, chain } = makeChain({
    candidates: [only],
    modeConfig: config,
  });

  assert.equal(chain.mode, 'review');
  await chain.step();

  const launch = launcher.launches[0];
  assert.equal(launch.mode, 'review');
  assert.match(launch.initialPrompt, /do not auto-commit|禁止自动 commit|禁自动 commit/i);
  assert.equal(config.readMode(), null, 'default path must not invent a repo mode write');
});

test('repo config mode=vibe: subsequent spawn carries vibe constraints', async () => {
  const only = candidate('02-from-repo.md');
  const config = makeModeConfig('vibe');
  const { launcher, chain } = makeChain({
    candidates: [only],
    modeConfig: config,
  });

  assert.equal(chain.mode, 'vibe');
  await chain.step();

  const launch = launcher.launches[0];
  assert.equal(launch.mode, 'vibe');
  assert.match(launch.initialPrompt, /vibe/i);
  assert.match(launch.initialPrompt, /commit/i);
  assert.match(launch.initialPrompt, /Closed:\s*true/i);
});

test('startup process mode overrides repo config and does not write that override to repo', async () => {
  const only = candidate('03-startup-override.md');
  const config = makeModeConfig('vibe');
  const { launcher, chain } = makeChain({
    candidates: [only],
    mode: 'review',
    modeConfig: config,
  });

  assert.equal(chain.mode, 'review', 'startup --mode wins over repo vibe');
  await chain.step();

  assert.equal(launcher.launches[0].mode, 'review');
  assert.equal(config.readMode(), 'vibe', 'startup override must not persist into repo config');
  assert.equal(config.writeCount, 0);
});

test('scheduler setMode writes repo and only changes subsequent spawns, not pinned current worker', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const config = makeModeConfig(null);
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    mode: 'review',
    modeConfig: config,
  });

  await chain.step();
  assert.equal(launcher.launches[0].mode, 'review');
  assert.equal(chain.slot.mode, 'review');

  const switched = await chain.setMode('vibe');
  assert.equal(switched.ok, true);
  assert.equal(config.readMode(), 'vibe', 'TUI mode change must write repo immediately');
  assert.equal(chain.mode, 'vibe', 'subsequent effective mode follows TUI write');
  assert.equal(chain.slot.mode, 'review', 'live worker stays pinned to spawn-time mode');

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);

  const next = await chain.step();
  assert.equal(next.spawned, true);
  assert.equal(launcher.launches[1].mode, 'vibe');
  assert.match(launcher.launches[1].initialPrompt, /vibe/i);
  assert.equal(chain.slot.mode, 'vibe');
});

test('live worker cannot hot-switch contract mode via setMode or repo rewrite', async () => {
  const only = candidate('01-pinned.md');
  const config = makeModeConfig('review');
  const { launcher, chain } = makeChain({
    candidates: [only],
    modeConfig: config,
  });

  await chain.step();
  const pinned = chain.slot.mode;
  assert.equal(pinned, 'review');

  await chain.setMode('vibe');
  config.writeMode('vibe');

  // Soft-stuck step must keep the same pinned contract; no re-launch with new mode.
  const again = await chain.step();
  assert.equal(again.spawned, false);
  assert.equal(chain.slot.mode, 'review');
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].mode, 'review');
});

test('switching to vibe emits a one-line consequence message/event', async () => {
  const only = candidate('01-warn.md');
  const config = makeModeConfig('review');
  const { chain } = makeChain({
    candidates: [only],
    modeConfig: config,
  });

  await chain.step();
  assert.equal((chain.events || []).length, 0);

  const switched = await chain.setMode('vibe');
  assert.equal(switched.ok, true);

  const events = chain.events;
  assert.ok(Array.isArray(events) && events.length >= 1);
  const tip = events.find((e) => e.type === 'mode-consequence' || e.kind === 'mode-consequence');
  assert.ok(tip, 'must emit a mode-consequence event when switching to vibe');
  assert.match(String(tip.message || tip.text || ''), /auto[- ]?commit|自动 commit|Closed|关票/i);
});

test('TUI setMode supersedes startup --mode for subsequent spawns', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const config = makeModeConfig('review');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    mode: 'review',
    modeConfig: config,
  });

  await chain.step();
  assert.equal(launcher.launches[0].mode, 'review');

  await chain.setMode('vibe');
  assert.equal(chain.mode, 'vibe');
  // Startup was review; after TUI choose, subsequent must follow TUI/repo not leftover startup.
  assert.equal(config.readMode(), 'vibe');

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);
  await chain.step();
  assert.equal(launcher.launches[1].mode, 'vibe');
});

test('mode resolution has no user-level or feature-level layer', async () => {
  // Contract: only startup process override, repo config, and hard default review.
  // Feature slug and userHome must not change the resolved mode.
  const only = candidate('01-layers.md');
  const config = makeModeConfig(null);
  const { launcher, chain } = makeChain({
    candidates: [only],
    feature: 'some-feature-that-must-not-imply-vibe',
    modeConfig: config,
    userHome: '/home/someone-with-vibe-default',
    userMode: 'vibe',
    featureMode: 'vibe',
  });

  assert.equal(chain.mode, 'review');
  await chain.step();
  assert.equal(launcher.launches[0].mode, 'review');
});

test('setMode without modeConfig is rejected (must write repo)', async () => {
  const only = candidate('01-need-config.md');
  const { chain } = makeChain({
    candidates: [only],
    // no modeConfig
  });

  await chain.step();
  const switched = await chain.setMode('vibe');
  assert.equal(switched.ok, false);
  assert.equal(switched.reason, 'no-mode-config');
  assert.equal(chain.mode, 'review');
  assert.equal((chain.events || []).length, 0);
});

// --- Ticket 11: non-ready / Wayfinder HITL (ask before spawn) ---

function hitlCandidate(id, overrides = {}) {
  return candidate(id, {
    entryClass: overrides.entryClass ?? 'wayfinder',
    type: overrides.type,
    statusRole: overrides.statusRole,
    ...overrides,
  });
}

function makeHitlChain(overrides = {}) {
  const {
    candidates = [],
    hitlCandidates = [],
    completions = {},
    launcherOptions = {},
    ...chainOptions
  } = overrides;
  const tracker = createFakeTracker({ candidates, hitlCandidates, completions });
  const launcher = createFakeLauncher(launcherOptions);
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
    ...chainOptions,
  });
  return { tracker, launcher, chain };
}

test('HITL only wayfinder frontier: step does not spawn and emits needs-confirmation', async () => {
  const wayfinder = hitlCandidate('01-wayfinder-research.md', {
    entryClass: 'wayfinder',
    type: 'research',
    title: 'wayfinder research',
  });
  const { launcher, chain } = makeHitlChain({
    candidates: [],
    hitlCandidates: [wayfinder],
  });

  const result = await chain.step();

  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'needs-confirmation');
  assert.equal(chain.status, 'needs-confirmation');
  assert.deepEqual(launcher.launches, []);
  assert.equal(chain.slot, null);

  const events = chain.events;
  const signal = events.find((e) => e.type === 'needs-confirmation');
  assert.ok(signal, 'must emit observable needs-confirmation signal');
  assert.equal(signal.issue?.id, '01-wayfinder-research.md');
  assert.equal(signal.entryClass, 'wayfinder');
  assert.equal(signal.runtime, 'grok');
  assert.equal(signal.title, 'demo/01-wayfinder-research');
  // model/effort omitted → show runtime default (null or explicit marker).
  assert.ok(signal.model === null || signal.model === 'runtime-default');
  assert.ok(signal.effort === null || signal.effort === 'runtime-default');
  assert.equal(chain.pendingHitl?.issue?.id, '01-wayfinder-research.md');
});

test('HITL approve wayfinder: launch uses /wayfinder path, not /implement, review-safe mode', async () => {
  const wayfinder = hitlCandidate('01-wayfinder-research.md', {
    entryClass: 'wayfinder',
    type: 'research',
  });
  const { launcher, chain } = makeHitlChain({
    candidates: [],
    hitlCandidates: [wayfinder],
  });

  await chain.step();
  assert.equal(chain.status, 'needs-confirmation');

  const approved = await chain.confirmHitl();
  assert.equal(approved.ok, true);
  assert.equal(approved.spawned, true);
  assert.equal(launcher.launches.length, 1);

  const launch = launcher.launches[0];
  assert.equal(launch.issue.id, '01-wayfinder-research.md');
  assert.equal(launch.title, 'demo/01-wayfinder-research');
  assert.equal(launch.mode, 'review');
  assert.match(launch.initialPrompt, /\/wayfinder\s+\.scratch\/demo\/issues\/01-wayfinder-research\.md/);
  assert.doesNotMatch(launch.initialPrompt, /\/implement\b/);
  assert.match(launch.initialPrompt, /do not auto-commit|禁止自动 commit|禁自动 commit/i);
  assert.ok(chain.slot, 'approved spawn occupies the logical slot');
  assert.equal(chain.pendingHitl, null);
});

test('HITL reject: zero spawn and logical slot stays empty', async () => {
  const wayfinder = hitlCandidate('01-wayfinder-research.md', {
    entryClass: 'wayfinder',
    type: 'research',
  });
  const { launcher, chain } = makeHitlChain({
    candidates: [],
    hitlCandidates: [wayfinder],
  });

  await chain.step();
  const rejected = await chain.rejectHitl();

  assert.equal(rejected.ok, true);
  assert.equal(launcher.launches.length, 0);
  assert.equal(chain.slot, null);
  assert.equal(chain.pendingHitl, null);
  assert.equal(chain.status, 'idle');
});

test('ready impl auto path still spawns without HITL misclassification', async () => {
  const ready = candidate('03-ready-impl.md');
  const wayfinder = hitlCandidate('01-wayfinder-research.md', {
    entryClass: 'wayfinder',
    type: 'research',
  });
  const { launcher, chain } = makeHitlChain({
    candidates: [ready],
    hitlCandidates: [wayfinder],
  });

  const result = await chain.step();

  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '03-ready-impl.md');
  assert.match(launcher.launches[0].initialPrompt, /\/implement\b/);
  assert.doesNotMatch(launcher.launches[0].initialPrompt, /\/wayfinder\b/);
  assert.equal(chain.pendingHitl, null);
  assert.ok(!(chain.events || []).some((e) => e.type === 'needs-confirmation'));
});

test('HITL approve human/unknown: launch has no concrete skill slash', async () => {
  const human = hitlCandidate('05-human-ready.md', {
    entryClass: 'human',
    statusRole: 'ready-for-human',
    title: 'needs a human',
  });
  const { launcher, chain } = makeHitlChain({
    candidates: [],
    hitlCandidates: [human],
    runtime: 'claude',
  });

  await chain.step();
  assert.equal(chain.status, 'needs-confirmation');
  assert.equal(chain.pendingHitl?.entryClass, 'human');

  const approved = await chain.confirmHitl();
  assert.equal(approved.ok, true);
  assert.equal(launcher.launches.length, 1);

  const launch = launcher.launches[0];
  assert.equal(launch.issue.id, '05-human-ready.md');
  assert.doesNotMatch(launch.initialPrompt, /\/implement\b/);
  assert.doesNotMatch(launch.initialPrompt, /\/wayfinder\b/);
  // Neutral open-path convention is fine; no concrete skill slash.
  assert.match(launch.initialPrompt, /\.scratch\/demo\/issues\/05-human-ready\.md/);
  assert.equal(launch.mode, 'review');
});

test('HITL approve respects process mode pin (vibe when resolved at confirm time)', async () => {
  const wayfinder = hitlCandidate('01-wayfinder-research.md', {
    entryClass: 'wayfinder',
    type: 'research',
  });
  const { launcher, chain } = makeHitlChain({
    candidates: [],
    hitlCandidates: [wayfinder],
    mode: 'vibe',
  });

  await chain.step();
  const approved = await chain.confirmHitl();
  assert.equal(approved.ok, true);
  assert.equal(launcher.launches[0].mode, 'vibe');
  assert.match(launcher.launches[0].initialPrompt, /vibe/i);
});

test('HITL approve unknown class: neutral open path, no concrete skill slash', async () => {
  const unknown = hitlCandidate('06-unparseable.md', {
    entryClass: 'unknown',
    title: 'cannot classify',
  });
  const { launcher, chain } = makeHitlChain({
    candidates: [],
    hitlCandidates: [unknown],
  });

  await chain.step();
  assert.equal(chain.pendingHitl?.entryClass, 'unknown');
  const approved = await chain.confirmHitl();
  assert.equal(approved.ok, true);
  assert.doesNotMatch(launcher.launches[0].initialPrompt, /\/implement\b/);
  assert.doesNotMatch(launcher.launches[0].initialPrompt, /\/wayfinder\b/);
  assert.match(launcher.launches[0].initialPrompt, /\.scratch\/demo\/issues\/06-unparseable\.md/);
});

// --- Ticket 13: stop chain — no further auto spawn ---

test('stop: subsequent step does not auto-spawn even with ready candidates', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  assert.equal(launcher.launches.length, 1);

  const stopped = await chain.stop();
  assert.equal(stopped.ok, true);
  assert.equal(chain.status, 'stopped');
  assert.equal(chain.stopped, true);

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);

  const result = await chain.step();
  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'stopped');
  assert.equal(launcher.launches.length, 1, 'stop must freeze auto relay');
  assert.equal(chain.status, 'stopped');
});

test('stop on empty frontier: step stays stopped with zero spawns', async () => {
  const { launcher, chain } = makeChain({ candidates: [] });

  await chain.stop();
  const result = await chain.step();

  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'stopped');
  assert.deepEqual(launcher.launches, []);
  assert.equal(chain.status, 'stopped');
});

test('stop blocks force-advance path that would open the next ticket', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  tracker.setCompletion('01-first.md', true);

  await chain.stop();
  const forced = await chain.forceAdvance();
  assert.equal(forced.ok, false);
  assert.equal(forced.reason, 'stopped');

  const result = await chain.step();
  assert.equal(result.spawned, false);
  assert.equal(launcher.launches.length, 1);
});

// --- dispatch-tui-start-and-polish / 01: autoAdvance gate ---

test('autoAdvance defaults on: step still auto-spawns ready impl (once / non-fullscreen seam)', async () => {
  const only = candidate('01-ready.md');
  const { launcher, chain } = makeChain({ candidates: [only] });

  assert.equal(chain.autoAdvance, true);
  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 1);
});

test('autoAdvance off: repeated step never auto-spawns ready impl', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: false,
  });

  assert.equal(chain.autoAdvance, false);

  for (let i = 0; i < 3; i += 1) {
    const result = await chain.step();
    assert.equal(result.spawned, false);
    assert.equal(result.reason, 'auto-advance-off');
  }

  assert.equal(launcher.launches.length, 0);
  assert.equal(chain.slot, null);
  assert.equal(chain.status, 'idle');
});

test('setAutoAdvance(true) re-enables auto spawn on subsequent step', async () => {
  const only = candidate('01-ready.md');
  const { launcher, chain } = makeChain({
    candidates: [only],
    autoAdvance: false,
  });

  await chain.step();
  assert.equal(launcher.launches.length, 0);

  const toggled = chain.setAutoAdvance(true);
  assert.equal(toggled.ok, true);
  assert.equal(chain.autoAdvance, true);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 1);
});

// --- dispatch-tui-start-and-polish / 02: Enter start + auto handoff ---

test('startIssue(id) with autoAdvance off spawns that issue exactly once', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: false,
  });

  const result = await chain.startIssue('02-second.md');
  assert.equal(result.ok, true);
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '02-second.md');
  assert.equal(chain.slot?.issue?.id, '02-second.md');
});

test('startNext with autoAdvance off spawns board default next (recommendNext)', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: false,
  });

  const result = await chain.startNext();
  assert.equal(result.ok, true);
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].issue.id, '01-first.md');
});

test('first successful startIssue opens autoAdvance', async () => {
  const only = candidate('01-ready.md');
  const { chain } = makeChain({
    candidates: [only],
    autoAdvance: false,
  });

  assert.equal(chain.autoAdvance, false);
  const result = await chain.startIssue('01-ready.md');
  assert.equal(result.spawned, true);
  assert.equal(chain.autoAdvance, true, 'first successful Enter/start must open autoAdvance');
});

test('after first start + Closed∧exit, step auto-spawns board next (ignores which id was manual)', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const third = candidate('03-third.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second, third],
    autoAdvance: false,
  });

  // Manual start of second (not frontier default)
  await chain.startIssue('02-second.md');
  assert.equal(launcher.launches.length, 1);
  assert.equal(chain.autoAdvance, true);

  tracker.setCompletion('02-second.md', true);
  launcher.markExited(chain.slot.pid);

  const handoff = await chain.step();
  assert.equal(handoff.spawned, true);
  assert.equal(launcher.launches.length, 2);
  // Board default among remaining open: 01 first
  assert.equal(launcher.launches[1].issue.id, '01-first.md');
});

test('startIssue while slot occupied does not second-spawn', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: false,
  });

  await chain.startIssue('01-first.md');
  assert.equal(launcher.launches.length, 1);

  const blocked = await chain.startIssue('02-second.md');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.spawned, false);
  assert.equal(blocked.reason, 'slot-occupied');
  assert.equal(launcher.launches.length, 1);
  assert.equal(chain.slot?.issue?.id, '01-first.md');
});

// --- dispatch-tui-start-and-polish / 03: s toggle autoAdvance ---

test('toggleAutoAdvance flips on/off and is observable', async () => {
  const only = candidate('01-ready.md');
  const { chain } = makeChain({
    candidates: [only],
    autoAdvance: false,
  });

  assert.equal(chain.autoAdvance, false);
  const on = chain.toggleAutoAdvance();
  assert.equal(on.ok, true);
  assert.equal(on.autoAdvance, true);
  assert.equal(chain.autoAdvance, true);

  const off = chain.toggleAutoAdvance();
  assert.equal(off.ok, true);
  assert.equal(off.autoAdvance, false);
  assert.equal(chain.autoAdvance, false);

  const onAgain = chain.toggleAutoAdvance();
  assert.equal(onAgain.autoAdvance, true);
  assert.equal(chain.autoAdvance, true);
});

test('after user toggle off, successful startIssue does not reopen autoAdvance', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: false,
  });

  // Clean first Enter still opens auto (ticket 02).
  await chain.startIssue('01-first.md');
  assert.equal(chain.autoAdvance, true);

  // User s-off.
  chain.toggleAutoAdvance();
  assert.equal(chain.autoAdvance, false);

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);
  await chain.step(); // release only; auto off → no spawn
  assert.equal(launcher.launches.length, 1);
  assert.equal(chain.slot, null);

  // Enter only opens one; must NOT sneak auto back on.
  const started = await chain.startIssue('02-second.md');
  assert.equal(started.ok, true);
  assert.equal(started.spawned, true);
  assert.equal(chain.autoAdvance, false, 'Enter after s-off must not reopen autoAdvance');
});

test('programmatic setAutoAdvance(false) still allows first start to open auto', async () => {
  // Fullscreen mount uses setAutoAdvance(false); that must not lock out ticket 02.
  const only = candidate('01-ready.md');
  const { chain } = makeChain({
    candidates: [only],
    autoAdvance: true,
  });

  chain.setAutoAdvance(false);
  assert.equal(chain.autoAdvance, false);

  await chain.startIssue('01-ready.md');
  assert.equal(chain.autoAdvance, true, 'mount gate must not suppress first-Enter open');
});

test('empty slot + toggle on allows step auto-spawn without prior Enter', async () => {
  const only = candidate('01-ready.md');
  const { launcher, chain } = makeChain({
    candidates: [only],
    autoAdvance: false,
  });

  await chain.step();
  assert.equal(launcher.launches.length, 0);

  chain.toggleAutoAdvance();
  assert.equal(chain.autoAdvance, true);

  const result = await chain.step();
  assert.equal(result.spawned, true);
  assert.equal(launcher.launches.length, 1);
});

test('after s-off then s-on, step auto-spawns again', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: false,
  });

  await chain.startIssue('01-first.md');
  chain.toggleAutoAdvance(); // off
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);
  await chain.step();
  assert.equal(launcher.launches.length, 1);

  chain.toggleAutoAdvance(); // on again
  const handoff = await chain.step();
  assert.equal(handoff.spawned, true);
  assert.equal(launcher.launches.length, 2);
});

// --- 20260804-1802-tui-model-effort / 01: subsequent model/effort 真源与仓分桶 ---

function makeModelEffortConfig(initial = {}) {
  return createMemoryModeConfig({ mode: initial.mode ?? null, workers: initial.workers });
}

test('startup model/effort flags seed the next spawn without writing repo', async () => {
  const only = candidate('01-startup-flags.md');
  const config = makeModelEffortConfig();
  const { launcher, chain } = makeChain({
    candidates: [only],
    model: 'grok-3.5',
    effort: 'high',
    modeConfig: config,
  });

  assert.equal(chain.model, 'grok-3.5');
  assert.equal(chain.effort, 'high');
  await chain.step();

  const launch = launcher.launches[0];
  assert.equal(launch.model, 'grok-3.5');
  assert.equal(launch.effort, 'high');
  assert.equal(config.readModelEffort('grok').model, null, 'startup flags must not write repo');
  assert.equal(config.writeCount, 0);
});

test('repo workers bucket seeds subsequent model/effort when flags omitted', async () => {
  const only = candidate('01-repo-bucket.md');
  const config = makeModelEffortConfig({
    workers: { grok: { model: 'grok-4', effort: 'medium' } },
  });
  const { launcher, chain } = makeChain({
    candidates: [only],
    modeConfig: config,
  });

  assert.equal(chain.model, 'grok-4', 'repo bucket seeds grok model');
  assert.equal(chain.effort, 'medium');
  await chain.step();
  assert.equal(launcher.launches[0].model, 'grok-4');
  assert.equal(launcher.launches[0].effort, 'medium');
});

test('startup flag wins over repo bucket per dimension', async () => {
  const only = candidate('01-flag-wins.md');
  const config = makeModelEffortConfig({
    workers: { grok: { model: 'grok-4', effort: 'medium' } },
  });
  const { launcher, chain } = makeChain({
    candidates: [only],
    model: 'grok-3.5', // flag only for model; effort falls back to repo bucket
    modeConfig: config,
  });

  assert.equal(chain.model, 'grok-3.5');
  assert.equal(chain.effort, 'medium');
  await chain.step();
  assert.equal(launcher.launches[0].model, 'grok-3.5');
  assert.equal(launcher.launches[0].effort, 'medium');
});

test('repo bucket only seeds the current runtime bucket (no cross-runtime bleed)', async () => {
  const only = candidate('01-runtime-bucket.md');
  const config = makeModelEffortConfig({
    workers: { claude: { model: 'opus', effort: 'max' } },
  });
  const { launcher, chain } = makeChain({
    candidates: [only],
    runtime: 'grok', // current runtime is grok; claude bucket must not bleed
    modeConfig: config,
  });

  assert.equal(chain.model, null);
  assert.equal(chain.effort, null);
  await chain.step();
  assert.equal(launcher.launches[0].model, null);
  assert.equal(launcher.launches[0].effort, null);
});

test('setModelEffort writes repo bucket, updates subsequent, keeps pinned slot', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const config = makeModelEffortConfig();
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    modeConfig: config,
  });

  await chain.step();
  assert.equal(launcher.launches[0].model, null, 'startup: no flag/repo → omit flags');
  assert.equal(chain.slot.model, null);

  const submitted = await chain.setModelEffort({ model: 'grok-3.5', effort: 'high' });
  assert.equal(submitted.ok, true);
  assert.deepEqual(config.readModelEffort('grok'), { model: 'grok-3.5', effort: 'high' });
  assert.equal(chain.model, 'grok-3.5');
  assert.equal(chain.effort, 'high');
  assert.equal(chain.slot.model, null, 'live worker stays pinned to spawn-time contract');

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);
  const next = await chain.step();
  assert.equal(next.spawned, true);
  assert.equal(launcher.launches[1].model, 'grok-3.5');
  assert.equal(launcher.launches[1].effort, 'high');
});

test('setModelEffort empty values omit flags and clear the repo bucket', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const config = makeModelEffortConfig({
    workers: { grok: { model: 'grok-4', effort: 'max' } },
  });
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    modeConfig: config,
  });

  await chain.step();
  assert.equal(launcher.launches[0].model, 'grok-4', 'repo bucket seeds first spawn');

  const submitted = await chain.setModelEffort({ model: null, effort: '' });
  assert.equal(submitted.ok, true);
  assert.deepEqual(config.readModelEffort('grok'), { model: null, effort: null });

  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);
  await chain.step();
  assert.equal(launcher.launches[1].model, null, 'cleared subsequent omits model flag');
  assert.equal(launcher.launches[1].effort, null);
});

test('setModelEffort supersedes startup flags for subsequent spawns', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const config = makeModelEffortConfig();
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    model: 'grok-3.5',
    effort: 'high',
    modeConfig: config,
  });

  await chain.step();
  assert.equal(launcher.launches[0].model, 'grok-3.5');

  await chain.setModelEffort({ model: 'grok-4', effort: 'max' });
  tracker.setCompletion('01-first.md', true);
  launcher.markExited(chain.slot.pid);
  await chain.step();
  assert.equal(launcher.launches[1].model, 'grok-4');
  assert.equal(launcher.launches[1].effort, 'max');
});

test('setModelEffort without modeConfig is rejected (must write repo)', async () => {
  const only = candidate('01-need-config.md');
  const { chain } = makeChain({ candidates: [only] }); // no modeConfig port
  await chain.step();
  const submitted = await chain.setModelEffort({ model: 'grok-4' });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.reason, 'no-model-config');
  assert.equal(chain.model, null);
});

test('live worker cannot hot-switch contract model/effort via setModelEffort', async () => {
  const only = candidate('01-pinned-me.md');
  const config = makeModelEffortConfig();
  const { launcher, chain } = makeChain({
    candidates: [only],
    model: 'grok-3.5',
    modeConfig: config,
  });

  await chain.step();
  assert.equal(chain.slot.model, 'grok-3.5');

  await chain.setModelEffort({ model: 'grok-4', effort: 'max' });
  const again = await chain.step();
  assert.equal(again.spawned, false);
  assert.equal(chain.slot.model, 'grok-3.5', 'pinned slot contract unchanged');
  assert.equal(chain.slot.effort, null, 'pinned slot effort unchanged');
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.launches[0].model, 'grok-3.5');
});

test('resume keeps the spawn-pinned model/effort contract', async () => {
  const only = candidate('01-resume-pinned.md');
  const config = makeModelEffortConfig();
  const { launcher, chain } = makeChain({
    candidates: [only],
    model: 'grok-3.5',
    effort: 'high',
    launcherOptions: { sessionId: 'sess-me-1' },
    modeConfig: config,
  });

  await chain.step();
  assert.equal(chain.slot.model, 'grok-3.5');

  launcher.markExited(chain.slot.pid); // dead + not closed → needs-resume
  const resumed = await chain.resume();
  assert.equal(resumed.ok, true);
  const resumeLaunch = launcher.launches[1];
  assert.equal(resumeLaunch.kind, 'resume');
  assert.equal(resumeLaunch.model, 'grok-3.5');
  assert.equal(resumeLaunch.effort, 'high');
});
