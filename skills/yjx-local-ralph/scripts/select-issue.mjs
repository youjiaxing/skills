#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const kanbanModuleUrl = new URL('../../yjx-local-kanban/scripts/issue-board.mjs', import.meta.url);

async function loadKanban() {
  try {
    return await import(kanbanModuleUrl);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('yjx-local-kanban is required beside yjx-local-ralph; install both skills');
    }
    throw error;
  }
}

function compareIssueNumbers(left, right) {
  const leftNumber = Number.parseInt(left.number, 10);
  const rightNumber = Number.parseInt(right.number, 10);
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left.id.localeCompare(right.id);
}

export function selectCandidates(payload) {
  if (!payload || !Array.isArray(payload.issues)) throw new Error('invalid Kanban payload: issues must be an array');
  return payload.issues
    .filter((issue) =>
      issue.closed === false
      && issue.statusRole === 'ready-for-agent'
      && issue.metadataValid === true
      && Array.isArray(issue.blockedByOpen) && issue.blockedByOpen.length === 0
      && Array.isArray(issue.blockedByMissing) && issue.blockedByMissing.length === 0
      && Array.isArray(issue.blockedByInvalid) && issue.blockedByInvalid.length === 0
      && Array.isArray(issue.dependencyCycle) && issue.dependencyCycle.length === 0)
    .sort(compareIssueNumbers);
}

export function selectionPayload(kanbanPayload) {
  const candidates = selectCandidates(kanbanPayload);
  return {
    feature: kanbanPayload.feature,
    candidates,
    recommended: candidates[0] ?? null,
    warnings: kanbanPayload.warnings ?? [],
  };
}

function parseArgs(argv) {
  const options = { featureDir: null, projectRoot: null, json: false, help: false };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--project-root') options.projectRoot = args.shift();
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument?.startsWith('-')) throw new Error(`unknown option: ${argument}`);
    else if (options.featureDir) throw new Error(`unexpected argument: ${argument}`);
    else options.featureDir = argument;
  }
  if (options.projectRoot === undefined) throw new Error('--project-root requires a value');
  if (!options.help && !options.featureDir) throw new Error('feature directory is required');
  return options;
}

function printHelp() {
  console.log(`Usage: node select-issue.mjs [options] <feature-dir>\n\nOptions:\n  --project-root PATH   Project root containing local tracker config\n  --json                Emit machine-readable selection facts\n  -h, --help            Show help\n\nThe script never starts implementation or modifies issues.`);
}

function renderText(result) {
  const lines = [
    `Ralph candidates: ${result.feature}`,
    `candidates=${result.candidates.length} warnings=${result.warnings.length}`,
    '',
  ];
  if (result.candidates.length === 0) lines.push('- none');
  for (const candidate of result.candidates) {
    const marker = result.recommended?.id === candidate.id ? 'recommended' : 'candidate';
    lines.push(`- ${candidate.number} ${candidate.title}`, `  ${marker}`, `  path: ${candidate.path}`);
  }
  if (result.warnings.length > 0) {
    lines.push('', 'WARNINGS');
    for (const warning of result.warnings) {
      lines.push(`- code=${warning.code}${warning.issue ? ` issue=${warning.issue}` : ''} detail=${warning.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const kanban = await loadKanban();
  const projectRoot = options.projectRoot
    ? path.resolve(options.projectRoot)
    : await kanban.findProjectRoot(path.resolve(options.featureDir));
  const config = await kanban.loadConfig(projectRoot);
  const featureDir = path.resolve(projectRoot, options.featureDir);
  const graph = await kanban.loadGraph(featureDir, config);
  const result = selectionPayload(kanban.graphPayload(featureDir, graph, projectRoot));
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
