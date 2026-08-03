/**
 * Controllable WorkerLauncher for Chain Run tests.
 * Records launch requests; never starts real Grok/Claude.
 * Tracks pid liveness so dual-condition handoff can be exercised.
 */
export function createFakeLauncher({ pid = 1000, sessionId = null } = {}) {
  const launches = [];
  const alive = new Set();
  let nextPid = pid;

  return {
    launches,
    async launch(request) {
      const assignedPid = nextPid;
      nextPid += 1;
      alive.add(assignedPid);
      const result = {
        pid: assignedPid,
        sessionId: sessionId ?? null,
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
  };
}
