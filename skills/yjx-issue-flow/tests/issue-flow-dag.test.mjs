import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDagFrontier } from '../scripts/issue-flow-dag.mjs';

test('computeDagFrontier computes ready, blocked, terminal, parent wait and cycle edges', () => {
  const graph = computeDagFrontier({
    issues: [
      { id: '1', status: 'resolved', blockedBy: [] },
      { id: '2', status: 'ready-for-agent', blockedBy: ['1'] },
      { id: '3', status: 'ready-for-agent', blockedBy: ['2'], parentId: '4' },
      { id: '4', status: 'ready-for-agent', blockedBy: [] },
      { id: '5', status: 'claimed', blockedBy: ['1'] },
    ],
  });
  assert.deepEqual(graph.readyFrontier.map((i) => i.id), ['2']);
  assert.deepEqual(graph.claimed.map((i) => i.id), ['5']);
  assert.deepEqual(graph.blocked.map((i) => i.id), ['3', '4']);

  const unlocked = computeDagFrontier({
    issues: [
      { id: '1', status: 'resolved', blockedBy: [] },
      { id: '2', status: 'ready-for-agent', blockedBy: ['1'] },
      { id: '3', status: 'ready-for-agent', blockedBy: ['2'], parentId: '4' },
      { id: '4', status: 'ready-for-agent', blockedBy: [] },
    ],
    markDone: ['2'],
  });
  assert.deepEqual(unlocked.readyFrontier.map((i) => i.id), ['3']);
});

test('computeDagFrontier detects dependency cycles instead of hanging', () => {
  const graph = computeDagFrontier({
    issues: [
      { id: 'A', status: 'ready-for-agent', blockedBy: ['B'] },
      { id: 'B', status: 'ready-for-agent', blockedBy: ['A'] },
    ],
  });
  assert.equal(graph.cycles.length, 1);
  assert.equal(graph.readyFrontier.length, 0);
  assert.equal(graph.blocked.every((item) => item.inCycle), true);
});
