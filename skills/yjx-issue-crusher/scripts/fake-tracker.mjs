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
    setCompletion(issueId, closed) {
      completionById.set(issueId, { closed: Boolean(closed) });
    },
  };
}
