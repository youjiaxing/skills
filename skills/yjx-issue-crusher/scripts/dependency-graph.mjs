/**
 * Read-only ASCII dependency graph for the dispatch TUI.
 *
 * Marks: ★ executable · blocked open · ▶ in slot · ✓ closed
 * Edge direction: upstream ──► downstream
 */

/**
 * @param {string} id
 * @returns {string}
 */
export function shortIssueLabel(id) {
  const base = String(id || '').replace(/\.md$/i, '');
  const match = base.match(/^(\d+)/);
  return match ? match[1] : base.slice(0, 12);
}

/**
 * Open blockers = blockedBy entries that exist and are not closed.
 * Missing blockers are listed for warnings but do not block ★ if only missing?
 * Spec: unresolved upstream blocks. Missing counts as open.
 * @param {Array<object>} issues
 * @returns {Map<string, string[]>}
 */
export function openBlockersById(issues) {
  const byId = new Map((issues || []).map((issue) => [issue.id, issue]));
  const result = new Map();
  for (const issue of issues || []) {
    const open = [];
    for (const blockerId of issue.blockedBy || []) {
      const blocker = byId.get(blockerId);
      if (!blocker || !blocker.closed) open.push(blockerId);
    }
    result.set(issue.id, open);
  }
  return result;
}

/** Human-triage roles: visible on board but not Enter-startable. */
const HUMAN_STATUS = new Set(['ready-for-human', 'needs-info', 'needs-triage']);

/** Wayfinder Status values that mean unfinished (not resolved). */
const WAYFINDER_OPEN_STATUS = new Set(['open', 'claimed', 'ready-for-agent']);

/** Type labels sometimes surface as board status when role is missing. */
const WAYFINDER_TYPE_AS_STATUS = new Set(['research', 'prototype', 'grilling', 'task']);

/**
 * "现在可执行": not closed, no open blockers, and either
 * - ordinary impl ready (empty / ready-for-agent status), or
 * - unfinished wayfinder frontier (open/claimed/… or Type/entryClass wayfinder).
 * Human triage / needs-info stays out — still ask before spawn.
 * @param {Array<object>} issues
 * @returns {string[]}
 */
export function listExecutableIssueIds(issues) {
  const openMap = openBlockersById(issues);
  return (issues || [])
    .filter((issue) => {
      if (issue.closed) return false;
      if ((openMap.get(issue.id) || []).length > 0) return false;
      const status = issue.status ?? issue.statusRole ?? null;
      if (HUMAN_STATUS.has(status)) return false;
      // Ordinary impl: ready or empty status.
      if (status == null || status === '' || status === 'ready-for-agent') return true;
      // Wayfinder frontier statuses (local-md Status: open / claimed).
      if (WAYFINDER_OPEN_STATUS.has(status)) return true;
      // Board projection sometimes puts Type in status when role is absent.
      if (WAYFINDER_TYPE_AS_STATUS.has(status)) return true;
      // Explicit wayfinder classification from tracker/board enrichment.
      if (
        issue.entryClass === 'wayfinder'
        || issue.workflow === 'wayfinder'
        || (issue.type && String(issue.type).trim() !== '')
      ) {
        return true;
      }
      return false;
    })
    .map((issue) => issue.id);
}

/**
 * @param {{ closed?: boolean, id: string, slotIssueId?: string|null, executableIds?: Set<string>|string[] }} opts
 */
export function issueMark({ closed, id, slotIssueId = null, executableIds = [] } = {}) {
  if (closed) return '✓';
  if (slotIssueId && id === slotIssueId) return '▶';
  const set = executableIds instanceof Set ? executableIds : new Set(executableIds);
  if (set.has(id)) return '★';
  return '·';
}

/**
 * Bracket type label for list / neighborhood rows.
 * Prefer explicit type, then entryClass, else ordinary impl.
 * @param {object | null | undefined} issue
 * @returns {string}
 */
export function issueTypeLabel(issue) {
  if (!issue) return 'impl';
  if (issue.type != null && String(issue.type).trim() !== '') {
    return String(issue.type).trim();
  }
  if (issue.entryClass != null && String(issue.entryClass).trim() !== '') {
    return String(issue.entryClass).trim();
  }
  return 'impl';
}

/**
 * Operator-facing board status display name (not chain-run soft-stuck ids).
 * Prototype target: 可实施 / 已完成 / 阻塞 / 待人工 / 已领取 …
 *
 * @param {object | null | undefined} issue
 * @param {{
 *   openBlockersById?: Map<string, string[]> | null,
 * }} [opts]
 * @returns {string}
 */
