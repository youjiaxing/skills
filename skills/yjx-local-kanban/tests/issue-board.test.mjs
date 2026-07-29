import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIG_RELATIVE_PATH,
  graphPayload,
  loadConfig,
  loadGraph,
  renderReadyOnly,
  renderText,
  validateConfig,
} from '../scripts/issue-board.mjs';

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  protocol: 'matt-local-markdown+closed-v1',
  trackerRoot: '.scratch',
  completionField: 'Closed',
  statusRoles: {
    'needs-triage': 'needs-triage',
    'needs-info': 'needs-info',
    'ready-for-agent': 'ready-for-agent',
    'ready-for-human': 'ready-for-human',
    wontfix: 'wontfix',
  },
};

async function fixture(t, config = DEFAULT_CONFIG) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-local-kanban-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const feature = path.join(root, '.scratch', 'feature');
  await mkdir(path.join(feature, 'issues'), { recursive: true });
  await mkdir(path.dirname(path.join(root, CONFIG_RELATIVE_PATH)), { recursive: true });
  await writeFile(path.join(root, CONFIG_RELATIVE_PATH), `${JSON.stringify(config, null, 2)}\n`);
  return { root, feature, config: await loadConfig(root) };
}

async function writeIssue(feature, filename, {
  status = 'ready-for-agent',
  closed = 'false',
  title = filename,
  blockedBy = null,
  bold = false,
  type = null,
  inlineBlockedBy = false,
  mattNative = false,
  comments = '',
} = {}) {
  const field = (name, value) => bold ? `**${name}:** ${value}` : `${name}: ${value}`;
  const lines = [`# ${title}`, ''];
  if (mattNative) lines.push(field('What to build', 'Native implementation slice'));
  if (status !== null) lines.push(field('Status', status));
  if (closed !== null) lines.push(field('Closed', closed));
  if (type !== null) lines.push(field('Type', type));
  if (inlineBlockedBy) lines.push(field('Blocked by', blockedBy ?? 'none'));
  else if (blockedBy !== null && bold) lines.push('', field('Blocked by', blockedBy));
  else {
    lines.push('', '## Blocked by', '', blockedBy ?? 'None - can start immediately');
  }
  lines.push('', '## Comments', '', comments, '');
  await writeFile(path.join(feature, 'issues', filename), lines.join('\n'));
}

function issue(graph, id) {
  return graph.issueById.get(id);
}

test('reads plain project issue and exposes agent-ready group', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-ready.md', { title: 'Ready' });
  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.groupOf(issue(graph, '01-ready.md')), 'AGENT READY');
});

test('reads Matt bold fields and inline numbered blocker', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-foundation.md', { title: '01 — Foundation', bold: true });
  await writeIssue(work.feature, '02-slice.md', { title: '02 — Slice', bold: true, blockedBy: '01 — Foundation' });
  const graph = await loadGraph(work.feature, work.config);
  assert.equal(issue(graph, '02-slice.md').title, 'Slice');
  assert.deepEqual(issue(graph, '02-slice.md').blockedBy, ['01-foundation.md']);
  assert.equal(graph.groupOf(issue(graph, '02-slice.md')), 'BLOCKED');
});

test('resolves POSIX and Windows blocker paths', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-foundation.md');
  await writeIssue(work.feature, '02-posix.md', { blockedBy: '- `.scratch/feature/issues/01-foundation.md`' });
  await writeIssue(work.feature, '03-windows.md', { blockedBy: '- `.scratch\\feature\\issues\\01-foundation.md`' });
  const graph = await loadGraph(work.feature, work.config);
  assert.deepEqual(issue(graph, '02-posix.md').blockedBy, ['01-foundation.md']);
  assert.deepEqual(issue(graph, '03-windows.md').blockedBy, ['01-foundation.md']);
});

test('missing Closed fails closed instead of entering frontier', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-legacy.md', { closed: null });
  const graph = await loadGraph(work.feature, work.config);
  const legacy = issue(graph, '01-legacy.md');
  assert.equal(legacy.metadataValid, false);
  assert.deepEqual(legacy.metadataErrors, ['missing-closed']);
  assert.equal(graph.groupOf(legacy), 'OTHER / WARNINGS');
});

