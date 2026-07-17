#!/usr/bin/env node

import { access, copyFile, lstat, mkdir, readFile, readdir, readlink, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseDocument } from 'yaml';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, '..');
export const skillsRoot = path.join(repoRoot, 'skills');
export const localConfigPath = path.join(repoRoot, 'developer-targets.local.yaml');
export const templateConfigPath = path.join(repoRoot, 'developer-targets.example.yaml');

const COMMON_TARGETS = [
  { label: 'Claude Code', value: '~/.claude/skills' },
  { label: 'Codex', value: '~/.codex/skills' },
  { label: 'Agent Skills 通用目录', value: '~/.agents/skills' },
];

function pathKey(value) {
  let normalized = path.normalize(path.resolve(value));
  if (process.platform === 'win32') {
    normalized = normalized.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase();
  }
  return normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function isDirectChild(parent, child) {
  return samePath(path.dirname(path.resolve(child)), parent);
}

async function pathInfo(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function resolveLinkTarget(linkPath, target) {
  return path.resolve(path.dirname(linkPath), target);
}

export function expandTargetPath(value, env = process.env, home = os.homedir()) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('目标目录必须是非空字符串');
  }

  let expanded = value.trim();
  expanded = expanded.replace(/^~(?=$|[\\/])/, home);
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([^%]+)%/g, (match, braced, plain, windowsName) => {
    const name = braced ?? plain ?? windowsName;
    if (!(name in env)) throw new Error(`环境变量未定义: ${name}`);
    return env[name];
  });
  return path.resolve(expanded);
}