export function issueBoardStatusLabelZh(issue, { openBlockersById = null } = {}) {
  if (!issue) return '未知';
  if (issue.closed) return '已完成';
  const status = issue.status ?? issue.statusRole ?? null;
  if (status === 'resolved' || status === 'wontfix') return '已完成';
  if (status === 'claimed') return '已领取';
  if (status === 'ready-for-human') return '待人工';
  if (status === 'needs-info') return '需补充';
  if (status === 'needs-triage') return '待分诊';

  let openBlockers = null;
  if (openBlockersById && issue.id != null) {
    openBlockers = openBlockersById.get(issue.id) ?? [];
  } else if (Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0) {
    // Without a board map, non-empty blockedBy is treated as blocked
    // only when we cannot prove they are all closed — callers with a full
    // board should pass openBlockersById for accuracy.
    openBlockers = issue.blockedBy;
  } else {
    openBlockers = [];
  }
  if (openBlockers.length > 0) return '阻塞';

  if (
    status == null
    || status === ''
    || status === 'ready-for-agent'
    || status === 'open'
    || WAYFINDER_TYPE_AS_STATUS.has(status)
  ) {
    return '可实施';
  }
  // Fall back to raw status so unknown roles stay visible rather than blank.
  return String(status);
}

/**
 * Truncate display text by Unicode code points (TUI column budget).
 * @param {string | null | undefined} value
 * @param {number} max
 * @returns {string}
 */
function truncateChars(value, max) {
  const text = String(value ?? '');
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 24;
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  if (limit <= 1) return '…';
  return `${chars.slice(0, limit - 1).join('')}…`;
}

/**
 * Dense list / neighborhood row:
 * `mark id [type] 状态显示名 标题截断[  roleSuffix]`
 *
 * @param {object | null | undefined} issue
 * @param {{
 *   mark?: string,
 *   titleMax?: number,
 *   suffix?: string | null,
 *   openBlockersById?: Map<string, string[]> | null,
 * }} [opts]
 * @returns {string}
 */
export function formatIssueListRow(issue, {
  mark = '·',
  titleMax = 24,
  suffix = null,
  openBlockersById = null,
} = {}) {
  const id = issue?.id ?? '—';
  const type = issueTypeLabel(issue);
  const statusZh = issueBoardStatusLabelZh(issue, { openBlockersById });
  const rawTitle = issue?.title != null && String(issue.title).trim() !== ''
    ? String(issue.title)
    : '';
  // Avoid repeating the bare id as a fake title when title was defaulted to id.
  const title = rawTitle && rawTitle !== id
    ? truncateChars(rawTitle, titleMax)
    : '';
  const parts = [
    mark,
    id,
    `[${type}]`,
    statusZh,
  ];
  if (title) parts.push(title);
  let row = parts.join(' ');
  if (suffix != null && String(suffix).trim() !== '') {
    row = `${row}  ${String(suffix).trim()}`;
  }
  return row;
}

/**
 * Minimum terminal rows before focus neighborhood uses multi-line true edges.
 * Below this, compact clue shape is allowed but must show 「已降级」.
 * Picked so three-band Ink chrome (top status + footer) still fits with dense list.
 */
export const NEIGHBORHOOD_EDGES_MIN_ROWS = 22;

/**
 * @param {number | null | undefined} terminalRows
 * @returns {'edges' | 'compact'}
 */
export function resolveNeighborhoodLayout(terminalRows) {
  // Unknown / omitted height → default to full edges (completion shape).
  // Note: Number(null) === 0, so null/undefined must be rejected before Number().
  if (terminalRows == null || terminalRows === '') return 'edges';
  const n = Number(terminalRows);
  if (!Number.isFinite(n)) return 'edges';
  if (n < NEIGHBORHOOD_EDGES_MIN_ROWS) return 'compact';
  return 'edges';
}

/**
 * @param {Array<object>} issues
 */
export function collectGraphWarnings(issues) {
  const ids = new Set((issues || []).map((i) => i.id));
  const missing = [];
  for (const issue of issues || []) {
    for (const blockerId of issue.blockedBy || []) {
      if (!ids.has(blockerId) && !missing.includes(blockerId)) missing.push(blockerId);
    }
  }
  return { missing };
}

