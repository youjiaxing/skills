import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPlan,
  canonicalizeTargets,
  checkAntigravityStatus,
  executePlan,
  isSkillsRootInAntigravity,
  readAntigravityConfig,
  scanSkills,
  syncAntigravityConfig,
} from '../scripts/link-skills.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-skills-'));
  const skills = path.join(root, 'skills');
  const prompts = path.join(root, 'prompts');
  const promptsLocal = path.join(root, 'prompts.local');
  const target = path.join(root, 'target');
  await mkdir(path.join(skills, 'yjx-one'), { recursive: true });
  await mkdir(prompts, { recursive: true });
  await mkdir(promptsLocal, { recursive: true });
  await writeFile(path.join(skills, 'yjx-one', 'SKILL.md'), '# one\n');
  await writeFile(path.join(prompts, 'AGENTS.md'), '# shared global prompt\n');
  return { root, skills, prompts, promptsLocal, target };
}

async function createLink(source, destination) {
  await symlink(path.resolve(source), destination, process.platform === 'win32' ? 'junction' : 'dir');
}

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

test('多个全局提示词入口链接至同一源文件或自定义源文件时保持独立状态且幂等', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));
  const customSource = path.join(work.promptsLocal, 'custom.md');
  await writeFile(customSource, '# custom prompt\n');

  const codexDest = path.join(work.root, 'home', '.codex', 'AGENTS.md');
  const claudeDest = path.join(work.root, 'home', '.claude', 'CLAUDE.md');
  const customDest = path.join(work.root, 'home', '.custom', 'AGENTS.md');
  const promptTargets = [
    codexDest,
    claudeDest,
    { target: customDest, source: 'prompts.local/custom.md' },
  ];

  const first = await buildPlan({
    promptTargets,
    root: work.skills,
    allowedPromptRoots: [work.prompts, work.promptsLocal],
  });
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.links.length, 3);
  await executePlan(first);

  assert.equal((await lstat(codexDest)).isSymbolicLink(), true);
  assert.equal((await lstat(claudeDest)).isSymbolicLink(), true);
  assert.equal(await readFile(customDest, 'utf8'), '# custom prompt\n');

  // 再次构建计划时，3 个已链接入口不得因指向同一 realpath 而被误合并
  const second = await buildPlan({
    promptTargets,
    root: work.skills,
    allowedPromptRoots: [work.prompts, work.promptsLocal],
  });
  assert.equal(second.links.length, 0);
  assert.equal(second.unchanged.length, 3);
});

test('提示词 --force 安全替换：不覆盖已有备份、链接失败时回滚原文件且拒绝删除目录', async (t) => {
  const work = await fixture();
  t.after(() => rm(work.root, { recursive: true, force: true }));

  const dest = path.join(work.root, 'home', '.codex', 'AGENTS.md');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, 'original user prompt\n');
  await writeFile(`${dest}.bak-before-link`, 'older backup\n');

  // 1. 模拟创建符号链接失败，验证原文件自动回滚且旧备份完好
  const failPlan = await buildPlan({
    promptTargets: [dest],
    force: true,
    root: work.skills,
    allowedPromptRoots: [work.prompts, work.promptsLocal],
  });
  assert.equal(failPlan.replacements.length, 1);
  await assert.rejects(
    () => executePlan(failPlan, { linkFn: async () => { throw new Error('EPERM symlink failed'); } }),
    /EPERM symlink failed/,
  );
  assert.equal((await lstat(dest)).isSymbolicLink(), false);
  assert.equal(await readFile(dest, 'utf8'), 'original user prompt\n');
  assert.equal(await readFile(`${dest}.bak-before-link`, 'utf8'), 'older backup\n');

  // 2. 正常执行 --force 替换，验证生成不冲突的新备份文件名并建立符号链接
  const okPlan = await buildPlan({
    promptTargets: [dest],
    force: true,
    root: work.skills,
    allowedPromptRoots: [work.prompts, work.promptsLocal],
  });
  await executePlan(okPlan);
  assert.equal((await lstat(dest)).isSymbolicLink(), true);
  assert.equal(await readFile(dest, 'utf8'), '# shared global prompt\n');
  assert.equal(await readFile(`${dest}.bak-before-link`, 'utf8'), 'older backup\n');
  assert.equal(await readFile(`${dest}.bak-before-link-1`, 'utf8'), 'original user prompt\n');

  // 3. 目标位置是目录时，即使传入 --force 也必须报冲突拒绝删除
  const dirDest = path.join(work.root, 'home', '.grok', 'AGENTS.md');
  await mkdir(dirDest, { recursive: true });
  const dirPlan = await buildPlan({
    promptTargets: [dirDest],
    force: true,
    root: work.skills,
    allowedPromptRoots: [work.prompts, work.promptsLocal],
  });
  assert.equal(dirPlan.conflicts.length, 1);
  assert.match(dirPlan.conflicts[0], /提示词目标路径是目录/);
});
