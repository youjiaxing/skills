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

test('empty frontier: Chain Run spawns nothing and becomes idle', async () => {
  const tracker = createFakeTracker({ candidates: [] });
  const launcher = createFakeLauncher();
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
  });

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
  const tracker = createFakeTracker({ candidates: [only] });
  const launcher = createFakeLauncher({ pid: 4242, sessionId: 'sess-1' });
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
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
