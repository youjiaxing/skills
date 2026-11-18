import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 16 * 1024 * 1024;

// Use the public read API and a short-lived least-privilege session. Tokens
// stay in memory; compiled application modules and auth databases are not APIs.
export function createT3Reader({run, fetchImpl = fetch, readRuntime = async file => JSON.parse(await readFile(file,'utf8')),
  now = Date.now} = {}) {
  const cache = new Map();
  return async function readProjection(record, {timeoutMs = 15000} = {}) {
    const baseDir = record.t3BaseDir ?? process.env.T3CODE_HOME ?? path.join(os.homedir(),'.t3');
    const key = JSON.stringify([record.t3Command,baseDir,record.threadId]);
    const previous = cache.get(key);
    if (previous && (previous.pending || previous.expires > now())) return previous.promise;
    const deadline = now() + timeoutMs;
    const remaining = () => Math.max(1,deadline - now());
    const promise = (async () => {
      let session;
      const extra = ['--base-dir',baseDir];
      try {
        const runtime = await readRuntime(path.join(baseDir,'userdata','server-runtime.json'));
        const origin = new URL(runtime.origin);
        if (!['http:','https:'].includes(origin.protocol) || !['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) throw new Error('T3 local runtime unavailable');
        const issued = await run(record.t3Command,
          ['auth','session','issue','--scope','orchestration:read','--ttl','1m','--label','yjx-feishu-observer','--json',...extra], undefined, {timeoutMs:remaining()});
        session = issued.data;
        if (issued.code !== 0 || !session?.token || !session.sessionId) throw new Error('T3 read session unavailable');
        const response = await fetchImpl(new URL(`/api/orchestration/threads/${encodeURIComponent(record.threadId)}`,origin), {
          headers:{Authorization:`Bearer ${session.token}`,'x-t3-orchestration-protocol':'2'},
          signal:AbortSignal.timeout(remaining()), redirect:'error',
        });
        if (!response.ok) throw new Error('T3 run query unavailable');
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > MAX_BYTES) { await response.body.cancel?.().catch(()=>{}); throw new Error('T3 run query exceeded limit'); }
          chunks.push(Buffer.from(chunk));
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (data.projection?.thread?.id !== record.threadId || !Array.isArray(data.projection.runs) || !Array.isArray(data.projection.messages)) throw new Error('T3 run query identity unavailable');
        return data.projection;
      } finally {
        if (session?.sessionId) {
          try { await run(record.t3Command,['auth','session','revoke',session.sessionId,...extra],undefined,{timeoutMs:3000}); }
          catch { /* The read-only token also expires after one minute. */ }
        }
      }
    })();
    const entry={promise,expires:now()+2000,pending:true};
    cache.set(key,entry);
    try { return await promise; }
    catch { cache.delete(key); throw new Error('T3 run observation unavailable'); }
    finally {
      entry.pending=false; entry.expires=now()+2000;
      for (const [key,value] of cache) if (value.expires < now()) cache.delete(key);
      while(cache.size>16) cache.delete(cache.keys().next().value);
    }
  };
}
