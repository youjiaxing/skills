/**
 * Pure GitHub Issues board engine for yjx-gh-kanban.
 *
 * Fixture-friendly: inject issues + native relations + triage config.
 * Does not call gh or the network. Thin CLI and path discovery live in
 * issue-board.mjs and resolve-board-script.mjs.
 */

export const DEFAULT_READY_LABEL = 'ready-for-agent';
export const SPEC_HEADINGS = ['Problem Statement', 'Solution', 'User Stories'];

const PRIORITY_CRITICAL = ['critical', 'crash', 'blocker', '严重', '崩溃', '阻塞'];
const PRIORITY_INFRA = ['test', 'type', 'ci', 'build', 'infra', '脚手架', '构建', '验证'];
const PRIORITY_TRACER = ['tracer', 'vertical', 'slice', '端到端', '闭环'];

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function asMap(value) {
  if (value instanceof Map) {
    for (const [key] of value) {
      if (!Number.isFinite(Number(key))) {
        throw new Error(`issue map has invalid number key: ${key}`);
      }
    }
    return value;
  }
  if (value == null) return new Map();
  if (Array.isArray(value)) {
    const map = new Map();
    for (const item of value) {
      const number = Number(item.number);
      if (!Number.isFinite(number)) {
        throw new Error(`issue entry missing valid number: ${JSON.stringify(item)}`);
      }
      map.set(number, item);
    }
    return map;
  }
  const map = new Map();
  for (const [key, item] of Object.entries(value)) {
    const number = Number(item?.number ?? key);
    if (!Number.isFinite(number)) {
      throw new Error(`issue entry missing valid number: ${JSON.stringify({ key, item })}`);
    }
    map.set(number, item);
  }
  return map;
}

function normalizeAssignees(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const login = item.login ?? item.name ?? item.username;
        return typeof login === 'string' ? login.trim() : '';
      }
      return '';
    })
    .filter(Boolean);
}

function normalizeIssue(raw) {
  const number = Number(raw.number);
  if (!Number.isFinite(number)) {
    throw new Error(`issue missing valid number: ${JSON.stringify(raw)}`);
  }
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((label) => (typeof label === 'string' ? label : label?.name ?? '')).filter(Boolean)
    : [];
  const state = String(raw.state ?? 'OPEN');
  return {
    number,
    title: String(raw.title ?? ''),
    state,
    url: String(raw.url ?? ''),
    labels,
    body: String(raw.body ?? ''),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? ''),
    assignees: normalizeAssignees(raw.assignees),
    isClosed: state.toUpperCase() === 'CLOSED',
  };
}

function normalizeDependency(raw) {
  const number = Number(raw.number);
  if (!Number.isFinite(number)) {
    throw new Error(`dependency missing valid number: ${JSON.stringify(raw)}`);
  }
  const state = String(raw.state ?? 'OPEN');
  return {
    number,
    state,
    isClosed: state.toUpperCase() === 'CLOSED',
  };
}

function normalizeRelations(raw) {
  if (raw == null) {
    return { parent: null, blockedBy: [] };
  }
  const parentRaw = raw.parent;
  let parent = null;
  if (parentRaw != null) {
    parent = typeof parentRaw === 'object' ? Number(parentRaw.number) : Number(parentRaw);
    if (!Number.isFinite(parent)) {
      throw new Error(`invalid parent value: ${JSON.stringify(parentRaw)}`);
    }
  }
  let blockedSource = raw.blockedBy ?? raw.blocked_by ?? [];
  // Accept gh-style { nodes, totalCount } for fixture convenience; fail-closed if truncated.
  if (blockedSource && typeof blockedSource === 'object' && !Array.isArray(blockedSource)) {
    const nodes = blockedSource.nodes;
    const totalCount = blockedSource.totalCount;
    if (!Array.isArray(nodes) || typeof totalCount !== 'number') {
      throw new Error(
        `invalid blocked-by data: expected nodes and totalCount, got ${JSON.stringify(blockedSource)}`,
      );
    }
    if (nodes.length !== totalCount) {
      throw new Error(
        `truncated blocked-by data: expected ${totalCount}, received ${nodes.length}`,
      );
    }
    blockedSource = nodes;
  }
  if (!Array.isArray(blockedSource)) {
    throw new Error(`invalid blockedBy: expected array, got ${JSON.stringify(blockedSource)}`);
  }
  const blockedBy = blockedSource
    .map(normalizeDependency)
    .sort((left, right) => left.number - right.number);
  return { parent, blockedBy };
}

