import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '..');
const skillsRoot = path.join(repository, 'skills');
const commands = [
  ['yjx-local-tracker-setup', 'scripts/setup-local-tracker.mjs'],
  ['yjx-local-kanban', 'scripts/issue-board.mjs'],
  ['yjx-local-ralph', 'scripts/select-issue.mjs'],
];

test('CLI scripts run when installed through a directory link', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-linked-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'skills'));

  for (const [skill, script] of commands) {
    const source = path.join(skillsRoot, skill);
    const linked = path.join(root, 'skills', skill);
    await symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [path.join(linked, script), '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${skill}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/, skill);
  }
});
