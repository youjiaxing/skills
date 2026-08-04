import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(skillDir, 'scripts', 'cli.mjs');
const emptyFixture = path.join(skillDir, 'fixtures', 'empty-frontier');
const singleFixture = path.join(skillDir, 'fixtures', 'single-ready');

function runCli(args, cwd = skillDir) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('cli chain --once on empty frontier: idle, zero worker identity, printable frame', () => {
  const result = runCli([
    'chain',
    '--feature', 'demo',
    '--cwd', emptyFixture,
    '--project-root', emptyFixture,
    '--fake-launcher',
    '--once',
    '--stop',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /mode:\s*review|后续 mode:\s*review/i);
  assert.match(result.stdout, /依赖图|不可图上派票/);
  assert.match(result.stdout, /"status": "stopped"/);
  assert.match(result.stdout, /"stopped": true/);
  assert.match(result.stdout, /"slot": null/);
});

test('cli chain --once on single-ready fixture spawns fake slot then can stop', () => {
  const result = runCli([
    'chain',
    '--feature', 'demo',
    '--cwd', singleFixture,
    '--project-root', singleFixture,
    '--runtime', 'grok',
    '--fake-launcher',
    '--once',
    '--stop',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /软卡住|02-do-work/);
  assert.match(result.stdout, /"stopped": true/);
  assert.match(result.stdout, /"subsequentMode": "review"/);
});

test('cli chain without feature in non-interactive fails helpfully', () => {
  const result = runCli(['chain', '--fake-launcher', '--once']);
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}${result.stdout}`,
    /未找到 feature|多个 feature|tracker config not found|请指定/,
  );
});

test('cli short form: positional feature defaults to chain', () => {
  const result = runCli([
    'demo',
    '--cwd', emptyFixture,
    '--project-root', emptyFixture,
    '--fake-launcher',
    '--once',
    '--stop',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"feature": "demo"/);
  assert.match(result.stdout, /"stopped": true/);
});

test('cli short form: chain <feature> positional', () => {
  const result = runCli([
    'chain',
    'demo',
    '--cwd', singleFixture,
    '--project-root', singleFixture,
    '--fake-launcher',
    '--once',
    '--stop',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /soft-stuck|02-do-work/);
});

// --- 20260804-1006-fix-fullscreen-cold-start / 03: --once non-fullscreen still spawns ---

test('regression 03: --once + fake-launcher still spawns on ready board (not fullscreen gate)', () => {
  const result = runCli([
    'chain',
    '--feature', 'demo',
    '--cwd', singleFixture,
    '--project-root', singleFixture,
    '--runtime', 'grok',
    '--fake-launcher',
    '--once',
    '--stop',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // Non-fullscreen once path must still attempt open-next (slot occupied / soft-stuck).
  assert.match(result.stdout, /02-do-work|软卡住|soft-stuck/);
  assert.doesNotMatch(result.stdout, /"slot": null/);
  assert.match(result.stdout, /"stopped": true/);
});
