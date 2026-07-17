#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TRACKER_DOC = path.join('docs', 'agents', 'issue-tracker.md');
const TRIAGE_DOC = path.join('docs', 'agents', 'triage-labels.md');
const CONFIG_RELATIVE_PATH = path.join('docs', 'agents', 'local-tracker.json');
const PROTOCOL = 'matt-local-markdown+closed-v1';
const CANONICAL_ROLES = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
];
const ISSUE_FILE_RE = /^\d+-.+\.md$/i;
const SECTION_RE = /^##\s+/;
const WAYFINDER_TYPES = new Set(['research', 'prototype', 'grilling', 'task']);
const WAYFINDER_STATUSES = new Set(['claimed', 'resolved']);

function normalizeKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function displayPath(target, projectRoot) {
  return path.relative(projectRoot, target).split(path.sep).join('/');
}

function validateConfig(value, configPath = CONFIG_RELATIVE_PATH) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('config must be an object');
  if (value?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (value?.protocol !== PROTOCOL) errors.push(`protocol must be ${PROTOCOL}`);
  if (typeof value?.trackerRoot !== 'string' || value.trackerRoot.trim() === '') errors.push('trackerRoot must be a non-empty string');
  if (typeof value?.completionField !== 'string' || value.completionField.trim() === '') errors.push('completionField must be a non-empty string');
  if (!value?.statusRoles || typeof value.statusRoles !== 'object' || Array.isArray(value.statusRoles)) {
    errors.push('statusRoles must be an object');
  } else {
    for (const role of CANONICAL_ROLES) {
      if (typeof value.statusRoles[role] !== 'string' || value.statusRoles[role].trim() === '') errors.push(`statusRoles.${role} must be a non-empty string`);
    }
    const actual = CANONICAL_ROLES.map((role) => value.statusRoles[role]);
    if (new Set(actual).size !== actual.length) errors.push('statusRoles values must be unique');
  }
  if (errors.length > 0) throw new Error(`invalid tracker config ${configPath}: ${errors.join('; ')}`);
  return {
    schemaVersion: 1,
    protocol: value.protocol,
    trackerRoot: value.trackerRoot,
    completionField: value.completionField,
    statusRoles: Object.fromEntries(CANONICAL_ROLES.map((role) => [role, value.statusRoles[role]])),
  };
}

function parseHeaderFields(source) {
  const fields = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (SECTION_RE.test(line)) break;
    const match = line.match(/^\*\*(?<name>[A-Za-z][A-Za-z0-9 _-]*):\*\*\s*(?<value>.*)$/)
      ?? line.match(/^(?<name>[A-Za-z][A-Za-z0-9 _-]*):\s*(?<value>.*)$/);
    if (!match) continue;
    fields.set(normalizeKey(match.groups.name), match.groups.value.trim());
  }
  return fields;
}

