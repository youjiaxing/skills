#!/usr/bin/env node

import { access, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
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

export const AGENT_PRESETS = [
  { id: 'codex', label: 'Codex (Desktop & CLI)', skillTarget: '~/.codex/skills', promptTarget: '~/.codex/AGENTS.md', antigravity: false, detectDir: '~/.codex' },
  { id: 'claude', label: 'Claude Code', skillTarget: '~/.claude/skills', promptTarget: '~/.claude/CLAUDE.md', antigravity: false, detectDir: '~/.claude' },
  { id: 'grok', label: 'Grok Build', skillTarget: '~/.grok/skills', promptTarget: '~/.grok/AGENTS.md', antigravity: false, detectDir: '~/.grok' },
  { id: 'codebuddy', label: 'CodeBuddy (IDE & CLI)', skillTarget: '~/.codebuddy/skills', promptTarget: '~/.codebuddy/CODEBUDDY.md', antigravity: false, detectDir: '~/.codebuddy' },
  { id: 'antigravity', label: 'Antigravity IDE & Agy CLI', skillTarget: null, promptTarget: '~/.gemini/config/AGENTS.md', antigravity: true, detectDir: '~/.gemini' },
  { id: 'agents-shared', label: 'Agent Skills 通用目录', skillTarget: '~/.agents/skills', promptTarget: null, antigravity: false, detectDir: '~/.agents' },
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

export function selectSkills(skills, requestedNames = []) {
  const names = [...new Set(requestedNames.map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) return skills;

  const available = new Map(skills.map((skill) => [skill.name, skill]));
  const missing = names.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`未找到指定 skill: ${missing.join('、')}`);
  }

  const selected = new Set(names);
  return skills.filter((skill) => selected.has(skill.name));
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
  const options = { command, targets: [], promptTargets: [], skillNames: [], force: false, prune: false, noConfig: false, help: false };

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
    else if (argument === '--skill') {
      if (args.length === 0) throw new Error('--skill 缺少名称参数');
      options.skillNames.push(args.shift());
    } else if (argument.startsWith('--skill=')) {
      const name = argument.slice('--skill='.length);
      if (!name.trim()) throw new Error('--skill 缺少名称参数');
      options.skillNames.push(name);
    }
    else throw new Error(`未知参数: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`用法: node scripts/link-skills.mjs <command> [options]\n\n命令:\n  init      交互配置本机目标目录与全局提示词入口\n  link      创建或校验 skill 与全局提示词链接\n  status    只检查链接状态\n\n选项:\n  --target PATH          临时追加 skill 目标目录，可重复使用\n  --skill NAME           只处理指定 skill，可重复使用；默认处理全部 skill\n  --prompt-target PATH   临时追加全局提示词目标文件，可重复使用\n  --no-config            忽略本机配置，只使用命令行参数\n  --force                替换冲突路径并重建链接（提示词普通文件自动备份）\n  --prune                清理本仓库已删除 skill 的陈旧链接\n  -h, --help             显示帮助`);
}

async function ensureLocalConfig({ stopAfterCreate }) {
  if (await pathInfo(localConfigPath)) return false;
  await copyFile(templateConfigPath, localConfigPath);
  console.log(`已创建本机配置: ${localConfigPath}`);
  if (stopAfterCreate) console.log('请编辑配置或运行 npm run init，然后重新执行。');
  return true;
}

function extractPromptEntryTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry.target === "string") return entry.target;
  return null;
}

export async function resolveInitialAgentSelection({
  rawTargets = [],
  rawPromptTargets = [],
  antigravity = false,
  presets = AGENT_PRESETS,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const skillKeys = new Map();
  for (const preset of presets) {
    if (preset.skillTarget) {
      skillKeys.set(pathKey(expandTargetPath(preset.skillTarget, env, home)), preset.id);
    }
  }
  const promptKeys = new Map();
  for (const preset of presets) {
    if (preset.promptTarget) {
      promptKeys.set(pathKey(expandTargetPath(preset.promptTarget, env, home)), preset.id);
    }
  }

  const configuredTargetKeys = new Set();
  const customTargets = [];
  for (const item of rawTargets) {
    if (typeof item !== "string" || item.trim() === "") continue;
    const key = pathKey(expandTargetPath(item, env, home));
    configuredTargetKeys.add(key);
    if (!skillKeys.has(key)) customTargets.push(item);
  }

  const configuredPromptByKey = new Map();
  const customPromptTargets = [];
  for (const entry of rawPromptTargets) {
    const rawPath = extractPromptEntryTarget(entry);
    if (!rawPath || rawPath.trim() === "") continue;
    const key = pathKey(expandTargetPath(rawPath, env, home));
    configuredPromptByKey.set(key, entry);
    if (!promptKeys.has(key)) customPromptTargets.push(entry);
  }

  const hasExistingConfig = configuredTargetKeys.size > 0 || configuredPromptByKey.size > 0 || Boolean(antigravity);
  const selectedIndexes = [];
  let mode = "configured";

  if (hasExistingConfig) {
    presets.forEach((preset, index) => {
      const hasSkill = preset.skillTarget
        ? configuredTargetKeys.has(pathKey(expandTargetPath(preset.skillTarget, env, home)))
        : false;
      const hasPrompt = preset.promptTarget
        ? configuredPromptByKey.has(pathKey(expandTargetPath(preset.promptTarget, env, home)))
        : false;
      const hasAg = Boolean(preset.antigravity && antigravity);
      if (hasSkill || hasPrompt || hasAg) selectedIndexes.push(index);
    });
  } else {
    mode = "detected";
    for (let index = 0; index < presets.length; index += 1) {
      const preset = presets[index];
      if (!preset.detectDir) continue;
      const dirPath = expandTargetPath(preset.detectDir, env, home);
      if (await pathInfo(dirPath)) {
        selectedIndexes.push(index);
      }
    }
    if (selectedIndexes.length === 0) {
      for (let index = 0; index < presets.length; index += 1) {
        selectedIndexes.push(index);
      }
    }
  }

  return {
    selectedIndexes,
    customTargets,
    customPromptTargets,
    configuredPromptByKey,
    mode,
  };
}

export function applyAgentSelection({
  selectedIndexes = [],
  rawTargets = [],
  rawPromptTargets = [],
  presets = AGENT_PRESETS,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const presetSkillKeys = new Set(
    presets.filter((p) => p.skillTarget).map((p) => pathKey(expandTargetPath(p.skillTarget, env, home))),
  );
  const presetPromptKeys = new Set(
    presets.filter((p) => p.promptTarget).map((p) => pathKey(expandTargetPath(p.promptTarget, env, home))),
  );

  const existingTargetEntryByKey = new Map();
  const customTargets = [];
  for (const item of rawTargets) {
    if (typeof item !== "string" || item.trim() === "") continue;
    const key = pathKey(expandTargetPath(item, env, home));
    if (!existingTargetEntryByKey.has(key)) existingTargetEntryByKey.set(key, item);
    if (!presetSkillKeys.has(key)) customTargets.push(item);
  }

  const existingPromptEntryByKey = new Map();
  const customPromptTargets = [];
  for (const entry of rawPromptTargets) {
    const rawPath = extractPromptEntryTarget(entry);
    if (!rawPath || rawPath.trim() === "") continue;
    const key = pathKey(expandTargetPath(rawPath, env, home));
    if (!existingPromptEntryByKey.has(key)) existingPromptEntryByKey.set(key, entry);
    if (!presetPromptKeys.has(key)) customPromptTargets.push(entry);
  }

  const uniqueIndexes = [...new Set(selectedIndexes)].filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < presets.length);
  const targets = [];
  const promptTargets = [];
  let antigravity = false;

  for (const idx of uniqueIndexes) {
    const preset = presets[idx];
    if (preset.skillTarget) {
      const key = pathKey(expandTargetPath(preset.skillTarget, env, home));
      targets.push(existingTargetEntryByKey.get(key) ?? preset.skillTarget);
    }
    if (preset.promptTarget) {
      const key = pathKey(expandTargetPath(preset.promptTarget, env, home));
      promptTargets.push(existingPromptEntryByKey.get(key) ?? preset.promptTarget);
    }
    if (preset.antigravity) {
      antigravity = true;
    }
  }

  targets.push(...customTargets);
  promptTargets.push(...customPromptTargets);

  return { targets, promptTargets, antigravity, customTargets, customPromptTargets };
}

export function parsePresetSelectionInput(input, candidates, defaultIndexes) {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return [...defaultIndexes];
  if (trimmed === "0" || trimmed === "none") return [];
  if (trimmed === "a" || trimmed === "all") return candidates.map((_, index) => index);
  const indexes = trimmed.split(",").map((part) => Number.parseInt(part.trim(), 10) - 1);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= candidates.length)) {
    throw new Error("候选编号无效");
  }
  return [...new Set(indexes)];
}

function describePresetSummary(preset) {
  const parts = [];
  if (preset.skillTarget) parts.push(`skills: ${preset.skillTarget}`);
  else if (preset.antigravity) parts.push("skills: ~/.gemini/config/skills.json");
  if (preset.promptTarget) parts.push(`prompt: ${preset.promptTarget}`);
  return parts.join(" | ");
}

async function runInteractiveChecklist({ presets, initialIndexes, mode, customTargetCount, customPromptCount }) {
  const selected = new Set(initialIndexes);
  let cursor = 0;
  let renderedLineCount = 0;

  const render = () => {
    const lines = [
      "配置本机要启用 Skills 与全局提示词软链接的 Agent 环境",
      "操作: ↑/↓(或 k/j) 移动  Space 勾选  a 全选/全不选  Enter 确认保存  Esc/q 取消",
      mode === "detected"
        ? "状态: 未检测到已有配置，已按本机宿主目录自动预勾选"
        : "状态: 已回显当前 developer-targets.local.yaml 配置",
      "",
    ];

    presets.forEach((preset, index) => {
      const pointer = index === cursor ? "❯" : " ";
      const check = selected.has(index) ? "[x]" : "[ ]";
      lines.push(`${pointer} ${check} ${preset.label} (${describePresetSummary(preset)})`);
    });

    if (customTargetCount > 0 || customPromptCount > 0) {
      lines.push("");
      lines.push(`注: 保存时将自动保留已有自定义项（${customTargetCount} 个 skill 目录，${customPromptCount} 个提示词目标）。`);
    }

    if (renderedLineCount > 0) {
      process.stdout.write(`\x1b[${renderedLineCount}A\r\x1b[J`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    renderedLineCount = lines.length;
  };

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(wasRaw);
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    const onData = (chunk) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (str === "\u0003" || str === "\u001b" || str === "q" || str === "Q") {
        finish(null);
        return;
      }
      if (str === "\r" || str === "\n") {
        finish([...selected].sort((a, b) => a - b));
        return;
      }
      if (str === " ") {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        render();
        return;
      }
      if (str === "a" || str === "A") {
        if (selected.size === presets.length) {
          selected.clear();
        } else {
          for (let i = 0; i < presets.length; i += 1) selected.add(i);
        }
        render();
        return;
      }
      if (str === "\u001b[A" || str === "\u001bOA" || str === "k" || str === "K") {
        cursor = (cursor - 1 + presets.length) % presets.length;
        render();
        return;
      }
      if (str === "\u001b[B" || str === "\u001bOB" || str === "j" || str === "J") {
        cursor = (cursor + 1) % presets.length;
        render();
      }
    };

    try {
      process.stdout.write("\x1b[?25l");
      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.on("data", onData);
      render();
    } catch (error) {
      cleanup();
      throw error;
    }
  });
}

async function readSingleLineFromStdin(promptText) {
  process.stdout.write(promptText);
  let input = "";
  for await (const chunk of process.stdin) {
    input += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (input.includes("\n")) break;
  }
  return input.split(/\r?\n/)[0] ?? "";
}

export async function runInit({
  localPath = localConfigPath,
  templatePath = templateConfigPath,
  presets = AGENT_PRESETS,
  env = process.env,
  home = os.homedir(),
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  lineReader = readSingleLineFromStdin,
} = {}) {
  const hasLocalFile = Boolean(await pathInfo(localPath));
  const sourcePath = hasLocalFile ? localPath : templatePath;
  const rawYaml = await readFile(sourcePath, "utf8");
  const document = parseDocument(rawYaml);
  if (document.errors.length > 0) {
    throw new Error(`配置文件格式错误: ${document.errors.map((error) => error.message).join("; ")}`);
  }

  const rawTargets = document.get("targets", true)?.toJSON() ?? [];
  const rawPromptTargets = document.get("prompt_targets", true)?.toJSON() ?? [];
  const rawAntigravity = Boolean(document.get("antigravity"));

  const initialState = await resolveInitialAgentSelection({
    rawTargets,
    rawPromptTargets,
    antigravity: rawAntigravity,
    presets,
    env,
    home,
  });

  let chosenIndexes = null;
  if (interactive) {
    chosenIndexes = await runInteractiveChecklist({
      presets,
      initialIndexes: initialState.selectedIndexes,
      mode: initialState.mode,
      customTargetCount: initialState.customTargets.length,
      customPromptCount: initialState.customPromptTargets.length,
    });
    if (chosenIndexes === null) {
      console.log("\n已取消配置，未修改本机配置文件。");
      return { cancelled: true };
    }
  } else {
    console.log("可配置的 Agent 环境（同时包含 Skills 挂载与全局提示词软链接）：");
    presets.forEach((preset, index) => {
      const selected = initialState.selectedIndexes.includes(index) ? "x" : " ";
      console.log(`  ${index + 1}. [${selected}] ${preset.label} (${describePresetSummary(preset)})`);
    });
    const answer = await lineReader("选择 Agent 编号（逗号分隔；a 全选；0 全不选；回车采用默认勾选）：");
    chosenIndexes = parsePresetSelectionInput(answer, presets, initialState.selectedIndexes);
  }

  const applied = applyAgentSelection({
    selectedIndexes: chosenIndexes,
    rawTargets,
    rawPromptTargets,
    presets,
    env,
    home,
  });

  document.set("targets", applied.targets);
  document.set("antigravity", applied.antigravity);
  document.set("prompt_targets", applied.promptTargets);
  await writeFile(localPath, document.toString(), "utf8");

  console.log(`\n已保存配置至 ${localPath}：共启用 ${applied.targets.length} 个 skill 目录、${applied.promptTargets.length} 个全局提示词入口，Antigravity 原生支持: ${applied.antigravity ? "已启用" : "已禁用"}。`);
  console.log("下一步：运行 make link（或 npm run link）建立链接；若首次替换已有同名文件可运行 make force（或 npm run force）。");
  return { cancelled: false, ...applied };
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
  if (options.skillNames.length > 0 && options.prune) {
    throw new Error('--skill 不能与 --prune 同时使用；定向挂载不会清理其它 skill');
  }
  if (options.skillNames.length > 0 && targets.length === 0) {
    throw new Error('--skill 需要至少一个 skill 目标目录（可通过配置或 --target 提供）');
  }

  let skills = [];
  if (targets.length > 0) {
    skills = await scanSkills();
    if (skills.length === 0) throw new Error('skills/ 下没有包含 SKILL.md 的直接子目录');
    skills = selectSkills(skills, options.skillNames);
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
