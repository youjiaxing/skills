import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BOARD_LIST_FIELDS,
  DEFAULT_LIMIT,
  loadBoardSnapshot,
  loadNativeRelations,
  main,
  parseArgs,
  parseParentFilter,
  resolveReadyLabel,
  runBoard,
  stubIssueFromRelationRef,
} from '../scripts/issue-board.mjs';

const SPEC_BODY = [
  '## Problem Statement',
  'x',
  '## Solution',
  'y',
  '## User Stories',
  'z',
].join('\n');

const TICKET_BODY = '## What to build\nDo the work.\n';

function issueJson(number, title, {
  labels = ['ready-for-agent'],
  state = 'OPEN',
  body = TICKET_BODY,
  assignees = [],
  parent = null,
  blockedBy = [],
} = {}) {
  const nodes = blockedBy.map((item) => (
    typeof item === 'number'
      ? { number: item, state: 'OPEN', title: `Issue ${item}`, url: `https://github.com/example/repo/issues/${item}` }
      : {
        number: item.number,
        state: item.state ?? 'OPEN',
        title: item.title ?? `Issue ${item.number}`,
        url: item.url ?? `https://github.com/example/repo/issues/${item.number}`,
      }
  ));
  return {
    number,
    title,
    state,
    url: `https://github.com/example/repo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    body,
    updatedAt: '2026-07-01T00:00:00Z',
    assignees: assignees.map((login) => ({ login })),
    parent: parent == null
      ? null
      : typeof parent === 'object'
        ? parent
        : { number: parent, state: 'OPEN', title: `Parent ${parent}`, url: `https://github.com/example/repo/issues/${parent}` },
    blockedBy: { nodes, totalCount: nodes.length },
  };
}

function isBoardListCall(args) {
  return args.includes('--json') && args.some((part) => String(part).includes('parent') && String(part).includes('blockedBy'));
}

test('parseArgs covers human default, machine flags, parent filter, and limit', () => {
  assert.deepEqual(parseArgs([]), {
    agent: false,
    json: false,
    readyOnly: false,
    limit: DEFAULT_LIMIT,
    readyLabel: null,
    parentFilter: null,
    projectRoot: null,
    includeClosed: false,
    help: false,
  });

  const parsed = parseArgs([
    '--json',
    '--agent',
    '--ready-only',
    '--include-closed',
    '--limit',
    '50',
    '--ready-label',
    'afk-ready',
    '--parent',
    '#102',
    '--project-root',
    '/repo',
  ]);
  assert.equal(parsed.json, true);
  assert.equal(parsed.agent, true);
  assert.equal(parsed.readyOnly, true);
  assert.equal(parsed.includeClosed, true);
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.readyLabel, 'afk-ready');
  assert.equal(parsed.parentFilter, 102);
  assert.equal(parsed.projectRoot, '/repo');
});

test('parseParentFilter accepts number and #number forms', () => {
  assert.equal(parseParentFilter('102'), 102);
  assert.equal(parseParentFilter('#102'), 102);
  assert.throws(() => parseParentFilter('abc'), /parent/i);
  assert.throws(() => parseParentFilter(''), /parent/i);
});

test('parseArgs rejects unknown flags and missing values', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['--limit']), /--limit requires/);
  assert.throws(() => parseArgs(['--parent']), /--parent requires/);
  assert.throws(() => parseArgs(['--limit', '0']), /positive/);
});

test('resolveReadyLabel uses triage doc mapping when present', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-gh-kanban-triage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agents = path.join(root, 'docs', 'agents');
  await mkdir(agents, { recursive: true });
  await writeFile(
    path.join(agents, 'triage-labels.md'),
    '| Role | Label |\n| --- | --- |\n| `ready-for-agent` | `ship-it` |\n',
    'utf8',
  );
  assert.equal(await resolveReadyLabel({ projectRoot: root }), 'ship-it');
  assert.equal(await resolveReadyLabel({ projectRoot: root, readyLabel: 'override' }), 'override');
});

test('resolveReadyLabel falls back when triage doc is missing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-gh-kanban-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await resolveReadyLabel({ projectRoot: root }), 'ready-for-agent');
});

