#!/usr/bin/env node
/**
 * 20260805-1244 ticket 04 — acceptance runner with stable process exit codes.
 *
 * Exit codes (process-level evidence for CI / agents):
 *   0  all stages green
 *   1  runner/infra failure (could not start tests)
 *   2  stage A failed (Closed handoff / no-exit / no-next)
 *   3  stage B failed (resume blank / reinject / bad resume)
 *   4  stage C failed (wrong-kill / not-closed mis-gate)
 *   5  mixed / unknown acceptance failure
 *
 * Stage evidence is also greppable in stdout as:
 *   [acceptance <stage>/<code>] ...
 *
 * Usage (skills monorepo root or any cwd):
 *   node skills/yjx-issue-crusher/scripts/run-vibe-handoff-acceptance.mjs
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, '..');
const testFile = path.join(skillRoot, 'tests', 'vibe-handoff-acceptance.test.mjs');

const result = spawnSync(
  process.execPath,
  ['--test', testFile],
  {
    encoding: 'utf8',
    env: process.env,
    cwd: skillRoot,
  },
);

const stdout = result.stdout || '';
const stderr = result.stderr || '';
process.stdout.write(stdout);
process.stderr.write(stderr);

if (result.error) {
  console.error(JSON.stringify({
    ok: false,
    exitCode: 1,
    reason: 'runner-infra',
    error: String(result.error.message || result.error),
  }, null, 2));
  process.exit(1);
}

if (result.status === 0) {
  console.log(JSON.stringify({
    ok: true,
    exitCode: 0,
    stages: ['A-closed-safe-reap-next', 'B-resume-nonblank', 'C-not-closed-no-kill'],
    failureCodes: ['not-closed', 'no-exit', 'resume-blank', 'wrong-kill'],
  }, null, 2));
  process.exit(0);
}

// Map first greppable acceptance tag to a stable exit code.
const combined = `${stdout}\n${stderr}`;
const tag = combined.match(/\[acceptance\s+([A-C]-[^/\]]+)\/([^\]]+)\]/);
let exitCode = 5;
let stage = null;
let code = null;
if (tag) {
  stage = tag[1];
  code = tag[2];
  if (stage.startsWith('A-')) exitCode = 2;
  else if (stage.startsWith('B-')) exitCode = 3;
  else if (stage.startsWith('C-')) exitCode = 4;
}

console.error(JSON.stringify({
  ok: false,
  exitCode,
  stage,
  code,
  nodeTestStatus: result.status,
  hint: 'grep stdout for [acceptance <stage>/<code>] — not-closed|no-exit|resume-blank|wrong-kill',
}, null, 2));
process.exit(exitCode);
