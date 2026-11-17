#!/usr/bin/env node
/**
 * Read-only DAG frontier calculator for yjx-issue-flow.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const TERMINAL_STATUSES = new Set(['resolved', 'wontfix', 'closed', 'done', 'invalid', 'duplicate']);
const CLAIMED_STATUSES = new Set(['claimed', 'in_progress', 'in-progress']);

function isTerminal(issue, extraDoneSet) {
  if (extraDoneSet.has(String(issue.id))) return true;
  if (typeof issue.terminal === 'boolean') return issue.terminal;
  const status = String(issue.status ?? '').trim().toLowerCase();
  return TERMINAL_STATUSES.has(status);
}

export function computeDagFrontier(payload) {
  const rawIssues = Array.isArray(payload) ? payload : payload?.issues;
  if (!Array.isArray(rawIssues)) throw new Error('issues array is required');
  const extraDone = new Set((Array.isArray(payload?.markDone) ? payload.markDone : []).map(String));
  const byId = new Map();
  for (const item of rawIssues) {
    if (!item || item.id === undefined || item.id === null || String(item.id).trim() === '') {
      throw new Error('every issue must have a non-empty id');
    }
    const id = String(item.id);
    if (byId.has(id)) throw new Error(`duplicate issue id: ${id}`);
    byId.set(id, {
      ...item,
      id,
      status: item.status ?? null,
      blockedBy: Array.isArray(item.blockedBy) ? [...new Set(item.blockedBy.map(String))] : [],
      parentId: item.parentId !== undefined && item.parentId !== null ? String(item.parentId) : null,
    });
  }

  const childrenByParent = new Map();
  for (const issue of byId.values()) {
    if (issue.parentId && byId.has(issue.parentId)) {
      const list = childrenByParent.get(issue.parentId) ?? [];
      list.push(issue.id);
      childrenByParent.set(issue.parentId, list);
    }
  }

  const state = new Map();
  const cycles = [];
  const stack = [];
  function dfs(id) {
    state.set(id, 1);
    stack.push(id);
    const issue = byId.get(id);
    const deps = [...issue.blockedBy, ...(childrenByParent.get(id) ?? [])];
    for (const dep of deps) {
      if (!byId.has(dep)) continue;
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const idx = stack.indexOf(dep);
        cycles.push(stack.slice(idx).concat(dep));
      } else if (s === 0) {
        dfs(dep);
      }
    }
    stack.pop();
    state.set(id, 2);
  }
  for (const id of byId.keys()) {
    if ((state.get(id) ?? 0) === 0) dfs(id);
  }
  const cycleNodes = new Set(cycles.flat());

  const readyFrontier = [];
  const blocked = [];
  const claimed = [];
  const terminal = [];
  const missingBlockers = [];

  for (const issue of byId.values()) {
    if (isTerminal(issue, extraDone)) {
      terminal.push({ id: issue.id, title: issue.title ?? null, status: issue.status });
      continue;
    }
    const waitingOn = [];
    for (const dep of issue.blockedBy) {
      if (!byId.has(dep)) {
        missingBlockers.push({ id: issue.id, blockerId: dep });
        waitingOn.push({ id: dep, reason: 'missing_from_scope' });
      } else if (!isTerminal(byId.get(dep), extraDone)) {
        waitingOn.push({ id: dep, reason: 'blocker_not_terminal', status: byId.get(dep).status });
      }
    }
    for (const childId of childrenByParent.get(issue.id) ?? []) {
      if (!isTerminal(byId.get(childId), extraDone)) {
        waitingOn.push({ id: childId, reason: 'child_not_terminal', status: byId.get(childId).status });
      }
    }
    if (cycleNodes.has(issue.id)) {
      blocked.push({ id: issue.id, title: issue.title ?? null, status: issue.status, waitingOn, inCycle: true });
      continue;
    }
    if (waitingOn.length > 0) {
      blocked.push({ id: issue.id, title: issue.title ?? null, status: issue.status, waitingOn, inCycle: false });
      continue;
    }
    const normalizedStatus = String(issue.status ?? '').trim().toLowerCase();
    if (CLAIMED_STATUSES.has(normalizedStatus)) {
      claimed.push({ id: issue.id, title: issue.title ?? null, status: issue.status });
      continue;
    }
    readyFrontier.push({ id: issue.id, title: issue.title ?? null, status: issue.status, parentId: issue.parentId });
  }

  return {
    total: byId.size,
    readyFrontier,
    blocked,
    claimed,
    terminal,
    cycles,
    missingBlockers,
  };
}

function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--input');
  const inputPath = idx >= 0 ? args[idx + 1] : null;
  const markIdx = args.indexOf('--mark-done');
  const markDone = markIdx >= 0 && args[markIdx + 1]
    ? args[markIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const raw = inputPath ? fs.readFileSync(inputPath, 'utf8') : fs.readFileSync(0, 'utf8');
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const payload = Array.isArray(parsed) ? { issues: parsed, markDone } : { ...parsed, markDone: [...(parsed.markDone ?? []), ...markDone] };
  process.stdout.write(JSON.stringify(computeDagFrontier(payload), null, 2) + '\n');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}