test('loadBoardSnapshot uses one open list call and hydrates closed blockers', async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    assert.ok(isBoardListCall(args), `expected combined board fields, got ${args.join(' ')}`);
    assert.ok(args.includes('open'), 'default fetch is open-only');
    assert.equal(args.includes(BOARD_LIST_FIELDS), true);
    return [
      issueJson(1, 'Spec', { labels: [], body: SPEC_BODY }),
      issueJson(2, 'Ready work', { parent: 1 }),
      issueJson(3, 'Blocked work', {
        parent: 1,
        blockedBy: [{ number: 9, state: 'CLOSED', title: 'Closed blocker' }],
      }),
    ];
  };

  const { issues, relations } = await loadBoardSnapshot(200, 'ready-for-agent', { runGh });
  assert.equal(calls.length, 1);
  assert.equal(issues.get(2).title, 'Ready work');
  assert.deepEqual(issues.get(2).labels, ['ready-for-agent']);
  assert.equal(issues.get(9).title, 'Closed blocker');
  assert.equal(issues.get(9).state, 'CLOSED');
  assert.equal(issues.get(9)._hydratedStub, true);
  assert.ok(relations.has(2));
  assert.ok(relations.has(3));
});

test('loadNativeRelations fail-closed when ready candidate missing from snapshot', async () => {
  const runGh = async () => [
    issueJson(1, 'Spec', { labels: [], body: SPEC_BODY }),
    issueJson(2, 'Ready work'),
  ];
  const issues = new Map([
    [1, { number: 1, title: 'Spec', state: 'OPEN', labels: [], body: SPEC_BODY, assignees: [] }],
    [2, { number: 2, title: 'Ready work', state: 'OPEN', labels: ['ready-for-agent'], body: '', assignees: [] }],
    [3, { number: 3, title: 'Missing', state: 'OPEN', labels: ['ready-for-agent'], body: '', assignees: [] }],
  ]);
  await assert.rejects(
    () => loadNativeRelations(issues, 'ready-for-agent', { runGh, limit: 200 }),
    /native relations|#3/i,
  );
});

test('stubIssueFromRelationRef copies title/state/url', () => {
  const stub = stubIssueFromRelationRef({
    number: 9,
    state: 'CLOSED',
    title: 'Done',
    url: 'https://example/9',
  });
  assert.equal(stub.number, 9);
  assert.equal(stub.title, 'Done');
  assert.equal(stub._hydratedStub, true);
});

test('runBoard builds human tree, json, agent, and ready-only outputs via injected gh', async () => {
  const runGh = async (args) => {
    assert.ok(isBoardListCall(args));
    // Default open-only: closed blocker arrives only as relation stub on #12.
    return [
      issueJson(10, 'Parent spec', { labels: [], body: SPEC_BODY }),
      issueJson(11, 'Ready child', { parent: 10 }),
      issueJson(12, 'Blocked child', {
        parent: 10,
        // Open blocker keeps #12 out of READY; closed #9 only appears for tree hydration.
        blockedBy: [
          { number: 8, state: 'OPEN', title: 'Open blocker' },
          { number: 9, state: 'CLOSED', title: 'Closed blocker' },
        ],
      }),
    ];
  };

  const human = await runBoard({
    limit: 50,
    readyLabel: 'ready-for-agent',
    parentFilter: 10,
    mode: 'human',
    runGh,
  });
  assert.match(human, /LEGEND/);
  assert.match(human, /DEPENDENCY TREE/);
  assert.match(human, /○ 11/);
  assert.match(human, /Closed blocker|✓ 9|Open blocker/);
  assert.match(human, /NOW/);

  const jsonText = await runBoard({
    limit: 50,
    readyLabel: 'ready-for-agent',
    mode: 'json',
    runGh,
  });
  const payload = JSON.parse(jsonText);
  assert.equal(payload.next.number, 11);
  assert.equal(payload.ready.length, 1);
  assert.equal(payload.ready[0].number, 11);

  const agent = await runBoard({
    limit: 50,
    readyLabel: 'ready-for-agent',
    mode: 'agent',
    runGh,
  });
  assert.match(agent, /next=#11/);
  assert.match(agent, /ready=1/);

  const readyOnly = await runBoard({
    limit: 50,
    readyLabel: 'ready-for-agent',
    mode: 'ready-only',
    runGh,
  });
  assert.match(readyOnly, /ready-only/i);
  assert.match(readyOnly, /#11/);
  assert.doesNotMatch(readyOnly, /DEPENDENCY TREE/);
});

test('main --help exits 0 and prints Usage', async () => {
  const chunks = [];
  const code = await main(['--help'], {
    stdout: { write(text) { chunks.push(text); } },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  assert.match(chunks.join(''), /Usage:/);
});

test('main prints agent board through deps without calling real gh when injected', async () => {
  const runGh = async (args) => {
    assert.ok(isBoardListCall(args));
    return [issueJson(5, 'Only ready')];
  };
  const out = [];
  const code = await main(['--agent', '--project-root', os.tmpdir()], {
    runGh,
    stdout: { write(text) { out.push(text); } },
    stderr: { write() {} },
  });
  assert.equal(code, 0);
  assert.match(out.join(''), /next=#5/);
});
