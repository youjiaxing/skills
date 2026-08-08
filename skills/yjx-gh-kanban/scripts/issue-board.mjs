#!/usr/bin/env node
/**
 * Thin CLI for yjx-gh-kanban:
 * parse args → call `gh` → pure board engine → print.
 *
 * Board classification / tree rendering lives in board-engine.mjs.
 * Path discovery for consumers lives in resolve-board-script.mjs.
 */

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_READY_LABEL,
  buildBoard,
  isSpecIssue,
  isWayfinderIssue,
  parseReadyLabelFromTriageDoc,
} from './board-engine.mjs';

export const DEFAULT_LIMIT = 200;
export const TRIAGE_LABELS_RELATIVE = path.join('docs', 'agents', 'triage-labels.md');

const ISSUE_LIST_FIELDS = 'number,title,state,url,labels,body,updatedAt,assignees';
const RELATION_LIST_FIELDS = 'number,parent,blockedBy';

export function parseParentFilter(raw) {
  if (raw == null || String(raw).trim() === '') {
    throw new Error('--parent requires an issue number (e.g. 102 or #102)');
  }
  const text = String(raw).trim().replace(/^#/, '');
  const number = Number(text);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`invalid --parent value: ${raw} (expected positive issue number)`);
  }
  return number;
}

export function parseArgs(argv) {
  const options = {
    agent: false,
    json: false,
    readyOnly: false,
    limit: DEFAULT_LIMIT,
    readyLabel: null,
    parentFilter: null,
    projectRoot: null,
    help: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--agent') options.agent = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--ready-only') options.readyOnly = true;
    else if (argument === '--limit') options.limit = args.shift();
    else if (argument === '--ready-label') options.readyLabel = args.shift();
    else if (argument === '--parent') options.parentFilter = args.shift();
    else if (argument === '--project-root') options.projectRoot = args.shift();
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument?.startsWith('-')) throw new Error(`unknown option: ${argument}`);
    else throw new Error(`unexpected argument: ${argument}`);
  }

  for (const [flag, value] of [
    ['--limit', options.limit],
    ['--ready-label', options.readyLabel],
    ['--parent', options.parentFilter],
    ['--project-root', options.projectRoot],
  ]) {
    if (value === undefined) throw new Error(`${flag} requires a value`);
  }

  const limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer, got: ${options.limit}`);
  }
  options.limit = limit;

  if (options.parentFilter != null) {
    options.parentFilter = parseParentFilter(options.parentFilter);
  }
  if (options.readyLabel != null && String(options.readyLabel).trim() === '') {
    throw new Error('--ready-label requires a non-empty value');
  }
  if (options.projectRoot != null) {
    options.projectRoot = path.resolve(options.projectRoot);
  }
  return options;
}

export function printHelp(stdout = process.stdout) {
  stdout.write(`Usage: node issue-board.mjs [options]

Read-only GitHub Issues board (gh + board engine). Run inside a repo with gh configured.

Options:
  --json                Emit structured board JSON (next/ready/...)
  --agent               Emit compact READY + next= output for agents
  --ready-only          Emit only the READY candidate list (/implement commands)
  --parent N|#N         Scope human DEPENDENCY TREE + NOW (READY / wayfinder frontier /
                        in-progress) to parent + blocker closure
                        (does not change --json / --agent / --ready-only READY pool)
  --limit N             Max issues to fetch (default ${DEFAULT_LIMIT})
  --ready-label LABEL   Override ready-for-agent label mapping
  --project-root PATH   Project root for triage-labels.md (default: cwd)
  -h, --help            Show help

Default output is the human board (LEGEND, dependency tree, WARNINGS, NOW).
Requires: Node.js 20+, GitHub CLI (\`gh\`) authenticated for the current repo.
`);
}

/**
 * Run `gh` and parse JSON stdout. Injected for tests.
 * @param {string[]} args
 * @param {{ cwd?: string, spawn?: typeof spawnSync }} [options]
 */
