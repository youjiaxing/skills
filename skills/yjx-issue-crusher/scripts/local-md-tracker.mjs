/**
 * Local-markdown TrackerPort adapter (phase-1).
 *
 * Soft-depends on sibling yjx-local-kanban for graph parsing (no hard package dep).
 * Candidate filter is owned here and matches ralph auto-relay contract.
 * HITL candidates (ticket 11): wayfinder / non-ready / unknown — not auto-spawned.
 */

import path from 'node:path';

import {
  selectAutoCandidates,
  selectHitlCandidates,
  toCandidate,
} from './select-candidates.mjs';

const kanbanModuleUrl = new URL('../../yjx-local-kanban/scripts/issue-board.mjs', import.meta.url);

async function loadKanban() {
  try {
    return await import(kanbanModuleUrl.href);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'yjx-local-kanban is required beside yjx-issue-crusher for the local-markdown adapter; install both skills',
      );
    }
    throw error;
  }
}

export function createLocalMarkdownTracker({
  projectRoot,
  feature,
  featureDir = null,
} = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  if (!feature && !featureDir) throw new Error('feature or featureDir is required');

  const resolvedRoot = path.resolve(projectRoot);

  /**
   * Always re-read markdown. Dual-condition handoff needs to observe
   * Closed flips written by a Worker between Chain Run steps.
   */
  async function loadPayload() {
    const kanban = await loadKanban();
    const config = await kanban.loadConfig(resolvedRoot);
    const dir = featureDir
      ? path.resolve(featureDir)
      : path.resolve(resolvedRoot, config.trackerRoot, feature);
    const graph = await kanban.loadGraph(dir, config);
    return kanban.graphPayload(dir, graph, resolvedRoot);
  }

  return {
    async listAutoCandidates() {
      const payload = await loadPayload();
      return selectAutoCandidates(payload).map(toCandidate);
    },
    async recommendNext() {
      const candidates = await this.listAutoCandidates();
      return candidates[0] ?? null;
    },
    async listHitlCandidates() {
      const payload = await loadPayload();
      return selectHitlCandidates(payload).map(toCandidate);
    },
    async recommendHitlNext() {
      const candidates = await this.listHitlCandidates();
      return candidates[0] ?? null;
    },
    async getCompletion(issueId) {
      const payload = await loadPayload();
      const issue = payload.issues.find((item) => item.id === issueId);
      if (!issue) {
        throw new Error(`issue not found: ${issueId}`);
      }
      return { closed: Boolean(issue.closed) };
    },
    /**
     * Read-only board/graph projection for the dispatch TUI.
     * Never used to claim or reorder tickets.
     */
    async getBoard() {
      const payload = await loadPayload();
      return {
        feature: payload.feature ?? feature,
        readOnly: true,
        issues: (payload.issues || []).map((issue) => ({
          id: issue.id,
          title: issue.title,
          closed: Boolean(issue.closed),
          blockedBy: Array.isArray(issue.blockedBy) ? issue.blockedBy : [],
          unlocks: Array.isArray(issue.unlocks) ? issue.unlocks : [],
          status: issue.statusRole ?? issue.status ?? issue.type ?? null,
          path: issue.path,
        })),
      };
    },
    /** @deprecated no-op kept for callers; payload is always fresh. */
    invalidate() {},
  };
}