test('completed Wayfinder tickets hand off to native Matt implementation tickets', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '01-decision.md', {
    status: 'resolved',
    closed: null,
    type: 'grilling',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '02-native.md', {
    title: '02 — Native slice',
    bold: true,
    closed: null,
    blockedBy: 'None — can start immediately',
    inlineBlockedBy: true,
    mattNative: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  const native = issue(graph, '02-native.md');
  const decision = issue(graph, '01-decision.md');
  assert.equal(graph.workflow, 'mixed');
  assert.deepEqual(graph.issues.map((item) => item.id), ['01-decision.md', '02-native.md']);
  assert.equal(decision.workflow, 'wayfinder');
  assert.equal(graph.groupOf(decision), 'RESOLVED');
  assert.equal(native.workflow, 'implementation');
  assert.equal(native.metadataValid, true);
  assert.equal(native.closed, false);
  assert.equal(native.hasClosedField, false);
  assert.equal(native.closedImplicit, true);
  assert.equal(graph.groupOf(native), 'AGENT READY');
  const payload = graphPayload(work.feature, graph, work.root);
  assert.equal(payload.summary.missingClosed, 0);
  assert.equal(payload.summary.implicitClosed, 1);
});

test('handoff keeps Status:done tickets in the graph instead of silent drop', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '01-decision.md', {
    status: 'resolved',
    closed: null,
    type: 'grilling',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '15-skeleton.md', {
    title: '15 — Skeleton',
    bold: true,
    status: 'done',
    closed: null,
    blockedBy: 'None — can start immediately',
    inlineBlockedBy: true,
    mattNative: true,
  });
  await writeIssue(work.feature, '16-preflight.md', {
    title: '16 — Preflight',
    bold: true,
    closed: null,
    blockedBy: '15 — Skeleton',
    inlineBlockedBy: true,
    mattNative: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.workflow, 'mixed');
  assert.deepEqual(graph.issues.map((item) => item.id), ['01-decision.md', '15-skeleton.md', '16-preflight.md']);

  const skeleton = issue(graph, '15-skeleton.md');
  assert.equal(skeleton.closed, false);
  assert.equal(skeleton.metadataValid, false);
  assert.ok(skeleton.metadataErrors.includes('invalid-status'));
  assert.equal(graph.groupOf(skeleton), 'OTHER / WARNINGS');
  assert.ok(graph.warnings.some((item) => item.code === 'status-done-not-completion' && item.issue === '15-skeleton.md'));
  assert.ok(graph.warnings.some((item) => item.code === 'non-canonical-status-on-handoff' && item.issue === '15-skeleton.md'));

  const preflight = issue(graph, '16-preflight.md');
  assert.deepEqual(preflight.blockedBy, ['15-skeleton.md']);
  assert.deepEqual(graph.missingBlockersOf(preflight), []);
  assert.equal(graph.groupOf(preflight), 'BLOCKED');
  assert.equal(graph.warnings.some((item) => item.code === 'missing-blocker'), false);
});

test('implementation Status:claimed is in-progress not agent-ready', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '01-decision.md', {
    status: 'resolved',
    closed: null,
    type: 'grilling',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '15-skeleton.md', {
    title: '15 — Skeleton',
    bold: true,
    closed: 'true',
    blockedBy: 'None — can start immediately',
    inlineBlockedBy: true,
    mattNative: true,
  });
  await writeIssue(work.feature, '16-preflight.md', {
    title: '16 — Preflight',
    bold: true,
    status: 'claimed',
    closed: 'false',
    blockedBy: '15 — Skeleton',
    inlineBlockedBy: true,
    mattNative: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.workflow, 'mixed');
  const preflight = issue(graph, '16-preflight.md');
  assert.equal(preflight.claimed, true);
  assert.equal(preflight.metadataValid, true);
  assert.equal(graph.groupOf(preflight), 'CLAIMED');
  assert.equal(graph.issuesInGroup('AGENT READY').length, 0);
  assert.equal(graphPayload(work.feature, graph, work.root).summary.claimed, 1);

  const text = renderText(work.feature, graph, work.root);
  assert.match(text, /NOW  可新增并行实施：0 \| 进行中：1/);
  assert.match(text, /> 16 \[impl\] Preflight/);
  assert.equal(graph.warnings.some((item) => item.code === 'invalid-status'), false);
  assert.equal(graph.warnings.some((item) => item.code === 'non-canonical-status-on-handoff'), false);
});

test('Closed:true completes even when Status is non-canonical leftover done', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '01-decision.md', {
    status: 'resolved',
    closed: null,
    type: 'grilling',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '15-skeleton.md', {
    title: '15 — Skeleton',
    bold: true,
    status: 'done',
    closed: 'true',
    blockedBy: 'None — can start immediately',
    inlineBlockedBy: true,
    mattNative: true,
  });
  await writeIssue(work.feature, '16-preflight.md', {
    title: '16 — Preflight',
    bold: true,
    closed: null,
    blockedBy: '15 — Skeleton',
    inlineBlockedBy: true,
    mattNative: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  const skeleton = issue(graph, '15-skeleton.md');
  assert.equal(skeleton.closed, true);
  assert.equal(skeleton.metadataValid, true);
  assert.equal(graph.groupOf(skeleton), 'CLOSED');
  assert.equal(graph.groupOf(issue(graph, '16-preflight.md')), 'AGENT READY');
});

test('unfinished Wayfinder tickets coexist with implementation tickets in a mixed graph', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '01-decision.md', {
    status: 'open',
    closed: null,
    type: 'grilling',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '02-native.md', {
    bold: true,
    closed: null,
    inlineBlockedBy: true,
    mattNative: true,
  });
  await writeIssue(work.feature, '03-blocked-impl.md', {
    bold: true,
    closed: 'false',
    blockedBy: '01-decision.md',
    inlineBlockedBy: true,
    mattNative: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.workflow, 'mixed');
  assert.equal(graph.groupOf(issue(graph, '01-decision.md')), 'FRONTIER');
  assert.equal(graph.groupOf(issue(graph, '02-native.md')), 'AGENT READY');
  assert.equal(graph.groupOf(issue(graph, '03-blocked-impl.md')), 'BLOCKED');
  assert.deepEqual(graph.openBlockersOf(issue(graph, '03-blocked-impl.md')).map((item) => item.id), ['01-decision.md']);
  const text = renderText(work.feature, graph, work.root);
  assert.match(text, /workflow=mixed/);
  assert.match(text, /可新增并行实施：2/);
});

test('invalid Wayfinder type stays in mixed graph without blocking siblings', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '01-decision.md', {
    status: 'resolved',
    closed: null,
    type: 'unsupported',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '02-native.md', {
    bold: true,
    closed: null,
    inlineBlockedBy: true,
    mattNative: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.workflow, 'mixed');
  assert.equal(graph.groupOf(issue(graph, '01-decision.md')), 'OTHER / WARNINGS');
  assert.ok(issue(graph, '01-decision.md').metadataErrors.includes('invalid-type'));
  assert.equal(graph.groupOf(issue(graph, '02-native.md')), 'AGENT READY');
});

test('research Status:ready-for-agent is frontier-ready in mixed graphs', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '26-research.md', {
    title: '26 — Realenv blockers research',
    status: 'ready-for-agent',
    closed: null,
    type: 'research',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '27-impl.md', {
    title: '27 — MySQL reader',
    bold: true,
    closed: 'false',
    blockedBy: 'None — can start immediately',
    inlineBlockedBy: true,
    mattNative: true,
  });
  await writeIssue(work.feature, '28-blocked.md', {
    title: '28 — Realenv loop',
    bold: true,
    closed: 'false',
    blockedBy: '26 — Realenv blockers research',
    inlineBlockedBy: true,
    mattNative: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.workflow, 'mixed');
  assert.equal(graph.groupOf(issue(graph, '26-research.md')), 'FRONTIER');
  assert.equal(graph.groupOf(issue(graph, '27-impl.md')), 'AGENT READY');
  assert.equal(graph.groupOf(issue(graph, '28-blocked.md')), 'BLOCKED');
  const ready = renderReadyOnly(work.feature, graph, work.root);
  assert.match(ready, /26 \[research\] Realenv blockers research/);
  assert.match(ready, /\/wayfinder /);
  assert.match(ready, /27 \[impl\] MySQL reader/);
  assert.match(ready, /\/implement /);
  const text = renderText(work.feature, graph, work.root);
  assert.match(text, /○ 26 \[research\] Realenv blockers research/);
  assert.match(text, /○ 27 \[impl\] MySQL reader/);
  assert.match(text, /× 28 \[impl\] Realenv loop/);
});

test('closed ready-for-agent is accepted for Matt implement completion', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-done.md', { closed: 'true' });
  const graph = await loadGraph(work.feature, work.config);
  assert.equal(issue(graph, '01-done.md').metadataValid, true);
  assert.equal(graph.groupOf(issue(graph, '01-done.md')), 'CLOSED');
});

test('implementation Status:resolved is a supported completion alias', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-resolved-only.md', {
    status: 'resolved',
    closed: null,
  });
  await writeIssue(work.feature, '02-resolved-and-closed.md', {
    status: 'resolved',
    closed: 'true',
    blockedBy: '01-resolved-only.md',
  });
  await writeIssue(work.feature, '03-conflict.md', {
    status: 'resolved',
    closed: 'false',
  });

  const graph = await loadGraph(work.feature, work.config);

  const resolvedOnly = issue(graph, '01-resolved-only.md');
  assert.equal(resolvedOnly.closed, true);
  assert.equal(resolvedOnly.metadataValid, true);
  assert.equal(graph.groupOf(resolvedOnly), 'CLOSED');

  const resolvedAndClosed = issue(graph, '02-resolved-and-closed.md');
  assert.equal(resolvedAndClosed.closed, true);
  assert.equal(resolvedAndClosed.metadataValid, true);
  assert.equal(graph.groupOf(resolvedAndClosed), 'CLOSED');
  assert.deepEqual(graph.openBlockersOf(resolvedAndClosed), []);

  const conflict = issue(graph, '03-conflict.md');
  assert.equal(conflict.closed, false);
  assert.equal(conflict.metadataValid, false);
  assert.ok(conflict.metadataErrors.includes('conflicting-resolved-open'));
  assert.ok(graph.warnings.some((item) => item.code === 'conflicting-resolved-open' && item.issue === '03-conflict.md'));
  assert.equal(graph.warnings.some((item) => item.code === 'invalid-status' && item.issue === '01-resolved-only.md'), false);
  assert.equal(graph.warnings.some((item) => item.code === 'invalid-status' && item.issue === '02-resolved-and-closed.md'), false);
});

