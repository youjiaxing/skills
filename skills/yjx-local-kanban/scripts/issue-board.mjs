#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ISSUE_FILE_RE = /^(?<number>\d+)-(?<slug>.+)\.md$/i;
const TITLE_RE = /^#\s+(?<title>.+?)\s*$/;
const SECTION_RE = /^##\s+(?<title>.+?)\s*$/;
const PLAIN_FIELD_RE = /^(?<name>[A-Za-z][A-Za-z0-9 _-]*):\s*(?<value>.*)$/;
const BOLD_FIELD_RE = /^\*\*(?<name>[A-Za-z][A-Za-z0-9 _-]*):\*\*\s*(?<value>.*)$/;
const WAYFINDER_TYPES = new Set(['research', 'prototype', 'grilling', 'task']);
const WAYFINDER_STATUSES = new Set(['claimed', 'resolved']);

export const CONFIG_RELATIVE_PATH = path.join('docs', 'agents', 'local-tracker.json');
export const CANONICAL_ROLES = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
];
export const GROUP_ORDER = [
  'CLOSED',
  'BLOCKED',
  'WAITING FOR INFO',
  'NEEDS TRIAGE',
  'OTHER / WARNINGS',
  'HUMAN READY',
  'AGENT READY',
];

const DEFAULT_STATUS_ROLES = Object.fromEntries(CANONICAL_ROLES.map((role) => [role, role]));

