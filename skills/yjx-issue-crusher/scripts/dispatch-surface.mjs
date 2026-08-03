/**
 * Dispatch surface — testable controller between Chain Run and the scheduler TUI.
 *
 * Builds a read-only projection (mode, slot, board, available actions, messages)
 * and routes human events. Graph/board is display-only: no claim/dispatch via graph.
 */

/**
 * @param {{
 *   chain: object,
 *   tracker?: object,
 * }} options
 */
export function createDispatchSurface({ chain, tracker = null } = {}) {
  if (!chain) throw new Error('chain is required');

  /** @type {object|null} */
  let lastSnapshot = null;
  /** @type {Array<{ type: string, text: string }>} */
  let localMessages = [];

  function pushMessage(type, text) {
    localMessages = [...localMessages, { type, text }].slice(-20);
  }

  function collectMessages() {
    const fromChain = Array.isArray(chain.events)
      ? chain.events.map((event) => ({
        type: event.type || 'event',
        text: String(event.message || event.text || event.type || ''),
      }))
      : [];
    // Prefer chain tip order; append local surface notes without duping identical text.
    const merged = [...fromChain];
    for (const message of localMessages) {
      if (!merged.some((item) => item.text === message.text && item.type === message.type)) {
        merged.push(message);
      }
    }
    return merged;
  }

  async function loadBoard() {
    const port = tracker && typeof tracker.getBoard === 'function'
      ? tracker
      : null;
    if (!port) {
      return {
        feature: chain.feature,
        readOnly: true,
        issues: [],
      };
    }
    const board = await port.getBoard();
    return {
      feature: board?.feature ?? chain.feature,
      readOnly: true,
      issues: Array.isArray(board?.issues)
        ? board.issues.map((issue) => ({
          id: issue.id,
          title: issue.title ?? issue.id,
          closed: Boolean(issue.closed),
          blockedBy: Array.isArray(issue.blockedBy) ? [...issue.blockedBy] : [],
          unlocks: Array.isArray(issue.unlocks) ? [...issue.unlocks] : [],
          status: issue.status ?? issue.statusRole ?? issue.type ?? null,
        }))
        : [],
    };
  }

  async function closedForSlot() {
    if (!chain.slot) return false;
    if (!tracker || typeof tracker.getCompletion !== 'function') return false;
    try {
      const completion = await tracker.getCompletion(chain.slot.issue.id);
      return Boolean(completion?.closed);
    } catch {
      return false;
    }
  }

  function buildActions({ closed, status, stopped }) {
    const needsResume = status === 'needs-resume';
    const needsConfirmation = status === 'needs-confirmation' && Boolean(chain.pendingHitl);
    return {
      setMode: {
        available: !stopped,
        reason: stopped ? 'stopped' : null,
      },
      forceAdvance: {
        available: !stopped && Boolean(chain.slot) && closed,
        reason: stopped
          ? 'stopped'
          : !chain.slot
            ? 'no-slot'
            : closed
              ? null
              : 'not-closed',
      },
      resume: {
        available: needsResume && Boolean(chain.slot?.sessionId),
        reason: needsResume
          ? (chain.slot?.sessionId ? null : 'no-session-id')
          : 'not-needs-resume',
      },
      confirmHitl: {
        available: !stopped && needsConfirmation,
        reason: stopped
          ? 'stopped'
          : needsConfirmation
            ? null
            : 'no-pending-hitl',
      },
      rejectHitl: {
        available: needsConfirmation,
        reason: needsConfirmation ? null : 'no-pending-hitl',
      },
      stop: {
        available: !stopped,
        reason: stopped ? 'already-stopped' : null,
      },
      // Explicitly absent: graphDispatch — board is read-only projection only.
    };
  }

  async function buildSnapshot() {
    const stopped = Boolean(chain.stopped);
    const status = stopped ? 'stopped' : chain.status;
    const closed = await closedForSlot();
    const board = await loadBoard();
    const slot = chain.slot
      ? {
        issueId: chain.slot.issue?.id ?? null,
        title: chain.slot.title ?? null,
        pid: chain.slot.pid ?? null,
        sessionId: chain.slot.sessionId ?? null,
        mode: chain.slot.mode ?? null,
        closed,
      }
      : null;
    const pending = chain.pendingHitl
      ? {
        issueId: chain.pendingHitl.issue?.id ?? null,
        entryClass: chain.pendingHitl.entryClass ?? null,
        title: chain.pendingHitl.title ?? null,
        runtime: chain.pendingHitl.runtime ?? null,
        model: chain.pendingHitl.model ?? null,
        effort: chain.pendingHitl.effort ?? null,
        mode: chain.pendingHitl.mode ?? null,
      }
      : null;

    lastSnapshot = {
      feature: chain.feature,
      cwd: chain.cwd,
      runtime: chain.runtime,
      subsequentMode: chain.mode,
      workerMode: slot?.mode ?? null,
      status,
      stopped,
      slot,
      pendingHitl: pending,
      board,
      messages: collectMessages(),
      actions: buildActions({ closed, status, stopped }),
    };
    return lastSnapshot;
  }

  return {
    /**
     * One auto-eval cycle (Chain Run step) then rebuild projection.
     * When stopped, only refreshes status/projection — no spawn.
     */
    async tick() {
      await chain.step();
      return buildSnapshot();
    },
    /**
     * Reclassify slot / HITL without spawning.
     */
    async refresh() {
      if (typeof chain.refreshStatus === 'function') {
        await chain.refreshStatus();
      }
      return buildSnapshot();
    },
    snapshot() {
      if (!lastSnapshot) {
        throw new Error('snapshot requires tick() or refresh() first');
      }
      return lastSnapshot;
    },
    async setMode(nextMode) {
      const result = await chain.setMode(nextMode);
      await buildSnapshot();
      return result;
    },
    async forceAdvance(options) {
      const result = await chain.forceAdvance(options);
      if (!result.ok && result.reason === 'not-closed') {
        pushMessage('warn', 'Force-advance is only available after Closed: true');
      }
      await buildSnapshot();
      return result;
    },
    async resume() {
      const result = await chain.resume();
      await buildSnapshot();
      return result;
    },
    async confirmHitl() {
      const result = await chain.confirmHitl();
      await buildSnapshot();
      return result;
    },
    async rejectHitl() {
      const result = await chain.rejectHitl();
      await buildSnapshot();
      return result;
    },
    async stop() {
      const result = await chain.stop();
      pushMessage('info', 'Chain stopped — no further auto spawn');
      await buildSnapshot();
      return result;
    },
  };
}