function sortIds(ids) {
  return [...ids].sort((left, right) => {
    const ln = Number.parseInt(shortIssueLabel(left), 10);
    const rn = Number.parseInt(shortIssueLabel(right), 10);
    if (Number.isFinite(ln) && Number.isFinite(rn) && ln !== rn) return ln - rn;
    return String(left).localeCompare(String(right));
  });
}

/** Single path covering every issue (each ≤1 in / ≤1 out among present nodes). */
function tryLinearOrder(issues) {
  if (!issues.length) return null;
  const idSet = new Set(issues.map((i) => i.id));
  const preds = new Map(issues.map((i) => [i.id, (i.blockedBy || []).filter((b) => idSet.has(b))]));
  const succs = new Map(issues.map((i) => [i.id, []]));
  for (const [id, ps] of preds) {
    for (const b of ps) succs.get(b).push(id);
  }
  for (const id of idSet) {
    if ((preds.get(id) || []).length > 1) return null;
    if ((succs.get(id) || []).length > 1) return null;
  }
  const roots = [...idSet].filter((id) => (preds.get(id) || []).length === 0);
  if (roots.length !== 1) return null;
  const order = [];
  let cur = roots[0];
  const seen = new Set();
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    order.push(cur);
    cur = (succs.get(cur) || [])[0];
  }
  return order.length === issues.length ? order : null;
}

/**
 * Immediate upstream of focus = blockedBy entries that exist on the board.
 * @param {Array<object>} issues
 * @param {string | null | undefined} focusId
 * @returns {string[]}
 */
export function listDirectUpstream(issues, focusId) {
  if (!focusId) return [];
  const list = Array.isArray(issues) ? issues : [];
  const byId = new Map(list.map((issue) => [issue.id, issue]));
  const focus = byId.get(focusId);
  if (!focus) return [];
  const idSet = new Set(byId.keys());
  return sortIds((focus.blockedBy || []).filter((blockerId) => idSet.has(blockerId)));
}

/**
 * Immediate downstream = open issues that list focus in blockedBy.
 * @param {Array<object>} issues
 * @param {string | null | undefined} focusId
 * @returns {string[]}
 */
export function listDirectDownstream(issues, focusId) {
  if (!focusId) return [];
  const list = Array.isArray(issues) ? issues : [];
  const idSet = new Set(list.map((issue) => issue.id));
  if (!idSet.has(focusId)) return [];
  return sortIds(
    list
      .filter((issue) => (issue.blockedBy || []).includes(focusId))
      .map((issue) => issue.id),
  );
}

/**
 * Focus for neighborhood: list highlight → current slot → board default → first board id.
 * Spec allows either list highlight or slot as reasonable default.
 *
 * @param {Array<object>} issues
 * @param {{
 *   selectedIssueId?: string | null,
 *   slotIssueId?: string | null,
 *   defaultIssueId?: string | null,
 * }} [opts]
 * @returns {string | null}
 */
export function resolveFocusIssueId(
  issues,
  {
    selectedIssueId = null,
    slotIssueId = null,
    defaultIssueId = null,
  } = {},
) {
  const list = Array.isArray(issues) ? issues : [];
  const ids = new Set(list.map((issue) => issue.id));
  for (const candidate of [selectedIssueId, slotIssueId, defaultIssueId]) {
    if (candidate != null && candidate !== '' && ids.has(candidate)) return candidate;
  }
  return list[0]?.id ?? null;
}

/**
 * Read-only direct up/downstream neighborhood of focus (not full-board map).
 * Collapses each side beyond maxPerSide with +N.
 *
 * Default layout is multi-line **true edges** (tree branches). Compact clue
 * chain is only for short terminals and must surface 「已降级」.
 *
 * @param {{
 *   issues?: Array<object>,
 *   focusId?: string | null,
 *   slotIssueId?: string | null,
 *   executableIds?: string[] | Set<string> | null,
 *   maxPerSide?: number,
 *   layout?: 'edges' | 'compact' | null,
 *   terminalRows?: number | null,
 * }} [options]
 * @returns {{
 *   lines: string[],
 *   focusId: string | null,
 *   upstream: string[],
 *   downstream: string[],
 *   layout: 'edges' | 'compact',
 *   degraded: boolean,
 * }}
 */
