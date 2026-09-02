#!/usr/bin/env node
/**
 * Resolve the installed yjx-gh-kanban board CLI script under common Agent skill roots.
 *
 * Consumers (Makefile wrappers, Ralph, agents) should use this instead of hard-coding
 * a developer machine monorepo path or a deleted app-repo local skill path.
 */

import { realpathSync } from 'node:fs';
import { access as accessAsync } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'yjx-gh-kanban';
export const BOARD_SCRIPT_RELATIVE = path.join('scripts', 'issue-board.mjs');

function pathKey(value) {
  let normalized = path.normalize(path.resolve(value));
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

export function expandHome(value, home = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('skills root must be a non-empty string');
  }
  const trimmed = value.trim();
  if (trimmed === '~') return path.resolve(home);
  if (trimmed.startsWith('~/') || trimmed.startsWith(`~${path.sep}`)) {
    return path.resolve(home, trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function siblingRoot() {
  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const skillDir = path.dirname(scriptDir);
    const rootDir = path.dirname(skillDir);
    if (path.basename(skillDir) === SKILL_NAME) {
      return rootDir;
    }
  } catch {}
  return null;
}

export function defaultSkillRoots({
  home = os.homedir(),
  env = process.env,
  projectRoot = null,
} = {}) {
  const roots = [];
  const envRoot = env.YJX_SKILLS_ROOT || env.SKILLS_PATH || env.AGENT_SKILLS_ROOT;
  if (envRoot) {
    roots.push(expandHome(envRoot, home));
  }
  const selfRoot = siblingRoot();
  if (selfRoot) {
    roots.push(selfRoot);
  }
  if (home) {
    roots.push(path.join(home, '.agents', 'skills'));
  }
  if (projectRoot) {
    roots.push(path.join(path.resolve(projectRoot), '.agents', 'skills'));
  }
  return [...new Map(roots.map((root) => [pathKey(root), root])).values()];
}

function buildMissingError({ skillName, scriptRelative, tried }) {
  const looked = tried.length
    ? tried.map((item) => `  - ${item}`).join('\n')
    : '  (no skill roots provided)';
  return new Error(
    [
      `Could not find ${skillName} board script (${scriptRelative}).`,
      'Looked under:',
      looked,
      '',
      'Install or link the skill, then retry:',
      `  npx skills add youjiaxing/skills --skill ${skillName}`,
      '  # developer monorepo link:',
      '  npm run link   # from youjiaxing/skills after configuring developer-targets.local.yaml',
      '',
      'Optional: set YJX_SKILLS_ROOT to the directory that contains installed skills.',
      'Do not point at deleted app-repo local kanban paths.',
    ].join('\n'),
  );
}

/**
 * Locate `yjx-gh-kanban/scripts/issue-board.mjs` under skill roots.
 *
 * @returns {Promise<{ scriptPath: string, skillDir: string, root: string }>}
 */
export async function resolveBoardScript({
  skillName = SKILL_NAME,
  scriptRelative = BOARD_SCRIPT_RELATIVE,
  roots,
  home = os.homedir(),
  env = process.env,
  projectRoot = null,
  accessFile = accessAsync,
} = {}) {
  const searchRoots = roots ?? defaultSkillRoots({ home, env, projectRoot });
  const tried = [];

  for (const root of searchRoots) {
    const skillDir = path.join(root, skillName);
    const scriptPath = path.join(skillDir, scriptRelative);
    tried.push(scriptPath);
    try {
      await accessFile(scriptPath);
      return { scriptPath, skillDir, root };
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
  }

  throw buildMissingError({ skillName, scriptRelative, tried });
}

export async function main(argv = process.argv.slice(2)) {
  const options = { projectRoot: null, help: false };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--project-root') options.projectRoot = args.shift();
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument?.startsWith('-')) throw new Error(`unknown option: ${argument}`);
    else throw new Error(`unexpected argument: ${argument}`);
  }
  if (options.projectRoot === undefined) throw new Error('--project-root requires a value');
  if (options.help) {
    console.log(
      'Usage: node resolve-board-script.mjs [--project-root PATH]\n\n'
      + 'Print the absolute path of the installed yjx-gh-kanban issue-board.mjs script.',
    );
    return 0;
  }
  const resolved = await resolveBoardScript({ projectRoot: options.projectRoot });
  process.stdout.write(`${resolved.scriptPath}\n`);
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