async function pathIsDirectory(target) {
  try {
    const entries = await readdir(target);
    return Array.isArray(entries);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function discoverFeatureDirs(projectRoot, config) {
  const trackerRoot = path.resolve(projectRoot, config.trackerRoot);
  let entries;
  try {
    entries = await readdir(trackerRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const features = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const issuesDir = path.join(trackerRoot, entry.name, 'issues');
    if (await pathIsDirectory(issuesDir)) features.push(path.join(trackerRoot, entry.name));
  }
  return features;
}

function isWayfinder(fields, config) {
  const type = normalizeKey(fields.get('type') ?? '');
  const status = fields.get('status') ?? '';
  const configuredStatuses = new Set(Object.values(config.statusRoles));
  return WAYFINDER_TYPES.has(type) || (WAYFINDER_STATUSES.has(normalizeKey(status)) && !configuredStatuses.has(status));
}

async function inventory(projectRoot, config) {
  const features = await discoverFeatureDirs(projectRoot, config);
  const result = [];
  for (const featureDir of features) {
    const issuesDir = path.join(featureDir, 'issues');
    const entries = await readdir(issuesDir, { withFileTypes: true });
    const issues = [];
    for (const entry of entries.filter((item) => item.isFile() && ISSUE_FILE_RE.test(item.name)).sort((left, right) => left.name.localeCompare(right.name))) {
      const issuePath = path.join(issuesDir, entry.name);
      const source = await readFile(issuePath, 'utf8');
      const fields = parseHeaderFields(source);
      if (isWayfinder(fields, config)) continue;
      issues.push({
        id: entry.name,
        path: displayPath(issuePath, projectRoot),
        hasStatusField: fields.has('status'),
        hasClosedField: fields.has(normalizeKey(config.completionField)),
      });
    }
    result.push({
      feature: path.basename(featureDir),
      path: displayPath(featureDir, projectRoot),
      issues: issues.length,
      missingClosed: issues.filter((issue) => !issue.hasClosedField).map(({ id, path: issuePath, hasStatusField }) => ({ id, path: issuePath, hasStatusField })),
      warnings: [],
    });
  }
  return result;
}

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    apply: false,
    yes: false,
    migrateClosed: false,
    json: false,
    help: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--project-root') options.projectRoot = args.shift();
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--yes') options.yes = true;
    else if (argument === '--migrate-closed') options.migrateClosed = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (options.projectRoot === undefined) throw new Error('--project-root requires a value');
  if (options.apply && !options.yes) throw new Error('--apply requires --yes after the preview has been approved');
  if (options.migrateClosed && !options.apply) throw new Error('--migrate-closed requires --apply --yes');
  return options;
}

function printHelp() {
  console.log(`Usage: node setup-local-tracker.mjs [options]\n\nOptions:\n  --project-root PATH   Project configured by setup-matt-pocock-skills\n  --json                Emit the preview/result as JSON\n  --apply --yes         Write docs/agents/local-tracker.json\n  --migrate-closed      Also add Closed: false to eligible legacy issues\n  -h, --help            Show help\n\nDefault behavior is read-only preview.`);
}

async function readRequired(projectRoot, relativePath) {
  const target = path.join(projectRoot, relativePath);
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`required Matt setup file is missing: ${relativePath}`);
    throw error;
  }
}

export function parseStatusRoles(markdown) {
  const roles = {};
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ''));
    if (cells.length < 2 || !CANONICAL_ROLES.includes(cells[0])) continue;
    if (cells[1]) roles[cells[0]] = cells[1];
  }
  const missing = CANONICAL_ROLES.filter((role) => !roles[role]);
  if (missing.length > 0) throw new Error(`triage role mapping is incomplete: ${missing.join(', ')}`);
  return Object.fromEntries(CANONICAL_ROLES.map((role) => [role, roles[role]]));
}

export function validateMattLocalTrackerDoc(markdown) {
  const normalized = markdown.toLowerCase();
  const errors = [];
  if (!normalized.includes('.scratch/')) errors.push('tracker document does not declare a .scratch/ root');
  if (!normalized.includes('issues/')) errors.push('tracker document does not declare per-feature issues/ files');
  if (!normalized.includes('local markdown')) errors.push('tracker document is not identified as Local Markdown');
  if (errors.length > 0) throw new Error(errors.join('; '));
}

export function buildConfig(statusRoles) {
  return validateConfig({
    schemaVersion: 1,
    protocol: PROTOCOL,
    trackerRoot: '.scratch',
    completionField: 'Closed',
    statusRoles,
  });
}

async function inspectExistingConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_RELATIVE_PATH);
  try {
    const raw = await readFile(configPath, 'utf8');
    try {
      return { exists: true, valid: true, value: validateConfig(JSON.parse(raw), configPath), error: null };
    } catch (error) {
      return { exists: true, valid: false, value: null, error: error.message };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, valid: false, value: null, error: null };
    throw error;
  }
}