export function renderFocusNeighborhood({
  issues = [],
  focusId = null,
  slotIssueId = null,
  executableIds = null,
  maxPerSide = 5,
  layout = null,
  terminalRows = null,
} = {}) {
  const list = Array.isArray(issues) ? issues : [];
  const byId = new Map(list.map((issue) => [issue.id, issue]));
  const lines = [];
  const resolvedLayout = layout === 'compact' || layout === 'edges'
    ? layout
    : resolveNeighborhoodLayout(terminalRows);
  const degraded = resolvedLayout === 'compact';

  if (!focusId || !byId.has(focusId)) {
    const head = degraded
      ? '已降级 · 焦点邻域: （无焦点）'
      : '焦点邻域（只读 · 直接上下游 · 非全板）: （无焦点）';
    lines.push(head);
    return {
      lines,
      focusId: null,
      upstream: [],
      downstream: [],
      layout: resolvedLayout,
      degraded,
    };
  }

  const execIds = executableIds == null
    ? listExecutableIssueIds(list)
    : [...executableIds];
  const execSet = new Set(execIds);
  const openMap = openBlockersById(list);
  const markOf = (id) => issueMark({
    closed: Boolean(byId.get(id)?.closed),
    id,
    slotIssueId,
    executableIds: execSet,
  });
  /** Dense token: mark + short number (or short id). */
  const tok = (id) => `${markOf(id)}${shortIssueLabel(id)}`;
  /** Slightly longer token when side needs id disambiguation. */
  const describe = (id) => `${markOf(id)}${shortIssueLabel(id)} ${id}`;
  const denseRow = (id, extraSuffix = null) => {
    const issue = byId.get(id) || { id };
    const suffix = extraSuffix;
    return formatIssueListRow(issue, {
      mark: markOf(id),
      titleMax: 20,
      suffix,
      openBlockersById: openMap,
    });
  };

  const upstream = listDirectUpstream(list, focusId);
  const downstream = listDirectDownstream(list, focusId);
  const limit = Number.isFinite(Number(maxPerSide)) && Number(maxPerSide) > 0
    ? Math.floor(Number(maxPerSide))
    : 5;
  const upMore = Math.max(0, upstream.length - limit);
  const downMore = Math.max(0, downstream.length - limit);
  const showUps = upstream.slice(0, limit);
  const showDowns = downstream.slice(0, limit);

  if (resolvedLayout === 'edges') {
    // Multi-line true edges: section + tree branches (no tall │/▼ chrome).
    // Keep line count modest so Ink three-band frames still show top status.
    lines.push('焦点邻域（只读 · 直接上下游 · 非全板）');
    lines.push('  上游:');
    if (showUps.length === 0) {
      lines.push('    （无）');
    } else {
      showUps.forEach((id, idx) => {
        const branch = idx === showUps.length - 1 ? '└─' : '├─';
        lines.push(`  ${branch} ${denseRow(id)}`);
      });
      if (upMore > 0) lines.push(`    … +${upMore}`);
    }
    lines.push(`  ▶ ${denseRow(focusId, '◀焦点')}`);
    lines.push('  下游:');
    if (showDowns.length === 0) {
      lines.push('    （无）');
    } else {
      showDowns.forEach((id, idx) => {
        const branch = idx === showDowns.length - 1 ? '└─' : '├─';
        lines.push(`  ${branch} ${denseRow(id)}`);
      });
      if (downMore > 0) lines.push(`    … +${downMore}`);
    }
    return {
      lines,
      focusId,
      upstream,
      downstream,
      layout: resolvedLayout,
      degraded,
    };
  }

  // Compact clue shape for short terminals — 「已降级」leads so clipping cannot hide it.
  const side = (ids, more) => {
    if (ids.length === 0) return '·';
    const body = ids.map((id) => tok(id)).join('+');
    return more > 0 ? `${body}+${more}` : body;
  };
  const chain = `${side(showUps, upMore)} ──► ${tok(focusId)}◀焦点 ──► ${side(showDowns, downMore)}`;
  lines.push(`已降级 · 焦点邻域: ${chain}`);
  if (showUps.length || showDowns.length) {
    const upDetail = showUps.length
      ? showUps.map((id) => describe(id)).join(' · ') + (upMore > 0 ? ` · +${upMore}` : '')
      : '（无）';
    const downDetail = showDowns.length
      ? showDowns.map((id) => describe(id)).join(' · ') + (downMore > 0 ? ` · +${downMore}` : '')
      : '（无）';
    lines.push(`  上游: ${upDetail} · 下游: ${downDetail}`);
  } else {
    lines.push('  上游: （无） · 下游: （无）');
  }

  return {
    lines,
    focusId,
    upstream,
    downstream,
    layout: resolvedLayout,
    degraded,
  };
}

