import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BOARD_SCRIPT_RELATIVE,
  SKILL_NAME,
  defaultSkillRoots,
  resolveBoardScript,
} from '../scripts/resolve-board-script.mjs';

async function makeSkillsRoot(t, { withSkill = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-gh-kanban-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (withSkill) {
    const scriptDir = path.join(root, SKILL_NAME, 'scripts');
    await mkdir(scriptDir, { recursive: true });
    await writeFile(path.join(scriptDir, 'issue-board.mjs'), 'export {}\n', 'utf8');
    await writeFile(path.join(root, SKILL_NAME, 'SKILL.md'), '# skill\n', 'utf8');
  }
  return root;
}

test('defaultSkillRoots includes sibling install root and standard agent skills directories', () => {
  const home = path.resolve('/Users/example');
  const projectRoot = path.resolve('/repo');
  const roots = defaultSkillRoots({ home, env: {}, projectRoot });
  assert.ok(roots.includes(path.join(home, '.agents', 'skills')));
  assert.ok(roots.includes(path.join(projectRoot, '.agents', 'skills')));
});

test('defaultSkillRoots honors env override and does not invent monorepo absolute paths', () => {
  const home = '/Users/example';
  const roots = defaultSkillRoots({
    home,
    env: { YJX_SKILLS_ROOT: '/custom/skills-root' },
    projectRoot: null,
  });
  assert.equal(roots[0], path.resolve('/custom/skills-root'));
  assert.ok(roots.every((root) => !root.includes('family-health-app')));
  assert.ok(roots.every((root) => !/Code\/youjiaxing\/skills$/.test(root)));
});

test('resolveBoardScript finds the board script under a fake skills root', async (t) => {
  const skillsRoot = await makeSkillsRoot(t, { withSkill: true });
  const result = await resolveBoardScript({ roots: [skillsRoot] });
  assert.equal(result.root, skillsRoot);
  assert.equal(result.skillDir, path.join(skillsRoot, SKILL_NAME));
  assert.equal(result.scriptPath, path.join(skillsRoot, SKILL_NAME, BOARD_SCRIPT_RELATIVE));
});

test('resolveBoardScript fails closed with readable install guidance when missing', async (t) => {
  const emptyRoot = await makeSkillsRoot(t, { withSkill: false });
  await assert.rejects(
    () => resolveBoardScript({ roots: [emptyRoot] }),
    (error) => {
      assert.match(String(error.message), /yjx-gh-kanban/);
      assert.match(String(error.message), /issue-board\.mjs/);
      assert.match(String(error.message), /npx skills add youjiaxing\/skills/);
      assert.doesNotMatch(String(error.message), /family-health-app/);
      assert.doesNotMatch(String(error.message), /\.agents\/skills\/kanban/);
      return true;
    },
  );
});

test('resolveBoardScript prefers earlier roots and ignores later missing ones', async (t) => {
  const emptyRoot = await makeSkillsRoot(t, { withSkill: false });
  const fullRoot = await makeSkillsRoot(t, { withSkill: true });
  const result = await resolveBoardScript({ roots: [emptyRoot, fullRoot] });
  assert.equal(result.root, fullRoot);
});