function normalizeRelationsMap(value) {
  const map = new Map();
  if (value == null) return map;
  if (value instanceof Map) {
    for (const [key, raw] of value) {
      map.set(Number(key), normalizeRelations(raw));
    }
    return map;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const number = Number(item.number);
      map.set(number, normalizeRelations(item));
    }
    return map;
  }
  for (const [key, raw] of Object.entries(value)) {
    map.set(Number(key), normalizeRelations(raw));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Spec / wayfinder / priority / triage helpers
// ---------------------------------------------------------------------------

export function hasH2Heading(body, heading) {
  // Multiline mode via flags (JS does not support Python-style (?m) inline).
  const pattern = new RegExp(`^##[ \\t]+${escapeRegExp(heading)}[ \\t]*$`, 'm');
  return pattern.test(body ?? '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isSpecIssue(issueOrBody) {
  const body = typeof issueOrBody === 'string' ? issueOrBody : issueOrBody?.body ?? '';
  return SPEC_HEADINGS.every((heading) => hasH2Heading(body, heading));
}

export function isWayfinderIssue(issueOrLabels) {
  const labels = Array.isArray(issueOrLabels)
    ? issueOrLabels
    : issueOrLabels?.labels ?? [];
  return labels.some((label) => String(label).startsWith('wayfinder:'));
}

export function priorityKey(issue) {
  const text = `${issue.title} ${(issue.labels ?? []).join(' ')}`.toLowerCase();
  let bucket = 3;
  if (PRIORITY_CRITICAL.some((token) => text.includes(token))) bucket = 0;
  else if (PRIORITY_INFRA.some((token) => text.includes(token))) bucket = 1;
  else if (PRIORITY_TRACER.some((token) => text.includes(token))) bucket = 2;
  return [bucket, Number(issue.number)];
}

/**
 * Parse ready-for-agent label from docs/agents/triage-labels.md style tables.
 * Falls back to DEFAULT_READY_LABEL when the mapping is missing.
 */
export function parseReadyLabelFromTriageDoc(markdown, fallback = DEFAULT_READY_LABEL) {
  if (!markdown) return fallback;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (!line.includes('`ready-for-agent`')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    if (cells.length >= 2) {
      const label = cells[1].replace(/^`|`$/g, '').trim();
      if (label) return label;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Machine board classification (compatible with family-health-app Python board)
// ---------------------------------------------------------------------------

function issueRef(number) {
  return `#${number}`;
}

function buildUnlocks(relationsMap) {
  const unlocksByIssue = new Map();
  for (const [issueNumber, native] of relationsMap) {
    for (const blocker of native.blockedBy) {
      const list = unlocksByIssue.get(blocker.number) ?? [];
      list.push(issueNumber);
      unlocksByIssue.set(blocker.number, list);
    }
  }
  for (const [key, list] of unlocksByIssue) {
    unlocksByIssue.set(key, [...new Set(list)].sort((a, b) => a - b));
  }
  return unlocksByIssue;
}

export function issueEntry(issue, relations, unlocks = []) {
  const blockedBy = relations?.blockedBy ?? [];
  return {
    number: issue.number,
    ref: issueRef(issue.number),
    title: issue.title,
    state: issue.state,
    url: issue.url,
    labels: [...issue.labels],
    updatedAt: issue.updatedAt,
    assignees: [...issue.assignees],
    parent: relations ? relations.parent : null,
    isSpec: isSpecIssue(issue),
    isWayfinder: isWayfinderIssue(issue),
    blockedBy: blockedBy.map((item) => item.number),
    openBlockers: blockedBy.filter((item) => !item.isClosed).map((item) => item.number),
    unlocks: [...unlocks].sort((a, b) => a - b),
  };
}

function comparePriorityEntries(left, right) {
  const [lb, ln] = priorityKey(left);
  const [rb, rn] = priorityKey(right);
  if (lb !== rb) return lb - rb;
  return ln - rn;
}

/**
 * Classify issues into READY / BLOCKED / SPEC / otherOpen / closed.
 * Fail-closed: ready-label open non-spec non-wayfinder tickets must have relations.
 *
 * @param {Map|Object|Array} issuesInput
 * @param {string} readyLabel
 * @param {Map|Object|Array} relationsInput
 * @returns {object} machine board payload
 */
export function classify(issuesInput, readyLabel, relationsInput) {
  const issuesMap = asMap(issuesInput);
  const issues = new Map([...issuesMap.entries()].map(([number, raw]) => [number, normalizeIssue(raw)]));
  const relationsMap = normalizeRelationsMap(relationsInput);
  const unlocksByIssue = buildUnlocks(relationsMap);

  const ready = [];
  const blocked = [];
  const specs = [];
  const otherOpen = [];
  const closed = [];

  const sorted = [...issues.values()].sort((a, b) => a.number - b.number);
  for (const issue of sorted) {
    const native = relationsMap.get(issue.number) ?? null;
    const entry = issueEntry(issue, native, unlocksByIssue.get(issue.number) ?? []);
    if (issue.isClosed) {
      closed.push(entry);
      continue;
    }
    if (entry.isSpec) {
      specs.push(entry);
      continue;
    }
    if (!issue.labels.includes(readyLabel) || entry.isWayfinder) {
      otherOpen.push(entry);
      continue;
    }
    if (native == null) {
      throw new Error(`Native GitHub relations were not loaded for ${entry.ref}`);
    }
    if (entry.openBlockers.length > 0) {
      blocked.push(entry);
    } else {
      ready.push(entry);
    }
  }

  ready.sort(comparePriorityEntries);
  specs.sort((a, b) => a.number - b.number);
  blocked.sort((a, b) => a.number - b.number);
  otherOpen.sort((a, b) => a.number - b.number);
  closed.sort((a, b) => a.number - b.number);

  const next = ready[0] ?? null;
  return {
    summary: {
      ready: ready.length,
      blocked: blocked.length,
      spec: specs.length,
      otherOpen: otherOpen.length,
      closed: closed.length,
      readyLabel,
    },
    next,
    ready,
    blocked,
    specs,
    otherOpen,
    closed,
  };
}

// ---------------------------------------------------------------------------
// View node selection (human dependency tree scope)
// ---------------------------------------------------------------------------

function childrenByParent(relationsMap) {
  const map = new Map();
  for (const [childNumber, native] of relationsMap) {
    if (native.parent == null) continue;
    const list = map.get(native.parent) ?? [];
    list.push(childNumber);
    map.set(native.parent, list);
  }
  for (const list of map.values()) list.sort((a, b) => a - b);
  return map;
}

/**
 * Default whole-repo: all open issues + closed blockers needed to understand blocking.
 * Parent filter: parent + descendant sub-issues + blocker closure (open and closed).
 */
export function selectViewNodes(issuesInput, relationsInput, options = {}) {
  const issuesMap = asMap(issuesInput);
  const issues = new Map([...issuesMap.entries()].map(([n, raw]) => [n, normalizeIssue(raw)]));
  const relationsMap = normalizeRelationsMap(relationsInput);
  const parentFilter = options.parentFilter == null ? null : Number(options.parentFilter);

  if (parentFilter != null) {
    if (!Number.isFinite(parentFilter)) {
      throw new Error(`invalid parentFilter: ${options.parentFilter}`);
    }
    const childMap = childrenByParent(relationsMap);
    const selected = new Set([parentFilter]);
    const queue = [parentFilter];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const child of childMap.get(current) ?? []) {
        if (selected.has(child)) continue;
        selected.add(child);
        queue.push(child);
      }
    }
    // Blocker closure over selected nodes (may pull external issues into the view).
    let growing = true;
    while (growing) {
      growing = false;
      for (const number of [...selected]) {
        const native = relationsMap.get(number);
        if (!native) continue;
        for (const blocker of native.blockedBy) {
          if (!selected.has(blocker.number)) {
            selected.add(blocker.number);
            growing = true;
          }
        }
      }
    }
    return selected;
  }

  // Whole-repo default.
  const selected = new Set();
  for (const issue of issues.values()) {
    if (!issue.isClosed) selected.add(issue.number);
  }
  for (const number of [...selected]) {
    const native = relationsMap.get(number);
    if (!native) continue;
    for (const blocker of native.blockedBy) {
      selected.add(blocker.number);
    }
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Human symbols / tree / NOW
// ---------------------------------------------------------------------------

function entryByNumber(board) {
  const map = new Map();
  for (const group of ['ready', 'blocked', 'specs', 'otherOpen', 'closed']) {
    for (const entry of board[group]) {
      map.set(entry.number, entry);
    }
  }
  return map;
}

/**
 * Resolve a display entry for a view node. May synthesize minimal entries for
 * closed blockers present only as relation targets.
 */
function resolveViewEntry(number, issues, relationsMap, boardEntries, unlocksByIssue) {
  if (boardEntries.has(number)) return boardEntries.get(number);
  if (issues.has(number)) {
    const issue = issues.get(number);
    const native = relationsMap.get(number) ?? null;
    return issueEntry(issue, native, unlocksByIssue.get(number) ?? []);
  }
  // Synthetic closed/unknown blocker referenced only by relations.
  let state = 'CLOSED';
  for (const native of relationsMap.values()) {
    const hit = native.blockedBy.find((item) => item.number === number);
    if (hit) {
      state = hit.state;
      break;
    }
  }
  return {
    number,
    ref: issueRef(number),
    title: `(missing #${number})`,
    state,
    url: '',
    labels: [],
    updatedAt: '',
    assignees: [],
    parent: null,
    isSpec: false,
    isWayfinder: false,
    blockedBy: [],
    openBlockers: [],
    unlocks: unlocksByIssue.get(number) ?? [],
    _synthetic: true,
  };
}

export function issueSymbol(entry, { readyLabel, readyNumbers, blockedNumbers } = {}) {
  if (String(entry.state).toUpperCase() === 'CLOSED') return '✓';
  if (entry._synthetic && entry.title.startsWith('(missing')) return '!';
  if (entry._warning) return '!';
  if (blockedNumbers?.has(entry.number)) return '×';
  if ((entry.openBlockers?.length ?? 0) > 0 && readyLabel && entry.labels?.includes(readyLabel) && !entry.isWayfinder) {
    return '×';
  }
  if (readyNumbers?.has(entry.number)) return '○';
  if (entry.assignees?.length) return '>';
  if (entry.isSpec || entry.isWayfinder) return '?';
  // Waiting / other open (human, triage, or unlabeled open work)
  if (
    entry.labels?.some((label) => label === 'ready-for-human' || label === 'needs-info' || label === 'needs-triage')
    || (entry.openBlockers?.length ?? 0) === 0
  ) {
    return '?';
  }
  if (entry.openBlockers?.length) return '×';
  return '!';
}

function typeTag(entry) {
  if (entry.isSpec) return ' [spec]';
  if (entry.isWayfinder) {
    const way = (entry.labels ?? []).find((label) => String(label).startsWith('wayfinder:'));
    if (way) {
      const kind = String(way).slice('wayfinder:'.length) || 'unknown';
      return ` [${kind}]`;
    }
    return ' [wayfinder]';
  }
  return ' [impl]';
}

function dependencyLabel(entry) {
  if (!entry.blockedBy?.length) return '';
  return ` <- ${entry.blockedBy.map((n) => `#${n}`).join(', ')}`;
}

function headline(entry) {
  return `${entry.number}${typeTag(entry)} ${entry.title}`;
}

/**
 * Visual main parent = native parent (not blocker). blockedBy stays as trailing list.
 * Each issue rendered at most once.
 */
export function renderDependencyTree(viewEntries, relationsMap, context) {
  const byNumber = new Map(viewEntries.map((entry) => [entry.number, entry]));
  const parentByChild = new Map();
  for (const entry of viewEntries) {
    const native = relationsMap.get(entry.number);
    const parent = native?.parent ?? entry.parent ?? null;
    if (parent != null && byNumber.has(parent)) {
      parentByChild.set(entry.number, parent);
    }
  }

  const childrenByParentMap = new Map(viewEntries.map((entry) => [entry.number, []]));
  for (const [child, parent] of parentByChild) {
    childrenByParentMap.get(parent)?.push(child);
  }
  for (const children of childrenByParentMap.values()) {
    children.sort((a, b) => a - b);
  }

  const roots = viewEntries
    .filter((entry) => !parentByChild.has(entry.number))
    .map((entry) => entry.number)
    .sort((a, b) => a - b);

  const rendered = new Set();
  const lines = [];

  function visit(number, prefix, isLast) {
    if (rendered.has(number)) return;
    rendered.add(number);
    const entry = byNumber.get(number);
    if (!entry) return;
    const symbol = issueSymbol(entry, context);
    lines.push(
      `${prefix}${isLast ? '└─' : '├─'} ${symbol} ${headline(entry)}${dependencyLabel(entry)}`,
    );
    const children = childrenByParentMap.get(number) ?? [];
    const childPrefix = `${prefix}${isLast ? '  ' : '│ '}`;
    children.forEach((childId, index) => visit(childId, childPrefix, index === children.length - 1));
  }

  roots.forEach((rootId, index) => visit(rootId, '', index === roots.length - 1));
  for (const entry of viewEntries) {
    if (!rendered.has(entry.number)) visit(entry.number, '', true);
  }
  return lines;
}

function slugTitle(title) {
  return String(title ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff.-]+/g, '')
    .slice(0, 48) || 'issue';
}

function renderReadyIssueLines(entry) {
  return [
    `- ○ ${headline(entry)}`,
    `  /rename gh/#${entry.number}-${slugTitle(entry.title)}`,
    `  gh issue view ${entry.number}`,
  ];
}

/**
 * NOW: implementable READY + in-progress (assignee approximation).
 * In-progress is human-only and does not redefine machine READY.
 */
export function renderNowLines(board, options = {}) {
  const ready = board.ready ?? [];
  // In-progress: open + assignees, exclude SPEC and wayfinder. Prefer board entries.
  const inProgress = [];
  const seen = new Set();
  for (const group of ['ready', 'blocked', 'otherOpen']) {
    for (const entry of board[group] ?? []) {
      if (!entry.assignees?.length) continue;
      if (entry.isSpec || entry.isWayfinder) continue;
      if (String(entry.state).toUpperCase() === 'CLOSED') continue;
      if (seen.has(entry.number)) continue;
      seen.add(entry.number);
      inProgress.push(entry);
    }
  }
  // Also scan view entries if provided (assignees on non-classified open nodes).
  for (const entry of options.viewEntries ?? []) {
    if (!entry.assignees?.length) continue;
    if (entry.isSpec || entry.isWayfinder) continue;
    if (String(entry.state).toUpperCase() === 'CLOSED') continue;
    if (seen.has(entry.number)) continue;
    seen.add(entry.number);
    inProgress.push(entry);
  }
  inProgress.sort((a, b) => a.number - b.number);

  const lines = [
    '',
    `NOW  可新增并行实施：${ready.length} | 进行中：${inProgress.length}`,
    '',
    '可新增并行实施',
  ];
  if (ready.length === 0) lines.push('- 无');
  else for (const entry of ready) lines.push(...renderReadyIssueLines(entry));

  lines.push('', '进行中（assignee 近似，非 claimed 协议；不改变 READY 契约）');
  if (inProgress.length === 0) lines.push('- 无');
  else {
    for (const entry of inProgress) {
      const who = entry.assignees.join(', ');
      lines.push(`- > ${headline(entry)} | assignees=${who}`);
    }
  }
  return lines;
}

export function renderWarnings(warnings) {
  const lines = ['', 'WARNINGS'];
  if (!warnings?.length) {
    lines.push('- none');
    return lines;
  }
  for (const warning of warnings) {
    if (typeof warning === 'string') lines.push(`- ${warning}`);
    else {
      lines.push(
        `- code=${warning.code ?? 'warning'}${warning.issue != null ? ` issue=${warning.issue}` : ''} detail=${warning.detail ?? ''}`,
      );
    }
  }
  return lines;
}

export function renderLegend() {
  return [
    'LEGEND  ✓ 已完成 | > 进行中(assignee) | × 被阻塞 | ○ 可实施 | ? 等待/其它 | ! 异常',
  ];
}

function collectWarnings(issues, relationsMap, board, viewNodeSet) {
  const warnings = [];
  // Missing issue bodies for blockers referenced in view.
  for (const number of viewNodeSet) {
    if (!issues.has(number)) {
      warnings.push({
        code: 'missing-issue',
        issue: issueRef(number),
        detail: 'referenced in relations/view but not present in issues fixture',
      });
    }
  }
  // Parent points outside view under parent filter — informational only when parent missing entirely.
  for (const [number, native] of relationsMap) {
    if (!viewNodeSet.has(number)) continue;
    if (native.parent != null && !issues.has(native.parent) && !viewNodeSet.has(native.parent)) {
      warnings.push({
        code: 'missing-parent',
        issue: issueRef(number),
        detail: `parent #${native.parent} not in issues`,
      });
    }
  }
  void board;
  return warnings;
}

/**
 * Full human board text (LEGEND, summary, DEPENDENCY TREE, WARNINGS, NOW).
 */
export function renderHuman(issuesInput, relationsInput, options = {}) {
  const readyLabel = options.readyLabel ?? DEFAULT_READY_LABEL;
  const issuesMap = asMap(issuesInput);
  const issues = new Map([...issuesMap.entries()].map(([n, raw]) => [n, normalizeIssue(raw)]));
  const relationsMap = normalizeRelationsMap(relationsInput);

  const board = options.board ?? classify(issues, readyLabel, relationsMap);
  const viewNodeSet = options.viewNodes
    ?? selectViewNodes(issues, relationsMap, { parentFilter: options.parentFilter });
  const unlocksByIssue = buildUnlocks(relationsMap);
  const boardEntries = entryByNumber(board);

  const viewEntries = [...viewNodeSet]
    .sort((a, b) => a - b)
    .map((number) => resolveViewEntry(number, issues, relationsMap, boardEntries, unlocksByIssue));

  const readyNumbers = new Set(board.ready.map((entry) => entry.number));
  const blockedNumbers = new Set(board.blocked.map((entry) => entry.number));
  const symbolContext = { readyLabel, readyNumbers, blockedNumbers };

  const warnings = [
    ...(options.warnings ?? []),
    ...collectWarnings(issues, relationsMap, board, viewNodeSet),
  ];

  const parentNote = options.parentFilter != null ? ` | parent=#${options.parentFilter}` : '';
  const lines = [
    ...renderLegend(),
    `KANBAN github${parentNote} | ready_label=${readyLabel}`,
    `READY ${board.summary.ready} | BLOCKED ${board.summary.blocked} | SPEC ${board.summary.spec} | OTHER_OPEN ${board.summary.otherOpen} | CLOSED ${board.summary.closed}`,
    '',
    'DEPENDENCY TREE',
    ...renderDependencyTree(viewEntries, relationsMap, symbolContext),
    ...renderWarnings(warnings),
    ...renderNowLines(board, { viewEntries }),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Compact agent output: ready counts + next= + READY list.
 */
export function renderAgent(board) {
  const summary = board.summary;
  const next = board.next;
  const lines = [
    `ready=${summary.ready} blocked=${summary.blocked} spec=${summary.spec} other_open=${summary.otherOpen}`,
    `next=${next ? next.ref : 'none'}`,
    'READY',
  ];
  if (!board.ready.length) {
    lines.push('- none');
  } else {
    for (const entry of board.ready) {
      lines.push(...issueLine(entry));
    }
  }
  return `${lines.join('\n')}\n`;
}

export function issueLine(entry) {
  const labels = entry.labels?.length ? entry.labels.join(', ') : 'no labels';
  const parent = entry.parent != null ? ` parent #${entry.parent}` : '';
  const unlocks = entry.unlocks?.length
    ? ` unlocks ${entry.unlocks.map((n) => `#${n}`).join(', ')}`
    : '';
  return [
    `- ${entry.ref} ${entry.title} (${labels})${parent}${unlocks}`,
    `  ${entry.url}`,
  ];
}

export function renderReadyOnly(board) {
  const lines = [
    'GitHub Issues Board (ready-only)',
    `ready=${board.summary.ready} next=${board.next ? board.next.ref : 'none'}`,
    '',
    'READY',
  ];
  if (!board.ready.length) lines.push('- none');
  else {
    for (const entry of board.ready) {
      lines.push(...renderReadyIssueLines(entry));
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderJson(board) {
  return `${JSON.stringify(board, null, 2)}\n`;
}

/**
 * High-level pure entry: classify + optional human/agent/json projections.
 *
 * @param {object} input
 * @param {Map|Object|Array} input.issues
 * @param {Map|Object|Array} input.relations
 * @param {object} [input.options]
 * @param {string} [input.options.readyLabel]
 * @param {number|null} [input.options.parentFilter]
 * @returns {{ board: object, viewNodes: Set<number>, human: string, agent: string, json: string, readyOnly: string }}
 */
export function buildBoard(input = {}) {
  const readyLabel = input.options?.readyLabel ?? input.readyLabel ?? DEFAULT_READY_LABEL;
  const issues = input.issues;
  const relations = input.relations;
  const parentFilter = input.options?.parentFilter ?? input.parentFilter ?? null;

  const board = classify(issues, readyLabel, relations);
  const viewNodes = selectViewNodes(issues, relations, { parentFilter });
  return {
    board,
    viewNodes,
    human: renderHuman(issues, relations, { readyLabel, parentFilter, board, viewNodes }),
    agent: renderAgent(board),
    json: renderJson(board),
    readyOnly: renderReadyOnly(board),
  };
}
