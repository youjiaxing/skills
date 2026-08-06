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
 *   after explicit off, manual start must not reopen autoAdvance;
 *   s is dial-only: idle empty tick must not spawn (first needs Enter);
 *   handoff after dual-gate release still auto-spawns when auto is on.
 * autoAdvance repo preference: s + Enter-open-auto write modeConfig;
 *   fullscreen mount restores preference with handoff-only; quit freeze does not write.
 * 20260806-1636/01: ban complete-state auto-kill; without sessionEnded success
 *   auto path never spawns next (honest degradation). Process exit alone is
 *   not enough. Wayfinder complete never auto-advances. forceAdvance remains
 *   the human escape (default no-kill orphan).
 * 20260806-1636/02: dual-gate order (Closed before success); interrupt path
 *   (failure/interrupted/process exit without success) with reason summary;
 *   countdown + c; f skips end wait (default orphan). needs-resume r unchanged.
 * 20260806-1636/03: Grok/Claude session-end adapters + Worker morph
 *   (impl+autoAdvance → observable AFK; wayfinder/人闸/resume → interactive).
 * Handoff countdown (when dual-gate allows autoHandoff): wait
 *   handoffCountdownMs (default 9s) before releasing slot / opening next;
 *   operator may cancelHandoffCountdown (or Enter next / forceAdvance).
 * forceAdvance default no-kill orphan path stays independent; killWorker opt-in.
 * 20260805-1244/04 (updated): vibe-handoff-acceptance stages pin no-kill +
 *   no auto without end signal + resume non-blank.
 */

/** Default pause after dual-gate auto handoff before opening the next ticket. */
export const DEFAULT_HANDOFF_COUNTDOWN_MS = 9000;

/** Unified session-end outcomes (Chain Run only consumes this enum). */
export const SESSION_ENDED = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  INTERRUPTED: 'interrupted',
});

/**
 * Operator-facing interrupt reason summary (exit code / failure class / last error).
 * Prefer lastError → message → failureClass → exitCode → outcome / process default.
 *
 * @param {{
 *   sessionEnded?: string|null,
 *   sessionEndDetail?: {
 *     exitCode?: number|string|null,
 *     failureClass?: string|null,
 *     lastError?: string|null,
 *     message?: string|null,
 *   }|null,
 * }|null|undefined} slot
 * @returns {string}
 */
export function sessionInterruptSummary(slot) {
  const detail = slot?.sessionEndDetail && typeof slot.sessionEndDetail === 'object'
    ? slot.sessionEndDetail
    : {};
  const lastError = detail.lastError != null && String(detail.lastError).trim() !== ''
    ? String(detail.lastError).trim()
    : null;
  if (lastError) return lastError;
  const message = detail.message != null && String(detail.message).trim() !== ''
    ? String(detail.message).trim()
    : null;
  if (message) return message;
  const failureClass = detail.failureClass != null && String(detail.failureClass).trim() !== ''
    ? String(detail.failureClass).trim()
    : null;
  const exitCode = detail.exitCode != null && detail.exitCode !== ''
    ? detail.exitCode
    : null;
  if (failureClass && exitCode != null) return `${failureClass} (exit ${exitCode})`;
  if (failureClass) return failureClass;
  if (exitCode != null) return `exit ${exitCode}`;
  if (slot?.sessionEnded === SESSION_ENDED.FAILURE) return '会话失败结束';
  if (slot?.sessionEnded === SESSION_ENDED.INTERRUPTED) return '会话中断';
  if (
    slot?.sessionEnded === SESSION_ENDED.SUCCESS
    && slot?.sessionSuccessOrderOk !== true
  ) {
    return 'success 早于 Closed（顺序无效）';
  }
  return '进程已退出（无成功结束信号）';
}

/**
 * Normalize optional session-end detail bag for slot storage.
 * @param {object|null|undefined} detail
 */
function normalizeSessionEndDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  if (detail.exitCode != null && detail.exitCode !== '') out.exitCode = detail.exitCode;
  if (detail.failureClass != null && String(detail.failureClass).trim() !== '') {
    out.failureClass = String(detail.failureClass).trim();
  }
  if (detail.lastError != null && String(detail.lastError).trim() !== '') {
    out.lastError = String(detail.lastError).trim();
  }
  if (detail.message != null && String(detail.message).trim() !== '') {
    out.message = String(detail.message).trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

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
import { resolveWorkerMorph } from './session-end-adapters.mjs';

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
  /**
   * After autoHandoff is allowed (sessionEnded success or forceAdvance path)
   * and autoAdvance on, wait this many ms before opening the next ticket
   * (operator can cancel). 0 disables the pause. Default 9s. Clamped to >= 0.
   */
  handoffCountdownMs: handoffCountdownMsOption = DEFAULT_HANDOFF_COUNTDOWN_MS,
  /**
   * Clock injection for countdown tests (deterministic). Defaults to Date.now.
   * @type {() => number}
   */
  now: nowOption = null,
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

  const handoffCountdownMs = Math.max(
    0,
    Number.isFinite(Number(handoffCountdownMsOption))
      ? Number(handoffCountdownMsOption)
      : DEFAULT_HANDOFF_COUNTDOWN_MS,
  );
  const now = typeof nowOption === 'function' ? nowOption : () => Date.now();

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
   * When true, step() may auto-spawn only after releasing a slot this cycle
   * (Closed handoff). Idle empty auto-spawn is blocked — fullscreen dial
   * and cold start need Enter for the first ticket.
   * When false, empty + autoAdvance may spawn (--once / default chain).
   * Initial: mirrors !autoAdvanceOption. setAutoAdvance(false) arms this
   * (fullscreen mount); setAutoAdvance(true) clears it (once seam).
   * toggleAutoAdvance never changes this flag.
   */
  let autoSpawnRequiresHandoff = !Boolean(autoAdvanceOption);
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

  /**
   * Persist auto-open-next preference when a modeConfig write port exists.
   * Best-effort: missing port is a no-op (tests without config).
   * @param {boolean} enabled
   */
  function persistAutoAdvancePreference(enabled) {
    if (!modeConfig || typeof modeConfig.writeAutoAdvance !== 'function') return;
    try {
      modeConfig.writeAutoAdvance(Boolean(enabled));
    } catch {
      // Preference write must not block spawn / dial UX.
    }
  }

  /**
   * Read repo auto-open-next preference. Missing port / invalid → false.
   * @returns {boolean}
   */
  function readAutoAdvancePreference() {
    if (!modeConfig || typeof modeConfig.readAutoAdvance !== 'function') return false;
    try {
      return modeConfig.readAutoAdvance() === true;
    } catch {
      return false;
    }
  }

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
   *
   * freeable — human Enter may free the slot (Closed ∧ dead/orphan path).
   * autoHandoff — step() may release and auto-spawn next ready impl.
   *
   * Auto handoff requires business complete AND sessionEnded === success
   * with Closed-before-success order (or explicit forceAdvance).
   * Process death alone is not enough. Auto path never kills a live worker.
   * Wayfinder complete never sets autoHandoff.
   * Closed + dead without valid success → session-interrupted (+ reason).
   */
  async function classifyOccupiedSlot() {
    if (!slot) {
      return {
        ok: true,
        freeable: true,
        autoHandoff: false,
        reason: 'empty-slot',
        status: 'idle',
      };
    }

    const completion = await tracker.getCompletion(slot.issue.id);
    const alive = workerAlive();

    if (!completion.closed) {
      // Process exit alone must never open the next issue.
      if (alive) {
        return {
          ok: false,
          freeable: false,
          autoHandoff: false,
          reason: 'soft-stuck',
          status: 'soft-stuck',
        };
      }
      return {
        ok: false,
        freeable: false,
        autoHandoff: false,
        reason: 'needs-resume',
        status: 'needs-resume',
      };
    }

    // Business complete — never auto-kill a still-live worker.
    // Closed + still alive = 等会话结束/等进程自退 (not interrupt yet).
    if (alive && !slot.forceAdvanceRequested) {
      return {
        ok: false,
        freeable: false,
        autoHandoff: false,
        reason: 'awaiting-worker-exit',
        status: 'awaiting-worker-exit',
      };
    }

    // Human force-advance: skip end-signal wait; free + allow auto next.
    if (slot.forceAdvanceRequested) {
      return {
        ok: true,
        freeable: true,
        autoHandoff: true,
        reason: 'closed-and-force-advance',
        status: 'idle',
      };
    }

    // Worker not alive (natural exit / already dead). Freeable for Enter;
    // auto path only with ordered sessionEnded success and non-wayfinder.
    const entryClass = resolveEntryClass(slot.issue?.entryClass, slot.issue);
    const isWayfinder = entryClass === 'wayfinder';
    const sessionSuccess =
      slot.sessionEnded === SESSION_ENDED.SUCCESS
      && slot.sessionSuccessOrderOk === true;

    if (isWayfinder) {
      // Human-gate complete: freeable, never auto next (not an "interrupt").
      return {
        ok: false,
        freeable: true,
        autoHandoff: false,
        reason: 'wayfinder-complete',
        status: 'awaiting-session-end',
      };
    }

    if (!sessionSuccess) {
      const interruptReason = sessionInterruptSummary(slot);
      let reason = 'process-exit-without-success';
      if (slot.sessionEnded === SESSION_ENDED.FAILURE) reason = 'session-failure';
      else if (slot.sessionEnded === SESSION_ENDED.INTERRUPTED) reason = 'session-interrupted';
      else if (
        slot.sessionEnded === SESSION_ENDED.SUCCESS
        && slot.sessionSuccessOrderOk !== true
      ) {
        reason = 'session-success-order-invalid';
      }
      return {
        ok: false,
        freeable: true,
        autoHandoff: false,
        reason,
        status: 'session-interrupted',
        interruptReason,
      };
    }

    return {
      ok: true,
      freeable: true,
      autoHandoff: true,
      reason: 'closed-and-session-success',
      status: 'idle',
    };
  }

  function countdownRemainingMs() {
    if (!slot || slot.handoffCountdownStartedAt == null) return null;
    const elapsed = Math.max(0, now() - slot.handoffCountdownStartedAt);
    return Math.max(0, handoffCountdownMs - elapsed);
  }

  function clearCountdownMarker() {
    if (!slot || slot.handoffCountdownStartedAt == null) return;
    const { handoffCountdownStartedAt: _drop, ...rest } = slot;
    slot = rest;
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

  /**
   * Record unified session-end on the current slot (internal + public port).
   * @param {'success'|'failure'|'interrupted'} outcome
   * @param {object} [detail]
   */
  async function applySessionEnded(outcome, detail = {}) {
    if (!slot) {
      return { ok: false, reason: 'empty-slot' };
    }
    const allowed = new Set([
      SESSION_ENDED.SUCCESS,
      SESSION_ENDED.FAILURE,
      SESSION_ENDED.INTERRUPTED,
    ]);
    if (!allowed.has(outcome)) {
      return { ok: false, reason: 'invalid-outcome' };
    }
    const sessionEndDetail = normalizeSessionEndDetail(detail);
    let orderOk = false;
    if (outcome === SESSION_ENDED.SUCCESS) {
      const completion = await tracker.getCompletion(slot.issue.id);
      orderOk = Boolean(completion?.closed);
    }
    slot = {
      ...slot,
      sessionEnded: outcome,
      sessionEndDetail,
      sessionSuccessOrderOk: orderOk,
    };
    return { ok: true, sessionEnded: outcome, orderOk };
  }

  /**
   * @param {object} issue
   * @param {string} [entryClass]
   * @param {{ autoAdvanceForMorph?: boolean }} [options]
   *   When starting a clean Enter that will open autoAdvance, pass true so the
   *   first impl spawn is already observable (otherwise dual-gate can never AFK).
   */
  async function spawnFromIssue(issue, entryClass, options = {}) {
    const spawnMode = effectiveSubsequentMode();
    const resolvedEntry = resolveEntryClass(entryClass, issue);
    // impl + autoAdvance → observable (AFK end events); wayfinder/人闸 → interactive.
    const morphAuto = options.autoAdvanceForMorph != null
      ? Boolean(options.autoAdvanceForMorph)
      : autoAdvance;
    const morph = resolveWorkerMorph({
      entryClass: resolvedEntry,
      autoAdvance: morphAuto,
      kind: 'initial',
    });
    const contract = buildLaunchContract({
      runtime,
      feature,
      cwd,
      issue,
      mode: spawnMode,
      entryClass: resolvedEntry,
      morph,
      model: subsequentModel,
      effort: subsequentEffort,
    });

    /** @type {{ outcome: string, detail: object }|null} */
    let queuedSessionEnd = null;
    /** @type {number|null} */
    let spawnedPid = null;

    const result = await launcher.launch({
      ...contract,
      onSessionEnded: (outcome, detail) => {
        // May race: event can arrive before slot is assigned after launch returns.
        if (spawnedPid == null || !slot || slot.pid !== spawnedPid) {
          queuedSessionEnd = { outcome, detail };
          return undefined;
        }
        return applySessionEnded(outcome, detail);
      },
    });

    spawnedPid = result.pid;
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
      morph: result.morph ?? contract.morph ?? morph,
      sessionEndCapable: Boolean(result.sessionEndCapable),
      forceAdvanceRequested: false,
      /** @type {null | 'success' | 'failure' | 'interrupted'} */
      sessionEnded: null,
      /** True only when success was reported while issue already Closed. */
      sessionSuccessOrderOk: false,
      /** @type {null | { exitCode?: *, failureClass?: string, lastError?: string, message?: string }} */
      sessionEndDetail: null,
    };
    status = 'soft-stuck';
    pendingHitl = null;
    nextIssue = issue;

    if (queuedSessionEnd) {
      const queued = queuedSessionEnd;
      queuedSessionEnd = null;
      await applySessionEnded(queued.outcome, queued.detail);
    }

    return {
      spawned: true,
      advanced: true,
      next: issue,
      status,
      ok: true,
    };
  }

  /**
   * Try to free a completed slot so explicit Enter start can proceed.
   * freeable: Closed ∧ (worker dead ∨ force-advance). Live incomplete slots stay.
   * Does not require sessionEnded success (human may free and start next).
   */
  async function releaseSlotIfHandoffReady() {
    if (!slot) return { ok: true, reason: 'empty-slot' };
    const gate = await classifyOccupiedSlot();
    if (!gate.freeable) {
      status = gate.status;
      return { ok: false, reason: gate.reason, status: gate.status };
    }
    slot = null;
    status = 'idle';
    return { ok: true, reason: gate.reason };
  }

  /**
   * Wayfinder tickets openable by manual Enter (not human/unknown HITL).
   * Sorted as tracker returns (number order via selectHitlCandidates).
   */
  async function listWayfinderStartCandidates() {
    if (typeof tracker.listHitlCandidates !== 'function') return [];
    const list = await tracker.listHitlCandidates();
    if (!Array.isArray(list)) return [];
    return list.filter((item) => resolveEntryClass(item?.entryClass, item) === 'wayfinder');
  }

  /**
   * Resolve a ticket for explicit operator start (Enter).
   * Default (no id): auto-ready impl first, else first open wayfinder.
   * With id: auto impl or wayfinder HITL candidate; human/unknown stay confirm-only.
   */
  async function resolveStartIssue(issueId) {
    if (issueId == null || issueId === '') {
      const auto = typeof tracker.recommendNext === 'function'
        ? await tracker.recommendNext()
        : null;
      if (auto) return auto;
      const wayfinders = await listWayfinderStartCandidates();
      return wayfinders[0] ?? null;
    }
    const wanted = String(issueId);
    if (typeof tracker.listAutoCandidates === 'function') {
      const list = await tracker.listAutoCandidates();
      const hit = Array.isArray(list)
        ? list.find((item) => item && item.id === wanted)
        : null;
      if (hit) return hit;
    }
    const next = typeof tracker.recommendNext === 'function'
      ? await tracker.recommendNext()
      : null;
    if (next && next.id === wanted) return next;

    const wayfinders = await listWayfinderStartCandidates();
    const wayfinderHit = wayfinders.find((item) => item && item.id === wanted);
    if (wayfinderHit) return wayfinderHit;
    return null;
  }

  /**
   * Explicit operator start (Enter): spawn one executable ticket into an empty slot.
   * Includes ordinary ready impl and wayfinder (Type:) tickets — no second confirm.
   * Human/unknown still use confirmHitl, not this path.
   * Bypasses autoAdvance gate. On a clean path (user never s-off'd), first
   * successful start opens autoAdvance so Closed∧exit handoffs can AFK
   * (auto still only spawns ready impl on step).
   * After user toggleAutoAdvance → off, start still spawns one but leaves
   * autoAdvance off — only another s (or set/toggle on) re-enables it.
   *
   * @param {string | null | undefined} issueId
   *   When set, spawn that executable id; otherwise default = impl then wayfinder.
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
    // If this Enter will open auto, first impl must already be observable so
    // session-end can feed dual-gate AFK handoff (do not wait for auto flip after spawn).
    const result = await spawnFromIssue(
      issue,
      resolveEntryClass(issue.entryClass, issue),
      { autoAdvanceForMorph: autoAdvance || openAutoOnManualStart },
    );
    // Clean first-success path only: do not sneak auto back on after user s-off.
    if (openAutoOnManualStart) {
      autoAdvance = true;
      // Dial became on → persist repo preference (same as explicit s-on).
      persistAutoAdvancePreference(true);
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
    /** Configured handoff countdown length in ms (default 9000). */
    get handoffCountdownMs() {
      return handoffCountdownMs;
    },
    /**
     * Remaining ms while status is handoff-countdown; null when not counting.
     */
    get handoffCountdownRemainingMs() {
      return countdownRemainingMs();
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
     * Programmatic only (tests / once path / quit freeze).
     * Does not lock out Enter→open-auto; does not clear the live slot; not stop().
     * Off also arms handoff-only mode (no idle empty auto-spawn); on clears it.
     * Does **not** write repo preference — use toggle / Enter-open / explicit persist.
     */
    setAutoAdvance(enabled) {
      autoAdvance = Boolean(enabled);
      // --once / tests set true → restore idle empty auto-spawn seam.
      // false → handoff-only (quit freeze / once off).
      autoSpawnRequiresHandoff = !autoAdvance;
      return { ok: true, autoAdvance };
    },
    /**
     * Fullscreen mount: restore repo auto preference with handoff-only gate.
     * Never enables idle empty auto-spawn (cold start must not fire Worker).
     * Does not write repo (read-only apply).
     */
    applyFullscreenAutoPreference() {
      autoAdvance = readAutoAdvancePreference();
      autoSpawnRequiresHandoff = true;
      return { ok: true, autoAdvance };
    },
    /**
     * Operator dial (fullscreen `s`): flip auto-open-next.
     * Turning off also locks Enter so a later manual start will not reopen auto.
     * Turning on arms AFK handoff only — does not idle-spawn an empty slot
     * (first / empty start still needs Enter / startIssue).
     * Persists repo preference immediately when a write port exists.
     */
    toggleAutoAdvance() {
      autoAdvance = !autoAdvance;
      if (!autoAdvance) {
        openAutoOnManualStart = false;
      }
      // Never touches autoSpawnRequiresHandoff — s is preference, not a fire command.
      persistAutoAdvancePreference(autoAdvance);
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
     * Human force-advance: skip waiting for worker exit / session-end signal
     * and skip countdown. Only valid when the current issue is already Closed.
     * Default: do not kill the old worker (orphan). Opt-in killWorker: true.
     * Auto path never kills; this is the only kill entry (explicit opt-in).
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
      const nextSlot = {
        ...slot,
        forceAdvanceRequested: true,
      };
      delete nextSlot.handoffCountdownStartedAt;
      slot = nextSlot;
      return { ok: true };
    },
    /**
     * Record a unified session-end outcome on the current slot.
     * success | failure | interrupted.
     * Auto path only auto-handoffs on success **and** only when the issue was
     * already Closed at report time (Closed-before-success order).
     * Real Worker path: Grok/Claude adapters → this port (via launcher callback).
     *
     * @param {'success'|'failure'|'interrupted'} outcome
     * @param {{
     *   exitCode?: number|string|null,
     *   failureClass?: string|null,
     *   lastError?: string|null,
     *   message?: string|null,
     * }} [detail]
     */
    async reportSessionEnded(outcome, detail = {}) {
      return applySessionEnded(outcome, detail);
    },
    /**
     * Cancel an in-progress handoff countdown: free the completed slot without
     * auto-spawning the next ticket. Operator may Enter to start next manually.
     */
    async cancelHandoffCountdown() {
      if (!slot || slot.handoffCountdownStartedAt == null) {
        return { ok: false, reason: 'no-countdown' };
      }
      slot = null;
      status = stopped ? 'stopped' : 'idle';
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
     * One-shot resume of the recorded session after needs-resume or
     * session-interrupted (same id history hang-back). Does not open the next
     * ticket; does not re-inject skill entry. Keeps spawn-pinned mode.
     */
    async resume() {
      if (!slot) {
        return { ok: false, reason: 'no-slot' };
      }
      const gate = await classifyOccupiedSlot();
      const resumable =
        gate.reason === 'needs-resume'
        || gate.status === 'session-interrupted';
      if (!resumable) {
        if (!stopped) status = gate.status;
        return { ok: false, reason: gate.reason };
      }
      if (!slot.sessionId) {
        if (!stopped) status = gate.status;
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
        // Fresh worker life: prior end/interrupt no longer applies.
        sessionEnded: null,
        sessionSuccessOrderOk: false,
        sessionEndDetail: null,
      };
      // Drop countdown marker if any (should not be active in needs-resume).
      if (slot.handoffCountdownStartedAt != null) {
        const { handoffCountdownStartedAt: _drop, ...rest } = slot;
        slot = rest;
      }
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
     * Never kills workers. Surfaces handoff-countdown remaining when active.
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
      // Prefer countdown projection when an active timer is still running
      // and autoHandoff is still allowed.
      if (
        slot.handoffCountdownStartedAt != null
        && !slot.forceAdvanceRequested
        && autoAdvance
      ) {
        const gate = await classifyOccupiedSlot();
        if (gate.autoHandoff) {
          const remainingMs = countdownRemainingMs();
          if (remainingMs != null && remainingMs > 0) {
            status = 'handoff-countdown';
            return {
              status: 'handoff-countdown',
              reason: 'handoff-countdown',
              remainingMs,
            };
          }
        }
      }
      const gate = await classifyOccupiedSlot();
      status = gate.status;
      return {
        status: gate.status,
        reason: gate.reason,
        remainingMs: countdownRemainingMs(),
        interruptReason: gate.interruptReason ?? null,
      };
    },
    /**
     * One evaluation cycle:
     * - If stopped, never auto-spawn or open HITL offers.
     * - Never auto-kill a live worker (Closed alone → awaiting-worker-exit).
     * - Auto handoff only when classify.autoHandoff (ordered sessionEnded
     *   success or forceAdvance). Closed ∧ natural exit without success →
     *   session-interrupted (no kill, no auto next).
     * - Wayfinder complete never auto-handoffs.
     * - When autoHandoff + autoAdvance + countdown > 0 → handoff-countdown.
     * - Then spawn at most one auto ready-impl candidate into an empty slot.
     * - Wayfinder is never auto-spawned; operator uses startIssue/Enter.
     * - human/unknown HITL: emit needs-confirmation until confirmHitl.
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

      let releasedThisStep = false;
      if (slot) {
        // Active countdown: re-validate autoHandoff preconditions, then wait or release.
        if (slot.handoffCountdownStartedAt != null && !slot.forceAdvanceRequested) {
          const gate = await classifyOccupiedSlot();
          if (!gate.autoHandoff) {
            clearCountdownMarker();
            status = gate.status;
            return {
              spawned: false,
              advanced: false,
              reason: gate.reason,
              next: nextIssue,
              status,
              interruptReason: gate.interruptReason ?? null,
            };
          }
          const remainingMs = countdownRemainingMs() ?? 0;
          if (remainingMs > 0 && autoAdvance) {
            status = 'handoff-countdown';
            return {
              spawned: false,
              advanced: false,
              reason: 'handoff-countdown',
              remainingMs,
              next: nextIssue,
              status,
            };
          }
          // Countdown elapsed, or auto turned off mid-countdown → free slot.
          slot = null;
          status = 'idle';
          releasedThisStep = true;
        } else {
          const gate = await classifyOccupiedSlot();
          if (!gate.autoHandoff) {
            clearCountdownMarker();
            status = gate.status;
            return {
              spawned: false,
              advanced: false,
              reason: gate.reason,
              next: nextIssue,
              status,
              interruptReason: gate.interruptReason ?? null,
            };
          }

          // autoHandoff: force-advance or Closed ∧ sessionEnded success.
          // Start countdown (default 9s) before open next when auto is on.
          const startCountdown =
            autoAdvance
            && !slot.forceAdvanceRequested
            && handoffCountdownMs > 0
            && !workerAlive();

          if (startCountdown) {
            slot = { ...slot, handoffCountdownStartedAt: now() };
            status = 'handoff-countdown';
            return {
              spawned: false,
              advanced: false,
              reason: 'handoff-countdown',
              remainingMs: handoffCountdownMs,
              next: nextIssue,
              status,
            };
          }

          // forceAdvance, auto off, or countdown disabled (0ms) → release now.
          slot = null;
          status = 'idle';
          releasedThisStep = true;
        }
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

      // s dial / fullscreen mount: auto on enables handoff only, not cold empty fire.
      if (!releasedThisStep && autoSpawnRequiresHandoff) {
        if (pendingHitl) {
          status = 'needs-confirmation';
          return {
            spawned: false,
            advanced: false,
            reason: 'awaiting-manual-start',
            next: pendingHitl.issue,
            status,
          };
        }
        status = 'idle';
        return {
          spawned: false,
          advanced: false,
          reason: 'awaiting-manual-start',
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
        const hitlClass = resolveEntryClass(hitl.entryClass, hitl);
        // Wayfinder is Enter-startable; do not park auto-step on needs-confirmation.
        // Auto step never spawns wayfinder — only ready impl (above) or human/unknown ask.
        if (hitlClass === 'wayfinder') {
          nextIssue = hitl;
          status = 'idle';
          return {
            spawned: false,
            advanced: true,
            reason: 'wayfinder-manual-start',
            next: hitl,
            status,
          };
        }
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