test('implementation Status:resolved survives wayfinder handoff without warnings', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '01-decision.md', {
    status: 'resolved',
    closed: null,
    type: 'grilling',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '15-skeleton.md', {
    title: '15 — Skeleton',
    bold: true,
    status: 'resolved',
    closed: 'true',
    blockedBy: 'None — can start immediately',
    inlineBlockedBy: true,
    mattNative: true,
  });
  await writeIssue(work.feature, '16-preflight.md', {
    title: '16 — Preflight',
    bold: true,
    closed: 'false',
    blockedBy: '15 — Skeleton',
    inlineBlockedBy: true,
    mattNative: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.workflow, 'mixed');
  assert.equal(graph.groupOf(issue(graph, '15-skeleton.md')), 'CLOSED');
  assert.equal(graph.groupOf(issue(graph, '16-preflight.md')), 'AGENT READY');
  assert.equal(graph.warnings.some((item) => item.code === 'invalid-status'), false);
  assert.equal(graph.warnings.some((item) => item.code === 'non-canonical-status-on-handoff'), false);
});

test('custom project status mapping maps back to canonical roles', async (t) => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.statusRoles['ready-for-agent'] = 'agent-ready';
  const work = await fixture(t, config);
  await writeIssue(work.feature, '01-ready.md', { status: 'agent-ready' });
  const graph = await loadGraph(work.feature, work.config);
  assert.equal(issue(graph, '01-ready.md').statusRole, 'ready-for-agent');
  assert.equal(graph.groupOf(issue(graph, '01-ready.md')), 'AGENT READY');
});

