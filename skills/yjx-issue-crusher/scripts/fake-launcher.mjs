/**
 * Controllable WorkerLauncher for Chain Run tests.
 * Records launch requests; never starts real Grok/Claude.
 * Tracks pid liveness so dual-condition handoff can be exercised.
 * kill() is explicit opt-in only (force-advance default must not call it).
 *
 * Optional session-end: launch records morph / onSessionEnded; tests may call
 * emitSessionEnded(pid, outcome, detail) to simulate adapter delivery.
 */
export function createFakeLauncher({ pid = 1000, sessionId = null } = {}) {
  const launches = [];
  const kills = [];
  const alive = new Set();
  /** @type {Map<number, (outcome: string, detail: object) => void|Promise<void>>} */
  const sessionEndHandlers = new Map();
  let nextPid = pid;

  return {
    launches,
    kills,
    async launch(request) {
      const assignedPid = nextPid;
      nextPid += 1;
      alive.add(assignedPid);
      // Resume keeps the recorded session; initial may use the launcher default.
      const resolvedSessionId = request?.kind === 'resume'
        ? (request.sessionId ?? sessionId ?? null)
        : (sessionId ?? request?.sessionId ?? null);
      const morph = request?.morph === 'observable' ? 'observable' : 'interactive';
      const sessionEndCapable = morph === 'observable';
      if (typeof request?.onSessionEnded === 'function') {
        sessionEndHandlers.set(assignedPid, request.onSessionEnded);
      }
      const result = {
        pid: assignedPid,
        sessionId: resolvedSessionId,
        morph,
        sessionEndCapable,
      };
      launches.push({ ...request, result });
      return result;
    },
    isAlive(processId) {
      return alive.has(processId);
    },
    markExited(processId) {
      alive.delete(processId);
    },
    /**
     * Simulate runtime adapter delivering a session-end for a live spawn.
     * @param {number} processId
     * @param {'success'|'failure'|'interrupted'} outcome
     * @param {object} [detail]
     */
    async emitSessionEnded(processId, outcome, detail = {}) {
      const handler = sessionEndHandlers.get(processId);
      if (typeof handler !== 'function') {
        return { ok: false, reason: 'no-handler' };
      }
      await handler(outcome, detail);
      return { ok: true };
    },
    async kill(processId) {
      kills.push(processId);
      alive.delete(processId);
      sessionEndHandlers.delete(processId);
    },
  };
}
