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
  assert.match(result.stdout, /mode:\s*review/i);
  assert.match(result.stdout, /Board \(read-only/i);
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
  assert.match(result.stdout, /soft-stuck|01-/);
  assert.match(result.stdout, /"stopped": true/);
  assert.match(result.stdout, /"subsequentMode": "review"/);
});

test('cli chain requires feature', () => {
  const result = runCli(['chain', '--fake-launcher', '--once']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /feature is required/);
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
