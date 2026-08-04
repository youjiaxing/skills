import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFileModeConfig,
  createMemoryModeConfig,
  resolveSubsequentMode,
} from '../scripts/mode-config.mjs';

test('resolveSubsequentMode: hard default is review', () => {
  assert.equal(resolveSubsequentMode({}), 'review');
});

test('resolveSubsequentMode: startup wins over repo until TUI supersedes', () => {
  assert.equal(
    resolveSubsequentMode({
      startupMode: 'review',
      repoMode: 'vibe',
    }),
    'review',
  );
  assert.equal(
    resolveSubsequentMode({
      startupMode: 'review',
      startupSupersededByTui: true,
      repoMode: 'vibe',
      tuiMode: 'vibe',
    }),
    'vibe',
  );
});

test('resolveSubsequentMode: after TUI, tuiMode beats stale repo', () => {
  assert.equal(
    resolveSubsequentMode({
      startupMode: 'review',
      startupSupersededByTui: true,
      repoMode: 'review',
      tuiMode: 'vibe',
    }),
    'vibe',
  );
});

test('file mode config: read/write persists mode under project root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'issue-crusher-mode-'));
  try {
    const config = createFileModeConfig({ projectRoot: root });
    assert.equal(config.readMode(), null);

    config.writeMode('vibe');
    assert.equal(config.readMode(), 'vibe');

    const raw = JSON.parse(readFileSync(config.path, 'utf8'));
    assert.equal(raw.mode, 'vibe');

    // Second instance re-reads the same file (repo truth across processes).
    const again = createFileModeConfig({ projectRoot: root });
    assert.equal(again.readMode(), 'vibe');
    again.writeMode('review');
    assert.equal(config.readMode(), 'review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory mode config: writeCount tracks persistence calls', () => {
  const config = createMemoryModeConfig({ mode: null });
  assert.equal(config.readMode(), null);
  assert.equal(config.writeCount, 0);
  config.writeMode('vibe');
  assert.equal(config.readMode(), 'vibe');
  assert.equal(config.writeCount, 1);
});

// --- 20260804-1802-tui-model-effort / 01: workers.<runtime>.{model,effort} buckets ---

test('memory model/effort: empty buckets read as null (omit flag)', () => {
  const config = createMemoryModeConfig({});
  assert.deepEqual(config.readModelEffort('grok'), { model: null, effort: null });
  assert.deepEqual(config.readModelEffort('claude'), { model: null, effort: null });
});

test('memory model/effort: write/read round-trips per runtime bucket', () => {
  const config = createMemoryModeConfig({});
  const written = config.writeModelEffort('grok', { model: 'grok-3.5', effort: 'high' });
  assert.deepEqual(written, { model: 'grok-3.5', effort: 'high' });

  assert.deepEqual(config.readModelEffort('grok'), { model: 'grok-3.5', effort: 'high' });
  // claude bucket stays untouched (no cross-runtime bleed).
  assert.deepEqual(config.readModelEffort('claude'), { model: null, effort: null });
  assert.equal(config.writeCount, 1, 'bucket write counts as a persistence call');

  config.writeModelEffort('claude', { model: 'opus', effort: 'max' });
  assert.deepEqual(config.readModelEffort('claude'), { model: 'opus', effort: 'max' });
  assert.deepEqual(config.readModelEffort('grok'), { model: 'grok-3.5', effort: 'high' });
});

test('memory model/effort: empty/whitespace values normalize to null', () => {
  const config = createMemoryModeConfig({});
  config.writeModelEffort('grok', { model: '  ', effort: '' });
  assert.deepEqual(config.readModelEffort('grok'), { model: null, effort: null });
  assert.equal(config.writeCount, 1);
});

test('memory model/effort: invalid runtime is rejected on read and write', () => {
  const config = createMemoryModeConfig({});
  assert.throws(() => config.readModelEffort('gemini'), /invalid runtime/);
  assert.throws(() => config.writeModelEffort('gemini', { model: 'x' }), /invalid runtime/);
});

test('memory model/effort: seeded workers bucket is honored at construction', () => {
  const config = createMemoryModeConfig({
    workers: { grok: { model: 'grok-4', effort: 'medium' } },
  });
  assert.deepEqual(config.readModelEffort('grok'), { model: 'grok-4', effort: 'medium' });
  assert.deepEqual(config.readModelEffort('claude'), { model: null, effort: null });
});

test('file model/effort: buckets persist under project root and coexist with mode/runtime', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'issue-crusher-me-'));
  try {
    const config = createFileModeConfig({ projectRoot: root });
    assert.deepEqual(config.readModelEffort('grok'), { model: null, effort: null });

    config.writeMode('vibe');
    config.writeModelEffort('grok', { model: 'grok-3.5', effort: 'high' });

    const raw = JSON.parse(readFileSync(config.path, 'utf8'));
    assert.equal(raw.mode, 'vibe');
    assert.equal(raw.runtime, undefined, 'runtime key untouched unless written');
    assert.deepEqual(raw.workers.grok, { model: 'grok-3.5', effort: 'high' });
    assert.equal(raw.workers.claude, undefined, 'no cross-runtime bucket invented');

    assert.deepEqual(config.readModelEffort('grok'), { model: 'grok-3.5', effort: 'high' });

    // Second instance re-reads the same file (repo truth across processes).
    const again = createFileModeConfig({ projectRoot: root });
    assert.deepEqual(again.readModelEffort('grok'), { model: 'grok-3.5', effort: 'high' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file model/effort: empty values omit keys and clear the bucket (read as null)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'issue-crusher-me2-'));
  try {
    const config = createFileModeConfig({ projectRoot: root });
    config.writeModelEffort('grok', { model: 'grok-3.5', effort: 'high' });

    // Clearing one dimension omits just that key.
    config.writeModelEffort('grok', { model: 'grok-3.5', effort: null });
    let raw = JSON.parse(readFileSync(config.path, 'utf8'));
    assert.deepEqual(raw.workers.grok, { model: 'grok-3.5' });
    assert.deepEqual(config.readModelEffort('grok'), { model: 'grok-3.5', effort: null });

    // Clearing both removes the bucket entirely; empty workers object is dropped.
    config.writeModelEffort('grok', { model: null, effort: '' });
    raw = JSON.parse(readFileSync(config.path, 'utf8'));
    assert.equal(raw.workers, undefined, 'empty workers container is omitted from file');
    assert.deepEqual(config.readModelEffort('grok'), { model: null, effort: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file model/effort: bucket writes never touch mode or the other runtime bucket', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'issue-crusher-me3-'));
  try {
    const config = createFileModeConfig({ projectRoot: root });
    config.writeMode('review');
    config.writeModelEffort('claude', { model: 'opus', effort: 'max' });

    const raw = JSON.parse(readFileSync(config.path, 'utf8'));
    assert.equal(raw.mode, 'review');
    assert.deepEqual(raw.workers.claude, { model: 'opus', effort: 'max' });

    config.writeModelEffort('claude', { model: 'sonnet' });
    const after = JSON.parse(readFileSync(config.path, 'utf8'));
    assert.equal(after.mode, 'review', 'mode survives bucket rewrite');
    assert.deepEqual(after.workers.claude, { model: 'sonnet' });
    assert.equal(after.workers.grok, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file model/effort: invalid runtime is rejected on write', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'issue-crusher-me4-'));
  try {
    const config = createFileModeConfig({ projectRoot: root });
    assert.throws(() => config.writeModelEffort('gemini', { model: 'x' }), /invalid runtime/);
    assert.equal(createFileModeConfig({ projectRoot: root }).readModelEffort('grok').model, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
