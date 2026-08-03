import assert from 'node:assert/strict';
import test from 'node:test';

import { createChainRun } from '../scripts/chain-run.mjs';
import { createFakeLauncher } from '../scripts/fake-launcher.mjs';
import { createFakeTracker } from '../scripts/fake-tracker.mjs';

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
  assert.equal(chain.status, 'running');
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
  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'exit-alone-not-success');
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
