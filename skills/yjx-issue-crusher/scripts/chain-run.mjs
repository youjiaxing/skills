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
 * Ticket 11: non-ready / Wayfinder HITL — auto path only ready impl; otherwise
 *            emit needs-confirmation, spawn only after confirmHitl (entry by class).
 * Ticket 13: stop() freezes auto spawn / force-advance; dispatch TUI consumes this.
 */

import {
  buildLaunchContract,
  buildResumeContract,
  buildSessionTitle,
  resolveEntryClass,
} from './build-launch-contract.mjs';
import {
  normalizeMode,
  resolveSubsequentMode,
  VIBE_CONSEQUENCE_MESSAGE,
} from './mode-config.mjs';

/** model/effort omitted → "runtime default" marker for HITL display. */
const RUNTIME_DEFAULT = 'runtime-default';

export function createChainRun({
  tracker,
  launcher,
  feature,
  cwd,
  runtime,
  mode,
  modeConfig = null,
  model = null,
  effort = null,
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
  /** @type {Array<object>} */
  const events = [];

  let status = 'idle';
  let stopped = false;
  let nextIssue = null;
  /**
   * Pending HITL ask (empty slot). Not a worker occupation.
   * @type {null | {
   *   issue: object,
   *   entryClass: string,
   *   title: string,
   *   runtime: string,
   *   model: string|null,
   *   effort: string|null,
   *   mode: string,
   * }}
   */
  let pendingHitl = null;
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

  function displayModel() {
    return model == null || model === '' ? RUNTIME_DEFAULT : model;
  }

  function displayEffort() {
    return effort == null || effort === '' ? RUNTIME_DEFAULT : effort;
  }

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

  async function recommendHitl() {
    if (typeof tracker.recommendHitlNext === 'function') {
      return tracker.recommendHitlNext();
    }
    if (typeof tracker.listHitlCandidates === 'function') {
      const list = await tracker.listHitlCandidates();
      return Array.isArray(list) && list.length > 0 ? list[0] : null;
    }
    return null;
  }

  function buildHitlOffer(issue) {
    const entryClass = resolveEntryClass(issue.entryClass, issue);
    const title = buildSessionTitle(feature, issue);
    const spawnMode = effectiveSubsequentMode();
    return {
      issue,
      entryClass,
      title,
      runtime,
      model: displayModel(),
      effort: displayEffort(),
      mode: spawnMode,
    };
  }

  function emitNeedsConfirmation(offer) {
    events.push({
      type: 'needs-confirmation',
      issue: offer.issue,
      entryClass: offer.entryClass,
      title: offer.title,
      runtime: offer.runtime,
      model: offer.model === RUNTIME_DEFAULT ? null : offer.model,
      effort: offer.effort === RUNTIME_DEFAULT ? null : offer.effort,
      // Also expose runtime-default markers for UIs that prefer explicit strings.
      modelDisplay: offer.model,
      effortDisplay: offer.effort,
      mode: offer.mode,
      message: `Needs human confirmation before spawning ${offer.entryClass} ticket ${offer.issue.id}`,
    });
  }

  async function spawnFromIssue(issue, entryClass) {
    const spawnMode = effectiveSubsequentMode();
    const contract = buildLaunchContract({
      runtime,
      feature,
      cwd,
      issue,
      mode: spawnMode,
      entryClass,
      model,
      effort,
    });
    const result = await launcher.launch(contract);

    slot = {
      issue,
      pid: result.pid,
      sessionId: result.sessionId ?? null,
      runtime,
      cwd,
      mode: spawnMode,
      title: contract.title,
      model: contract.model,
      effort: contract.effort,
      forceAdvanceRequested: false,
    };
    status = 'soft-stuck';
    pendingHitl = null;
    nextIssue = issue;

    return {
      spawned: true,
      advanced: true,
      next: issue,
      status,
      ok: true,
    };
  }

  return {
    get status() {
      return status;
    },
    get stopped() {
      return stopped;
    },
    get nextIssue() {
      return nextIssue;
    },
    get slot() {
      return slot;
    },
    get pendingHitl() {
      return pendingHitl;
    },
    /** Subsequent-ticket effective mode (live worker pin is slot.mode). */
    get mode() {
      return effectiveSubsequentMode();
    },
    get events() {
      return events;
    },
    get feature() {
      return feature;
    },
    get cwd() {
      return cwd;
    },
    get runtime() {
      return runtime;
    },
    /**
     * Freeze the chain: no further auto spawn and no force-advance to next.
     * Resume of the current needs-resume slot remains allowed.
     */
    async stop() {
      stopped = true;
      status = 'stopped';
      return { ok: true };
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
      if (stopped) {
        return { ok: false, reason: 'stopped' };
      }
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
     * Approve a pending HITL ask and spawn with class-appropriate entry.
     * Mode is pinned at confirm/spawn time (same as auto path / ticket 10).
     */
    async confirmHitl() {
      if (stopped) {
        return { ok: false, reason: 'stopped', spawned: false };
      }
      if (slot) {
        return { ok: false, reason: 'slot-occupied', spawned: false };
      }
      if (!pendingHitl) {
        return { ok: false, reason: 'no-pending-hitl', spawned: false };
      }
      const { issue, entryClass } = pendingHitl;
      return spawnFromIssue(issue, entryClass);
    },
    /**
     * Reject a pending HITL ask: zero spawn, slot stays empty.
     */
    async rejectHitl() {
      if (!pendingHitl) {
        return { ok: false, reason: 'no-pending-hitl' };
      }
      pendingHitl = null;
      status = stopped ? 'stopped' : 'idle';
      return { ok: true, spawned: false };
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
        if (!stopped) status = gate.status;
        return { ok: false, reason: gate.reason };
      }
      if (!slot.sessionId) {
        if (!stopped) status = 'needs-resume';
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
        model: slot.model,
        effort: slot.effort,
      });
      const result = await launcher.launch(contract);

      slot = {
        ...slot,
        pid: result.pid,
        sessionId: result.sessionId ?? slot.sessionId,
        forceAdvanceRequested: false,
      };
      status = stopped ? 'stopped' : 'soft-stuck';
      return { ok: true, pid: result.pid, sessionId: slot.sessionId };
    },
    /**
     * Reclassify occupied-slot status without spawning (for TUI refresh).
     */
    async refreshStatus() {
      if (stopped) {
        status = 'stopped';
        return { status, reason: 'stopped' };
      }
      if (!slot) {
        if (pendingHitl) {
          status = 'needs-confirmation';
          return { status, reason: 'needs-confirmation' };
        }
        status = 'idle';
        return { status, reason: 'empty-slot' };
      }
      const gate = await classifyOccupiedSlot();
      status = gate.status;
      return { status: gate.status, reason: gate.reason };
    },
    /**
     * One evaluation cycle:
     * - If stopped, never auto-spawn or open HITL offers.
     * - If a slot is held, release it only when dual conditions are met.
     * - Then spawn at most one auto candidate into an empty slot (single slot).
     * - If no auto candidate but a HITL candidate exists, emit needs-confirmation
     *   and do not spawn until confirmHitl.
     * - Spawn pins the then-effective mode onto the worker slot.
     */
    async step() {
      if (stopped) {
        status = 'stopped';
        return {
          spawned: false,
          advanced: false,
          reason: 'stopped',
          next: nextIssue,
          status,
        };
      }

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

      // Auto ready-impl path wins over HITL — never misclassify ready as ask-first.
      const next = await tracker.recommendNext();
      nextIssue = next;

      if (next) {
        // Clear any stale HITL offer when auto work is available.
        pendingHitl = null;
        return spawnFromIssue(next, resolveEntryClass(next.entryClass, next));
      }

      // Already waiting on the same HITL offer: re-signal without double-pending.
      if (pendingHitl) {
        status = 'needs-confirmation';
        return {
          spawned: false,
          advanced: false,
          reason: 'needs-confirmation',
          next: pendingHitl.issue,
          status,
        };
      }

      const hitl = await recommendHitl();
      if (hitl) {
        const offer = buildHitlOffer(hitl);
        pendingHitl = offer;
        nextIssue = hitl;
        status = 'needs-confirmation';
        emitNeedsConfirmation(offer);
        return {
          spawned: false,
          advanced: true,
          reason: 'needs-confirmation',
          next: hitl,
          status,
        };
      }

      status = 'idle';
      return {
        spawned: false,
        advanced: true,
        next: null,
        status,
      };
    },
  };
}
