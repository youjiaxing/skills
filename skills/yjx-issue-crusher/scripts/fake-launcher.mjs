/**
 * Controllable WorkerLauncher for Chain Run tests.
 * Records launch requests; never starts real Grok/Claude.
 */
export function createFakeLauncher({ pid = 1000, sessionId = null } = {}) {
  const launches = [];
  let nextPid = pid;

  return {
    launches,
    async launch(request) {
      const assignedPid = nextPid;
      nextPid += 1;
      const result = {
        pid: assignedPid,
        sessionId: sessionId ?? null,
      };
      launches.push({ ...request, result });
      return result;
    },
  };
}