test('auto-detects Wayfinder graph and exposes its frontier with the required skill', async (t) => {
  const work = await fixture(t);
  await writeFile(path.join(work.feature, 'map.md'), '# Map\n\nLabel: wayfinder:map\n');
  await writeIssue(work.feature, '01-resolved.md', {
    title: 'Resolved decision',
    status: 'resolved',
    closed: null,
    type: 'grilling',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '02-claimed.md', {
    title: 'Claimed task',
    status: 'claimed',
    closed: null,
    type: 'task',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '03-blocked.md', {
    title: 'Blocked task',
    status: 'open',
    closed: null,
    type: 'task',
    blockedBy: '02',
    inlineBlockedBy: true,
  });
  await writeIssue(work.feature, '04-frontier.md', {
    title: 'Frontier task',
    status: 'open',
    closed: null,
    type: 'task',
    blockedBy: '01',
    inlineBlockedBy: true,
  });

  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.workflow, 'wayfinder');
  assert.equal(graph.requiredSkill, '/wayfinder');
  assert.equal(graph.groupOf(issue(graph, '01-resolved.md')), 'RESOLVED');
  assert.equal(graph.groupOf(issue(graph, '02-claimed.md')), 'CLAIMED');
  assert.equal(graph.groupOf(issue(graph, '03-blocked.md')), 'BLOCKED');
  assert.equal(graph.groupOf(issue(graph, '04-frontier.md')), 'FRONTIER');

  const payload = graphPayload(work.feature, graph, work.root);
  assert.equal(payload.workflow, 'wayfinder');
  assert.equal(payload.requiredSkill, '/wayfinder');
  assert.equal(payload.issues[3].requiredSkill, '/wayfinder');
  assert.deepEqual(payload.issues[3].blockedByOpen, []);

  const text = renderText(work.feature, graph, work.root);
  assert.match(text, /required_skill=\/wayfinder/);
  assert.match(text, /^LEGEND/);
  assert.match(text, /LEGEND.*✓ 已完成.*> 已领取\/进行中.*× 被阻塞.*○ 可实施/s);
  assert.match(text, /DEPENDENCY TREE/);
  assert.match(text, /NOW  可新增并行实施：1 \| 进行中：1/);
  assert.match(text, /- ○ 04 \[task\] Frontier task\n  \/rename feature\/04-Frontier task\n  \/wayfinder \.scratch\/feature\/issues\/04-frontier\.md/);
  assert.ok(text.lastIndexOf('\nNOW  ') > text.indexOf('DEPENDENCY TREE'));
  const readyOnly = renderReadyOnly(work.feature, graph, work.root);
  assert.match(readyOnly, /Wayfinder frontier/);
  assert.match(readyOnly, /- ○ 04 \[task\] Frontier task\n  \/rename feature\/04-Frontier task\n  \/wayfinder \.scratch\/feature\/issues\/04-frontier\.md/);
  assert.doesNotMatch(readyOnly, /03-blocked\.md/);
});

test('tree projection renders each issue once and preserves multiple blockers', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-first.md', { title: 'First', closed: 'true' });
  await writeIssue(work.feature, '02-second.md', { title: 'Second', closed: 'true' });
  await writeIssue(work.feature, '03-joined.md', { title: 'Joined', blockedBy: '01, 02' });
  const graph = await loadGraph(work.feature, work.config);
  const text = renderText(work.feature, graph, work.root);
  const tree = text.slice(text.indexOf('DEPENDENCY TREE'), text.indexOf('\nNOW  '));
  assert.equal(tree.match(/03 \[impl\] Joined/g)?.length, 1);
  assert.match(tree, /03 \[impl\] Joined <- 01, 02/);
  assert.match(text, /NOW  可新增并行实施：1 \| 进行中：0/);
  assert.match(text, /- ○ 03 \[impl\] Joined\n  \/rename feature\/03-Joined\n  \/implement \.scratch\/feature\/issues\/03-joined\.md/);
  const readyOnly = renderReadyOnly(work.feature, graph, work.root);
  assert.match(readyOnly, /- ○ 03 \[impl\] Joined\n  \/rename feature\/03-Joined\n  \/implement \.scratch\/feature\/issues\/03-joined\.md/);
});

