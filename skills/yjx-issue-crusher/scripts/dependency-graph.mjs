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

/**
 * "现在可执行": not closed, no open blockers, ready-for-agent or empty status.
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
      if (status == null || status === '' || status === 'ready-for-agent') return true;
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
    'awaiting-worker-exit': '等待 Worker 退出',
    'needs-resume': '需恢复会话',
    'needs-confirmation': '需人工确认',
    stopped: '已停链',
  };
  return map[status] || status || '未知';
}
