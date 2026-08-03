import { toCandidate } from './select-candidates.mjs';

/**
 * In-memory TrackerPort for Chain Run tests.
 * Does not touch the filesystem or yjx-local-kanban.
 */
export function createFakeTracker({ candidates = [], completions = {} } = {}) {
  const normalized = candidates.map((item) => toCandidate(item));
  const completionById = new Map(
    Object.entries(completions).map(([id, value]) => [
      id,
      typeof value === 'boolean' ? { closed: value } : { closed: Boolean(value?.closed) },
    ]),
  );

  return {
    async listAutoCandidates() {
      return [...normalized];
    },
    async recommendNext() {
      return normalized[0] ?? null;
    },
    async getCompletion(issueId) {
      if (completionById.has(issueId)) return { ...completionById.get(issueId) };
      const hit = normalized.find((item) => item.id === issueId);
      if (hit) return { closed: false };
      return { closed: false };
    },
  };
}
