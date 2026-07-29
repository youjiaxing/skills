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
// ready-for-agent：与 implementation triage 混用时的开放别名，等价于 open（仍可领取 /research|/wayfinder）。
const WAYFINDER_STATUSES = new Set(['open', 'claimed', 'resolved', 'ready-for-agent']);
const WAYFINDER_OPEN_STATUSES = new Set(['open', 'ready-for-agent']);
// Implementation 执行锁：与 triage role 正交，不进 statusRoles 配置。
const IMPLEMENTATION_CLAIMED_STATUS = 'claimed';
// Implementation 完成态别名：与 Wayfinder 同名同义；Closed: true 仍是主完成字段，resolved 也可单独表示完成。
const IMPLEMENTATION_RESOLVED_STATUS = 'resolved';

export const WORKFLOW_IMPLEMENTATION = 'implementation';
export const WORKFLOW_WAYFINDER = 'wayfinder';
export const WORKFLOW_MIXED = 'mixed';
export const WAYFINDER_REQUIRED_SKILL = '/wayfinder';

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
  'CLAIMED',
  'WAITING FOR INFO',
  'NEEDS TRIAGE',
  'OTHER / WARNINGS',
  'HUMAN READY',
  'AGENT READY',
];
export const WAYFINDER_GROUP_ORDER = [
  'RESOLVED',
  'BLOCKED',
  'CLAIMED',
  'OTHER / WARNINGS',
  'FRONTIER',
];
export const MIXED_GROUP_ORDER = [
  'CLOSED',
  'RESOLVED',
  'BLOCKED',
  'CLAIMED',
  'WAITING FOR INFO',
  'NEEDS TRIAGE',
  'OTHER / WARNINGS',
  'HUMAN READY',
  'AGENT READY',
  'FRONTIER',
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

function isImplementationClaimedStatus(status) {
  return normalizeKey(status) === IMPLEMENTATION_CLAIMED_STATUS;
}

function isImplementationResolvedStatus(status) {
  return normalizeKey(status) === IMPLEMENTATION_RESOLVED_STATUS;
}

// Status 是否为 implementation 图已知值：canonical triage role、执行锁 claimed、或完成别名 resolved。
function isKnownImplementationStatus(status, config) {
  return statusRoleMap(config).has(status)
    || isImplementationClaimedStatus(status)
    || isImplementationResolvedStatus(status);
}

// 判断一张票是否声明属于 Wayfinder 决策流程；非法 Type 也不能静默落入 implementation。
function isWayfinderTicket(fields) {
  return (fields.get('type') ?? []).length > 0;
}

// 判断 Wayfinder 票是否拥有合法类型且已经完成，作为进入实施阶段的前置条件。
function isResolvedWayfinderTicket(fields) {
  const types = fields.get('type') ?? [];
  const status = normalizeKey((fields.get('status') ?? []).at(-1) ?? '');
  return types.length === 1 && WAYFINDER_TYPES.has(normalizeKey(types[0])) && status === 'resolved';
}

// 交接时入图：无 Type 即视为 implementation 候选。Status 合法性留给 parse，禁止静默丢票。
function isImplementationCandidate(fields) {
  return !fields.has('type');
}

// 仅识别 Matt to-tickets 原生的三个行内字段，避免放宽任意缺少 Closed 的项目票。
function isMattNativeImplementationTicket(fields) {
  return !fields.has('closed')
    && !fields.has('type')
    && ['what to build', 'blocked by', 'status'].every((name) => fields.has(name));
}

async function readIssueHeaders(issuePaths) {
  return Promise.all(issuePaths.map(async (issuePath) => ({
    issuePath,
    fields: readHeaderFields((await readFile(issuePath, 'utf8')).split(/\r?\n/)),
  })));
}

// 同 feature 可混合 Wayfinder（Type）与 implementation（无 Type）票；各自解析、共依赖图。
// 未完成的 research 只阻塞其下游，不再整板 fail-closed。
async function selectWorkflow(featureDir, issuePaths, config) {
  const headers = await readIssueHeaders(issuePaths);
  const wayfinderTickets = headers.filter(({ fields }) => isWayfinderTicket(fields));
  const implementationCandidates = headers.filter(({ fields }) => isImplementationCandidate(fields));
  const empty = { warnings: [] };

  if (wayfinderTickets.length > 0 && implementationCandidates.length > 0) {
    const warnings = [];
    for (const { issuePath, fields } of implementationCandidates) {
      const status = (fields.get('status') ?? []).at(-1) ?? '';
      if (status && !isKnownImplementationStatus(status, config)) {
        warnings.push({
          code: 'non-canonical-status-on-handoff',
          issue: path.basename(issuePath),
          detail: status,
        });
      }
    }
    return {
      workflow: WORKFLOW_MIXED,
      issuePaths,
      warnings,
    };
  }

  // 仅有 Wayfinder 票时：map.md 标签或 Type 识别为 wayfinder 图。
  const mapPath = path.join(featureDir, 'map.md');
  try {
    const mapFields = readHeaderFields((await readFile(mapPath, 'utf8')).split(/\r?\n/));
    const labels = mapFields.get('label') ?? [];
    if (labels.some((label) => normalizeKey(label) === 'wayfinder:map')) {
      return { workflow: WORKFLOW_WAYFINDER, issuePaths, ...empty };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (wayfinderTickets.length > 0) return { workflow: WORKFLOW_WAYFINDER, issuePaths, ...empty };
  return { workflow: WORKFLOW_IMPLEMENTATION, issuePaths, ...empty };
}

function resolveTicketWorkflow(fields, graphWorkflow) {
  if (graphWorkflow === WORKFLOW_MIXED) {
    return isWayfinderTicket(fields) ? WORKFLOW_WAYFINDER : WORKFLOW_IMPLEMENTATION;
  }
  return graphWorkflow;
}

function isWayfinderOpenStatus(status) {
  return WAYFINDER_OPEN_STATUSES.has(normalizeKey(status));
}

async function parseIssueDraft(issuePath, config, graphWorkflow) {
  const text = await readFile(issuePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const fileMatch = issuePath.match(/(?:^|[\\/])(?<file>[^\\/]+)$/)?.groups.file.match(ISSUE_FILE_RE);
  if (!fileMatch) throw new Error(`issue filename must look like NN-slug.md: ${issuePath}`);

  const fields = readHeaderFields(lines);
  const warnings = [];
  const metadataErrors = [];
  const id = path.basename(issuePath);
  const number = fileMatch.groups.number;
  const heading = lines.map((line) => line.match(TITLE_RE)).find(Boolean)?.groups.title ?? path.parse(id).name;
  const workflow = resolveTicketWorkflow(fields, graphWorkflow);

  const statuses = fields.get('status') ?? [];
  const status = statuses.at(-1) ?? '';
  if (workflow === WORKFLOW_WAYFINDER) {
    const normalizedStatus = normalizeKey(status);
    const types = fields.get('type') ?? [];
    const type = normalizeKey(types.at(-1) ?? '');
    if (types.length === 0) {
      metadataErrors.push('missing-type');
      warnings.push({ code: 'missing-type', issue: id, detail: 'Type field is required for Wayfinder tickets' });
    } else if (new Set(types.map(normalizeKey)).size > 1) {
      metadataErrors.push('conflicting-type');
      warnings.push({ code: 'conflicting-type', issue: id, detail: types.join(' | ') });
    } else if (!WAYFINDER_TYPES.has(type)) {
      metadataErrors.push('invalid-type');
      warnings.push({ code: 'invalid-type', issue: id, detail: type || '<empty>' });
    }
    if (statuses.length === 0) {
      metadataErrors.push('missing-status');
      warnings.push({ code: 'missing-status', issue: id, detail: 'Status field is missing' });
    } else if (new Set(statuses.map(normalizeKey)).size > 1) {
      metadataErrors.push('conflicting-status');
      warnings.push({ code: 'conflicting-status', issue: id, detail: statuses.join(' | ') });
    } else if (!WAYFINDER_STATUSES.has(normalizedStatus)) {
      metadataErrors.push('invalid-status');
      warnings.push({ code: 'invalid-status', issue: id, detail: status || '<empty>' });
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
        workflow,
        requiredSkill: WAYFINDER_REQUIRED_SKILL,
        type,
        status,
        statusRole: normalizedStatus,
        hasStatusField: statuses.length > 0,
        closed: normalizedStatus === 'resolved',
        resolved: normalizedStatus === 'resolved',
        claimed: normalizedStatus === 'claimed',
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

  const roleByStatus = statusRoleMap(config);
  const statusRole = roleByStatus.get(status) ?? '';
  const claimed = isImplementationClaimedStatus(status);
  const resolvedStatus = isImplementationResolvedStatus(status);
  if (statuses.length === 0) {
    metadataErrors.push('missing-status');
    warnings.push({ code: 'missing-status', issue: id, detail: 'Status field is missing' });
  } else if (new Set(statuses).size > 1) {
    metadataErrors.push('conflicting-status');
    warnings.push({ code: 'conflicting-status', issue: id, detail: statuses.join(' | ') });
  } else if (!statusRole && !claimed && !resolvedStatus) {
    metadataErrors.push('invalid-status');
    warnings.push({ code: 'invalid-status', issue: id, detail: status || '<empty>' });
    // 常见误用：把完成写在 Status 上。Status: done 不是完成字段；请用 Closed: true 或 Status: resolved。
    if (normalizeKey(status) === 'done') {
      warnings.push({
        code: 'status-done-not-completion',
        issue: id,
        detail: 'use Closed: true or Status: resolved; Status: done is not a completion field',
      });
    }
  }

  const completionKey = normalizeKey(config.completionField);
  const completionValues = fields.get(completionKey) ?? [];
  const closedRaw = completionValues.at(-1) ?? '';
  const parsedClosed = completionValues.length > 0 ? parseClosed(closedRaw) : null;
  const closedImplicit = completionValues.length === 0 && isMattNativeImplementationTicket(fields);
  // 原生 Matt 模板未声明 Closed 时，兼容地按仍开放的 implementation issue 处理。
  if (completionValues.length === 0) {
    if (!closedImplicit && !resolvedStatus) {
      metadataErrors.push('missing-closed');
      warnings.push({ code: 'missing-closed', issue: id, detail: `${config.completionField} field is required` });
    }
  } else if (new Set(completionValues.map(normalizeKey)).size > 1) {
    metadataErrors.push('conflicting-closed');
    warnings.push({ code: 'conflicting-closed', issue: id, detail: completionValues.join(' | ') });
  } else if (parsedClosed === null) {
    metadataErrors.push('invalid-closed');
    warnings.push({ code: 'invalid-closed', issue: id, detail: closedRaw || '<empty>' });
  }

  // Status: resolved 与 Closed: false 冲突；resolved 且未显式打开时视为已完成。
  if (resolvedStatus && parsedClosed === false) {
    metadataErrors.push('conflicting-resolved-open');
    warnings.push({
      code: 'conflicting-resolved-open',
      issue: id,
      detail: 'Status: resolved conflicts with Closed: false; use Closed: true or drop Closed',
    });
  }

  // Closed: true 是完成真源之一；Status: resolved 是完成别名。不要求 Status 仍为某个固定 triage 值。
  const closed = parsedClosed === true || (resolvedStatus && parsedClosed !== false);
  if (closed) {
    for (const code of ['invalid-status', 'missing-status', 'missing-closed']) {
      const index = metadataErrors.indexOf(code);
      if (index >= 0) metadataErrors.splice(index, 1);
    }
  }

  if (statusRole === 'wontfix' && !closed) {
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
      workflow,
      status,
      statusRole,
      claimed,
      hasStatusField: statuses.length > 0,
      closed,
      closedRaw,
      hasClosedField: completionValues.length > 0,
      closedImplicit,
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

function makeGraph(issues, warnings, workflow) {
  const graph = {
    workflow,
    requiredSkill: workflow === WORKFLOW_WAYFINDER ? WAYFINDER_REQUIRED_SKILL : null,
    groupOrder: workflow === WORKFLOW_WAYFINDER
      ? WAYFINDER_GROUP_ORDER
      : workflow === WORKFLOW_MIXED
        ? MIXED_GROUP_ORDER
        : GROUP_ORDER,
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
      // 混合图按票自身 workflow 分组，避免全局 workflow 抹掉 Type 语义。
      if (issue.workflow === WORKFLOW_WAYFINDER || (this.workflow === WORKFLOW_WAYFINDER && issue.workflow !== WORKFLOW_IMPLEMENTATION)) {
        if (issue.resolved && issue.metadataValid) return 'RESOLVED';
        if (!issue.metadataValid || this.hasGraphError(issue)) return 'OTHER / WARNINGS';
        if (this.openBlockersOf(issue).length > 0) return 'BLOCKED';
        if (issue.claimed) return 'CLAIMED';
        if (isWayfinderOpenStatus(issue.status)) return 'FRONTIER';
        return 'OTHER / WARNINGS';
      }
      if (issue.closed && issue.metadataValid) return 'CLOSED';
      if (!issue.metadataValid || this.hasGraphError(issue)) return 'OTHER / WARNINGS';
      if (this.openBlockersOf(issue).length > 0) return 'BLOCKED';
      if (issue.claimed) return 'CLAIMED';
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

  const issuePaths = entries
    .filter((item) => item.isFile() && ISSUE_FILE_RE.test(item.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => path.join(issuesDir, entry.name));
  if (issuePaths.length === 0) throw new Error(`no issue markdown files found under: ${issuesDir}`);

  const selection = await selectWorkflow(featureDir, issuePaths, config);
  const parsed = [];
  for (const issuePath of selection.issuePaths) parsed.push(await parseIssueDraft(issuePath, config, selection.workflow));

  const issues = parsed.map((item) => item.issue);
  const warnings = [...(selection.warnings ?? []), ...parsed.flatMap((item) => item.warnings)];
  resolveReferences(issues, warnings);
  let graph = makeGraph(issues, warnings, selection.workflow);
  for (const issue of issues) {
    for (const blocker of graph.missingBlockersOf(issue)) warnings.push({ code: 'missing-blocker', issue: issue.id, detail: blocker });
  }
  for (const cycle of dependencyCycles(graph)) {
    const detail = [...cycle, cycle[0]].join(' -> ');
    for (const issue of cycle) warnings.push({ code: 'dependency-cycle', issue, detail });
  }
  graph = makeGraph(issues, warnings, selection.workflow);
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
  if (issue.workflow === WORKFLOW_WAYFINDER) {
    lines.push(`  type: ${issue.type || 'unknown'}`, `  required skill: ${issue.requiredSkill}`);
  }
  lines.push(...issueReferenceLines('open blockers', graph.openBlockersOf(issue)));
  const missing = graph.missingBlockersOf(issue);
  if (missing.length > 0) lines.push('  missing blockers:', ...missing.map((id) => `    - ${id}`));
  lines.push(...issueReferenceLines('open dependents', graph.dependentsOf(issue).filter((candidate) => !candidate.closed)));
  lines.push(`  path: ${displayPath(issue.path, projectRoot)}`);
  return lines;
}

function isImplementationLikeIssue(issue) {
  return issue.workflow !== WORKFLOW_WAYFINDER;
}

export function summaryPayload(graph) {
  const edges = graph.issues.reduce((count, issue) => count + issue.blockedBy.filter((id) => graph.issueById.has(id)).length, 0);
  if (graph.workflow === WORKFLOW_WAYFINDER) {
    return {
      issues: graph.issues.length,
      open: graph.issues.filter((issue) => !issue.resolved).length,
      resolved: graph.issuesInGroup('RESOLVED').length,
      blocked: graph.issuesInGroup('BLOCKED').length,
      claimed: graph.issuesInGroup('CLAIMED').length,
      frontier: graph.issuesInGroup('FRONTIER').length,
      other: graph.issuesInGroup('OTHER / WARNINGS').length,
      edges,
      warnings: graph.warnings.length,
    };
  }
  const implementationIssues = graph.issues.filter(isImplementationLikeIssue);
  return {
    issues: graph.issues.length,
    open: graph.issues.filter((issue) => !issue.closed).length,
    closed: graph.issuesInGroup('CLOSED').length + (graph.workflow === WORKFLOW_MIXED ? graph.issuesInGroup('RESOLVED').length : 0),
    resolved: graph.issuesInGroup('RESOLVED').length,
    blocked: graph.issuesInGroup('BLOCKED').length,
    claimed: graph.issuesInGroup('CLAIMED').length,
    agentReady: graph.issuesInGroup('AGENT READY').length,
    frontier: graph.issuesInGroup('FRONTIER').length,
    humanReady: graph.issuesInGroup('HUMAN READY').length,
    waitingForInfo: graph.issuesInGroup('WAITING FOR INFO').length,
    needsTriage: graph.issuesInGroup('NEEDS TRIAGE').length,
    other: graph.issuesInGroup('OTHER / WARNINGS').length,
    missingClosed: implementationIssues.filter((issue) => !issue.hasClosedField && !issue.closedImplicit).length,
    implicitClosed: implementationIssues.filter((issue) => issue.closedImplicit).length,
    edges,
    warnings: graph.warnings.length,
  };
}

function issueSymbol(issue, graph) {
  const group = graph.groupOf(issue);
  if (group === 'CLOSED' || group === 'RESOLVED') return '✓';
  if (group === 'AGENT READY' || group === 'FRONTIER') return '○';
  if (group === 'CLAIMED') return '>';
  if (group === 'BLOCKED') return '×';
  if (group === 'HUMAN READY' || group === 'WAITING FOR INFO' || group === 'NEEDS TRIAGE') return '?';
  return '!';
}

// 人类看板类型标签：始终打印，便于扫一眼区分票种与完成态（完成看行首 ✓ 等符号）。
// Wayfinder 有 Type 时打印 research/grilling/task/prototype；缺失时 [unknown]。
// 实施票（无 Type 字段）统一 [impl]，含纯 implementation 图与 mixed 图。
function issueTypeTag(issue, _graph) {
  if (issue.workflow === WORKFLOW_WAYFINDER) {
    return issue.type ? ` [${issue.type}]` : ' [unknown]';
  }
  return ' [impl]';
}

function issueHeadline(issue, graph) {
  return `${issue.number}${issueTypeTag(issue, graph)} ${issue.title}`;
}

function issueDependencyLabel(issue, graph) {
  if (issue.blockedBy.length === 0) return '';
  const blockers = issue.blockedBy.map((id) => {
    const blocker = graph.issueById.get(id);
    return blocker ? blocker.number : id;
  });
  return ` <- ${blockers.join(', ')}`;
}

function treeParentMap(graph) {
  const order = new Map(graph.issues.map((issue, index) => [issue.id, index]));
  const parentByChild = new Map();
  for (const issue of graph.issues) {
    // 环成员不挂到彼此下面，避免异常依赖让渲染递归失控。
    if (graph.cycleOf(issue).length > 0) continue;
    const blockers = graph.blockersOf(issue).sort((left, right) => order.get(left.id) - order.get(right.id));
    if (blockers.length > 0) parentByChild.set(issue.id, blockers.at(-1).id);
  }
  return parentByChild;
}

function renderDependencyTree(graph) {
  const parentByChild = treeParentMap(graph);
  const childrenByParent = new Map(graph.issues.map((issue) => [issue.id, []]));
  for (const [childId, parentId] of parentByChild) childrenByParent.get(parentId)?.push(childId);

  const issueOrder = new Map(graph.issues.map((issue, index) => [issue.id, index]));
  for (const children of childrenByParent.values()) children.sort((left, right) => issueOrder.get(left) - issueOrder.get(right));
  const roots = graph.issues.filter((issue) => !parentByChild.has(issue.id)).map((issue) => issue.id);
  const rendered = new Set();
  const lines = [];

  function visit(issueId, prefix, isLast) {
    if (rendered.has(issueId)) return;
    rendered.add(issueId);
    const issue = graph.issueById.get(issueId);
    lines.push(`${prefix}${isLast ? '└─' : '├─'} ${issueSymbol(issue, graph)} ${issueHeadline(issue, graph)}${issueDependencyLabel(issue, graph)}`);
    const children = childrenByParent.get(issueId) ?? [];
    const childPrefix = `${prefix}${isLast ? '  ' : '│ '}`;
    children.forEach((childId, index) => visit(childId, childPrefix, index === children.length - 1));
  }

  roots.forEach((rootId, index) => visit(rootId, '', index === roots.length - 1));
  // 依赖环或异常图可能没有可达根节点，剩余节点各自作为根展示。
  for (const issue of graph.issues) if (!rendered.has(issue.id)) visit(issue.id, '', true);
  return lines;
}

function readyIssueCommand(issue, graph, projectRoot) {
  const issuePath = displayPath(issue.path, projectRoot);
  if (issue.workflow === WORKFLOW_WAYFINDER || graph.workflow === WORKFLOW_WAYFINDER) {
    return `${issue.requiredSkill || WAYFINDER_REQUIRED_SKILL} ${issuePath}`;
  }
  return `/implement ${issuePath}`;
}

function readyIssues(graph) {
  if (graph.workflow === WORKFLOW_WAYFINDER) return graph.issuesInGroup('FRONTIER');
  if (graph.workflow === WORKFLOW_MIXED) {
    return [...graph.issuesInGroup('FRONTIER'), ...graph.issuesInGroup('AGENT READY')]
      .sort((left, right) => left.number.localeCompare(right.number));
  }
  return graph.issuesInGroup('AGENT READY');
}

function renameSessionTitle(featureDir, issue) {
  return `${path.basename(featureDir)}/${issue.number}-${issue.title}`;
}

function renderReadyIssueLines(issue, graph, projectRoot, featureDir) {
  return [
    `- ${issueSymbol(issue, graph)} ${issueHeadline(issue, graph)}`,
    `  /rename ${renameSessionTitle(featureDir, issue)}`,
    `  ${readyIssueCommand(issue, graph, projectRoot)}`,
  ];
}

function renderNowLines(graph, projectRoot, featureDir) {
  const ready = readyIssues(graph);
  const claimed = graph.issuesInGroup('CLAIMED');
  const lines = [
    '',
    `NOW  可新增并行实施：${ready.length} | 进行中：${claimed.length}`,
    '',
    '可新增并行实施',
  ];
  if (ready.length === 0) lines.push('- 无');
  for (const issue of ready) lines.push(...renderReadyIssueLines(issue, graph, projectRoot, featureDir));
  lines.push('', '进行中');
  if (claimed.length === 0) lines.push('- 无');
  for (const issue of claimed) {
    const skill = issue.workflow === WORKFLOW_WAYFINDER || graph.workflow === WORKFLOW_WAYFINDER
      ? `skill=${issue.requiredSkill || WAYFINDER_REQUIRED_SKILL}`
      : `cmd=${readyIssueCommand(issue, graph, projectRoot)}`;
    lines.push(`- ${issueSymbol(issue, graph)} ${issueHeadline(issue, graph)} | ${skill}`);
  }
  return lines;
}

function renderWarnings(graph) {
  if (graph.warnings.length === 0) return [];
  return ['', 'WARNINGS', ...graph.warnings.map((warning) => `- code=${warning.code}${warning.issue ? ` issue=${warning.issue}` : ''} detail=${warning.detail}`)];
}

function renderLegend() {
  return [
    'LEGEND  ✓ 已完成 | > 已领取/进行中 | × 被阻塞 | ○ 可实施 | ? 等待人工 | ! 异常',
  ];
}

function renderSummaryLine(featureDir, graph, summary) {
  const completed = graph.workflow === WORKFLOW_WAYFINDER
    ? summary.resolved
    : summary.closed;
  return [
    ...renderLegend(),
    `KANBAN ${path.basename(featureDir)} | workflow=${graph.workflow}${graph.requiredSkill ? ` | required_skill=${graph.requiredSkill}` : ''}`,
    `ISSUES ${summary.issues} | 已完成 ${completed} | 未完成 ${summary.open} | 阻塞 ${summary.blocked}`,
    '',
    'DEPENDENCY TREE',
  ];
}

export function renderText(featureDir, graph, projectRoot = process.cwd()) {
  const summary = summaryPayload(graph);
  const lines = [
    ...renderSummaryLine(featureDir, graph, summary),
    ...renderDependencyTree(graph),
    ...renderWarnings(graph),
    ...renderNowLines(graph, projectRoot, featureDir),
  ];
  return `${lines.join('\n')}\n`;
}

export function renderReadyOnly(featureDir, graph, projectRoot = process.cwd()) {
  const ready = readyIssues(graph);
  const lines = graph.workflow === WORKFLOW_WAYFINDER
    ? [`Wayfinder frontier: ${path.basename(featureDir)}`, `required_skill=${graph.requiredSkill} frontier=${ready.length} warnings=${graph.warnings.length}`, '', 'FRONTIER']
    : graph.workflow === WORKFLOW_MIXED
      ? [`Mixed ready issues: ${path.basename(featureDir)}`, `ready=${ready.length} warnings=${graph.warnings.length}`, '', 'FRONTIER + AGENT READY']
      : [`Agent-ready issues: ${path.basename(featureDir)}`, `agent_ready=${ready.length} warnings=${graph.warnings.length}`, '', 'AGENT READY'];
  if (ready.length === 0) lines.push(graph.workflow === WORKFLOW_IMPLEMENTATION ? '- none' : '- 无');
  for (const issue of ready) lines.push(...renderReadyIssueLines(issue, graph, projectRoot, featureDir));
  if (graph.warnings.length > 0) {
    lines.push('', 'WARNINGS');
    for (const warning of graph.warnings) lines.push(`- code=${warning.code}${warning.issue ? ` issue=${warning.issue}` : ''} detail=${warning.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

export function issuePayload(issue, graph, projectRoot = process.cwd()) {
  if (issue.workflow === WORKFLOW_WAYFINDER) {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      workflow: issue.workflow,
      type: issue.type,
      status: issue.status,
      resolved: issue.resolved,
      claimed: issue.claimed,
      closed: Boolean(issue.closed),
      requiredSkill: issue.requiredSkill,
      hasStatusField: issue.hasStatusField,
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
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    workflow: issue.workflow || WORKFLOW_IMPLEMENTATION,
    status: issue.status,
    statusRole: issue.statusRole,
    claimed: Boolean(issue.claimed),
    hasStatusField: issue.hasStatusField,
    closed: issue.closed,
    closedRaw: issue.closedRaw,
    hasClosedField: issue.hasClosedField,
    closedImplicit: issue.closedImplicit,
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
    workflow: graph.workflow,
    requiredSkill: graph.requiredSkill,
    ...((graph.workflow === WORKFLOW_WAYFINDER || graph.workflow === WORKFLOW_MIXED)
      ? { map: displayPath(path.join(featureDir, 'map.md'), projectRoot) }
      : {}),
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
    const typePart = issueTypeTag(issue, graph);
    const label = `${issue.number}${typePart} ${issue.title}\\n${issue.status || 'unknown'} / ${graph.groupOf(issue)}`.replace(/"/g, '\\"');
    lines.push(`  ${ids.get(issue.id)}["${label}"]`);
  }
  for (const issue of graph.issues) {
    for (const blocker of issue.blockedBy) if (ids.has(blocker)) lines.push(`  ${ids.get(blocker)} --> ${ids.get(issue.id)}`);
  }
  const lifecycleHeader = graph.workflow === WORKFLOW_WAYFINDER ? 'Resolved' : 'Done';
  lines.push('```', '', '## Issues', '', `| Issue | Status | ${lifecycleHeader} | Group | Blocked by |`, '| --- | --- | --- | --- | --- |');
  for (const issue of graph.issues) {
    const issueLink = path.relative(path.dirname(outputPath), issue.path).split(path.sep).join('/');
    const blockers = issue.blockedBy.map((id) => graph.issueById.has(id)
      ? `[${graph.issueById.get(id).number}](${path.relative(path.dirname(outputPath), graph.issueById.get(id).path).split(path.sep).join('/')})`
      : `\`${id}\``).join(', ') || 'None';
    const lifecycle = issue.workflow === WORKFLOW_WAYFINDER ? issue.resolved : issue.closed;
    lines.push(`| [${issue.number} ${issue.title}](${issueLink}) | \`${issue.status || 'unknown'}\` | \`${lifecycle}\` | ${graph.groupOf(issue)} | ${blockers} |`);
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
  console.log(`Usage: node issue-board.mjs [options] [feature-dir]\n\nAuto-detects implementation and Wayfinder issue graphs.\n\nOptions:\n  --project-root PATH   Project root containing docs/agents/local-tracker.json\n  --list-features       List feature directories under the configured tracker root\n  --json                Emit the complete machine-readable graph\n  --non-interactive     Never prompt; fail when feature selection is ambiguous\n  --ready-only          Emit only AGENT READY or the Wayfinder FRONTIER\n  --format mermaid      Render a Mermaid projection (requires --output)\n  --output PATH         Write output to a file\n  -h, --help            Show help`);
}

async function chooseFeature(features, nonInteractive) {
  if (features.length === 0) throw new Error('no feature directories with issues found');
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
