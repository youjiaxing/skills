import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// --- 20260804-1802-tui-model-effort / 01: CLI model/effort init and repo bucket ---

test('cli chain --once carries --model/--effort into snapshot and pinned slot', () => {
  const result = runCli([
    'chain',
    '--feature', 'demo',
    '--cwd', singleFixture,
    '--project-root', singleFixture,
    '--runtime', 'grok',
    '--fake-launcher',
    '--model', 'grok-3.5',
    '--effort', 'high',
    '--once',
    '--stop',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"subsequentModel": "grok-3\.5"/);
  assert.match(result.stdout, /"subsequentEffort": "high"/);
  // The spawned fake slot pins the same values (snapshot slot.model/effort).
  assert.match(result.stdout, /"model": "grok-3\.5"/);
  assert.match(result.stdout, /"effort": "high"/);
});

test('cli chain --once without model/effort omits flags (runtime default)', () => {
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
  assert.match(result.stdout, /"subsequentModel": null/);
  assert.match(result.stdout, /"subsequentEffort": null/);
});

test('cli chain --once seeds subsequent model/effort from repo workers bucket', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ic-cli-bucket-'));
  try {
    cpSync(emptyFixture, root, { recursive: true });
    mkdirSync(path.join(root, '.issue-crusher'), { recursive: true });
    writeFileSync(
      path.join(root, '.issue-crusher', 'config.json'),
      JSON.stringify({ workers: { grok: { model: 'grok-4', effort: 'medium' } } }, null, 2),
    );
    const result = runCli([
      'chain',
      '--feature', 'demo',
      '--cwd', root,
      '--project-root', root,
      '--runtime', 'grok',
      '--fake-launcher',
      '--once',
      '--stop',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"subsequentModel": "grok-4"/);
    assert.match(result.stdout, /"subsequentEffort": "medium"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli chain --once: flag beats repo bucket (flag wins over repo per dimension)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ic-cli-flagwins-'));
  try {
    cpSync(emptyFixture, root, { recursive: true });
    mkdirSync(path.join(root, '.issue-crusher'), { recursive: true });
    writeFileSync(
      path.join(root, '.issue-crusher', 'config.json'),
      JSON.stringify({ workers: { grok: { model: 'grok-4', effort: 'medium' } } }, null, 2),
    );
    const result = runCli([
      'chain',
      '--feature', 'demo',
      '--cwd', root,
      '--project-root', root,
      '--runtime', 'grok',
      '--fake-launcher',
      '--model', 'grok-3.5',
      '--once',
      '--stop',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"subsequentModel": "grok-3\.5"/, 'flag model wins');
    assert.match(result.stdout, /"subsequentEffort": "medium"/, 'effort falls back to repo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
