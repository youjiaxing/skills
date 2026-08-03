import { toCandidate } from './select-candidates.mjs';

/**
 * In-memory TrackerPort for Chain Run tests.
 * Does not touch the filesystem or yjx-local-kanban.
 * Completions are mutable so dual-condition handoff can close tickets mid-run.
 *
 * Auto candidates = ready-for-agent ordinary impl (auto spawn).
 * HITL candidates = wayfinder / human / unknown (ask before spawn).
 */
export function createFakeTracker({
  candidates = [],
  hitlCandidates = [],
  completions = {},
  boardIssues = null,
  feature = 'demo',
} = {}) {
  const normalized = candidates.map((item) => toCandidate({
    ...item,
    entryClass: item.entryClass ?? 'impl',
  }));
  const normalizedHitl = hitlCandidates.map((item) => toCandidate(item));
  const completionById = new Map(
    Object.entries(completions).map(([id, value]) => [
      id,
      typeof value === 'boolean' ? { closed: value } : { closed: Boolean(value?.closed) },
    ]),
  );

  async function completionOf(issueId) {
    if (completionById.has(issueId)) return { ...completionById.get(issueId) };
    const hit = normalized.find((item) => item.id === issueId)
      || normalizedHitl.find((item) => item.id === issueId);
    if (hit) return { closed: false };
    return { closed: false };
  }

  function defaultBoardIssues() {
    const rows = [];
    for (const item of [...normalized, ...normalizedHitl]) {
      rows.push({
        id: item.id,
        title: item.title,
        closed: false,
        blockedBy: item.blockedBy ?? [],
        unlocks: item.unlocks ?? [],
        status: item.statusRole ?? item.type ?? item.entryClass ?? null,
      });
    }
    return rows;
  }

  return {
    async listAutoCandidates() {
      const open = [];
      for (const item of normalized) {
        const completion = await completionOf(item.id);
        if (!completion.closed) open.push(item);
      }
      return open;
    },
    async recommendNext() {
      const open = await this.listAutoCandidates();
      return open[0] ?? null;
    },
    async listHitlCandidates() {
      const open = [];
      for (const item of normalizedHitl) {
        const completion = await completionOf(item.id);
        if (!completion.closed) open.push(item);
      }
      return open;
    },
    async recommendHitlNext() {
      const open = await this.listHitlCandidates();
      return open[0] ?? null;
    },
    async getCompletion(issueId) {
      return completionOf(issueId);
    },
    /**
     * Read-only board projection for dispatch TUI tests (ticket 13).
     */
    async getBoard() {
      const source = Array.isArray(boardIssues) ? boardIssues : defaultBoardIssues();
      const issues = [];
      for (const issue of source) {
        const closed = completionById.has(issue.id)
          ? Boolean(completionById.get(issue.id).closed)
          : Boolean(issue.closed);
        issues.push({
          id: issue.id,
          title: issue.title ?? issue.id,
          closed,
          blockedBy: Array.isArray(issue.blockedBy) ? [...issue.blockedBy] : [],
          unlocks: Array.isArray(issue.unlocks) ? [...issue.unlocks] : [],
          status: issue.status ?? issue.statusRole ?? issue.type ?? null,
        });
      }
      return {
        feature,
        readOnly: true,
        issues,
      };
    },
    setCompletion(issueId, closed) {
      completionById.set(issueId, { closed: Boolean(closed) });
    },
  };
}
