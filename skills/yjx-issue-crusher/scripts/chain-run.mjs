/**
 * Chain Run — primary product test seam for the issue-chain orchestrator.
 *
 * Inject TrackerPort + WorkerLauncher + optional ModeConfig + human events.
 * Ticket 07: empty frontier → idle + zero spawns; unique candidate → identify + spawn once.
 * Ticket 08: full impl launch contract; dual-condition handoff before next spawn.
 * Ticket 09: edge states (soft-stuck / awaiting-worker-exit / needs-resume),
 *            force-advance no-kill default, resume launch, single slot.
 * Ticket 10: review/vibe selection — hard default review; repo config; startup
 *            process override (no write); TUI setMode writes repo + subsequent only;
 *            pin mode on spawn; vibe consequence event.
 */

import {
  buildLaunchContract,
  buildResumeContract,
} from './build-launch-contract.mjs';
import {
  normalizeMode,
  resolveSubsequentMode,
  VIBE_CONSEQUENCE_MESSAGE,
} from './mode-config.mjs';

export function createChainRun({
  tracker,
  launcher,
  feature,
  cwd,
  runtime,
  mode,
  modeConfig = null,
  // Intentionally accepted and ignored: no user-level or feature-level mode layer.
  userHome: _userHome,
  userMode: _userMode,
  featureMode: _featureMode,
} = {}) {
  if (!tracker) throw new Error('tracker is required');
  if (!launcher) throw new Error('launcher is required');
  if (!feature) throw new Error('feature is required');
  if (!cwd) throw new Error('cwd is required');
  if (!runtime) throw new Error('runtime is required');

  /** @type {'review'|'vibe'|null} */
  const startupMode = normalizeMode(mode);
  /** Once TUI/scheduler chooses mode, startup --mode no longer wins. */
  let startupSupersededByTui = false;
  /** Fallback when setMode runs without a modeConfig port. */
  let tuiChosenMode = null;
  /** @type {Array<{ type: string, message: string, mode?: string }>} */
  const events = [];

  let status = 'idle';
  let nextIssue = null;
  /**
   * @type {null | {
   *   issue: object,
   *   pid: number,
   *   sessionId: string|null,
   *   runtime: string,
   *   cwd: string,
   *   mode: string,
   *   title: string,
   *   forceAdvanceRequested: boolean,
   * }}
   */
  let slot = null;

  function readRepoMode() {
    if (!modeConfig || typeof modeConfig.readMode !== 'function') return null;
    return normalizeMode(modeConfig.readMode());
  }

  /** Effective mode for *subsequent* spawns (not the live worker pin). */
  function effectiveSubsequentMode() {
    return resolveSubsequentMode({
      startupMode,
      startupSupersededByTui,
      repoMode: readRepoMode(),
      tuiMode: tuiChosenMode,
    });
  }

  function workerAlive() {
    if (!slot) return false;
    if (typeof launcher.isAlive !== 'function') return true;
    return launcher.isAlive(slot.pid);
  }

  /**
   * Classify the occupied slot for outward status / step reason.
   * Dual conditions for opening the next ticket remain Closed ∧ (exit ∨ force-advance).
   */
  async function classifyOccupiedSlot() {
    if (!slot) return { ok: true, reason: 'empty-slot', status: 'idle' };

    const completion = await tracker.getCompletion(slot.issue.id);
    const alive = workerAlive();

    if (!completion.closed) {
      // Process exit alone must never open the next issue.
      if (alive) {
        return { ok: false, reason: 'soft-stuck', status: 'soft-stuck' };
      }
      return { ok: false, reason: 'needs-resume', status: 'needs-resume' };
    }

    if (alive && !slot.forceAdvanceRequested) {
      return { ok: false, reason: 'awaiting-worker-exit', status: 'awaiting-worker-exit' };
    }

    return {
      ok: true,
      reason: slot.forceAdvanceRequested && alive
        ? 'closed-and-force-advance'
        : 'closed-and-exited',
      status: 'idle',
    };
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
    /** Subsequent-ticket effective mode (live worker pin is slot.mode). */
    get mode() {
      return effectiveSubsequentMode();
    },
    get events() {
      return events;
    },
    /**
     * Scheduler / TUI mode dial.
     * Writes repo immediately (when modeConfig is present), supersedes startup
     * --mode for subsequent spawns, and never mutates the live worker pin.
     * Switching to vibe emits a one-line consequence event.
     */
    async setMode(nextMode) {
      const normalized = normalizeMode(nextMode);
      if (!normalized) {
        return { ok: false, reason: 'invalid-mode' };
      }
      // Spec: scheduler dial must write repo immediately — require a write port.
      if (!modeConfig || typeof modeConfig.writeMode !== 'function') {
        return { ok: false, reason: 'no-mode-config' };
      }

      await modeConfig.writeMode(normalized);

      tuiChosenMode = normalized;
      startupSupersededByTui = true;

      if (normalized === 'vibe') {
        events.push({
          type: 'mode-consequence',
          mode: 'vibe',
          message: VIBE_CONSEQUENCE_MESSAGE,
        });
      }

      return { ok: true, mode: normalized };
    },
    /**
     * Human force-advance: skip waiting for worker exit.
     * Only valid when the current issue is already Closed.
     * Default: do not kill the old worker (orphan). Opt-in killWorker: true.
     */
    async forceAdvance({ killWorker = false } = {}) {
      if (!slot) {
        return { ok: false, reason: 'no-slot' };
      }
      const completion = await tracker.getCompletion(slot.issue.id);
      if (!completion.closed) {
        return { ok: false, reason: 'not-closed' };
      }
      if (killWorker && typeof launcher.kill === 'function') {
        await launcher.kill(slot.pid);
      }
      slot = { ...slot, forceAdvanceRequested: true };
      return { ok: true };
    },
    /**
     * One-shot resume of the recorded session after needs-resume.
     * Same logical slot; does not open the next ticket; does not re-inject skill entry.
     * Resume keeps the spawn-pinned mode (no hot switch).
     */
    async resume() {
      if (!slot) {
        return { ok: false, reason: 'no-slot' };
      }
      const gate = await classifyOccupiedSlot();
      if (gate.reason !== 'needs-resume') {
        status = gate.status;
        return { ok: false, reason: gate.reason };
      }
      if (!slot.sessionId) {
        status = 'needs-resume';
        return { ok: false, reason: 'no-session-id' };
      }

      const contract = buildResumeContract({
        runtime: slot.runtime,
        feature,
        cwd: slot.cwd,
        issue: slot.issue,
        title: slot.title,
        sessionId: slot.sessionId,
        mode: slot.mode,
      });
      const result = await launcher.launch(contract);

      slot = {
        ...slot,
        pid: result.pid,
        sessionId: result.sessionId ?? slot.sessionId,
        forceAdvanceRequested: false,
      };
      status = 'soft-stuck';
      return { ok: true, pid: result.pid, sessionId: slot.sessionId };
    },
    /**
     * One evaluation cycle:
     * - If a slot is held, release it only when dual conditions are met.
     * - Then spawn at most one auto candidate into an empty slot (single slot).
     * - Spawn pins the then-effective mode onto the worker slot.
     */
    async step() {
      if (slot) {
        const gate = await classifyOccupiedSlot();
        if (!gate.ok) {
          status = gate.status;
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

      // Pin at spawn time — later setMode / repo rewrite must not change this slot.
      const spawnMode = effectiveSubsequentMode();
      const contract = buildLaunchContract({
        runtime,
        feature,
        cwd,
        issue: next,
        mode: spawnMode,
      });
      const result = await launcher.launch(contract);

      slot = {
        issue: next,
        pid: result.pid,
        sessionId: result.sessionId ?? null,
        runtime,
        cwd,
        mode: spawnMode,
        title: contract.title,
        forceAdvanceRequested: false,
      };
      // Occupied + not closed + alive → soft-stuck is the outward edge name.
      status = 'soft-stuck';

      return {
        spawned: true,
        advanced: true,
        next,
        status,
      };
    },
  };
}
