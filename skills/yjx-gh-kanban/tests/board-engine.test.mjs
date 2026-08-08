import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBoard,
  classify,
  isSpecIssue,
  isWayfinderIssue,
  parseReadyLabelFromTriageDoc,
  priorityKey,
  renderAgent,
  renderHuman,
  renderReadyOnly,
  selectViewNodes,
} from '../scripts/board-engine.mjs';

const SPEC_BODY = [
  '## Problem Statement',
  'Current behavior is scattered.',
  '## Solution',
  'Create a focused module.',
  '## User Stories',
  'As a maintainer, I want focused slices.',
].join('\n');

const TICKET_BODY = [
  '## Parent',
  'Parent: #1',
  '## What to build',
  'Align the success result contract.',
  '## Acceptance criteria',
  '- [ ] The contract is aligned.',
  '## Blocked by',
  'None - can start immediately',
].join('\n');

function issue(number, title, {
  body = TICKET_BODY,
  labels = ['ready-for-agent'],
  state = 'OPEN',
  assignees = [],
  url,
} = {}) {
  return {
    number,
    title,
    state,
    url: url ?? `https://github.com/example/repo/issues/${number}`,
    labels,
    body,
    updatedAt: '2026-07-01T00:00:00Z',
    assignees,
  };
}

function rel(parent = null, blockedBy = []) {
  return {
    parent,
    blockedBy: blockedBy.map((item) => (
      typeof item === 'number'
        ? { number: item, state: 'OPEN' }
        : { number: item.number, state: item.state ?? 'OPEN' }
    )),
  };
}

test('SPEC requires exact H2 headings; lookalikes are not specs', () => {
  assert.equal(isSpecIssue({ body: SPEC_BODY }), true);
  assert.equal(
    isSpecIssue({ body: 'Problem Statement / Solution / User Stories are discussed inline.' }),
    false,
  );
  assert.equal(isSpecIssue({ body: SPEC_BODY.replace('## Solution', '## solution') }), false);
  assert.equal(isSpecIssue({ body: SPEC_BODY.replace('## Solution', '##\nSolution') }), false);
});

test('wayfinder labels are detected', () => {
  assert.equal(isWayfinderIssue({ labels: ['ready-for-agent', 'wayfinder:research'] }), true);
  assert.equal(isWayfinderIssue({ labels: ['ready-for-agent'] }), false);
});

test('parseReadyLabelFromTriageDoc reads table mapping', () => {
  const markdown = [
    '| role | label |',
    '| --- | --- |',
    '| `ready-for-agent` | `afk-ready` | 可交给 agent |',
  ].join('\n');
  assert.equal(parseReadyLabelFromTriageDoc(markdown), 'afk-ready');
  assert.equal(parseReadyLabelFromTriageDoc(''), 'ready-for-agent');
});

test('spec is excluded from READY/next; native parent is exposed', () => {
  const issues = {
    1: issue(1, '深化 Health Record mutation module', { body: SPEC_BODY, labels: [] }),
    7: issue(7, '对齐 mutation success result contract'),
  };
  const board = classify(issues, 'ready-for-agent', {
    7: rel(1),
  });

  assert.equal(board.summary.spec, 1);
  assert.equal(board.summary.ready, 1);
  assert.equal(board.specs[0].number, 1);
  assert.equal(board.ready[0].parent, 1);
  assert.equal(board.next.number, 7);
  assert.equal(board.next.isSpec, false);
});

test('SPEC never becomes next even if labeled ready-for-agent', () => {
  const issues = {
    1: issue(1, 'spec container', { body: SPEC_BODY, labels: ['ready-for-agent'] }),
  };
  const board = classify(issues, 'ready-for-agent', {});
  assert.equal(board.summary.ready, 0);
  assert.equal(board.summary.spec, 1);
  assert.equal(board.next, null);
});

test('wayfinder issue never enters READY/next', () => {
  const issues = {
    20: issue(20, '调研原生依赖', {
      labels: ['ready-for-agent', 'wayfinder:research'],
    }),
  };
  const board = classify(issues, 'ready-for-agent', {});
  assert.equal(board.summary.ready, 0);
  assert.equal(board.summary.otherOpen, 1);
  assert.equal(board.next, null);
});

test('markdown Blocked by body is not a machine source', () => {
  const body = TICKET_BODY.replace('None - can start immediately', '- #99');
  const issues = { 7: issue(7, '正文 blocker 不参与判断', { body }) };
  const board = classify(issues, 'ready-for-agent', { 7: rel() });
  assert.equal(board.summary.ready, 1);
  assert.deepEqual(board.ready[0].blockedBy, []);
});