/**
 * @param {{
 *   issues: Array<object>,
 *   slotIssueId?: string|null,
 *   executableIds?: string[]|null,
 * }} options
 * @returns {{ lines: string[], executable: Array<{id:string,title?:string}>, warnings: string[] }}
 */
export function renderDependencyGraph({
  issues = [],
  slotIssueId = null,
  executableIds = null,
} = {}) {
  const list = Array.isArray(issues) ? issues : [];
  const execIds = executableIds ? [...executableIds] : listExecutableIssueIds(list);
  const execSet = new Set(execIds);
  const byId = new Map(list.map((i) => [i.id, i]));
  const executable = execIds.map((id) => ({
    id,
    title: byId.get(id)?.title ?? id,
  }));

  const { missing } = collectGraphWarnings(list);
  const warnings = missing.map((id) => `上游引用不存在: ${id}`);

  if (list.length === 0) {
    return { lines: ['  （无 issue）'], executable, warnings };
  }

  const markOf = (id) => issueMark({
    closed: Boolean(byId.get(id)?.closed),
    id,
    slotIssueId,
    executableIds: execSet,
  });
  const token = (id) => `${markOf(id)}${shortIssueLabel(id)}`;

  const idSet = new Set(list.map((i) => i.id));
  const succs = new Map(list.map((i) => [i.id, []]));
  for (const issue of list) {
    for (const b of issue.blockedBy || []) {
      if (idSet.has(b)) succs.get(b).push(issue.id);
    }
  }
  for (const [id, arr] of succs) succs.set(id, sortIds(arr));

  const lines = [];
  const linear = tryLinearOrder(list);
  if (linear) {
    lines.push(`  ${linear.map(token).join(' ──► ')}`);
  } else {
    // Multi-parent / fork: print each edge group from parents with ≤1 visual style.
    // Strategy: for each node with multiple successors, show fork; chains as arrows.
    const roots = sortIds(
      list
        .filter((i) => (i.blockedBy || []).filter((b) => idSet.has(b)).length === 0)
        .map((i) => i.id),
    );
    const printed = new Set();

    function printChainFrom(start, indent) {
      const chain = [start];
      let cur = start;
      while (true) {
        const kids = succs.get(cur) || [];
        if (kids.length !== 1) break;
        cur = kids[0];
        chain.push(cur);
      }
      const last = chain[chain.length - 1];
      const lastKids = succs.get(last) || [];
      lines.push(`${indent}${chain.map(token).join(' ──► ')}`);
      for (const id of chain) printed.add(id);
      if (lastKids.length > 1) {
        lastKids.forEach((kid, index) => {
          const branch = index === lastKids.length - 1 ? '└──►' : '├──►';
          lines.push(`${indent}       ${branch} ${token(kid)}`);
          printed.add(kid);
          const grand = succs.get(kid) || [];
          if (grand.length === 1) {
            printChainFrom(grand[0], `${indent}              `);
          } else if (grand.length > 1) {
            printChainFrom(kid, `${indent}              `);
          }
        });
      } else if (lastKids.length === 1 && !printed.has(lastKids[0])) {
        printChainFrom(lastKids[0], indent);
      }
    }

    // Join (multi-parent): also list "A,B ──► C" hints
    const multiParent = list.filter(
      (i) => (i.blockedBy || []).filter((b) => idSet.has(b)).length > 1,
    );
    for (const root of roots) {
      if (!printed.has(root)) printChainFrom(root, '  ');
    }
    for (const issue of multiParent) {
      const parents = sortIds((issue.blockedBy || []).filter((b) => idSet.has(b)));
      lines.push(
        `  ${parents.map(token).join(' + ')} ──► ${token(issue.id)}  （汇合）`,
      );
      printed.add(issue.id);
    }
    for (const issue of list) {
      if (!printed.has(issue.id)) {
        lines.push(`  ${token(issue.id)}`);
        printed.add(issue.id);
      }
    }
  }

  return { lines, executable, warnings };
}

/**
 * @param {string} status
 */
export function statusLabelZh(status) {
  const map = {
    idle: '空闲',
    'soft-stuck': '软卡住（票未关，进程仍在）',
    // Base labels stay short; top-bar statusLine adds wait / countdown / f / r hints.
    'awaiting-worker-exit': '等待 Worker 退出',
    'awaiting-session-end': '等待会话结束信号',
    'session-interrupted': '会话中断',
    'handoff-countdown': '交接倒计时',
    'needs-resume': '需恢复会话',
    'needs-confirmation': '需人工确认',
    stopped: '已停链',
  };
  return map[status] || status || '未知';
}
