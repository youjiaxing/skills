import { toCandidate } from './select-candidates.mjs';

/**
 * In-memory TrackerPort for Chain Run tests.
 * Does not touch the filesystem or yjx-local-kanban.
 * Completions are mutable so dual-condition handoff can close tickets mid-run.
 */
export function createFakeTracker({ candidates = [], completions = {} } = {}) {
  const normalized = candidates.map((item) => toCandidate(item));
  const completionById = new Map(
    Object.entries(completions).map(([id, value]) => [
      id,
      typeof value === 'boolean' ? { closed: value } : { closed: Boolean(value?.closed) },
    ]),
  );

  async function completionOf(issueId) {
    if (completionById.has(issueId)) return { ...completionById.get(issueId) };
    const hit = normalized.find((item) => item.id === issueId);
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
    async getCompletion(issueId) {
      return completionOf(issueId);
    },
    setCompletion(issueId, closed) {
      completionById.set(issueId, { closed: Boolean(closed) });
    },
  };
}
