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
  comments = '',
} = {}) {
  const field = (name, value) => bold ? `**${name}:** ${value}` : `${name}: ${value}`;
  const lines = [`# ${title}`, ''];
  if (status !== null) lines.push(field('Status', status));
  if (closed !== null) lines.push(field('Closed', closed));
  if (type !== null) lines.push(field('Type', type));
  if (blockedBy !== null && bold) lines.push('', field('Blocked by', blockedBy));
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

test('closed ready-for-agent is accepted for Matt implement completion', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-done.md', { closed: 'true' });
  const graph = await loadGraph(work.feature, work.config);
  assert.equal(issue(graph, '01-done.md').metadataValid, true);
  assert.equal(graph.groupOf(issue(graph, '01-done.md')), 'CLOSED');
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

test('wayfinder artifacts are excluded from implementation graph', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-research.md', { status: 'claimed', closed: null, type: 'research' });
  await writeIssue(work.feature, '02-implementation.md');
  const graph = await loadGraph(work.feature, work.config);
  assert.deepEqual(graph.issues.map((item) => item.id), ['02-implementation.md']);
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

test('human board keeps immediately actionable groups last', async (t) => {
  const work = await fixture(t);
  await writeIssue(work.feature, '01-info.md', { status: 'needs-info' });
  await writeIssue(work.feature, '02-human.md', { status: 'ready-for-human' });
  await writeIssue(work.feature, '03-agent.md');
  const graph = await loadGraph(work.feature, work.config);
  const text = renderText(work.feature, graph, work.root);
  assert.ok(text.indexOf('\nWAITING FOR INFO\n') < text.indexOf('\nHUMAN READY\n'));
  assert.ok(text.indexOf('\nHUMAN READY\n') < text.indexOf('\nAGENT READY\n'));
});

test('config validation rejects non-unique status mappings', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.statusRoles['ready-for-human'] = 'ready-for-agent';
  assert.throws(() => validateConfig(config), /must be unique/);
});