export function runGh(args, { cwd = process.cwd(), spawn = spawnSync } = {}) {
  const completed = spawn('gh', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (completed.error) {
    throw new Error(`failed to spawn gh: ${completed.error.message}`);
  }
  if (completed.status !== 0) {
    const message = (completed.stderr || completed.stdout || '').trim() || `exit ${completed.status}`;
    throw new Error(`gh ${args.join(' ')} failed: ${message}`);
  }
  try {
    return JSON.parse(completed.stdout || 'null');
  } catch (error) {
    throw new Error(`gh ${args.join(' ')} returned invalid JSON: ${error.message}`);
  }
}

export async function loadIssues(limit, { runGh: gh = runGh, cwd } = {}) {
  const raw = await gh(
    ['issue', 'list', '--state', 'all', '--limit', String(limit), '--json', ISSUE_LIST_FIELDS],
    { cwd },
  );
  if (!Array.isArray(raw)) {
    throw new Error('gh issue list returned a non-array payload');
  }
  const issues = new Map();
  for (const item of raw) {
    const number = Number(item.number);
    if (!Number.isFinite(number)) {
      throw new Error(`gh issue list entry missing number: ${JSON.stringify(item)}`);
    }
    const labels = Array.isArray(item.labels)
      ? item.labels.map((label) => (typeof label === 'string' ? label : label?.name ?? '')).filter(Boolean)
      : [];
    const assignees = Array.isArray(item.assignees)
      ? item.assignees.map((assignee) => {
        if (typeof assignee === 'string') return assignee;
        return assignee?.login ?? assignee?.name ?? '';
      }).filter(Boolean)
      : [];
    issues.set(number, {
      number,
      title: item.title ?? '',
      state: item.state ?? 'OPEN',
      url: item.url ?? '',
      labels,
      body: item.body ?? '',
      updatedAt: item.updatedAt ?? item.updated_at ?? '',
      assignees,
    });
  }
  return issues;
}

function needsNativeRelations(issue, readyLabel) {
  if (String(issue.state).toUpperCase() === 'CLOSED') return false;
  if (!issue.labels.includes(readyLabel)) return false;
  if (isSpecIssue(issue) || isWayfinderIssue(issue)) return false;
  return true;
}

/**
 * Load native parent / blockedBy for the same limit window.
 * Fail-closed when a READY candidate is missing from the relation payload.
 */
export async function loadNativeRelations(issues, readyLabel, { runGh: gh = runGh, limit, cwd } = {}) {
  const raw = await gh(
    ['issue', 'list', '--state', 'all', '--limit', String(limit), '--json', RELATION_LIST_FIELDS],
    { cwd },
  );
  if (!Array.isArray(raw)) {
    throw new Error('gh relation list returned a non-array payload');
  }

  const relations = new Map();
  for (const item of raw) {
    const number = Number(item.number);
    if (!Number.isFinite(number)) {
      throw new Error(`gh relation entry missing number: ${JSON.stringify(item)}`);
    }
    relations.set(number, {
      parent: item.parent ?? null,
      blockedBy: item.blockedBy,
    });
  }

  const missing = [...issues.values()]
    .filter((issue) => needsNativeRelations(issue, readyLabel) && !relations.has(issue.number))
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
  if (missing.length > 0) {
    const refs = missing.map((number) => `#${number}`).join(', ');
    throw new Error(`GitHub did not return native relations for: ${refs}`);
  }
  return relations;
}

export async function resolveReadyLabel({
  readyLabel = null,
  projectRoot = process.cwd(),
  readFileFn = readFile,
} = {}) {
  if (readyLabel) return readyLabel;
  const triagePath = path.join(path.resolve(projectRoot), TRIAGE_LABELS_RELATIVE);
  try {
    const markdown = await readFileFn(triagePath, 'utf8');
    return parseReadyLabelFromTriageDoc(markdown, DEFAULT_READY_LABEL);
  } catch (error) {
    if (error && error.code === 'ENOENT') return DEFAULT_READY_LABEL;
    throw error;
  }
}

function selectMode(options) {
  if (options.json) return 'json';
  if (options.agent) return 'agent';
  if (options.readyOnly) return 'ready-only';
  return 'human';
}

/**
 * End-to-end board build with injectable gh.
 * @returns {Promise<string>}
 */
export async function runBoard({
  limit = DEFAULT_LIMIT,
  readyLabel = DEFAULT_READY_LABEL,
  parentFilter = null,
  mode = 'human',
  runGh: gh = runGh,
  cwd,
} = {}) {
  const issues = await loadIssues(limit, { runGh: gh, cwd });
  const relations = await loadNativeRelations(issues, readyLabel, { runGh: gh, limit, cwd });
  const result = buildBoard({
    issues,
    relations,
    options: { readyLabel, parentFilter },
  });
  if (mode === 'json') return result.json;
  if (mode === 'agent') return result.agent;
  if (mode === 'ready-only') return result.readyOnly;
  return result.human;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const gh = deps.runGh ?? runGh;
  const cwd = deps.cwd ?? process.cwd();

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`error: ${error.message}\n`);
    return 1;
  }

  if (options.help) {
    printHelp(stdout);
    return 0;
  }

  const projectRoot = options.projectRoot ?? cwd;
  try {
    const readyLabel = await resolveReadyLabel({
      readyLabel: options.readyLabel,
      projectRoot,
      readFileFn: deps.readFileFn ?? readFile,
    });
    const mode = selectMode(options);
    const text = await runBoard({
      limit: options.limit,
      readyLabel,
      // Parent filter scopes human dependency tree; machine modes still classify the full fetch.
      parentFilter: options.parentFilter,
      mode,
      runGh: gh,
      cwd,
    });
    stdout.write(text);
    return 0;
  } catch (error) {
    stderr.write(`error: ${error.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
