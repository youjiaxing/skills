#!/usr/bin/env node

/**
 * Minimal runnable entry for yjx-issue-crusher (ticket 07 skeleton).
 *
 * Commands:
 *   recommend  — print auto-next candidate from local-md tracker (no spawn)
 *   --help
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createLocalMarkdownTracker } from './local-md-tracker.mjs';

function printHelp() {
  console.log(`Usage: node cli.mjs <command> [options]

Commands:
  recommend   List auto-relay candidates and recommend next (local-md)

Options:
  --project-root PATH   Project root with docs/agents/local-tracker.json
  --feature SLUG        Feature slug under trackerRoot (default: required)
  -h, --help            Show help

This entry does not start Grok/Claude workers. Chain Run is the test seam.
`);
}

function parseArgs(argv) {
  const options = {
    command: null,
    projectRoot: process.cwd(),
    feature: null,
    help: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--project-root') {
      options.projectRoot = args.shift();
      if (!options.projectRoot) throw new Error('--project-root requires a value');
    } else if (argument === '--feature') {
      options.feature = args.shift();
      if (!options.feature) throw new Error('--feature requires a value');
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument?.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    } else if (!options.command) {
      options.command = argument;
    } else {
      throw new Error(`unexpected argument: ${argument}`);
    }
  }
  return options;
}

async function runRecommend(options) {
  if (!options.feature) throw new Error('--feature is required for recommend');
  const tracker = createLocalMarkdownTracker({
    projectRoot: path.resolve(options.projectRoot),
    feature: options.feature,
  });
  const candidates = await tracker.listAutoCandidates();
  const recommended = await tracker.recommendNext();
  const payload = {
    feature: options.feature,
    candidates,
    recommended,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    printHelp();
    return options.help || !options.command ? 0 : 1;
  }
  if (options.command === 'recommend') return runRecommend(options);
  throw new Error(`unknown command: ${options.command}`);
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