function normalizeKey(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function unique(values) {
  return [...new Set(values)];
}

function portableBasename(value) {
  return value.replace(/[?#].*$/, '').split(/[\\/]/).pop();
}

function displayTitle(rawTitle, number) {
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return rawTitle.replace(new RegExp(`^${escaped}\\s*(?:[—–:-]|-)\\s*`), '').trim() || rawTitle;
}

function parseField(line) {
  const match = line.match(BOLD_FIELD_RE) ?? line.match(PLAIN_FIELD_RE);
  if (!match) return null;
  return { name: normalizeKey(match.groups.name), value: match.groups.value.trim() };
}

function readHeaderFields(lines) {
  const fields = new Map();
  for (const line of lines) {
    if (SECTION_RE.test(line)) break;
    const field = parseField(line);
    if (!field) continue;
    const values = fields.get(field.name) ?? [];
    values.push(field.value);
    fields.set(field.name, values);
  }
  return fields;
}

function readSection(lines, heading) {
  const wanted = normalizeKey(heading);
  const result = [];
  let inSection = false;
  for (const line of lines) {
    const match = line.match(SECTION_RE);
    if (match) {
      const current = normalizeKey(match.groups.title);
      if (inSection && current !== wanted) break;
      inSection = current === wanted;
      continue;
    }
    if (inSection) result.push(line);
  }
  return result;
}

function readInlineFieldValues(lines, fieldName) {
  const wanted = normalizeKey(fieldName);
  const values = [];
  let inComments = false;
  for (const line of lines) {
    const section = line.match(SECTION_RE);
    if (section) inComments = normalizeKey(section.groups.title) === 'comments';
    if (inComments) continue;
    const field = parseField(line);
    if (field?.name === wanted) values.push(field.value);
  }
  return values;
}

function normalizeReferenceTitle(value) {
  return normalizeKey(value.replace(/^[-*+]\s*/, '').replace(/^[`*_]+|[`*_.,;:]+$/g, '').replace(/^[—–:-]+\s*/, ''));
}

function referenceTokens(rawLine) {
  const line = rawLine.trim().replace(/^[-*+]\s*/, '');
  if (!line || /^none\b/i.test(line)) return [];

  const tokens = [];
  for (const match of line.matchAll(/\[[^\]]+\]\((?<target>[^)]+)\)/g)) {
    tokens.push({ kind: 'file', value: portableBasename(match.groups.target), raw: rawLine.trim() });
  }
  for (const match of line.matchAll(/(?<file>\d+-[^\s`,;)]+\.md)\b/gi)) {
    tokens.push({ kind: 'file', value: portableBasename(match.groups.file), raw: rawLine.trim() });
  }
  if (tokens.length > 0) return unique(tokens.map((token) => JSON.stringify(token))).map(JSON.parse);

  const parts = line.split(/\s*[,;]\s*/).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^`?(?<number>\d+)`?(?:\s*(?:[—–:-]|-)\s*|\s+)?(?<title>.*)$/);
    if (!match) {
      tokens.push({ kind: 'invalid', value: part, raw: rawLine.trim() });
      continue;
    }
    tokens.push({
      kind: 'number',
      value: match.groups.number,
      title: normalizeReferenceTitle(match.groups.title),
      raw: rawLine.trim(),
    });
  }
  return tokens;
}

function parseClosed(value) {
  const normalized = normalizeKey(value);
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

export function validateConfig(value, configPath = CONFIG_RELATIVE_PATH) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('config must be an object');
  if (value?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (value?.protocol !== 'matt-local-markdown+closed-v1') errors.push('protocol must be matt-local-markdown+closed-v1');
  if (typeof value?.trackerRoot !== 'string' || value.trackerRoot.trim() === '') errors.push('trackerRoot must be a non-empty string');
  if (typeof value?.completionField !== 'string' || value.completionField.trim() === '') errors.push('completionField must be a non-empty string');
  if (!value?.statusRoles || typeof value.statusRoles !== 'object' || Array.isArray(value.statusRoles)) {
    errors.push('statusRoles must be an object');
  } else {
    for (const role of CANONICAL_ROLES) {
      if (typeof value.statusRoles[role] !== 'string' || value.statusRoles[role].trim() === '') {
        errors.push(`statusRoles.${role} must be a non-empty string`);
      }
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

async function exists(target) {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if (error.code === 'EISDIR') return true;
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (await exists(path.join(current, CONFIG_RELATIVE_PATH))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`cannot find ${CONFIG_RELATIVE_PATH}; run yjx-local-tracker-setup first`);
}

export async function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_RELATIVE_PATH);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`tracker config not found: ${configPath}`);
    if (error instanceof SyntaxError) throw new Error(`invalid JSON in tracker config ${configPath}: ${error.message}`);
    throw error;
  }
  return validateConfig(parsed, configPath);
}

export async function discoverFeatureDirs(projectRoot, config) {
  const scratch = path.resolve(projectRoot, config.trackerRoot);
  let entries;
  try {
    entries = await readdir(scratch, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const features = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const issuesDir = path.join(scratch, entry.name, 'issues');
    try {
      const issueEntries = await readdir(issuesDir, { withFileTypes: true });
      if (issueEntries.some((item) => item.isFile() && ISSUE_FILE_RE.test(item.name))) {
        features.push(path.join(scratch, entry.name));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return features;
}

function statusRoleMap(config) {
  return new Map(CANONICAL_ROLES.map((role) => [config.statusRoles[role], role]));
}

function isWayfinder(fields, roleByStatus) {
  const type = normalizeKey((fields.get('type') ?? []).at(-1) ?? '');
  const status = (fields.get('status') ?? []).at(-1) ?? '';
  if (WAYFINDER_TYPES.has(type)) return true;
  return WAYFINDER_STATUSES.has(normalizeKey(status)) && !roleByStatus.has(status);
}

async function parseIssueDraft(issuePath, config) {
  const text = await readFile(issuePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const fileMatch = issuePath.match(/(?:^|[\\/])(?<file>[^\\/]+)$/)?.groups.file.match(ISSUE_FILE_RE);
  if (!fileMatch) throw new Error(`issue filename must look like NN-slug.md: ${issuePath}`);

  const fields = readHeaderFields(lines);
  const roleByStatus = statusRoleMap(config);
  if (isWayfinder(fields, roleByStatus)) return null;

  const warnings = [];
  const metadataErrors = [];
  const id = path.basename(issuePath);
  const number = fileMatch.groups.number;
  const heading = lines.map((line) => line.match(TITLE_RE)).find(Boolean)?.groups.title ?? path.parse(id).name;

  const statuses = fields.get('status') ?? [];
  const status = statuses.at(-1) ?? '';
  const statusRole = roleByStatus.get(status) ?? '';
  if (statuses.length === 0) {
    metadataErrors.push('missing-status');
    warnings.push({ code: 'missing-status', issue: id, detail: 'Status field is missing' });
  } else if (new Set(statuses).size > 1) {
    metadataErrors.push('conflicting-status');
    warnings.push({ code: 'conflicting-status', issue: id, detail: statuses.join(' | ') });
  } else if (!statusRole) {
    metadataErrors.push('invalid-status');
    warnings.push({ code: 'invalid-status', issue: id, detail: status || '<empty>' });
  }

  const completionKey = normalizeKey(config.completionField);
  const completionValues = fields.get(completionKey) ?? [];
  const closedRaw = completionValues.at(-1) ?? '';
  const parsedClosed = completionValues.length > 0 ? parseClosed(closedRaw) : null;
  if (completionValues.length === 0) {
    metadataErrors.push('missing-closed');
    warnings.push({ code: 'missing-closed', issue: id, detail: `${config.completionField} field is required` });
  } else if (new Set(completionValues.map(normalizeKey)).size > 1) {
    metadataErrors.push('conflicting-closed');
    warnings.push({ code: 'conflicting-closed', issue: id, detail: completionValues.join(' | ') });
  } else if (parsedClosed === null) {
    metadataErrors.push('invalid-closed');
    warnings.push({ code: 'invalid-closed', issue: id, detail: closedRaw || '<empty>' });
  }

  if (statusRole === 'wontfix' && parsedClosed !== true) {
    metadataErrors.push('open-wontfix');
    warnings.push({ code: 'open-wontfix', issue: id, detail: 'wontfix must be closed' });
  }

  const sectionLines = readSection(lines, 'Blocked by');
  const inlineValues = readInlineFieldValues(lines, 'Blocked by');
  const referenceLines = sectionLines.length > 0 ? sectionLines : inlineValues;
  const references = referenceLines.flatMap(referenceTokens);

  return {
    issue: {
      id,
      number,
      title: displayTitle(heading.trim(), number),
      status,
      statusRole,
      hasStatusField: statuses.length > 0,
      closed: parsedClosed === true,
      closedRaw,
      hasClosedField: completionValues.length > 0,
      metadataValid: metadataErrors.length === 0,
      metadataErrors,
      blockedBy: [],
      blockedByInvalid: [],
      path: issuePath,
      _references: references,
    },
    warnings,
  };
}

function resolveReferences(issues, warnings) {
  const byId = new Map(issues.map((issue) => [normalizeKey(issue.id), issue]));
  const byNumber = new Map();
  for (const issue of issues) {
    const candidates = byNumber.get(issue.number) ?? [];
    candidates.push(issue);
    byNumber.set(issue.number, candidates);
  }

  for (const issue of issues) {
    for (const reference of issue._references) {
      let resolved = null;
      if (reference.kind === 'file') resolved = byId.get(normalizeKey(reference.value));
      if (reference.kind === 'number') {
        const candidates = byNumber.get(reference.value) ?? [];
        if (candidates.length === 1) resolved = candidates[0];
        else if (reference.title) {
          const titled = candidates.filter((candidate) => normalizeReferenceTitle(candidate.title) === reference.title);
          if (titled.length === 1) resolved = titled[0];
        }
      }

      if (resolved) {
        if (!issue.blockedBy.includes(resolved.id)) issue.blockedBy.push(resolved.id);
        continue;
      }

      const missingFile = reference.kind === 'file' && ISSUE_FILE_RE.test(reference.value);
      if (missingFile) {
        if (!issue.blockedBy.includes(reference.value)) issue.blockedBy.push(reference.value);
        continue;
      }
      issue.blockedByInvalid.push(reference.raw);
      warnings.push({ code: 'invalid-blocker-reference', issue: issue.id, detail: reference.raw });
    }
    delete issue._references;
  }
}

export function dependencyCycles(graph) {
  const adjacency = new Map(graph.issues.map((issue) => [issue.id, issue.blockedBy.filter((id) => graph.issueById.has(id))]));
  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  function visit(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of adjacency.get(node)) {
      if (!indices.has(neighbor)) {
        visit(neighbor);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(neighbor)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;

    const component = [];
    while (true) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    const selfCycle = component.length === 1 && adjacency.get(component[0]).includes(component[0]);
    if (component.length > 1 || selfCycle) {
      const order = new Map(graph.issues.map((issue, position) => [issue.id, position]));
      cycles.push(component.sort((left, right) => order.get(left) - order.get(right)));
    }
  }

  for (const issue of graph.issues) if (!indices.has(issue.id)) visit(issue.id);
  return cycles;
}

function makeGraph(issues, warnings) {
  const graph = {
    issues,
    warnings,
    issueById: new Map(issues.map((issue) => [issue.id, issue])),
    blockersOf(issue) {
      return issue.blockedBy.flatMap((id) => this.issueById.has(id) ? [this.issueById.get(id)] : []);
    },
    openBlockersOf(issue) {
      return this.blockersOf(issue).filter((blocker) => !blocker.closed);
    },
    missingBlockersOf(issue) {
      return issue.blockedBy.filter((id) => !this.issueById.has(id));
    },
    dependentsOf(issue) {
      return this.issues.filter((candidate) => candidate.blockedBy.includes(issue.id));
    },
    cycleOf(issue) {
      return dependencyCycles(this).find((cycle) => cycle.includes(issue.id)) ?? [];
    },
    hasGraphError(issue) {
      return issue.blockedByInvalid.length > 0 || this.missingBlockersOf(issue).length > 0 || this.cycleOf(issue).length > 0;
    },
    groupOf(issue) {
      if (issue.closed && issue.metadataValid) return 'CLOSED';
      if (!issue.metadataValid || this.hasGraphError(issue)) return 'OTHER / WARNINGS';
      if (this.openBlockersOf(issue).length > 0) return 'BLOCKED';
      if (issue.statusRole === 'needs-info') return 'WAITING FOR INFO';
      if (issue.statusRole === 'needs-triage') return 'NEEDS TRIAGE';
      if (issue.statusRole === 'ready-for-human') return 'HUMAN READY';
      if (issue.statusRole === 'ready-for-agent') return 'AGENT READY';
      return 'OTHER / WARNINGS';
    },
    issuesInGroup(group) {
      return this.issues.filter((issue) => this.groupOf(issue) === group);
    },
  };
  return graph;
}

export async function loadGraph(featureDir, config) {
  const issuesDir = path.join(featureDir, 'issues');
  let entries;
  try {
    entries = await readdir(issuesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`issues directory not found: ${issuesDir}`);
    throw error;
  }

  const parsed = [];
  for (const entry of entries.filter((item) => item.isFile() && ISSUE_FILE_RE.test(item.name)).sort((left, right) => left.name.localeCompare(right.name))) {
    const draft = await parseIssueDraft(path.join(issuesDir, entry.name), config);
    if (draft) parsed.push(draft);
  }
  if (parsed.length === 0) throw new Error(`no implementation issue markdown files found under: ${issuesDir}`);

  const issues = parsed.map((item) => item.issue);
  const warnings = parsed.flatMap((item) => item.warnings);
  resolveReferences(issues, warnings);
  let graph = makeGraph(issues, warnings);
  for (const issue of issues) {
    for (const blocker of graph.missingBlockersOf(issue)) warnings.push({ code: 'missing-blocker', issue: issue.id, detail: blocker });
  }
  for (const cycle of dependencyCycles(graph)) {
    const detail = [...cycle, cycle[0]].join(' -> ');
    for (const issue of cycle) warnings.push({ code: 'dependency-cycle', issue, detail });
  }
  graph = makeGraph(issues, warnings);
  return graph;
}

export function displayPath(target, projectRoot = process.cwd()) {
  const relative = path.relative(projectRoot, target);
  return (relative || '.').split(path.sep).join('/');
}

function issueReferenceLines(label, issues) {
  if (issues.length === 0) return [];
  return [`  ${label}:`, ...issues.map((issue) => `    - ${issue.number} ${issue.title}`)];
}

export function renderIssueLines(issue, graph, projectRoot = process.cwd()) {
  const lines = [`- ${issue.number} ${issue.title}`, `  status: ${issue.status || 'unknown'}`];
  lines.push(...issueReferenceLines('open blockers', graph.openBlockersOf(issue)));
  const missing = graph.missingBlockersOf(issue);
  if (missing.length > 0) lines.push('  missing blockers:', ...missing.map((id) => `    - ${id}`));
  lines.push(...issueReferenceLines('open dependents', graph.dependentsOf(issue).filter((candidate) => !candidate.closed)));
  lines.push(`  path: ${displayPath(issue.path, projectRoot)}`);
  return lines;
}

export function summaryPayload(graph) {
  return {
    issues: graph.issues.length,
    open: graph.issues.filter((issue) => !issue.closed).length,
    closed: graph.issuesInGroup('CLOSED').length,
    blocked: graph.issuesInGroup('BLOCKED').length,
    agentReady: graph.issuesInGroup('AGENT READY').length,
    humanReady: graph.issuesInGroup('HUMAN READY').length,
    waitingForInfo: graph.issuesInGroup('WAITING FOR INFO').length,
    needsTriage: graph.issuesInGroup('NEEDS TRIAGE').length,
    other: graph.issuesInGroup('OTHER / WARNINGS').length,
    missingClosed: graph.issues.filter((issue) => !issue.hasClosedField).length,
    edges: graph.issues.reduce((count, issue) => count + issue.blockedBy.filter((id) => graph.issueById.has(id)).length, 0),
    warnings: graph.warnings.length,
  };
}

export function renderText(featureDir, graph, projectRoot = process.cwd()) {
  const summary = summaryPayload(graph);
  const lines = [
    `Issue board: ${path.basename(featureDir)}`,
    `issues=${summary.issues} open=${summary.open} closed=${summary.closed} agent_ready=${summary.agentReady} blocked=${summary.blocked} human_ready=${summary.humanReady} waiting_info=${summary.waitingForInfo} needs_triage=${summary.needsTriage} other=${summary.other} warnings=${summary.warnings}`,
  ];
  for (const group of GROUP_ORDER) {
    lines.push('', group);
    const grouped = graph.issuesInGroup(group);
    if (grouped.length === 0) lines.push('- none');
    for (const issue of grouped) lines.push(...renderIssueLines(issue, graph, projectRoot));
    if (group === 'OTHER / WARNINGS' && graph.warnings.length > 0) {
      lines.push('', 'WARNINGS');
      for (const warning of graph.warnings) lines.push(`- code=${warning.code}${warning.issue ? ` issue=${warning.issue}` : ''} detail=${warning.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderReadyOnly(featureDir, graph, projectRoot = process.cwd()) {
  const ready = graph.issuesInGroup('AGENT READY');
  const lines = [`Agent-ready issues: ${path.basename(featureDir)}`, `agent_ready=${ready.length} warnings=${graph.warnings.length}`, '', 'AGENT READY'];
  if (ready.length === 0) lines.push('- none');
  for (const issue of ready) lines.push(...renderIssueLines(issue, graph, projectRoot));
  if (graph.warnings.length > 0) {
    lines.push('', 'WARNINGS');
    for (const warning of graph.warnings) lines.push(`- code=${warning.code}${warning.issue ? ` issue=${warning.issue}` : ''} detail=${warning.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

export function issuePayload(issue, graph, projectRoot = process.cwd()) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    status: issue.status,
    statusRole: issue.statusRole,
    hasStatusField: issue.hasStatusField,
    closed: issue.closed,
    closedRaw: issue.closedRaw,
    hasClosedField: issue.hasClosedField,
    metadataValid: issue.metadataValid,
    metadataErrors: issue.metadataErrors,
    path: displayPath(issue.path, projectRoot),
    blockedBy: issue.blockedBy,
    blockedByOpen: graph.openBlockersOf(issue).map((blocker) => blocker.id),
    blockedByMissing: graph.missingBlockersOf(issue),
    blockedByInvalid: issue.blockedByInvalid,
    unlocks: graph.dependentsOf(issue).map((dependent) => dependent.id),
    dependencyCycle: graph.cycleOf(issue),
  };
}

export function graphPayload(featureDir, graph, projectRoot = process.cwd()) {
  return {
    feature: path.basename(featureDir),
    summary: summaryPayload(graph),
    issues: graph.issues.map((issue) => issuePayload(issue, graph, projectRoot)),
    warnings: graph.warnings,
  };
}

export function renderJson(featureDir, graph, projectRoot = process.cwd()) {
  return `${JSON.stringify(graphPayload(featureDir, graph, projectRoot), null, 2)}\n`;
}

function mermaidId(value) {
  const safe = value.replace(/[^0-9A-Za-z_]/g, '_');
  return /^\d/.test(safe) ? `I${safe}` : safe;
}

export function renderMermaid(featureDir, outputPath, graph, projectRoot = process.cwd()) {
  const ids = new Map(graph.issues.map((issue) => [issue.id, mermaidId(issue.id.replace(/\.md$/i, ''))]));
  const lines = [`# Issue DAG: ${path.basename(featureDir)}`, '', '```mermaid', 'graph TD'];
  for (const issue of graph.issues) {
    const label = `${issue.number} ${issue.title}\\n${issue.status || 'unknown'} / ${graph.groupOf(issue)}`.replace(/"/g, '\\"');
    lines.push(`  ${ids.get(issue.id)}["${label}"]`);
  }
  for (const issue of graph.issues) {
    for (const blocker of issue.blockedBy) if (ids.has(blocker)) lines.push(`  ${ids.get(blocker)} --> ${ids.get(issue.id)}`);
  }
  lines.push('```', '', '## Issues', '', '| Issue | Status | Closed | Group | Blocked by |', '| --- | --- | --- | --- | --- |');
  for (const issue of graph.issues) {
    const issueLink = path.relative(path.dirname(outputPath), issue.path).split(path.sep).join('/');
    const blockers = issue.blockedBy.map((id) => graph.issueById.has(id)
      ? `[${graph.issueById.get(id).number}](${path.relative(path.dirname(outputPath), graph.issueById.get(id).path).split(path.sep).join('/')})`
      : `\`${id}\``).join(', ') || 'None';
    lines.push(`| [${issue.number} ${issue.title}](${issueLink}) | \`${issue.status || 'unknown'}\` | \`${issue.closed}\` | ${graph.groupOf(issue)} | ${blockers} |`);
  }
  if (graph.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of graph.warnings) lines.push(`- \`${warning.code}\`${warning.issue ? ` \`${warning.issue}\`` : ''}: ${warning.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = {
    featureDir: null,
    projectRoot: null,
    format: 'text',
    readyOnly: false,
    json: false,
    output: null,
    listFeatures: false,
    nonInteractive: false,
    help: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--project-root') options.projectRoot = args.shift();
    else if (argument === '--format') options.format = args.shift();
    else if (argument === '--ready-only') options.readyOnly = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--output') options.output = args.shift();
    else if (argument === '--list-features') options.listFeatures = true;
    else if (argument === '--non-interactive') options.nonInteractive = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument?.startsWith('-')) throw new Error(`unknown option: ${argument}`);
    else if (options.featureDir) throw new Error(`unexpected argument: ${argument}`);
    else options.featureDir = argument;
  }
  for (const [flag, value] of [['--project-root', options.projectRoot], ['--format', options.format], ['--output', options.output]]) {
    if (value === undefined) throw new Error(`${flag} requires a value`);
  }
  if (!['text', 'mermaid'].includes(options.format)) throw new Error('--format must be text or mermaid');
  if (options.format === 'mermaid' && !options.output) throw new Error('--format mermaid requires --output');
  return options;
}

function printHelp() {
  console.log(`Usage: node issue-board.mjs [options] [feature-dir]\n\nOptions:\n  --project-root PATH   Project root containing docs/agents/local-tracker.json\n  --list-features       List feature directories under the configured tracker root\n  --json                Emit the complete machine-readable graph\n  --non-interactive     Never prompt; fail when feature selection is ambiguous\n  --ready-only          Emit only the human AGENT READY list\n  --format mermaid      Render a Mermaid projection (requires --output)\n  --output PATH         Write output to a file\n  -h, --help            Show help`);
}

async function chooseFeature(features, nonInteractive) {
  if (features.length === 0) throw new Error('no feature directories with implementation issues found');
  if (features.length === 1) return features[0];
  if (nonInteractive || !process.stdin.isTTY) throw new Error('multiple features found; pass an explicit feature directory or use --list-features');
  console.log('Select feature:');
  features.forEach((feature, index) => console.log(`${index + 1}. ${path.basename(feature)}`));
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question('Choose feature number: ');
    const selected = Number.parseInt(answer, 10);
    if (!Number.isInteger(selected) || selected < 1 || selected > features.length) throw new Error('invalid feature selection');
    return features[selected - 1];
  } finally {
    readline.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const rootHint = options.projectRoot ?? (options.featureDir ? path.resolve(options.featureDir) : process.cwd());
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : await findProjectRoot(rootHint);
  const config = await loadConfig(projectRoot);
  const features = await discoverFeatureDirs(projectRoot, config);

  if (options.listFeatures) {
    const payload = features.map((feature) => ({ feature: path.basename(feature), path: displayPath(feature, projectRoot) }));
    process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.map((item) => `${item.feature}\t${item.path}`).join('\n')}\n`);
    return 0;
  }

  const featureDir = options.featureDir ? path.resolve(projectRoot, options.featureDir) : await chooseFeature(features, options.nonInteractive);
  const graph = await loadGraph(featureDir, config);
  if (options.format === 'mermaid') {
    const outputPath = path.resolve(projectRoot, options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, renderMermaid(featureDir, outputPath, graph, projectRoot), 'utf8');
    console.log(`wrote ${displayPath(outputPath, projectRoot)}`);
    return 0;
  }
  const report = options.json ? renderJson(featureDir, graph, projectRoot) : options.readyOnly ? renderReadyOnly(featureDir, graph, projectRoot) : renderText(featureDir, graph, projectRoot);
  if (options.output) {
    const outputPath = path.resolve(projectRoot, options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, report, 'utf8');
    console.log(`wrote ${displayPath(outputPath, projectRoot)}`);
  } else process.stdout.write(report);
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

export { DEFAULT_STATUS_ROLES };
