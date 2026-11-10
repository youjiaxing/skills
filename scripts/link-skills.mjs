#!/usr/bin/env node

import { access, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseDocument } from 'yaml';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, '..');
export const skillsRoot = path.join(repoRoot, 'skills');
export const promptsRoot = path.join(repoRoot, 'prompts');
export const promptsLocalRoot = path.join(repoRoot, 'prompts.local');
export const defaultPromptSource = path.join(promptsRoot, 'AGENTS.md');
export const localConfigPath = path.join(repoRoot, 'developer-targets.local.yaml');
export const templateConfigPath = path.join(repoRoot, 'developer-targets.example.yaml');
export const antigravityConfigPath = path.join(os.homedir(), '.gemini', 'config', 'skills.json');

const COMMON_TARGETS = [
  { label: 'Claude Code', value: '~/.claude/skills' },
  { label: 'Codex', value: '~/.codex/skills' },
  { label: 'Agent Skills 通用目录', value: '~/.agents/skills' },
  { label: 'CodeBuddy Code', value: '~/.codebuddy/skills' },
  { label: 'Grok Build', value: '~/.grok/skills' },
];

export const COMMON_PROMPT_TARGETS = [
  { label: 'Codex (Desktop & CLI)', value: '~/.codex/AGENTS.md' },
  { label: 'Grok Build', value: '~/.grok/AGENTS.md' },
  { label: 'Antigravity IDE & Agy CLI', value: '~/.gemini/config/AGENTS.md' },
  { label: 'Claude Code', value: '~/.claude/CLAUDE.md' },
  { label: 'CodeBuddy (IDE & CLI)', value: '~/.codebuddy/CODEBUDDY.md' },
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

function isInsideRoot(root, candidate) {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`);
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
    throw new Error('目标路径必须是非空字符串');
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

export function normalizePromptTargets(rawEntries = [], {
  env = process.env,
  home = os.homedir(),
  baseRoot = repoRoot,
  defaultSource = path.join(baseRoot, 'prompts', 'AGENTS.md'),
} = {}) {
  if (!Array.isArray(rawEntries)) {
    throw new Error('配置项 prompt_targets 必须是数组');
  }
  return rawEntries.map((entry) => {
    if (typeof entry === 'string') {
      return {
        destination: expandTargetPath(entry, env, home),
        source: path.resolve(defaultSource),
      };
    }
    if (!entry || typeof entry !== 'object' || typeof entry.target !== 'string' || entry.target.trim() === '') {
      throw new Error('prompt_targets 条目必须是路径字符串或包含 target 的对象');
    }
    const destination = expandTargetPath(entry.target, env, home);
    let source = path.resolve(defaultSource);
    if (entry.source !== undefined) {
      if (typeof entry.source !== 'string' || entry.source.trim() === '') {
        throw new Error('prompt_targets.source 必须是非空字符串');
      }
      const trimmedSource = entry.source.trim();
      source = path.isAbsolute(trimmedSource) || trimmedSource.startsWith('~')
        ? expandTargetPath(trimmedSource, env, home)
        : path.resolve(baseRoot, trimmedSource);
    }
    return { destination, source };
  });
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

export async function readDeveloperConfig(configPath = localConfigPath) {
  const source = await readFile(configPath, 'utf8');
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`配置文件格式错误: ${document.errors.map((error) => error.message).join('; ')}`);
  }

  const config = document.toJS() ?? {};
  if (config.targets !== undefined && !Array.isArray(config.targets)) {
    throw new Error('配置项 targets 必须是数组');
  }
  const targets = (config.targets ?? []).map((target) => expandTargetPath(target));
  const antigravity = Boolean(config.antigravity);
  const promptTargets = normalizePromptTargets(config.prompt_targets ?? []);
  return { targets, antigravity, promptTargets, document };
}

export async function readTargets(configPath = localConfigPath) {
  const { targets } = await readDeveloperConfig(configPath);
  return targets;
}

export async function readAntigravityConfig(filePath = antigravityConfigPath) {
  try {
    const source = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null) return { entries: [] };
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [] };
    throw error;
  }
}

export function isSkillsRootInAntigravity(antigravityConfig, root = skillsRoot) {
  const targetKey = pathKey(root);
  return (antigravityConfig.entries ?? []).some((entry) => {
    if (!entry || typeof entry.path !== 'string') return false;
    try {
      return samePath(expandTargetPath(entry.path), targetKey);
    } catch {
      return false;
    }
  });
}

export async function checkAntigravityStatus({ enabled = false, root = skillsRoot, filePath = antigravityConfigPath } = {}) {
  if (!enabled) return { status: 'disabled', path: filePath };
  const config = await readAntigravityConfig(filePath);
  const mounted = isSkillsRootInAntigravity(config, root);
  return {
    status: mounted ? 'configured' : 'missing',
    path: filePath,
    entryPath: path.resolve(root).replaceAll('\\', '/'),
  };
}

export async function syncAntigravityConfig({ enabled = false, root = skillsRoot, filePath = antigravityConfigPath } = {}) {
  if (!enabled) return { action: 'skipped' };
  const config = await readAntigravityConfig(filePath);
  if (isSkillsRootInAntigravity(config, root)) {
    return { action: 'unchanged', path: filePath };
  }
  const normalizedEntryPath = path.resolve(root).replaceAll('\\', '/');
  const updated = {
    ...config,
    entries: [
      ...(config.entries ?? []),
      { path: normalizedEntryPath },
    ],
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  return { action: 'updated', path: filePath, entryPath: normalizedEntryPath };
}

export function mergeTargets(configTargets, cliTargets) {
  const merged = [...configTargets, ...cliTargets.map((target) => expandTargetPath(target))];
  return [...new Map(merged.map((target) => [pathKey(target), target])).values()];
}

async function inspectExistingLink(linkPath) {
  const info = await pathInfo(linkPath);
  if (!info) return { kind: 'missing' };
  if (!info.isSymbolicLink()) {
    return { kind: info.isDirectory() ? 'directory' : 'file', size: info.size };
  }

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

export async function canonicalizeTargets(targets) {
  const result = [];
  const seen = new Set();
  for (const target of targets) {
    let resolved = target;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const key = pathKey(resolved);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(target);
    }
  }
  return result;
}

async function canonicalPromptDestinationKey(destination) {
  const parentDir = path.dirname(path.resolve(destination));
  let canonicalParent = parentDir;
  try {
    canonicalParent = await realpath(parentDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return pathKey(path.join(canonicalParent, path.basename(destination)));
}

async function validatePromptSource(sourcePath, allowedRoots) {
  const allowed = allowedRoots.some((allowedRoot) => isInsideRoot(allowedRoot, sourcePath));
  if (!allowed) {
    return `提示词源文件必须位于仓库 prompts/ 或 prompts.local/ 目录内: ${sourcePath}`;
  }
  const info = await pathInfo(sourcePath);
  if (!info) {
    return `提示词源文件不存在: ${sourcePath}`;
  }
  if (!info.isFile()) {
    return `提示词源文件必须是普通文件: ${sourcePath}`;
  }
  return null;
}

export async function buildPlan({
  skills = [],
  targets = [],
  promptTargets = [],
  force = false,
  prune = false,
  root = skillsRoot,
  allowedPromptRoots = [promptsRoot, promptsLocalRoot],
}) {
  const plan = { mkdirs: [], links: [], replacements: [], prunes: [], unchanged: [], conflicts: [] };
  const mkdirSeen = new Set();
  const addMkdir = (dirPath) => {
    const key = pathKey(dirPath);
    if (!mkdirSeen.has(key)) {
      mkdirSeen.add(key);
      plan.mkdirs.push(dirPath);
    }
  };

  const effectiveTargets = await canonicalizeTargets(targets);

  // 第一阶段只读取文件系统并构造完整计划，任何冲突都会阻止后续写入。
  for (const targetRoot of effectiveTargets) {
    const rootError = await validateTargetRoot(targetRoot, root);
    if (rootError) {
      plan.conflicts.push(rootError);
      continue;
    }
    if (!(await pathInfo(targetRoot))) addMkdir(targetRoot);

    for (const skill of skills) {
      const destination = path.join(targetRoot, skill.name);
      const existing = await inspectExistingLink(destination);
      if (existing.kind === 'missing') {
        plan.links.push({ kind: 'dir', source: skill.source, destination });
      } else if (existing.kind === 'link' && samePath(existing.target, skill.source)) {
        plan.unchanged.push({ kind: 'dir', source: skill.source, destination });
      } else if (force) {
        plan.replacements.push({ kind: 'dir', source: skill.source, destination, existingKind: existing.kind });
      } else {
        const detail = existing.kind === 'link' ? `当前指向 ${existing.target}` : '当前是普通文件或目录';
        plan.conflicts.push(`目标已存在: ${destination}（${detail}）`);
      }
    }

    if (prune) plan.prunes.push(...await collectPruneActions(targetRoot, skills, root));
  }

  const normalizedPrompts = normalizePromptTargets(
    promptTargets.map((item) => (typeof item === 'string' || item.target ? item : { target: item.destination, source: item.source })),
    { baseRoot: path.dirname(allowedPromptRoots[0] ?? promptsRoot), defaultSource: path.join(allowedPromptRoots[0] ?? promptsRoot, 'AGENTS.md') },
  );

  const seenPromptDest = new Map();
  for (const item of normalizedPrompts) {
    const destKey = await canonicalPromptDestinationKey(item.destination);
    const sourceError = await validatePromptSource(item.source, allowedPromptRoots);
    if (sourceError) {
      plan.conflicts.push(sourceError);
      continue;
    }
    const sourceKey = pathKey(item.source);
    if (destKey === sourceKey) {
      plan.conflicts.push(`提示词目标不能指向自身: ${item.destination}`);
      continue;
    }
    if (seenPromptDest.has(destKey)) {
      const prevSourceKey = seenPromptDest.get(destKey);
      if (prevSourceKey !== sourceKey) {
        plan.conflicts.push(`同一提示词目标配置了多个不同源文件: ${item.destination}`);
      }
      continue;
    }
    seenPromptDest.set(destKey, sourceKey);

    const parentDir = path.dirname(item.destination);
    const parentInfo = await pathInfo(parentDir);
    if (!parentInfo) {
      addMkdir(parentDir);
    } else {
      try {
        const parentStat = await stat(parentDir);
        if (!parentStat.isDirectory()) {
          plan.conflicts.push(`提示词目标的父路径不是目录: ${parentDir}`);
          continue;
        }
      } catch (error) {
        plan.conflicts.push(`无法访问提示词目标父目录 ${parentDir}: ${error.message}`);
        continue;
      }
    }

    const existing = await inspectExistingLink(item.destination);
    if (existing.kind === 'missing') {
      plan.links.push({ kind: 'file', source: item.source, destination: item.destination });
    } else if (existing.kind === 'link' && samePath(existing.target, item.source)) {
      plan.unchanged.push({ kind: 'file', source: item.source, destination: item.destination });
    } else if (existing.kind === 'directory') {
      plan.conflicts.push(`提示词目标路径是目录，拒绝删除替换: ${item.destination}`);
    } else if (force) {
      plan.replacements.push({
        kind: 'file',
        source: item.source,
        destination: item.destination,
        existingKind: existing.kind,
        existingSize: existing.size ?? 0,
      });
    } else {
      const detail = existing.kind === 'link' ? `当前指向 ${existing.target}` : '当前是普通文件';
      plan.conflicts.push(`提示词目标已存在: ${item.destination}（${detail}）`);
    }
  }

  return plan;
}

async function removePath(targetPath) {
  const info = await pathInfo(targetPath);
  if (!info) return;
  if (info.isSymbolicLink() || info.isFile()) {
    await unlink(targetPath);
  } else {
    await rm(targetPath, { recursive: true, force: true });
  }
}

async function allocateBackupPath(destination) {
  const baseBackup = `${destination}.bak-before-link`;
  if (!(await pathInfo(baseBackup))) return baseBackup;
  let counter = 1;
  while (await pathInfo(`${baseBackup}-${counter}`)) {
    counter += 1;
  }
  return `${baseBackup}-${counter}`;
}

async function createEntryLink(action, linkFn = symlink) {
  if (action.kind === 'file') {
    await linkFn(path.resolve(action.source), action.destination, 'file');
  } else {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    await linkFn(path.resolve(action.source), action.destination, type);
  }
}

async function replaceFileEntrySafely(action, linkFn = symlink) {
  const info = await pathInfo(action.destination);
  if (!info) {
    await createEntryLink(action, linkFn);
    return null;
  }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    throw new Error(`提示词目标路径是目录，拒绝删除替换: ${action.destination}`);
  }
  const backupPath = await allocateBackupPath(action.destination);
  const keepBackup = !info.isSymbolicLink() && info.size > 0;
  await rename(action.destination, backupPath);
  try {
    await createEntryLink(action, linkFn);
  } catch (error) {
    try {
      await rename(backupPath, action.destination);
    } catch {
      // Best-effort rollback
    }
    throw error;
  }
  if (!keepBackup) {
    await removePath(backupPath);
    return null;
  }
  return backupPath;
}

export async function executePlan(plan, { linkFn = symlink } = {}) {
  if (plan.conflicts.length > 0) throw new Error('存在冲突，不能执行计划');

  // 第二阶段才执行写操作；先建立目标根目录，再逐项清理、替换和创建链接。
  for (const targetRoot of plan.mkdirs) await mkdir(targetRoot, { recursive: true });
  for (const action of plan.prunes) await removePath(action.destination);
  for (const action of plan.replacements) {
    if (action.kind === 'file') {
      const backupPath = await replaceFileEntrySafely(action, linkFn);
      if (backupPath) action.backupPath = backupPath;
    } else {
      await removePath(action.destination);
      await createEntryLink(action, linkFn);
    }
  }
  for (const action of plan.links) await createEntryLink(action, linkFn);
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
  const options = { command, targets: [], promptTargets: [], force: false, prune: false, noConfig: false, help: false };

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
    else if (argument === '--prompt-target') {
      if (args.length === 0) throw new Error('--prompt-target 缺少文件参数');
      options.promptTargets.push(args.shift());
    } else if (argument.startsWith('--prompt-target=')) options.promptTargets.push(argument.slice('--prompt-target='.length));
    else throw new Error(`未知参数: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`用法: node scripts/link-skills.mjs <command> [options]\n\n命令:\n  init      交互配置本机目标目录与全局提示词入口\n  link      创建或校验 skill 与全局提示词链接\n  status    只检查链接状态\n\n选项:\n  --target PATH          临时追加 skill 目标目录，可重复使用\n  --prompt-target PATH   临时追加全局提示词目标文件，可重复使用\n  --no-config            忽略本机配置，只使用命令行参数\n  --force                替换冲突路径并重建链接（提示词普通文件自动备份）\n  --prune                清理本仓库已删除 skill 的陈旧链接\n  -h, --help             显示帮助`);
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
  const { document, antigravity: currentAntigravity } = await readDeveloperConfig(localConfigPath);

  const configured = document.get('targets', true)?.toJSON() ?? [];
  const configuredKeys = new Set(configured.map((target) => pathKey(expandTargetPath(target))));
  const currentIndexes = COMMON_TARGETS.flatMap((candidate, index) => configuredKeys.has(pathKey(expandTargetPath(candidate.value))) ? [index] : []);
  const customTargets = configured.filter((target) => !COMMON_TARGETS.some((candidate) => samePath(expandTargetPath(candidate.value), expandTargetPath(target))));

  const configuredPrompts = document.get('prompt_targets', true)?.toJSON() ?? [];
  const configuredPromptPaths = configuredPrompts.map((entry) => (typeof entry === 'string' ? entry : entry.target)).filter(Boolean);
  const configuredPromptKeys = new Set(configuredPromptPaths.map((target) => pathKey(expandTargetPath(target))));
  const currentPromptIndexes = COMMON_PROMPT_TARGETS.flatMap((candidate, index) => configuredPromptKeys.has(pathKey(expandTargetPath(candidate.value))) ? [index] : []);
  const customPrompts = configuredPrompts.filter((entry) => {
    const target = typeof entry === 'string' ? entry : entry?.target;
    if (!target) return false;
    return !COMMON_PROMPT_TARGETS.some((candidate) => samePath(expandTargetPath(candidate.value), expandTargetPath(target)));
  });

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
    const selection = await ask('选择 skill 候选编号（逗号分隔；0 表示全不选；回车保留当前值）：');
    const selectedIndexes = parseSelection(selection, COMMON_TARGETS, currentIndexes);
    const custom = await ask(`自定义 skill 目录（逗号分隔；回车保留当前值${customTargets.length ? `：${customTargets.join(', ')}` : ''}）：`);
    const selectedCustom = custom.trim() === '' ? customTargets : custom.split(',').map((item) => item.trim()).filter(Boolean);
    const targets = [...selectedIndexes.map((index) => COMMON_TARGETS[index].value), ...selectedCustom];

    const defaultAgChoice = currentAntigravity ? 'Y/n' : 'y/N';
    const antigravityAnswer = await ask(`启用 Antigravity 全局挂载 (~/.gemini/config/skills.json) [${defaultAgChoice}]：`);
    let enableAntigravity = currentAntigravity;
    const agTrimmed = antigravityAnswer.trim().toLowerCase();
    if (agTrimmed === 'y' || agTrimmed === 'yes') enableAntigravity = true;
    else if (agTrimmed === 'n' || agTrimmed === 'no') enableAntigravity = false;

    console.log('\n常见 Agent 全局提示词文件（默认软链接至 prompts/AGENTS.md）：');
    COMMON_PROMPT_TARGETS.forEach((candidate, index) => {
      const selected = currentPromptIndexes.includes(index) ? 'x' : ' ';
      console.log(`  ${index + 1}. [${selected}] ${candidate.label}: ${candidate.value}`);
    });
    const promptSelection = await ask('选择全局提示词候选编号（逗号分隔；0 表示全不选；回车保留当前值）：');
    const selectedPromptIndexes = parseSelection(promptSelection, COMMON_PROMPT_TARGETS, currentPromptIndexes);
    const promptTargets = [...selectedPromptIndexes.map((index) => COMMON_PROMPT_TARGETS[index].value), ...customPrompts];

    document.set('targets', targets);
    document.set('antigravity', enableAntigravity);
    document.set('prompt_targets', promptTargets);
    await writeFile(localConfigPath, document.toString(), 'utf8');
    console.log(`\n已更新本机配置，共 ${targets.length} 个 skill 目标目录，${promptTargets.length} 个全局提示词入口，Antigravity 原生支持: ${enableAntigravity ? '已启用' : '已禁用'}。`);
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
  let configPromptTargets = [];
  let antigravityEnabled = false;
  if (!options.noConfig) {
    const created = await ensureLocalConfig({ stopAfterCreate: true });
    if (created) return;
    const devConfig = await readDeveloperConfig();
    configTargets = devConfig.targets;
    configPromptTargets = devConfig.promptTargets;
    antigravityEnabled = devConfig.antigravity;
  }

  const targets = mergeTargets(configTargets, options.targets);
  const promptTargets = [
    ...configPromptTargets,
    ...normalizePromptTargets(options.promptTargets),
  ];

  if (targets.length === 0 && promptTargets.length === 0 && !antigravityEnabled) {
    throw new Error('没有配置 skill 目标目录、全局提示词目标或 Antigravity；请运行 npm run init、编辑本机配置，或传入 --target / --prompt-target');
  }

  let skills = [];
  if (targets.length > 0) {
    skills = await scanSkills();
    if (skills.length === 0) throw new Error('skills/ 下没有包含 SKILL.md 的直接子目录');
  }

  const plan = await buildPlan({
    skills,
    targets,
    promptTargets,
    force: options.force,
    prune: options.prune,
  });
  console.log(formatPlan(plan));

  if (antigravityEnabled) {
    const agStatus = await checkAntigravityStatus({ enabled: true });
    if (agStatus.status === 'configured') {
      console.log(`= 已原生挂载  Antigravity (${agStatus.path})`);
    } else {
      console.log(`+ 待写入配置  Antigravity (${agStatus.path} -> ${agStatus.entryPath})`);
    }
  }

  if (plan.conflicts.length > 0) {
    console.error('\n发现冲突，未执行任何修改：');
    plan.conflicts.forEach((conflict) => console.error(`- ${conflict}`));
    process.exitCode = 1;
    return;
  }
  if (options.command === 'status') return;

  await executePlan(plan);
  for (const replacement of plan.replacements) {
    if (replacement.backupPath) {
      console.log(`  已备份原文件: ${replacement.backupPath}`);
    }
  }
  if (antigravityEnabled) {
    const agResult = await syncAntigravityConfig({ enabled: true });
    if (agResult.action === 'updated') {
      console.log(`\n已更新 Antigravity 全局配置: ${agResult.path}`);
    }
  }
  console.log('\n处理完成。');
}

const isMain = process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  });
}