function sameConfig(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function lineField(line) {
  const bold = line.match(/^\*\*(?<name>[A-Za-z][A-Za-z0-9 _-]*):\*\*\s*(?<value>.*)$/);
  if (bold) return { name: bold.groups.name.toLowerCase(), bold: true };
  const plain = line.match(/^(?<name>[A-Za-z][A-Za-z0-9 _-]*):\s*(?<value>.*)$/);
  return plain ? { name: plain.groups.name.toLowerCase(), bold: false } : null;
}

export function addClosedField(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = source.endsWith('\n');
  const lines = source.split(/\r?\n/);
  let sectionIndex = lines.findIndex((line) => /^##\s+/.test(line));
  if (sectionIndex < 0) sectionIndex = lines.length;

  for (let index = 0; index < sectionIndex; index += 1) {
    const field = lineField(lines[index]);
    if (field?.name === 'closed') return { changed: false, reason: 'already-present', source };
    if (field?.name !== 'status') continue;
    lines.splice(index + 1, 0, field.bold ? '**Closed:** false' : 'Closed: false');
    let result = lines.join(newline);
    if (!trailingNewline && result.endsWith(newline)) result = result.slice(0, -newline.length);
    return { changed: true, reason: null, source: result };
  }
  return { changed: false, reason: 'missing-status', source };
}

async function applyMigration(projectRoot, features) {
  const changed = [];
  const skipped = [];
  for (const feature of features) {
    for (const issue of feature.missingClosed) {
      const issuePath = path.join(projectRoot, issue.path);
      const source = await readFile(issuePath, 'utf8');
      const result = addClosedField(source);
      if (!result.changed) {
        skipped.push({ path: issue.path, reason: result.reason });
        continue;
      }
      await writeFile(issuePath, result.source, 'utf8');
      changed.push(issue.path);
    }
  }
  return { changed, skipped };
}

export async function inspectSetup(projectRoot) {
  const root = path.resolve(projectRoot);
  const trackerText = await readRequired(root, TRACKER_DOC);
  const triageText = await readRequired(root, TRIAGE_DOC);
  validateMattLocalTrackerDoc(trackerText);
  const config = buildConfig(parseStatusRoles(triageText));
  const existing = await inspectExistingConfig(root);
  const features = await inventory(root, config);
  const missingClosed = features.flatMap((feature) => feature.missingClosed);
  return {
    projectRoot: root,
    prerequisites: {
      mattLocalMarkdown: true,
      trackerDocument: TRACKER_DOC.split(path.sep).join('/'),
      triageDocument: TRIAGE_DOC.split(path.sep).join('/'),
    },
    config: {
      path: CONFIG_RELATIVE_PATH.split(path.sep).join('/'),
      desired: config,
      exists: existing.exists,
      valid: existing.valid,
      matches: existing.valid && sameConfig(existing.value, config),
      error: existing.error,
      action: !existing.exists ? 'create' : existing.valid && sameConfig(existing.value, config) ? 'none' : 'replace',
    },
    features,
    migration: {
      missingClosed: missingClosed.length,
      eligible: missingClosed.filter((issue) => issue.hasStatusField).map((issue) => issue.path),
      skipped: missingClosed.filter((issue) => !issue.hasStatusField).map((issue) => ({ path: issue.path, reason: 'missing-status' })),
      defaultValue: false,
    },
  };
}

function renderText(report, applied = null) {
  const lines = [
    'Local tracker setup preview',
    `project_root=${report.projectRoot}`,
    `config=${report.config.path} action=${report.config.action}`,
    `features=${report.features.length} issues=${report.features.reduce((sum, feature) => sum + feature.issues, 0)} missing_closed=${report.migration.missingClosed}`,
    '',
    'Desired config:',
    JSON.stringify(report.config.desired, null, 2),
  ];
  if (report.migration.eligible.length > 0) {
    lines.push('', 'Legacy issues eligible for Closed: false migration:', ...report.migration.eligible.map((item) => `- ${item}`));
  }
  if (report.migration.skipped.length > 0) {
    lines.push('', 'Legacy issues skipped:', ...report.migration.skipped.map((item) => `- ${item.path}: ${item.reason}`));
  }
  if (applied) {
    lines.push('', 'Applied:', `config=${applied.config}`, `migrated=${applied.migration.changed.length}`, `skipped=${applied.migration.skipped.length}`);
  } else {
    lines.push('', 'No files changed. After human approval, rerun with --apply --yes; add --migrate-closed to migrate listed issues.');
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const report = await inspectSetup(options.projectRoot);
  let applied = null;
  if (options.apply) {
    const configPath = path.join(report.projectRoot, CONFIG_RELATIVE_PATH);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(report.config.desired, null, 2)}\n`, 'utf8');
    const migration = options.migrateClosed
      ? await applyMigration(report.projectRoot, report.features)
      : { changed: [], skipped: [] };
    applied = { config: displayPath(configPath, report.projectRoot), migration };
  }
  process.stdout.write(options.json
    ? `${JSON.stringify({ ...report, applied }, null, 2)}\n`
    : renderText(report, applied));
  return 0;
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
