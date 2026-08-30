import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPlan,
  canonicalizeTargets,
  checkAntigravityStatus,
  executePlan,
  expandTargetPath,
  isSkillsRootInAntigravity,
  mergeTargets,
  readAntigravityConfig,
  readDeveloperConfig,
  scanSkills,
  syncAntigravityConfig,
} from '../scripts/link-skills.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-skills-'));
  const skills = path.join(root, 'skills');
  const target = path.join(root, 'target');
  await mkdir(path.join(skills, 'yjx-one'), { recursive: true });
  await writeFile(path.join(skills, 'yjx-one', 'SKILL.md'), '# one\n');
  return { root, skills, target };
}

async function createLink(source, destination) {
  await symlink(path.resolve(source), destination, process.platform === 'win32' ? 'junction' : 'dir');
}

async function collectSkillFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectSkillFiles(entryPath));
    else if (entry.isFile() && entry.name === 'SKILL.md') files.push(entryPath);
  }
  return files;
}

test('可发布 SKILL.md 只能位于顶层 skills 目录', async () => {
  const repository = path.resolve(import.meta.dirname, '..');
  const files = await collectSkillFiles(repository);
  const unexpected = files.filter((file) => {
    const relative = path.relative(repository, file).split(path.sep);
    return relative.length !== 3 || relative[0] !== 'skills' || relative[2] !== 'SKILL.md';
  });

  assert.deepEqual(unexpected, []);
});

test('只扫描包含 SKILL.md 的直接子目录', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  await mkdir(path.join(work.skills, 'draft'));
  await mkdir(path.join(work.skills, 'nested', 'yjx-two'), { recursive: true });
  await writeFile(path.join(work.skills, 'nested', 'yjx-two', 'SKILL.md'), '# two\n');

  const skills = await scanSkills(work.skills);
  assert.deepEqual(skills.map((skill) => skill.name), ['yjx-one']);
});

test('目标目录会展开环境变量并去重', () => {
  const expanded = expandTargetPath('$SKILL_HOME/skills', { SKILL_HOME: '/tmp/example' }, '/home/user');
  assert.equal(expanded, path.resolve('/tmp/example/skills'));
  assert.equal(mergeTargets([expanded], [expanded]).length, 1);
});

test('指向同一实际目录的符号链接目标目录会被去重', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  await mkdir(work.target);
  const aliasTarget = path.join(work.root, 'alias-target');
  await createLink(work.target, aliasTarget);

  const canonical = await canonicalizeTargets([work.target, aliasTarget]);
  assert.equal(canonical.length, 1);

  const skills = await scanSkills(work.skills);
  const plan = await buildPlan({ skills, targets: [work.target, aliasTarget], root: work.skills });
  assert.equal(plan.links.length, 1);
  await executePlan(plan);
  assert.equal((await lstat(path.join(work.target, 'yjx-one'))).isSymbolicLink(), true);
});

test('发现任意冲突时计划不会执行', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  const secondTarget = path.join(work.root, 'second-target');
  await mkdir(work.target);
  await writeFile(path.join(work.target, 'yjx-one'), 'conflict');

  const skills = await scanSkills(work.skills);
  const plan = await buildPlan({ skills, targets: [work.target, secondTarget], root: work.skills });
  assert.equal(plan.conflicts.length, 1);
  await assert.rejects(() => executePlan(plan), /存在冲突/);
  await assert.rejects(() => lstat(path.join(secondTarget, 'yjx-one')), { code: 'ENOENT' });
});

test('创建链接后重复执行保持幂等', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  const skills = await scanSkills(work.skills);

  const first = await buildPlan({ skills, targets: [work.target], root: work.skills });
  await executePlan(first);
  const second = await buildPlan({ skills, targets: [work.target], root: work.skills });

  assert.equal(second.links.length, 0);
  assert.equal(second.unchanged.length, 1);
  assert.equal(path.resolve(path.dirname(path.join(work.target, 'yjx-one')), await readlink(path.join(work.target, 'yjx-one'))), path.resolve(skills[0].source));
});

test('--force 对冲突目录生成替换计划', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  await mkdir(path.join(work.target, 'yjx-one'), { recursive: true });
  await writeFile(path.join(work.target, 'yjx-one', 'local.txt'), 'local changes');

  const skills = await scanSkills(work.skills);
  const plan = await buildPlan({ skills, targets: [work.target], force: true, root: work.skills });
  assert.equal(plan.replacements.length, 1);
  await executePlan(plan);
  assert.equal((await lstat(path.join(work.target, 'yjx-one'))).isSymbolicLink(), true);
});

test('--prune 只清理当前 skills 根目录下的陈旧链接', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  const staleSource = path.join(work.skills, 'yjx-old');
  const foreignRoot = path.join(work.root, 'foreign');
  const foreignSource = path.join(foreignRoot, 'other');
  await mkdir(staleSource);
  await mkdir(foreignSource, { recursive: true });
  await mkdir(work.target);
  await createLink(staleSource, path.join(work.target, 'yjx-old'));
  await createLink(foreignSource, path.join(work.target, 'other'));
  await rm(staleSource, { recursive: true });

  const skills = await scanSkills(work.skills);
  const plan = await buildPlan({ skills, targets: [work.target], prune: true, root: work.skills });
  assert.deepEqual(plan.prunes.map((action) => path.basename(action.destination)), ['yjx-old']);
  await executePlan(plan);
  await assert.rejects(() => lstat(path.join(work.target, 'yjx-old')), { code: 'ENOENT' });
  assert.equal((await lstat(path.join(work.target, 'other'))).isSymbolicLink(), true);
});

test('readDeveloperConfig 解析 targets 与 antigravity 状态', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  const configPath = path.join(work.root, 'config.yaml');
  await writeFile(configPath, 'targets:\n  - /custom/skills\nantigravity: true\n', 'utf8');

  const config = await readDeveloperConfig(configPath);
  assert.deepEqual(config.targets, [path.resolve('/custom/skills')]);
  assert.equal(config.antigravity, true);
});

test('Antigravity skills.json 检查与同步幂等性', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  const agJson = path.join(work.root, 'skills.json');

  // 1. 初始状态：文件不存在
  const initialStatus = await checkAntigravityStatus({ enabled: true, root: work.skills, filePath: agJson });
  assert.equal(initialStatus.status, 'missing');

  // 2. 写入同步
  const syncResult1 = await syncAntigravityConfig({ enabled: true, root: work.skills, filePath: agJson });
  assert.equal(syncResult1.action, 'updated');

  const parsed1 = await readAntigravityConfig(agJson);
  assert.equal(isSkillsRootInAntigravity(parsed1, work.skills), true);

  // 3. 再次检查：已配置
  const configuredStatus = await checkAntigravityStatus({ enabled: true, root: work.skills, filePath: agJson });
  assert.equal(configuredStatus.status, 'configured');

  // 4. 重复同步保持幂等
  const syncResult2 = await syncAntigravityConfig({ enabled: true, root: work.skills, filePath: agJson });
  assert.equal(syncResult2.action, 'unchanged');
});