test('open native dependency blocks ticket; closed dependency unblocks', () => {
  const blockedBoard = classify(
    {
      3: issue(3, '建立基础能力', { labels: [] }),
      7: issue(7, '使用基础能力'),
    },
    'ready-for-agent',
    { 7: rel(1, [3]) },
  );
  assert.equal(blockedBoard.summary.blocked, 1);
  assert.deepEqual(blockedBoard.blocked[0].blockedBy, [3]);
  assert.deepEqual(blockedBoard.blocked[0].openBlockers, [3]);
  assert.deepEqual(blockedBoard.otherOpen[0].unlocks, [7]);
  assert.equal(blockedBoard.next, null);

  const readyBoard = classify(
    { 7: issue(7, '依赖已完成') },
    'ready-for-agent',
    { 7: rel(null, [{ number: 3, state: 'CLOSED' }]) },
  );
  assert.equal(readyBoard.summary.ready, 1);
  assert.deepEqual(readyBoard.ready[0].blockedBy, [3]);
  assert.deepEqual(readyBoard.ready[0].openBlockers, []);
  assert.equal(readyBoard.next.number, 7);
});

test('ready ticket without parent is valid', () => {
  const board = classify(
    { 7: issue(7, '独立小修复') },
    'ready-for-agent',
    { 7: rel() },
  );
  assert.equal(board.ready[0].parent, null);
  assert.equal(board.next.number, 7);
});

test('missing native relations for ready candidate fails closed (no usable next)', () => {
  assert.throws(
    () => classify({ 7: issue(7, '关系读取缺失') }, 'ready-for-agent', {}),
    /not loaded for #7/,
  );
});

test('truncated blockedBy payload fails closed', () => {
  assert.throws(
    () => classify(
      { 7: issue(7, '依赖被截断') },
      'ready-for-agent',
      {
        7: {
          parent: null,
          blockedBy: {
            nodes: [{ number: 3, state: 'OPEN' }],
            totalCount: 2,
          },
        },
      },
    ),
    /truncated blocked-by/,
  );
});

test('next priority: critical → infra → tracer → other, then number', () => {
  const issues = {
    10: issue(10, '普通功能'),
    11: issue(11, '端到端闭环 tracer'),
    12: issue(12, '补齐 CI 构建验证'),
    13: issue(13, 'critical crash 严重崩溃'),
  };
  const relations = {
    10: rel(),
    11: rel(),
    12: rel(),
    13: rel(),
  };
  const board = classify(issues, 'ready-for-agent', relations);
  assert.deepEqual(
    board.ready.map((entry) => entry.number),
    [13, 12, 11, 10],
  );
  assert.equal(board.next.number, 13);
  assert.ok(priorityKey(issues[13])[0] < priorityKey(issues[12])[0]);
});

