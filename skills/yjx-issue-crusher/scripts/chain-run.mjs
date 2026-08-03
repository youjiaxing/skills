/**
 * Chain Run — primary product test seam for the issue-chain orchestrator.
 *
 * Inject TrackerPort + WorkerLauncher (and later mode/config/human events).
 * Ticket 07: empty frontier → idle + zero spawns; unique candidate → identify + spawn once.
 * Ticket 08: full impl launch contract; dual-condition handoff before next spawn.
 */

import { buildLaunchContract, resolveMode } from './build-launch-contract.mjs';

export function createChainRun({
  tracker,
  launcher,
  feature,
  cwd,
  runtime,
  mode,
} = {}) {
  if (!tracker) throw new Error('tracker is required');
  if (!launcher) throw new Error('launcher is required');
  if (!feature) throw new Error('feature is required');
  if (!cwd) throw new Error('cwd is required');
  if (!runtime) throw new Error('runtime is required');

  const effectiveMode = resolveMode(mode);
  let status = 'idle';
  let nextIssue = null;
  /** @type {null | { issue: object, pid: number, sessionId: string|null, runtime: string, mode: string, title: string, forceAdvanceRequested: boolean }} */
  let slot = null;

  async function dualConditionsMet() {
    if (!slot) return { ok: true, reason: 'empty-slot' };
    const completion = await tracker.getCompletion(slot.issue.id);
    if (!completion.closed) {
      // Process exit alone must never open the next issue.
      return { ok: false, reason: 'exit-alone-not-success' };
    }
    const exited = typeof launcher.isAlive === 'function'
      ? !launcher.isAlive(slot.pid)
      : false;
    if (exited || slot.forceAdvanceRequested) {
      return { ok: true, reason: exited ? 'closed-and-exited' : 'closed-and-force-advance' };
    }
    return { ok: false, reason: 'awaiting-worker-exit' };
  }

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
    get mode() {
      return effectiveMode;
    },
    /**
     * Human force-advance: skip waiting for worker exit.
     * Only valid when the current issue is already Closed.
     */
    async forceAdvance() {
      if (!slot) {
        return { ok: false, reason: 'no-slot' };
      }
      const completion = await tracker.getCompletion(slot.issue.id);
      if (!completion.closed) {
        return { ok: false, reason: 'not-closed' };
      }
      slot = { ...slot, forceAdvanceRequested: true };
      return { ok: true };
    },
    /**
     * One evaluation cycle:
     * - If a slot is held, release it only when dual conditions are met.
     * - Then spawn at most one auto candidate into an empty slot.
     */
    async step() {
      if (slot) {
        const gate = await dualConditionsMet();
        if (!gate.ok) {
          if (gate.reason === 'awaiting-worker-exit') {
            status = 'awaiting-worker-exit';
          } else if (gate.reason === 'exit-alone-not-success') {
            const alive = typeof launcher.isAlive === 'function'
              ? launcher.isAlive(slot.pid)
              : true;
            status = alive ? 'running' : 'blocked';
          }
          return {
            spawned: false,
            advanced: false,
            reason: gate.reason,
            next: nextIssue,
            status,
          };
        }
        slot = null;
        status = 'idle';
      }

      const next = await tracker.recommendNext();
      nextIssue = next;

      if (!next) {
        status = 'idle';
        return {
          spawned: false,
          advanced: true,
          next: null,
          status,
        };
      }

      const contract = buildLaunchContract({
        runtime,
        feature,
        cwd,
        issue: next,
        mode: effectiveMode,
      });
      const result = await launcher.launch(contract);

      slot = {
        issue: next,
        pid: result.pid,
        sessionId: result.sessionId ?? null,
        runtime,
        mode: effectiveMode,
        title: contract.title,
        forceAdvanceRequested: false,
      };
      status = 'running';

      return {
        spawned: true,
        advanced: true,
        next,
        status,
      };
    },
  };
}
