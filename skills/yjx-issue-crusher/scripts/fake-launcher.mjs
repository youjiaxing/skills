/**
 * Controllable WorkerLauncher for Chain Run tests.
 * Records launch requests; never starts real Grok/Claude.
 * Tracks pid liveness so dual-condition handoff can be exercised.
 * kill() is explicit opt-in only (force-advance default must not call it).
 */
export function createFakeLauncher({ pid = 1000, sessionId = null } = {}) {
  const launches = [];
  const kills = [];
  const alive = new Set();
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
      const result = {
        pid: assignedPid,
        sessionId: resolvedSessionId,
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
    async kill(processId) {
      kills.push(processId);
      alive.delete(processId);
    },
  };
}
