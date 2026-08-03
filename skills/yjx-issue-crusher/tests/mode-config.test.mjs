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
