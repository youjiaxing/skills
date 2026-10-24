import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const skillsRoot = path.join(import.meta.dirname, '..', 'skills');

// The repository distributes skills as directory symlinks. A CLI whose main-module
// check compares paths without resolving symlinks exits 0 while doing nothing, so
// assert real work happened instead of only the exit code.
test('CLI entrypoints still run when invoked through a symlinked skill directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-linked-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = path.join(root, 'yjx-gh-kanban');
  await symlink(path.join(skillsRoot, 'yjx-gh-kanban'), linked, process.platform === 'win32' ? 'junction' : 'dir');

  const result = spawnSync(process.execPath, [path.join(linked, 'scripts', 'issue-board.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), '', 'CLI exited 0 without running its main entry');
});
