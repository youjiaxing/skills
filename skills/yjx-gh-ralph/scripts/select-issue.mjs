#!/usr/bin/env node
/**
 * Manual single-issue selection for GitHub Issues READY pool.
 * Reads board JSON from yjx-gh-kanban (--json); never starts implementation.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access as defaultAccess } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const KANBAN_SKILL = 'yjx-gh-kanban';
const RALPH_SKILL = 'yjx-gh-ralph';
const BOARD_SCRIPT_RELATIVE = path.join('scripts', 'issue-board.mjs');

/** Sibling install: .../skills/yjx-gh-ralph/scripts → .../skills/yjx-gh-kanban/scripts/issue-board.mjs */
const DEFAULT_ADJACENT_BOARD = new URL(
  `../../${KANBAN_SKILL}/${BOARD_SCRIPT_RELATIVE}`,
  import.meta.url,
);
const DEFAULT_ADJACENT_RESOLVE = new URL(
  `../../${KANBAN_SKILL}/scripts/resolve-board-script.mjs`,
  import.meta.url,
);

function urlToPath(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (value.startsWith('file:')) return fileURLToPath(value);
    return path.resolve(value);
  }
  if (value instanceof URL || typeof value.href === 'string') {
    return fileURLToPath(value.href ?? String(value));
  }
  return path.resolve(String(value));
}

function missingKanbanError(tried) {
  return new Error(
    [
      `Could not find ${KANBAN_SKILL} board script (${BOARD_SCRIPT_RELATIVE}).`,
      `${RALPH_SKILL} must be installed beside ${KANBAN_SKILL} under the same Agent skills root.`,
      'Looked under:',
      ...(tried.length ? tried.map((item) => `  - ${item}`) : ['  (no skill roots provided)']),
      '',
      'Install both skills, then retry:',
      `  npx skills add youjiaxing/skills --skill ${KANBAN_SKILL}`,
      `  npx skills add youjiaxing/skills --skill ${RALPH_SKILL}`,
      '  # developer monorepo link: npm run link  (from youjiaxing/skills)',
      '',
      'Optional: set YJX_SKILLS_ROOT to the directory that contains installed skills.',
    ].join('\n'),
  );
}

/**
 * Candidates are exactly board.ready. No blocked / specs / otherOpen / closed.
 */
export function selectCandidates(board) {
  if (board == null || typeof board !== 'object') {
    throw new Error('invalid board payload: expected an object');
  }
  if (!Array.isArray(board.ready)) {
    throw new Error('invalid board payload: ready must be an array');
  }
  return [...board.ready];
}

/**
 * Whether issueNumber is in the READY candidate pool (not merely present on the board).
 */
export function isSelectableCandidate(board, issueNumber) {
  const target = Number(issueNumber);
  if (!Number.isFinite(target)) return false;
  return selectCandidates(board).some((entry) => entry.number === target);
}

/**
 * Selection contract: candidates = ready; recommended = board.next (kanban priority).
 */
export function selectionPayload(board) {
  const candidates = selectCandidates(board);
  const recommended = board.next ?? null;
  if (recommended != null && !candidates.some((entry) => entry.number === recommended.number)) {
    throw new Error(
      `invalid board payload: next ${recommended.ref ?? `#${recommended.number}`} is not in ready`,
    );
  }
  return {
    candidates,
    recommended,
    summary: board.summary ?? null,
    warnings: Array.isArray(board.warnings) ? board.warnings : [],
  };
}

/**
 * Locate yjx-gh-kanban board CLI.
 *
 * Order:
 * 1. Adjacent sibling install (same skills root as this ralph skill)
 * 2. yjx-gh-kanban resolve-board-script (env / common Agent roots / optional project)
 * 3. Explicit `roots` fallback when resolve module is unavailable
 */
