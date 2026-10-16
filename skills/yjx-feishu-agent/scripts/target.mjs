import { AppServer, resolveCodex, RpcError } from './app-server.mjs';

export async function readTarget(client, threadId, deadline) {
  try {
    const result = await client.call('thread/read', { threadId, includeTurns: false }, deadline);
    if (result.thread?.id !== threadId) return { state: 'unknown', reason: 'identity_mismatch' };
    const parts = (result.thread.path ?? '').split(/[\\/]/);
    return { state: parts.includes('archived_sessions') ? 'archived' : parts.includes('sessions') ? 'readable' : 'unknown', threadId };
  } catch (error) {
    if (error instanceof RpcError && error.code === -32600 && error.message === `thread not loaded: ${threadId}`) {
      return { state: 'unavailable', threadId, reason: 'not_loaded_or_missing' };
    }
    return { state: 'unknown', threadId, reason: 'query_failed' };
  }
}

export async function inspectTarget({ threadId, codex, cwd, timeoutMs = 15000 },
  { createClient = (binary, directory) => new AppServer(binary, directory) } = {}) {
  let client;
  try {
    client = createClient(await resolveCodex(codex), cwd);
    const deadline = performance.now() + timeoutMs;
    await client.initialize(deadline);
    return await readTarget(client, threadId, deadline);
  } catch (error) {
    // This is also returned for unloaded/missing data: do not claim permanent deletion.
    if (error instanceof RpcError && error.code === -32600 &&
        error.message === `thread not loaded: ${threadId}`) return { state: 'unavailable', threadId, reason: 'not_loaded_or_missing' };
    return { state: 'unknown', threadId, reason: 'query_failed' };
  } finally { if (client) await client.close(); }
}
