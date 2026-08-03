/**
 * Chain Run — primary product test seam for the issue-chain orchestrator.
 *
 * Inject TrackerPort + WorkerLauncher (and later mode/config/human events).
 * Ticket 07: empty frontier → idle + zero spawns; unique candidate → identify + spawn once.
 */

export function createChainRun({
  tracker,
  launcher,
  feature,
  cwd,
  runtime,
} = {}) {
  if (!tracker) throw new Error('tracker is required');
  if (!launcher) throw new Error('launcher is required');
  if (!feature) throw new Error('feature is required');
  if (!cwd) throw new Error('cwd is required');
  if (!runtime) throw new Error('runtime is required');

  let status = 'idle';
  let nextIssue = null;
  let slot = null;

  return {
    get status() {
      return status;
    },
    get nextIssue() {
      return nextIssue;
    },
    get slot() {
      return slot;
    },
    /**
     * One evaluation cycle: read auto next from tracker; spawn at most once when empty slot.
     */
    async step() {
      if (slot) {
        return {
          spawned: false,
          next: nextIssue,
          status,
        };
      }

      const next = await tracker.recommendNext();
      nextIssue = next;

      if (!next) {
        status = 'idle';
        return {
          spawned: false,
          next: null,
          status,
        };
      }

      const result = await launcher.launch({
        runtime,
        feature,
        cwd,
        issue: next,
      });

      slot = {
        issue: next,
        pid: result.pid,
        sessionId: result.sessionId ?? null,
        runtime,
      };
      status = 'running';

      return {
        spawned: true,
        next,
        status,
      };
    },
  };
}