export async function resolveKanbanBoardScript({
  projectRoot = null,
  roots = null,
  adjacentBoardUrl = DEFAULT_ADJACENT_BOARD,
  adjacentResolveUrl = DEFAULT_ADJACENT_RESOLVE,
  env = process.env,
  home = os.homedir(),
  accessFile = defaultAccess,
} = {}) {
  const tried = [];

  // 1. Same-root adjacent install (works for monorepo siblings and co-installed skills)
  const adjacentBoardPath = urlToPath(adjacentBoardUrl);
  if (adjacentBoardPath) {
    tried.push(adjacentBoardPath);
    try {
      await accessFile(adjacentBoardPath);
      const skillDir = path.dirname(path.dirname(adjacentBoardPath));
      return {
        scriptPath: adjacentBoardPath,
        skillDir,
        root: path.dirname(skillDir),
        source: 'adjacent',
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  // 2. Shared path-discovery module from adjacent kanban (env + common roots)
  if (adjacentResolveUrl) {
    try {
      const resolveHref = adjacentResolveUrl.href ?? String(adjacentResolveUrl);
      const resolveMod = await import(resolveHref);
      return await resolveMod.resolveBoardScript({ projectRoot, roots, env, home });
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      // fall through when kanban skill is not beside ralph
    }
  }

  // 3. Minimal discovery for tests / partial installs without resolve module
  const searchRoots = roots ?? [
    env.YJX_SKILLS_ROOT || env.AGENT_SKILLS_ROOT,
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
    projectRoot ? path.join(path.resolve(projectRoot), '.agents', 'skills') : null,
  ].filter(Boolean).map((root) => {
    const text = String(root);
    if (text === '~') return path.resolve(home);
    if (text.startsWith('~/') || text.startsWith(`~${path.sep}`)) {
      return path.resolve(home, text.slice(2));
    }
    return path.resolve(text);
  });

  for (const root of searchRoots) {
    const scriptPath = path.join(root, KANBAN_SKILL, BOARD_SCRIPT_RELATIVE);
    tried.push(scriptPath);
    try {
      await accessFile(scriptPath);
      return {
        scriptPath,
        skillDir: path.join(root, KANBAN_SKILL),
        root,
        source: 'roots',
      };
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }

  throw missingKanbanError(tried);
}

/**
 * Run installed kanban CLI with --json and parse the board payload.
 */
export function loadBoardJson(scriptPath, {
  projectRoot = null,
  limit = null,
  readyLabel = null,
  cwd = process.cwd(),
  nodeExecutable = process.execPath,
  spawn = spawnSync,
} = {}) {
  const args = [scriptPath, '--json'];
  if (projectRoot) args.push('--project-root', projectRoot);
  if (limit != null) args.push('--limit', String(limit));
  if (readyLabel) args.push('--ready-label', readyLabel);

  const result = spawn(nodeExecutable, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `yjx-gh-kanban board failed (exit ${result.status})${detail ? `:\n${detail}` : ''}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('yjx-gh-kanban --json did not return valid JSON');
  }
}

function parseArgs(argv) {
  const options = {
    json: false,
    help: false,
    projectRoot: null,
    limit: null,
    readyLabel: null,
  };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--project-root') options.projectRoot = args.shift();
    else if (argument === '--limit') options.limit = args.shift();
    else if (argument === '--ready-label') options.readyLabel = args.shift();
    else if (argument?.startsWith('-')) throw new Error(`unknown option: ${argument}`);
    else throw new Error(`unexpected argument: ${argument}`);
  }
  if (options.projectRoot === undefined) throw new Error('--project-root requires a value');
  if (options.limit === undefined) throw new Error('--limit requires a value');
  if (options.readyLabel === undefined) throw new Error('--ready-label requires a value');
  if (options.limit != null) {
    const parsed = Number.parseInt(String(options.limit), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--limit must be a positive integer');
    options.limit = parsed;
  }
  return options;
}

function printHelp() {
  console.log(
    [
      `Usage: node select-issue.mjs [options]`,
      '',
      'Read READY candidates from installed yjx-gh-kanban (--json) and recommend board.next.',
      'This script never starts implementation, never loops, and never modifies issues.',
      '',
      'Options:',
      '  --json                Emit machine-readable selection facts',
      '  --project-root PATH   Project root for triage label resolution (passed to kanban)',
      '  --limit N             Forward issue list limit to kanban',
      '  --ready-label LABEL   Forward ready label override to kanban',
      '  -h, --help            Show help',
    ].join('\n'),
  );
}

function renderText(result) {
  const lines = [
    'Ralph candidates (GitHub Issues READY)',
    `candidates=${result.candidates.length}`
      + (result.summary ? ` board_ready=${result.summary.ready} blocked=${result.summary.blocked}` : '')
      + ` warnings=${result.warnings.length}`,
    '',
  ];
  if (result.candidates.length === 0) {
    lines.push('- none');
  }
  for (const candidate of result.candidates) {
    const marker = result.recommended?.number === candidate.number ? 'recommended' : 'candidate';
    lines.push(`- ${candidate.ref ?? `#${candidate.number}`} ${candidate.title}`);
    lines.push(`  ${marker}`);
    if (candidate.url) lines.push(`  url: ${candidate.url}`);
    if (candidate.parent != null) lines.push(`  parent: #${candidate.parent}`);
    if (Array.isArray(candidate.unlocks) && candidate.unlocks.length > 0) {
      lines.push(`  unlocks: ${candidate.unlocks.map((n) => `#${n}`).join(', ')}`);
    }
  }
  if (result.recommended) {
    lines.push('', `next=${result.recommended.ref ?? `#${result.recommended.number}`}`);
  } else {
    lines.push('', 'next=none');
  }
  if (result.warnings.length > 0) {
    lines.push('', 'WARNINGS');
    for (const warning of result.warnings) {
      const code = warning.code ?? 'warning';
      const detail = warning.detail ?? String(warning);
      lines.push(`- code=${code} detail=${detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2), {
  resolveBoard = resolveKanbanBoardScript,
  loadBoard = loadBoardJson,
  cwd = process.cwd(),
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const { scriptPath } = await resolveBoard({ projectRoot: options.projectRoot });
  const board = loadBoard(scriptPath, {
    projectRoot: options.projectRoot,
    limit: options.limit,
    readyLabel: options.readyLabel,
    cwd,
  });
  const result = selectionPayload(board);
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
  return 0;
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