test('duplicate numbers require a unique title match', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-alpha.md', { title: 'Alpha' });
  await writeIssue(work.feature, '01-beta.md', { title: 'Beta' });
  await writeIssue(work.feature, '02-good.md', { blockedBy: '01 — Beta' });
  await writeIssue(work.feature, '03-ambiguous.md', { blockedBy: '01' });
  const graph = await loadGraph(work.feature, work.config);
  assert.deepEqual(issue(graph, '02-good.md').blockedBy, ['01-beta.md']);
  assert.deepEqual(issue(graph, '03-ambiguous.md').blockedByInvalid, ['01']);
  assert.equal(graph.groupOf(issue(graph, '03-ambiguous.md')), 'OTHER / WARNINGS');
});

test('dependency cycle freezes only cycle members', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-a.md', { blockedBy: '- `02-b.md`' });
  await writeIssue(work.feature, '02-b.md', { blockedBy: '- `01-a.md`' });
  await writeIssue(work.feature, '03-ready.md');
  const graph = await loadGraph(work.feature, work.config);
  assert.deepEqual(graph.cycleOf(issue(graph, '01-a.md')), ['01-a.md', '02-b.md']);
  assert.equal(graph.groupOf(issue(graph, '03-ready.md')), 'AGENT READY');
});

