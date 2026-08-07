import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueMark,
  listDirectDownstream,
  listDirectUpstream,
  listExecutableIssueIds,
  renderDependencyGraph,
  renderFocusNeighborhood,
  resolveFocusIssueId,
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

test('listExecutableIssueIds: includes open wayfinder / grilling; excludes human triage', () => {
  const issues = [
    {
      id: '01-grill.md',
      closed: false,
      blockedBy: [],
      status: 'open',
      type: 'grilling',
      entryClass: 'wayfinder',
    },
    {
      id: '02-human.md',
      closed: false,
      blockedBy: [],
      status: 'ready-for-human',
      entryClass: 'human',
    },
    {
      id: '03-blocked-grill.md',
      closed: false,
      blockedBy: ['01-grill.md'],
      status: 'open',
      type: 'grilling',
      entryClass: 'wayfinder',
    },
    {
      id: '04-impl.md',
      closed: false,
      blockedBy: [],
      status: 'ready-for-agent',
    },
  ];
  assert.deepEqual(listExecutableIssueIds(issues), ['01-grill.md', '04-impl.md']);
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

// 20260805-1244 / 03 — edge status labels must stay operator-distinguishable.
test('statusLabelZh distinguishes awaiting-worker-exit and needs-resume', () => {
  assert.match(statusLabelZh('awaiting-worker-exit'), /等待.*退出|Worker.*退出/);
  assert.match(statusLabelZh('needs-resume'), /恢复|resume/i);
  assert.notEqual(
    statusLabelZh('awaiting-worker-exit'),
    statusLabelZh('needs-resume'),
  );
});

// --- 20260807-fullscreen-tui-ux-impl / 04: focus neighborhood projection ---

test('listDirectUpstream/Downstream: only immediate neighbors', () => {
  const issues = [
    { id: '01-a.md', closed: true, blockedBy: [] },
    { id: '02-b.md', closed: false, blockedBy: ['01-a.md'] },
    { id: '03-c.md', closed: false, blockedBy: ['02-b.md'] },
    { id: '04-d.md', closed: false, blockedBy: ['01-a.md', '02-b.md'] },
  ];
  assert.deepEqual(listDirectUpstream(issues, '02-b.md'), ['01-a.md']);
  assert.deepEqual(listDirectDownstream(issues, '02-b.md'), ['03-c.md', '04-d.md']);
  // Not transitive: focus 02 does not include 04 as upstream.
  assert.deepEqual(listDirectUpstream(issues, '03-c.md'), ['02-b.md']);
  assert.equal(listDirectUpstream(issues, '01-a.md').length, 0);
});

test('resolveFocusIssueId: selected > slot > default > first board', () => {
  const issues = [
    { id: '01-a.md', closed: true, blockedBy: [] },
    { id: '02-b.md', closed: false, blockedBy: [] },
    { id: '03-c.md', closed: false, blockedBy: ['02-b.md'] },
  ];
  assert.equal(
    resolveFocusIssueId(issues, {
      selectedIssueId: '03-c.md',
      slotIssueId: '02-b.md',
      defaultIssueId: '02-b.md',
    }),
    '03-c.md',
  );
  assert.equal(
    resolveFocusIssueId(issues, {
      selectedIssueId: null,
      slotIssueId: '02-b.md',
      defaultIssueId: '02-b.md',
    }),
    '02-b.md',
  );
  assert.equal(
    resolveFocusIssueId(issues, {
      selectedIssueId: null,
      slotIssueId: null,
      defaultIssueId: '02-b.md',
    }),
    '02-b.md',
  );
  assert.equal(
    resolveFocusIssueId(issues, {
      selectedIssueId: null,
      slotIssueId: null,
      defaultIssueId: null,
    }),
    '01-a.md',
  );
});

test('renderFocusNeighborhood: direct up/down only; +N fold; read-only clues', () => {
  const issues = [
    { id: '01-a.md', title: 'A', closed: true, blockedBy: [] },
    { id: '02-b.md', title: 'B', closed: false, blockedBy: ['01-a.md'] },
    { id: '03-c.md', title: 'C', closed: false, blockedBy: ['02-b.md'] },
  ];
  const { lines } = renderFocusNeighborhood({
    issues,
    focusId: '02-b.md',
    slotIssueId: null,
    maxPerSide: 5,
  });
  const text = lines.join('\n');
  assert.match(text, /焦点邻域|邻域/);
  assert.match(text, /只读|直接上下游|非全板/);
  assert.match(text, /02-b\.md|焦点/);
  assert.match(text, /上游/);
  assert.match(text, /01-a\.md|01/);
  assert.match(text, /下游/);
  assert.match(text, /03-c\.md|03/);
  assert.match(text, /──►/);

  // Collapse when many direct neighbors.
  const hub = {
    id: 'hub.md',
    title: 'hub',
    closed: false,
    blockedBy: ['u1.md', 'u2.md', 'u3.md', 'u4.md', 'u5.md', 'u6.md'],
  };
  const many = [
    hub,
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
      id: `u${n}.md`,
      title: `u${n}`,
      closed: true,
      blockedBy: [],
    })),
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
      id: `d${n}.md`,
      title: `d${n}`,
      closed: false,
      blockedBy: ['hub.md'],
    })),
  ];
  const folded = renderFocusNeighborhood({
    issues: many,
    focusId: 'hub.md',
    maxPerSide: 3,
  }).lines.join('\n');
  assert.match(folded, /\+\d+/);
});
