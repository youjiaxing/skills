import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatIssueListRow,
  formatLinearDependencyLines,
  issueBoardStatusLabelZh,
  issueMark,
  issueTypeLabel,
  listDirectDownstream,
  listDirectUpstream,
  listExecutableIssueIds,
  renderDependencyGraph,
  renderFocusNeighborhood,
  resolveFocusIssueId,
  resolveNeighborhoodLayout,
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

test('formatLinearDependencyLines: short stays inline; long goes vertical', () => {
  const short = formatLinearDependencyLines(['★01', '·02', '·03'], {
    maxLineWidth: 72,
    maxInlineNodes: 4,
  });
  assert.equal(short.length, 1);
  assert.match(short[0], /★01 ──► ·02 ──► ·03/);

  const longTokens = ['★01[impl]可实施', '·02[impl]阻塞', '·03[impl]阻塞', '·04[impl]阻塞', '·05[impl]阻塞'];
  const long = formatLinearDependencyLines(longTokens, {
    maxLineWidth: 72,
    maxInlineNodes: 3,
  });
  assert.ok(long.length >= longTokens.length, `expected vertical chain, got ${JSON.stringify(long)}`);
  assert.match(long[0], /★01\[impl\]可实施/);
  assert.match(long[1], /^ {2}──► /);
  assert.doesNotMatch(long.join('\n'), /★01.*──► ·02.*──► ·03.*──► ·04.*──► ·05/);
});

