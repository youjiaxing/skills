import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_LIMIT,
  loadIssues,
  loadNativeRelations,
  main,
  parseArgs,
  parseParentFilter,
  resolveReadyLabel,
  runBoard,
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
} = {}) {
  return {
    number,
    title,
    state,
    url: `https://github.com/example/repo/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    body,
    updatedAt: '2026-07-01T00:00:00Z',
    assignees: assignees.map((login) => ({ login })),
  };
}

function relationJson(number, parent = null, blockedBy = []) {
  return {
    number,
    parent: parent == null ? null : { number: parent },
    blockedBy: {
      nodes: blockedBy.map((item) => (
        typeof item === 'number'
          ? { number: item, state: 'OPEN' }
          : { number: item.number, state: item.state ?? 'OPEN' }
      )),
      totalCount: blockedBy.length,
    },
  };
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
    help: false,
  });

  const parsed = parseArgs([
    '--json',
    '--agent',
    '--ready-only',
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

test('loadIssues / loadNativeRelations map gh JSON and fail-closed on missing ready relations', async () => {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args.includes('number,title,state,url,labels,body,updatedAt,assignees')) {
      return [
        issueJson(1, 'Spec', { labels: [], body: SPEC_BODY }),
        issueJson(2, 'Ready work'),
        issueJson(3, 'Blocked work'),
      ];
    }
    if (args.includes('number,parent,blockedBy')) {
      return [
        relationJson(1),
        relationJson(2),
        // missing #3 on purpose
      ];
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  };

  const issues = await loadIssues(200, { runGh });
  assert.equal(issues.get(2).title, 'Ready work');
  assert.deepEqual(issues.get(2).labels, ['ready-for-agent']);

  await assert.rejects(
    () => loadNativeRelations(issues, 'ready-for-agent', { runGh, limit: 200 }),
    /native relations|#3/i,
  );
  assert.equal(calls.length, 2);
});

test('runBoard builds human tree, json, agent, and ready-only outputs via injected gh', async () => {
  const runGh = async (args) => {
    if (args.includes('number,title,state,url,labels,body,updatedAt,assignees')) {
      return [
        issueJson(10, 'Parent spec', { labels: [], body: SPEC_BODY }),
        issueJson(11, 'Ready child'),
        issueJson(12, 'Blocked child'),
        issueJson(9, 'Closed blocker', { state: 'CLOSED', labels: [] }),
      ];
    }
    if (args.includes('number,parent,blockedBy')) {
      return [
        relationJson(10),
        relationJson(11, 10),
        relationJson(12, 10, [9]),
        relationJson(9),
      ];
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
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
    if (args.includes('number,title,state,url,labels,body,updatedAt,assignees')) {
      return [issueJson(5, 'Only ready')];
    }
    if (args.includes('number,parent,blockedBy')) {
      return [relationJson(5)];
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
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