test('comments cannot override header metadata', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-ready.md', { comments: 'Status: needs-info\nClosed: true' });
  const graph = await loadGraph(work.feature, work.config);
  assert.equal(issue(graph, '01-ready.md').status, 'ready-for-agent');
  assert.equal(issue(graph, '01-ready.md').closed, false);
});

test('JSON remains a complete flat graph without recommendations', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-ready.md');
  await writeIssue(work.feature, '02-blocked.md', { blockedBy: '- `01-ready.md`' });
  const graph = await loadGraph(work.feature, work.config);
  const payload = graphPayload(work.feature, graph, work.root);
  assert.equal('next' in payload, false);
  assert.deepEqual(payload.issues.map((item) => item.id), ['01-ready.md', '02-blocked.md']);
  assert.deepEqual(payload.issues[1].blockedByOpen, ['01-ready.md']);
});

test('human board uses symbols and puts NOW at the bottom', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-info.md', { title: 'Info', status: 'needs-info' });
  await writeIssue(work.feature, '02-human.md', { title: 'Human', status: 'ready-for-human' });
  await writeIssue(work.feature, '03-agent.md', { title: 'Agent' });
  const graph = await loadGraph(work.feature, work.config);
  const text = renderText(work.feature, graph, work.root);
  assert.match(text, /\? 01 \[impl\] Info/);
  assert.match(text, /\? 02 \[impl\] Human/);
  assert.match(text, /○ 03 \[impl\] Agent/);
  assert.match(text, /NOW  可新增并行实施：1 \| 进行中：0/);
  assert.equal(text.trimEnd().endsWith('- 无'), true);
});

test('pure implementation board always prints [impl] type tags', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-done.md', { title: 'Done', closed: 'true' });
  await writeIssue(work.feature, '02-open.md', { title: 'Open', blockedBy: '01' });
  const graph = await loadGraph(work.feature, work.config);
  assert.equal(graph.workflow, 'implementation');
  const text = renderText(work.feature, graph, work.root);
  assert.match(text, /✓ 01 \[impl\] Done/);
  assert.match(text, /○ 02 \[impl\] Open <- 01/);
});

test('config validation rejects non-unique status mappings', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.statusRoles['ready-for-human'] = 'ready-for-agent';
  assert.throws(() => validateConfig(config), /must be unique/);
});
