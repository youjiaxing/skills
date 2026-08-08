import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  isSelectableCandidate,
  resolveKanbanBoardScript,
  selectCandidates,
  selectionPayload,
} from '../scripts/select-issue.mjs';

function entry(number, title = `issue ${number}`, overrides = {}) {
  return {
    number,
    ref: `#${number}`,
    title,
    state: 'OPEN',
    url: `https://github.com/example/repo/issues/${number}`,
    labels: ['ready-for-agent'],
    parent: null,
    isSpec: false,
    isWayfinder: false,
    blockedBy: [],
    openBlockers: [],
    unlocks: [],
    ...overrides,
  };
}

function boardFixture(overrides = {}) {
  const ready = overrides.ready ?? [entry(10, 'later'), entry(3, 'next ticket')];
  const next = overrides.next !== undefined ? overrides.next : ready[0];
  return {
    summary: {
      ready: ready.length,
      blocked: (overrides.blocked ?? []).length,
      spec: (overrides.specs ?? []).length,
      otherOpen: (overrides.otherOpen ?? []).length,
      closed: (overrides.closed ?? []).length,
      readyLabel: 'ready-for-agent',
    },
    next,
    ready,
    blocked: overrides.blocked ?? [entry(20, 'blocked', { labels: ['ready-for-agent'], openBlockers: [99] })],
    specs: overrides.specs ?? [entry(1, 'spec', { isSpec: true, labels: [] })],
    otherOpen: overrides.otherOpen ?? [entry(30, 'other', { labels: [] })],
    closed: overrides.closed ?? [entry(40, 'done', { state: 'CLOSED' })],
    ...overrides,
  };
}

test('candidates come only from board.ready', () => {
  const board = boardFixture({
    ready: [entry(7, 'ready a'), entry(8, 'ready b')],
  });
  const candidates = selectCandidates(board);
  assert.deepEqual(candidates.map((item) => item.number), [7, 8]);
  assert.ok(candidates.every((item) => board.ready.some((ready) => ready.number === item.number)));
  assert.equal(candidates.some((item) => item.number === 20), false);
  assert.equal(candidates.some((item) => item.number === 1), false);
  assert.equal(candidates.some((item) => item.number === 30), false);
  assert.equal(candidates.some((item) => item.number === 40), false);
});

test('recommended equals board.next when multiple ready candidates exist', () => {
  const first = entry(5, 'priority first');
  const second = entry(12, 'priority second');
  const board = boardFixture({
    ready: [first, second],
    next: first,
  });
  const result = selectionPayload(board);
  assert.deepEqual(result.candidates.map((item) => item.number), [5, 12]);
  assert.equal(result.recommended.number, 5);
  assert.equal(result.recommended.number, board.next.number);
  assert.equal(result.recommended.ref, board.next.ref);
});

test('non-READY issues are not selectable', () => {
  const board = boardFixture({
    ready: [entry(7, 'only ready')],
    next: entry(7, 'only ready'),
  });
  assert.equal(isSelectableCandidate(board, 7), true);
  assert.equal(isSelectableCandidate(board, 20), false); // blocked
  assert.equal(isSelectableCandidate(board, 1), false); // spec
  assert.equal(isSelectableCandidate(board, 30), false); // otherOpen
  assert.equal(isSelectableCandidate(board, 40), false); // closed
  assert.equal(isSelectableCandidate(board, 999), false); // unknown
});

test('empty ready pool yields no recommendation', () => {
  const board = boardFixture({ ready: [], next: null });
  const result = selectionPayload(board);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.recommended, null);
});

test('invalid board payload fails closed', () => {
  assert.throws(() => selectCandidates(null), /invalid board/i);
  assert.throws(() => selectCandidates({}), /ready must be an array/i);
  assert.throws(() => selectionPayload({ ready: 'nope' }), /ready must be an array/i);
});

test('resolveKanbanBoardScript prefers adjacent sibling board script', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-gh-ralph-adj-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const scriptDir = path.join(root, 'yjx-gh-kanban', 'scripts');
  await mkdir(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, 'issue-board.mjs');
  await writeFile(scriptPath, 'export {}\n', 'utf8');

  const resolved = await resolveKanbanBoardScript({
    adjacentBoardUrl: pathToFileURL(scriptPath),
    adjacentResolveUrl: null,
    roots: [],
  });
  assert.equal(resolved.scriptPath, scriptPath);
  assert.equal(resolved.source, 'adjacent');
  assert.equal(resolved.root, root);
  await access(resolved.scriptPath);
});

test('resolveKanbanBoardScript finds board via installed skills root fixture', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-gh-ralph-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const scriptDir = path.join(root, 'yjx-gh-kanban', 'scripts');
  await mkdir(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, 'issue-board.mjs');
  await writeFile(scriptPath, 'export {}\n', 'utf8');
  await writeFile(path.join(root, 'yjx-gh-kanban', 'SKILL.md'), '# kanban\n', 'utf8');

  const resolved = await resolveKanbanBoardScript({
    roots: [root],
    adjacentBoardUrl: null,
    adjacentResolveUrl: null,
  });
  assert.equal(resolved.scriptPath, scriptPath);
  assert.equal(resolved.source, 'roots');
  await access(resolved.scriptPath);
});

test('resolveKanbanBoardScript fails with install guidance when kanban missing', async (t) => {
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'yjx-gh-ralph-empty-'));
  t.after(() => rm(emptyRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => resolveKanbanBoardScript({
      roots: [emptyRoot],
      adjacentBoardUrl: null,
      adjacentResolveUrl: null,
    }),
    (error) => {
      assert.match(String(error.message), /yjx-gh-kanban/);
      assert.match(String(error.message), /yjx-gh-ralph/);
      assert.match(String(error.message), /npx skills add youjiaxing\/skills/);
      return true;
    },
  );
});

test('default adjacent resolution finds monorepo sibling yjx-gh-kanban board', async () => {
  const resolved = await resolveKanbanBoardScript({
    roots: [],
    // keep default adjacentBoardUrl / adjacentResolveUrl from the skill install layout
  });
  assert.match(resolved.scriptPath, /yjx-gh-kanban[/\\]scripts[/\\]issue-board\.mjs$/);
  assert.equal(resolved.source, 'adjacent');
  await access(resolved.scriptPath);
});
