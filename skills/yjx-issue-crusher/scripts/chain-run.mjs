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
 * dispatch-tui-start-and-polish/01: autoAdvance gates tick/poll auto spawn
 *   (fullscreen mounts off; --once / default chain stays on).
 * dispatch-tui-start-and-polish/02: startIssue / startNext for Enter;
 *   first successful manual start opens autoAdvance for AFK handoff.
 * dispatch-tui-start-and-polish/03: toggleAutoAdvance (user s dial);
 *   after explicit off, manual start must not reopen autoAdvance.
 * 20260805-1244/01: Closed ∧ autoAdvance on ∧ live slot worker → short
 *   reconfirm then safe-reap this slot only, then dual-gate opens next;
 *   never kill when not Closed / auto off / HITL / empty / other slot;
 *   forceAdvance default no-kill orphan path stays independent.
 * 20260805-1244/04: vibe-handoff-acceptance stages A/B/C pin handoff,
 *   resume non-blank, and no mis-kill with greppable failure codes.
 */

import {
  buildLaunchContract,
  buildResumeContract,
  buildSessionTitle,
  normalizeOptionalFlag,
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
  /**
   * Whether step() may auto-spawn the next ready impl (and open HITL offers).
   * Default true preserves --once / chain unit seams; fullscreen mount sets false.
   */
  autoAdvance: autoAdvanceOption = true,
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

  /**
   * Startup initial subsequent model/effort (ticket 01): CLI flag →
   * repo `workers.<current runtime>` bucket → empty (omit flags, runtime
   * product default). Resolved once at process start; setModelEffort
   * overrides afterwards. Startup flags never write the repo.
   */
  function resolveInitialModelEffort() {
    const flagModel = normalizeOptionalFlag(model);
    const flagEffort = normalizeOptionalFlag(effort);
    let repo = null;
    if (modeConfig && typeof modeConfig.readModelEffort === 'function') {
      repo = modeConfig.readModelEffort(runtime);
    }
    return {
      model: flagModel ?? repo?.model ?? null,
      effort: flagEffort ?? repo?.effort ?? null,
    };
  }

  const initialModelEffort = resolveInitialModelEffort();
  /** Subsequent model for the next spawn (null → omit flag). */
  let subsequentModel = initialModelEffort.model;
  /** Subsequent effort for the next spawn (null → omit flag). */
  let subsequentEffort = initialModelEffort.effort;

  let status = 'idle';
  let stopped = false;
  /** @type {boolean} */
  let autoAdvance = Boolean(autoAdvanceOption);
  /**
   * When false, successful startIssue/startNext must not flip autoAdvance on.
   * Set only by user toggleAutoAdvance → off (fullscreen `s`), not by
   * programmatic setAutoAdvance(false) used at fullscreen mount.
   */
  let openAutoOnManualStart = true;
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
    return subsequentModel == null || subsequentModel === ''
      ? RUNTIME_DEFAULT
      : subsequentModel;
  }

  function displayEffort() {
    return subsequentEffort == null || subsequentEffort === ''
      ? RUNTIME_DEFAULT
      : subsequentEffort;
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
   * Dual conditions for opening the next ticket remain
   * Closed ∧ (exit ∨ force-advance ∨ auto safe-reap under autoAdvance).
   * refreshStatus never reaps; only step() may safe-reap.
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

  /**
   * Closed ∧ autoAdvance on ∧ this slot still holds a live worker for that
   * ticket → short reconfirm, then end only this slot's process (if still
   * alive). Already-exited: confirm death only, no kill. Never runs when
   * not Closed, auto off, force-advance already requested, empty slot, or
   * HITL-only (no slot). Does not touch other pids.
   */
  async function safeReapClosedSlotWorker() {
    if (!slot || !autoAdvance || slot.forceAdvanceRequested) {
      return { reaped: false, reason: 'not-applicable' };
    }

    const completion = await tracker.getCompletion(slot.issue.id);
    if (!completion.closed) {
      return { reaped: false, reason: 'not-closed' };
    }

    // Short reconfirm: re-read Closed + liveness before acting.
    const reconfirm = await tracker.getCompletion(slot.issue.id);
    if (!reconfirm.closed) {
      return { reaped: false, reason: 'not-closed' };
    }
    if (!workerAlive()) {
      return { reaped: false, reason: 'already-exited' };
    }

    const pid = slot.pid;
    if (typeof launcher.kill === 'function') {
      await launcher.kill(pid);
    }
    return { reaped: true, reason: 'reaped', pid };
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
      model: subsequentModel,
      effort: subsequentEffort,
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

  /**
   * Try to free a completed slot (Closed ∧ exit/force) so explicit start can proceed.
   * Live/incomplete slots stay occupied.
   */
  async function releaseSlotIfHandoffReady() {
    if (!slot) return { ok: true, reason: 'empty-slot' };
    const gate = await classifyOccupiedSlot();
    if (!gate.ok) {
      status = gate.status;
      return { ok: false, reason: gate.reason, status: gate.status };
    }
    slot = null;
    status = 'idle';
    return { ok: true, reason: gate.reason };
  }

  /**
   * Resolve an auto-ready impl by id (or frontier default when id is null/omitted).
   */
  async function resolveStartIssue(issueId) {
    if (issueId == null || issueId === '') {
      return tracker.recommendNext();
    }
    const wanted = String(issueId);
    if (typeof tracker.listAutoCandidates === 'function') {
      const list = await tracker.listAutoCandidates();
      const hit = Array.isArray(list)
        ? list.find((item) => item && item.id === wanted)
        : null;
      if (hit) return hit;
    }
    // Fallback: recommendNext only matches when it is the wanted id.
    const next = await tracker.recommendNext();
    if (next && next.id === wanted) return next;
    return null;
  }

  /**
   * Explicit operator start (Enter): spawn one ready impl into an empty slot.
   * Bypasses autoAdvance gate. On a clean path (user never s-off'd), first
   * successful start opens autoAdvance so Closed∧exit handoffs can AFK.
   * After user toggleAutoAdvance → off, start still spawns one but leaves
   * autoAdvance off — only another s (or set/toggle on) re-enables it.
   *
   * @param {string | null | undefined} issueId
   *   When set, spawn that auto-ready id; otherwise board default (recommendNext).
   */
  async function startIssue(issueId) {
    if (stopped) {
      status = 'stopped';
      return {
        ok: false,
        spawned: false,
        advanced: false,
        reason: 'stopped',
        next: nextIssue,
        status,
      };
    }

    const released = await releaseSlotIfHandoffReady();
    if (!released.ok) {
      return {
        ok: false,
        spawned: false,
        advanced: false,
        reason: 'slot-occupied',
        next: nextIssue,
        status,
      };
    }

    const issue = await resolveStartIssue(issueId);
    if (!issue) {
      status = 'idle';
      return {
        ok: false,
        spawned: false,
        advanced: false,
        reason: issueId ? 'not-executable' : 'no-candidate',
        next: null,
        status,
      };
    }

    pendingHitl = null;
    const result = await spawnFromIssue(issue, resolveEntryClass(issue.entryClass, issue));
    // Clean first-success path only: do not sneak auto back on after user s-off.
    if (openAutoOnManualStart) {
      autoAdvance = true;
    }
    return {
      ...result,
      ok: true,
      reason: 'started',
      autoAdvance,
    };
  }

  return {
    get status() {
      return status;
    },
    get stopped() {
      return stopped;
    },
    /**
     * Whether tick/step may auto-spawn the next ready impl.
     * Independent of `stopped` (stop is stronger: also blocks force-advance).
     */
    get autoAdvance() {
      return autoAdvance;
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
    /** Subsequent model for the next spawn (null → omit flag; runtime default). */
    get model() {
      return subsequentModel;
    },
    /** Subsequent effort for the next spawn (null → omit flag; runtime default). */
    get effort() {
      return subsequentEffort;
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
     * Allow or forbid auto spawn on subsequent step()/tick cycles.
     * Programmatic only (fullscreen mount / tests / once path).
     * Does not lock out Enter→open-auto; does not clear the live slot; not stop().
     */
    setAutoAdvance(enabled) {
      autoAdvance = Boolean(enabled);
      return { ok: true, autoAdvance };
    },
    /**
     * Operator dial (fullscreen `s`): flip auto-open-next.
     * Turning off also locks Enter so a later manual start will not reopen auto.
     * Turning on allows tick/poll auto spawn (empty slot needs no Enter).
     */
    toggleAutoAdvance() {
      autoAdvance = !autoAdvance;
      if (!autoAdvance) {
        openAutoOnManualStart = false;
      }
      return { ok: true, autoAdvance };
    },
    /**
     * Explicit start of a ready impl by id (Enter + highlight).
     * Ignores autoAdvance gate; may open autoAdvance on success (see startIssue).
     */
    async startIssue(issueId) {
      return startIssue(issueId);
    },
    /**
     * Explicit start of the board-default next ready impl (Enter, no highlight).
     */
    async startNext() {
      return startIssue(null);
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
     * Scheduler / TUI submit of subsequent model/effort (ticket 01).
     * Writes the repo `workers.<runtime>` bucket immediately (when modeConfig
     * is present), supersedes startup flag/repo values for subsequent spawns,
     * and never mutates the live worker pin. Empty/blank values normalize to
     * null (= omit the CLI flag; runtime product default).
     *
     * @param {{ model?: string|null, effort?: string|null }} next
     */
    async setModelEffort({ model: nextModel = null, effort: nextEffort = null } = {}) {
      // Spec: submit must write repo immediately — require a write port.
      if (!modeConfig || typeof modeConfig.writeModelEffort !== 'function') {
        return { ok: false, reason: 'no-model-config' };
      }
      const normalized = {
        model: normalizeOptionalFlag(nextModel),
        effort: normalizeOptionalFlag(nextEffort),
      };
      await modeConfig.writeModelEffort(runtime, normalized);
      subsequentModel = normalized.model;
      subsequentEffort = normalized.effort;
      return { ok: true, model: normalized.model, effort: normalized.effort };
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
      // history: optional blank/non-blank probe from real launcher (Grok);
      // fake launcher omits it. Acceptance must not treat spawn alone as proof.
      return {
        ok: true,
        pid: result.pid,
        sessionId: slot.sessionId,
        history: result.history ?? null,
      };
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
     * - If a slot is held and Closed ∧ autoAdvance on ∧ still alive, safe-reap
     *   this slot's worker (short reconfirm); then dual-gate release.
     * - If a slot is held, release it only when dual conditions are met.
     * - If autoAdvance is false, reclassify/release only — no auto reap of a
     *   still-live Closed worker, no auto spawn / HITL offer.
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
        // AFK path: Closed + auto on + live this-slot worker → reap then gate.
        await safeReapClosedSlotWorker();
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

      // Fullscreen default / manual-start gate: tick may refresh but must not fire.
      if (!autoAdvance) {
        if (pendingHitl) {
          status = 'needs-confirmation';
          return {
            spawned: false,
            advanced: false,
            reason: 'auto-advance-off',
            next: pendingHitl.issue,
            status,
          };
        }
        status = 'idle';
        return {
          spawned: false,
          advanced: false,
          reason: 'auto-advance-off',
          next: nextIssue,
          status,
        };
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