test('json shape exposes next/ready and key entry fields', () => {
  const issues = {
    1: issue(1, 'spec', { body: SPEC_BODY, labels: [] }),
    7: issue(7, 'child ticket'),
  };
  const { board, json } = buildBoard({
    issues,
    relations: { 7: rel(1) },
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.next.number, 7);
  assert.equal(parsed.ready.length, 1);
  assert.equal(parsed.ready[0].ref, '#7');
  assert.equal(parsed.ready[0].parent, 1);
  assert.deepEqual(parsed.ready[0].blockedBy, []);
  assert.deepEqual(parsed.ready[0].openBlockers, []);
  assert.ok(Array.isArray(parsed.ready[0].labels));
  assert.equal(parsed.summary.readyLabel, 'ready-for-agent');
  assert.equal(board.specs[0].isSpec, true);
});

test('agent output includes READY and next=', () => {
  const board = classify(
    { 7: issue(7, '独立票') },
    'ready-for-agent',
    { 7: rel() },
  );
  const text = renderAgent(board);
  assert.match(text, /^ready=1 blocked=0 spec=0 other_open=0$/m);
  assert.match(text, /^next=#7$/m);
  assert.match(text, /^READY$/m);
  assert.match(text, /#7 独立票/);

  const empty = classify({}, 'ready-for-agent', {});
  assert.match(renderAgent(empty), /^next=none$/m);
});

test('human render has LEGEND, dependency tree, WARNINGS area, NOW', () => {
  const issues = {
    1: issue(1, '规格容器', { body: SPEC_BODY, labels: [] }),
    3: issue(3, '基础能力', { labels: [] }),
    7: issue(7, '依赖基础能力'),
    8: issue(8, '可直接开干'),
  };
  const relations = {
    7: rel(1, [3]),
    8: rel(1),
  };
  const text = renderHuman(issues, relations, { readyLabel: 'ready-for-agent' });
  assert.match(text, /^LEGEND /m);
  assert.match(text, /^DEPENDENCY TREE$/m);
  assert.match(text, /^WARNINGS$/m);
  assert.match(text, /\[spec\].*规格容器/);
  assert.match(text, /├─|└─/);
  assert.match(text, /7 \[impl\] 依赖基础能力 <- #3/);
  assert.match(text, /NOW  可新增并行实施：1 \| 进行中：0/);
  assert.match(text, /可新增并行实施/);
  assert.match(text, /\/rename gh\/#8-/);
  assert.match(text, /gh issue view 8/);
  assert.match(text, /进行中（assignee 近似/);
});

test('dependency tree mounts on native parent; multi-blockers listed fully; each issue once', () => {
  const issues = {
    1: issue(1, 'spec', { body: SPEC_BODY, labels: [] }),
    2: issue(2, 'blocker-a', { labels: [] }),
    3: issue(3, 'blocker-b', { labels: [] }),
    9: issue(9, 'multi-blocked child'),
  };
  const relations = {
    9: rel(1, [2, 3]),
  };
  const text = renderHuman(issues, relations);
  // Child hangs under parent #1, not under a blocker root.
  const treeSection = text.split('DEPENDENCY TREE\n')[1].split('\n\n')[0] ?? text.split('DEPENDENCY TREE\n')[1].split('\nNOW')[0];
  assert.match(treeSection, /1 \[spec\]/);
  assert.match(treeSection, /9 \[impl\] multi-blocked child <- #2, #3/);
  // Each issue number headline appears once in the tree section.
  for (const number of [1, 2, 3, 9]) {
    const hits = treeSection.match(new RegExp(`\\b${number} \\[`, 'g')) ?? [];
    assert.equal(hits.length, 1, `issue #${number} should appear once in tree, got ${hits.length}`);
  }
});

test('default whole-repo view is open issues plus closed blockers for understanding', () => {
  const issues = {
    1: issue(1, 'open ready'),
    2: issue(2, 'open other', { labels: [] }),
    3: issue(3, 'closed historical', { state: 'CLOSED', labels: [] }),
    4: issue(4, 'closed blocker', { state: 'CLOSED', labels: [] }),
  };
  const relations = {
    1: rel(null, [{ number: 4, state: 'CLOSED' }]),
  };
  const nodes = selectViewNodes(issues, relations);
  assert.ok(nodes.has(1));
  assert.ok(nodes.has(2));
  assert.ok(nodes.has(4), 'closed blocker required for understanding must be included');
  assert.equal(nodes.has(3), false, 'unrelated closed noise must stay out');
});

test('parent filter includes descendant sub-issues and blocker closure with closed nodes', () => {
  const issues = {
    10: issue(10, 'parent spec', { body: SPEC_BODY, labels: [] }),
    11: issue(11, 'child ready'),
    12: issue(12, 'grandchild blocked'),
    20: issue(20, 'external blocker open', { labels: [] }),
    21: issue(21, 'external blocker closed', { state: 'CLOSED', labels: [] }),
    99: issue(99, 'unrelated open', { labels: [] }),
  };
  const relations = {
    11: rel(10),
    12: rel(11, [20, { number: 21, state: 'CLOSED' }]),
    // external blockers may also have relations
    20: rel(),
    21: rel(),
  };
  const nodes = selectViewNodes(issues, relations, { parentFilter: 10 });
  assert.ok(nodes.has(10));
  assert.ok(nodes.has(11));
  assert.ok(nodes.has(12));
  assert.ok(nodes.has(20), 'open external blocker enters closure');
  assert.ok(nodes.has(21), 'closed external blocker enters closure');
  assert.equal(nodes.has(99), false);

  const text = renderHuman(issues, relations, { parentFilter: 10 });
  assert.match(text, /parent=#10/);
  assert.match(text, /✓ 21 \[impl\] external blocker closed|✓ 21 /);
  assert.doesNotMatch(text, /99 \[impl\] unrelated open/);
});

test('NOW in-progress uses assignee approximation and does not redefine READY', () => {
  const issues = {
    5: issue(5, 'assigned in progress', { assignees: ['alice'] }),
    6: issue(6, 'unassigned ready'),
  };
  const relations = {
    5: rel(),
    6: rel(),
  };
  const board = classify(issues, 'ready-for-agent', relations);
  // Machine READY still includes assigned tickets (compat with old board).
  assert.equal(board.summary.ready, 2);
  assert.ok(board.ready.some((entry) => entry.number === 5));

  const text = renderHuman(issues, relations);
  assert.match(text, /NOW  可新增并行实施：2 \| 进行中：1/);
  assert.match(text, /进行中（assignee 近似，非 claimed 协议；不改变 READY 契约）/);
  assert.match(text, /assignees=alice/);
  assert.match(text, /#6/);
});

test('ready-only lists implementable READY with rename and gh view hints', () => {
  const board = classify(
    { 8: issue(8, '可直接开干') },
    'ready-for-agent',
    { 8: rel() },
  );
  const text = renderReadyOnly(board);
  assert.match(text, /ready=1 next=#8/);
  assert.match(text, /○ 8 \[impl\] 可直接开干/);
  assert.match(text, /\/rename gh\/#8-/);
  assert.match(text, /gh issue view 8/);
});

test('buildBoard returns consistent human/agent/json projections', () => {
  const result = buildBoard({
    issues: {
      1: issue(1, 'spec', { body: SPEC_BODY, labels: [] }),
      7: issue(7, 'ticket'),
    },
    relations: { 7: rel(1) },
  });
  assert.equal(result.board.next.number, 7);
  assert.match(result.agent, /next=#7/);
  assert.match(result.human, /DEPENDENCY TREE/);
  assert.equal(JSON.parse(result.json).next.number, 7);
  assert.ok(result.viewNodes.has(1));
  assert.ok(result.viewNodes.has(7));
});
