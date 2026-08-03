import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueMark,
  listExecutableIssueIds,
  renderDependencyGraph,
  shortIssueLabel,
  statusLabelZh,
} from '../scripts/dependency-graph.mjs';

test('shortIssueLabel uses leading number', () => {
  assert.equal(shortIssueLabel('01-pure-go-gateway-zstd-unpack.md'), '01');
  assert.equal(shortIssueLabel('12-foo.md'), '12');
});

test('listExecutableIssueIds: only unblocked open ready tickets', () => {
  const issues = [
    { id: '01-a.md', closed: false, blockedBy: [], status: 'ready-for-agent' },
    { id: '02-b.md', closed: false, blockedBy: ['01-a.md'], status: 'ready-for-agent' },
    { id: '03-c.md', closed: true, blockedBy: [], status: 'ready-for-agent' },
  ];
  assert.deepEqual(listExecutableIssueIds(issues), ['01-a.md']);
  issues[0].closed = true;
  assert.deepEqual(listExecutableIssueIds(issues), ['02-b.md']);
});

test('issueMark: closed / slot / executable / blocked', () => {
  assert.equal(issueMark({ closed: true, id: '01.md' }), '✓');
  assert.equal(issueMark({ closed: false, id: '01.md', slotIssueId: '01.md' }), '▶');
  assert.equal(issueMark({
    closed: false,
    id: '01.md',
    executableIds: ['01.md'],
  }), '★');
  assert.equal(issueMark({ closed: false, id: '02.md' }), '·');
});

test('renderDependencyGraph linear chain with marks', () => {
  const issues = [
    { id: '01-a.md', closed: false, blockedBy: [], unlocks: ['02-b.md'], status: 'ready-for-agent' },
    { id: '02-b.md', closed: false, blockedBy: ['01-a.md'], unlocks: ['03-c.md'], status: 'ready-for-agent' },
    { id: '03-c.md', closed: false, blockedBy: ['02-b.md'], unlocks: [], status: 'ready-for-agent' },
  ];
  const { lines, executable } = renderDependencyGraph({
    issues,
    slotIssueId: '01-a.md',
  });
  const joined = lines.join('\n');
  assert.match(joined, /▶01/);
  assert.match(joined, /·02/);
  assert.match(joined, /·03/);
  assert.match(joined, /──►/);
  assert.deepEqual(executable.map((e) => e.id), ['01-a.md']);
});

test('renderDependencyGraph join shows multi-parent edge', () => {
  const issues = [
    { id: '01-a.md', closed: true, blockedBy: [], status: 'ready-for-agent' },
    { id: '02-b.md', closed: false, blockedBy: [], status: 'ready-for-agent' },
    {
      id: '03-c.md',
      closed: false,
      blockedBy: ['01-a.md', '02-b.md'],
      status: 'ready-for-agent',
    },
  ];
  const { lines, executable, warnings } = renderDependencyGraph({ issues });
  const joined = lines.join('\n');
  assert.match(joined, /汇合|──►/);
  assert.ok(executable.some((e) => e.id === '02-b.md'));
  assert.equal(warnings.length, 0);
});

test('renderDependencyGraph warns on missing upstream', () => {
  const issues = [
    { id: '01-a.md', closed: false, blockedBy: ['99-missing.md'], status: 'ready-for-agent' },
  ];
  const { warnings } = renderDependencyGraph({ issues });
  assert.ok(warnings.some((w) => /99-missing/.test(w)));
});

test('statusLabelZh covers soft-stuck', () => {
  assert.match(statusLabelZh('soft-stuck'), /软卡住/);
  assert.equal(statusLabelZh('idle'), '空闲');
});