export async function scanSkills(root = skillsRoot) {
  const entries = await readdir(root, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = path.join(root, entry.name);
    try {
      await access(path.join(source, 'SKILL.md'));
      skills.push({ name: entry.name, source });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readTargets(configPath = localConfigPath) {
  const source = await readFile(configPath, 'utf8');
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`配置文件格式错误: ${document.errors.map((error) => error.message).join('; ')}`);
  }

  const config = document.toJS() ?? {};
  if (!Array.isArray(config.targets)) throw new Error('配置项 targets 必须是数组');
  return config.targets.map((target) => expandTargetPath(target));
}

export function mergeTargets(configTargets, cliTargets) {
  const merged = [...configTargets, ...cliTargets.map((target) => expandTargetPath(target))];
  return [...new Map(merged.map((target) => [pathKey(target), target])).values()];
}

async function inspectExistingLink(linkPath) {
  const info = await pathInfo(linkPath);
  if (!info) return { kind: 'missing' };
  if (!info.isSymbolicLink()) return { kind: 'other' };

  const rawTarget = await readlink(linkPath);
  return { kind: 'link', target: resolveLinkTarget(linkPath, rawTarget) };
}

async function validateTargetRoot(targetRoot, root = skillsRoot) {
  if (samePath(targetRoot, root) || pathKey(targetRoot).startsWith(`${pathKey(root)}${path.sep}`)) {
    return `目标目录不能位于仓库 skills/ 内: ${targetRoot}`;
  }

  try {
    const info = await stat(targetRoot);
    if (!info.isDirectory()) return `目标路径不是目录: ${targetRoot}`;
  } catch (error) {
    if (error.code !== 'ENOENT') return `无法访问目标目录 ${targetRoot}: ${error.message}`;
  }
  return null;
}

async function collectPruneActions(targetRoot, currentSkills, root = skillsRoot) {
  const rootInfo = await pathInfo(targetRoot);
  if (!rootInfo) return [];

  const currentSources = new Set(currentSkills.map((skill) => pathKey(skill.source)));
  const entries = await readdir(targetRoot, { withFileTypes: true });
  const actions = [];

  for (const entry of entries) {
    const linkPath = path.join(targetRoot, entry.name);
    const existing = await inspectExistingLink(linkPath);
    if (existing.kind !== 'link') continue;
    if (!isDirectChild(root, existing.target)) continue;
    if (currentSources.has(pathKey(existing.target))) continue;
    actions.push({ destination: linkPath, source: existing.target });
  }
  return actions;
}

export async function buildPlan({ skills, targets, force = false, prune = false, root = skillsRoot }) {
  const plan = { mkdirs: [], links: [], replacements: [], prunes: [], unchanged: [], conflicts: [] };

  // 第一阶段只读取文件系统并构造完整计划，任何冲突都会阻止后续写入。
  for (const targetRoot of targets) {
    const rootError = await validateTargetRoot(targetRoot, root);
    if (rootError) {
      plan.conflicts.push(rootError);
      continue;
    }
    if (!(await pathInfo(targetRoot))) plan.mkdirs.push(targetRoot);

    for (const skill of skills) {
      const destination = path.join(targetRoot, skill.name);
      const existing = await inspectExistingLink(destination);
      if (existing.kind === 'missing') {
        plan.links.push({ source: skill.source, destination });
      } else if (existing.kind === 'link' && samePath(existing.target, skill.source)) {
        plan.unchanged.push({ source: skill.source, destination });
      } else if (force) {
        plan.replacements.push({ source: skill.source, destination });
      } else {
        const detail = existing.kind === 'link' ? `当前指向 ${existing.target}` : '当前是普通文件或目录';
        plan.conflicts.push(`目标已存在: ${destination}（${detail}）`);
      }
    }

    if (prune) plan.prunes.push(...await collectPruneActions(targetRoot, skills, root));
  }

  return plan;
}

async function removePath(targetPath) {
  const info = await pathInfo(targetPath);
  if (!info) return;
  if (info.isSymbolicLink()) {
    await unlink(targetPath);
  } else {
    await rm(targetPath, { recursive: true, force: true });
  }
}

async function createDirectoryLink(source, destination) {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(path.resolve(source), destination, type);
}

export async function executePlan(plan) {
  if (plan.conflicts.length > 0) throw new Error('存在冲突，不能执行计划');

  // 第二阶段才执行写操作；先建立目标根目录，再逐项清理、替换和创建链接。
  for (const targetRoot of plan.mkdirs) await mkdir(targetRoot, { recursive: true });
  for (const action of plan.prunes) await removePath(action.destination);
  for (const action of plan.replacements) {
    await removePath(action.destination);
    await createDirectoryLink(action.source, action.destination);
  }
  for (const action of plan.links) await createDirectoryLink(action.source, action.destination);
}

export function formatPlan(plan) {
  const lines = [];
  for (const action of plan.unchanged) lines.push(`= 已正确链接  ${action.destination}`);
  for (const action of plan.links) lines.push(`+ 创建链接    ${action.destination} -> ${action.source}`);
  for (const action of plan.replacements) lines.push(`! 删除并链接  ${action.destination} -> ${action.source}`);
  for (const action of plan.prunes) lines.push(`- 清理旧链接  ${action.destination} -> ${action.source}`);
  if (lines.length === 0) lines.push('没有需要处理的链接。');
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'link';
  const options = { command, targets: [], force: false, prune: false, noConfig: false, help: false };

  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--force') options.force = true;
    else if (argument === '--prune') options.prune = true;
    else if (argument === '--no-config') options.noConfig = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--target') {
      if (args.length === 0) throw new Error('--target 缺少目录参数');
      options.targets.push(args.shift());
    } else if (argument.startsWith('--target=')) options.targets.push(argument.slice('--target='.length));
    else throw new Error(`未知参数: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`用法: node scripts/link-skills.mjs <command> [options]\n\n命令:\n  init      交互配置本机目标目录\n  link      创建或校验 skill 链接\n  status    只检查链接状态\n\n选项:\n  --target PATH   临时追加目标目录，可重复使用\n  --no-config     忽略本机配置，只使用 --target\n  --force         删除冲突路径并重建链接\n  --prune         清理本仓库管理的陈旧链接\n  -h, --help      显示帮助`);
}

async function ensureLocalConfig({ stopAfterCreate }) {
  if (await pathInfo(localConfigPath)) return false;
  await copyFile(templateConfigPath, localConfigPath);
  console.log(`已创建本机配置: ${localConfigPath}`);
  if (stopAfterCreate) console.log('请编辑配置或运行 npm run init，然后重新执行。');
  return true;
}

function parseSelection(input, candidates, currentIndexes) {
  if (input.trim() === '') return currentIndexes;
  if (input.trim() === '0') return [];
  const indexes = input.split(',').map((part) => Number.parseInt(part.trim(), 10) - 1);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= candidates.length)) {
    throw new Error('候选编号无效');
  }
  return [...new Set(indexes)];
}

async function runInit() {
  await ensureLocalConfig({ stopAfterCreate: false });
  const source = await readFile(localConfigPath, 'utf8');
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error(`配置文件格式错误: ${document.errors[0].message}`);

  const configured = document.get('targets', true)?.toJSON() ?? [];
  const configuredKeys = new Set(configured.map((target) => pathKey(expandTargetPath(target))));
  const currentIndexes = COMMON_TARGETS.flatMap((candidate, index) => configuredKeys.has(pathKey(expandTargetPath(candidate.value))) ? [index] : []);
  const customTargets = configured.filter((target) => !COMMON_TARGETS.some((candidate) => samePath(expandTargetPath(candidate.value), expandTargetPath(target))));

  console.log('常见 Agent 全局 skill 目录：');
  COMMON_TARGETS.forEach((candidate, index) => {
    const selected = currentIndexes.includes(index) ? 'x' : ' ';
    console.log(`  ${index + 1}. [${selected}] ${candidate.label}: ${candidate.value}`);
  });

  let scriptedAnswers = null;
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    scriptedAnswers = input.split(/\r?\n/);
  }
  const readline = scriptedAnswers ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt) => {
    if (readline) return readline.question(prompt);
    process.stdout.write(prompt);
    return scriptedAnswers.shift() ?? '';
  };

  try {
    const selection = await ask('选择候选编号（逗号分隔；0 表示全不选；回车保留当前值）：');
    const selectedIndexes = parseSelection(selection, COMMON_TARGETS, currentIndexes);
    const custom = await ask(`自定义目录（逗号分隔；回车保留当前值${customTargets.length ? `：${customTargets.join(', ')}` : ''}）：`);
    const selectedCustom = custom.trim() === '' ? customTargets : custom.split(',').map((item) => item.trim()).filter(Boolean);
    const targets = [...selectedIndexes.map((index) => COMMON_TARGETS[index].value), ...selectedCustom];

    document.set('targets', targets);
    await writeFile(localConfigPath, document.toString(), 'utf8');
    console.log(`\n已更新本机配置，共 ${targets.length} 个目标目录。`);
  } finally {
    readline?.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!['init', 'link', 'status'].includes(options.command)) throw new Error(`未知命令: ${options.command}`);
  if (options.command === 'init') {
    await runInit();
    return;
  }
  if (options.command === 'status' && (options.force || options.prune)) throw new Error('status 不接受 --force 或 --prune');

  let configTargets = [];
  if (!options.noConfig) {
    const created = await ensureLocalConfig({ stopAfterCreate: true });
    if (created) return;
    configTargets = await readTargets();
  }

  const targets = mergeTargets(configTargets, options.targets);
  if (targets.length === 0) throw new Error('没有目标目录；请运行 npm run init、编辑本机配置，或传入 --target');
  const skills = await scanSkills();
  if (skills.length === 0) throw new Error('skills/ 下没有包含 SKILL.md 的直接子目录');

  const plan = await buildPlan({ skills, targets, force: options.force, prune: options.prune });
  console.log(formatPlan(plan));
  if (plan.conflicts.length > 0) {
    console.error('\n发现冲突，未执行任何修改：');
    plan.conflicts.forEach((conflict) => console.error(`- ${conflict}`));
    process.exitCode = 1;
    return;
  }
  if (options.command === 'status') return;

  await executePlan(plan);
  console.log('\n处理完成。');
}

const isMain = process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  });
}
