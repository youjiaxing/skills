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
  assert.match(launch.initialPrompt, /\/rename\s+demo\/05-worker-launch-and-title-contract/);
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

test('Closed without exit and without force-advance does not spawn next', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  tracker.setCompletion('01-first.md', true);
  assert.equal(launcher.isAlive(chain.slot.pid), true);

  const result = await chain.step();
  assert.equal(result.spawned, false);
  assert.equal(launcher.launches.length, 1);
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

test('Closed without exit is observable as awaiting-worker-exit and auto path still blocks next', async () => {
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
  });

  await chain.step();
  tracker.setCompletion('01-first.md', true);

  const result = await chain.step();

  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'awaiting-worker-exit');
  assert.equal(chain.status, 'awaiting-worker-exit');
  assert.equal(launcher.launches.length, 1);
  assert.equal(launcher.isAlive(chain.slot.pid), true);
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
  if (resumeLaunch.initialPrompt) {
    assert.doesNotMatch(resumeLaunch.initialPrompt, /\/implement\b/);
    assert.doesNotMatch(resumeLaunch.initialPrompt, /\/wayfinder\b/);
  }
  assert.equal(chain.status, 'soft-stuck');
  assert.equal(chain.slot?.pid, 5001);
  assert.equal(chain.slot?.sessionId, 'sess-resume-42');
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
