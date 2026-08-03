import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLocalMarkdownTracker } from '../scripts/local-md-tracker.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = path.join(skillRoot, 'fixtures');

function trackerFor(fixtureName) {
  const projectRoot = path.join(fixturesRoot, fixtureName);
  return createLocalMarkdownTracker({
    projectRoot,
    feature: 'demo',
  });
}

test('local-md empty frontier fixture: no auto candidates and nothing recommended', async () => {
  const tracker = trackerFor('empty-frontier');
  const candidates = await tracker.listAutoCandidates();
  const next = await tracker.recommendNext();
  const closed = await tracker.getCompletion('01-already-done.md');

  assert.deepEqual(candidates.map((c) => c.id), []);
  assert.equal(next, null);
  assert.equal(closed.closed, true);
});

test('local-md single-ready fixture: recommends the only ready impl', async () => {
  const tracker = trackerFor('single-ready');
  const candidates = await tracker.listAutoCandidates();
  const next = await tracker.recommendNext();
  const open = await tracker.getCompletion('02-do-work.md');

  assert.deepEqual(candidates.map((c) => c.id), ['02-do-work.md']);
  assert.equal(next?.id, '02-do-work.md');
  assert.equal(next?.number, '02');
  assert.equal(open.closed, false);
});

test('local-md mixed board: Wayfinder, blocked, and closed are not auto-next', async () => {
  const tracker = trackerFor('mixed-board');
  const candidates = await tracker.listAutoCandidates();
  const next = await tracker.recommendNext();
  const ids = candidates.map((c) => c.id);

  assert.deepEqual(ids, ['03-ready-impl.md']);
  assert.equal(next?.id, '03-ready-impl.md');
  assert.ok(!ids.includes('01-wayfinder-research.md'));
  assert.ok(!ids.includes('02-closed-impl.md'));
  assert.ok(!ids.includes('04-blocked-impl.md'));
});