test('renderDependencyGraph dense long linear chain is not one mega-row', () => {
  const issues = [];
  for (let i = 1; i <= 6; i += 1) {
    const id = `${String(i).padStart(2, '0')}-x.md`;
    issues.push({
      id,
      title: `票${i}`,
      closed: i === 1,
      blockedBy: i === 1 ? [] : [`${String(i - 1).padStart(2, '0')}-x.md`],
      type: 'impl',
      status: i === 1 ? 'resolved' : 'ready-for-agent',
    });
  }
  const { lines } = renderDependencyGraph({
    issues,
    denseNodes: true,
    maxLineWidth: 72,
    maxInlineNodes: 3,
  });
  assert.ok(lines.length >= 4, `long dense chain should wrap vertically, got ${JSON.stringify(lines)}`);
  const mega = lines.find((line) => (line.match(/──►/g) || []).length >= 4);
  assert.equal(mega, undefined, `should not keep one mega-row: ${mega}`);
  assert.match(lines.join('\n'), /──►/);
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
    { id: '01-a.md', title: 'A', closed: true, blockedBy: [], type: 'impl' },
    { id: '02-b.md', title: 'B', closed: false, blockedBy: ['01-a.md'], type: 'impl', status: 'ready-for-agent' },
    { id: '03-c.md', title: 'C', closed: false, blockedBy: ['02-b.md'], type: 'impl' },
  ];
  const { lines, layout, degraded } = renderFocusNeighborhood({
    issues,
    focusId: '02-b.md',
    slotIssueId: null,
    maxPerSide: 5,
  });
  const text = lines.join('\n');
  assert.equal(layout, 'edges');
  assert.equal(degraded, false);
  assert.match(text, /焦点邻域|邻域/);
  // Short chrome title (detail parentheticals dropped for density).
  assert.match(text, /焦点邻域/);
  assert.match(text, /02-b\.md|焦点/);
  assert.match(text, /上游/);
  assert.match(text, /01-a\.md|01/);
  assert.match(text, /下游/);
  assert.match(text, /03-c\.md|03/);
  // Default completion shape is multi-line true edges, not a single clue chain.
  assert.match(text, /├─|└─|│|▼|──►/);
  assert.doesNotMatch(text, /已降级/);

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

// --- 20260807-1618 char-grid parity / 01: dense list row + true neighborhood ---

test('issueTypeLabel / issueBoardStatusLabelZh / formatIssueListRow dense columns', () => {
  assert.equal(issueTypeLabel({ type: 'grilling' }), 'grilling');
  assert.equal(issueTypeLabel({ entryClass: 'wayfinder' }), 'wayfinder');
  assert.equal(issueTypeLabel({ entryClass: 'human' }), 'human');
  assert.equal(issueTypeLabel({ id: '01-x.md' }), 'impl');

  const ready = {
    id: '02-ready.md',
    title: '可执行票标题很长需要截断ABCDEFGHIJKLMNOP',
    closed: false,
    blockedBy: [],
    status: 'ready-for-agent',
    type: 'impl',
  };
  const closed = {
    id: '01-done.md',
    title: '已完成票',
    closed: true,
    blockedBy: [],
    type: 'research',
  };
  const blocked = {
    id: '03-blocked.md',
    title: '阻塞票',
    closed: false,
    blockedBy: ['02-ready.md'],
    type: 'impl',
  };
  const human = {
    id: '04-human.md',
    title: '人工票',
    closed: false,
    blockedBy: [],
    status: 'ready-for-human',
    entryClass: 'human',
  };

  assert.equal(issueBoardStatusLabelZh(ready), '可实施');
  assert.equal(issueBoardStatusLabelZh(closed), '已完成');
  assert.equal(issueBoardStatusLabelZh(blocked), '阻塞');
  assert.equal(issueBoardStatusLabelZh(human), '待人工');

  const row = formatIssueListRow(ready, {
    mark: '★',
    titleMax: 12,
    suffix: '◀选中',
  });
  // mark + id + [type] + status display + truncated title + role mark
  assert.match(row, /^★ 02-ready\.md \[impl\] 可实施 /);
  assert.match(row, /可执行票/);
  assert.match(row, /…|◀选中/);
  assert.match(row, /◀选中/);
  assert.ok(row.includes('…') || Array.from(ready.title).length <= 12);
});

test('resolveNeighborhoodLayout: tall → edges; short → compact', () => {
  assert.equal(resolveNeighborhoodLayout(28), 'edges');
  assert.equal(resolveNeighborhoodLayout(null), 'edges');
  assert.equal(resolveNeighborhoodLayout(12), 'compact');
  assert.equal(resolveNeighborhoodLayout(16), 'compact');
  assert.equal(resolveNeighborhoodLayout(21), 'compact');
  assert.equal(resolveNeighborhoodLayout(22), 'edges');
});

test('renderFocusNeighborhood edges vs compact+已降级', () => {
  const issues = [
    { id: '01-a.md', title: '上游A', closed: true, blockedBy: [], type: 'research' },
    {
      id: '02-b.md',
      title: '焦点B',
      closed: false,
      blockedBy: ['01-a.md'],
      type: 'impl',
      status: 'ready-for-agent',
    },
    { id: '03-c.md', title: '下游C', closed: false, blockedBy: ['02-b.md'], type: 'impl' },
  ];

  const edges = renderFocusNeighborhood({
    issues,
    focusId: '02-b.md',
    layout: 'edges',
  });
  const edgesText = edges.lines.join('\n');
  assert.equal(edges.layout, 'edges');
  assert.equal(edges.degraded, false);
  // Multi-line true edges: section headers + column-aligned tree branches.
  assert.match(edgesText, /上游/);
  assert.match(edgesText, /下游/);
  assert.match(edgesText, /焦点/);
  assert.match(edgesText, /├─|└─/);
  assert.match(edgesText, /01-a\.md/);
  assert.match(edgesText, /\[research\].*已完成|已完成.*上游A|上游A/);
  assert.match(edgesText, /02-b\.md/);
  assert.match(edgesText, /◀焦点/);
  assert.match(edgesText, /03-c\.md/);
  // Body rows share a common indent gutter (4 spaces + 2-col marker).
  const body = edges.lines.filter((line) => /├─|└─|▶/.test(line));
  assert.ok(body.length >= 2, `expected aligned body rows, got ${body.join(' | ')}`);
  for (const line of body) {
    assert.match(line, /^ {4}(├─|└─|▶ )/, `misaligned neighborhood row: ${JSON.stringify(line)}`);
  }
  // Roomy terminals (>=30 rows) insert section gaps; mid-height stays tight.
  const roomy = renderFocusNeighborhood({
    issues,
    focusId: '02-b.md',
    layout: 'edges',
    terminalRows: 32,
  });
  const roomyText = roomy.lines.join('\n');
  assert.match(roomyText, /上游[\s\S]*\n\n  焦点/);
  assert.match(roomyText, /焦点[\s\S]*\n\n  下游/);
  // Must not be the single-line clue completion shape alone.
  assert.ok(
    edges.lines.length >= 4,
    `edges layout should span multiple lines, got ${edges.lines.length}`,
  );
  assert.doesNotMatch(edgesText, /已降级/);

  const compact = renderFocusNeighborhood({
    issues,
    focusId: '02-b.md',
    layout: 'compact',
  });
  const compactText = compact.lines.join('\n');
  assert.equal(compact.layout, 'compact');
  assert.equal(compact.degraded, true);
  assert.match(compactText, /已降级/);
  assert.match(compactText, /──►/);
  assert.match(compactText, /上游|下游/);
});

// --- 20260807-1618 char-grid parity / 02: dense global graph tokens ---

test('renderDependencyGraph denseNodes: mark + id + type + status (scannable, not bare dots)', () => {
  const issues = [
    {
      id: '01-a.md',
      title: '盘点',
      closed: true,
      blockedBy: [],
      type: 'research',
      status: 'resolved',
    },
    {
      id: '02-b.md',
      title: '可开',
      closed: false,
      blockedBy: ['01-a.md'],
      type: 'impl',
      status: 'ready-for-agent',
    },
    {
      id: '03-c.md',
      title: '堵住',
      closed: false,
      blockedBy: ['02-b.md'],
      type: 'impl',
      status: 'ready-for-agent',
    },
  ];
  const compact = renderDependencyGraph({ issues });
  assert.match(compact.lines.join('\n'), /✓01/);
  assert.doesNotMatch(compact.lines.join('\n'), /\[research\].*已完成|已完成.*\[research\]/);

  const dense = renderDependencyGraph({ issues, denseNodes: true });
  const text = dense.lines.join('\n');
  assert.match(text, /──►/);
  assert.match(text, /✓01.*\[research\].*已完成|✓01\[research\]已完成/);
  assert.match(text, /★02.*\[impl\].*可实施|★02\[impl\]可实施/);
  assert.match(text, /·03.*\[impl\].*阻塞|·03\[impl\]阻塞/);
  // Still no gratuitous blank lines inside the graph body.
  assert.ok(!dense.lines.some((l) => l.trim() === ''), `dense graph has empty line: ${JSON.stringify(dense.lines)}`);
});
