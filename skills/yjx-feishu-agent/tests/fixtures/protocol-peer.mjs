// Deterministic JSON-RPC peer for executable transport tests; no model or skill prompt evaluation.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = process.env.PEER_DIRECTORY;
const mode = process.env.PEER_MODE;
const threadId = process.env.PEER_THREAD;
let turn;
let polls = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ id, result });
const log = (method) => appendFileSync(path.join(directory, 'calls.jsonl'), `${JSON.stringify({ method, at: Date.now() })}\n`);
const user = (message) => ({ type: 'userMessage', content: [{ type: 'text', text: message }] });
function makeTurn(message, completed) {
  return { id: 'protocol-turn-1', status: completed ? 'completed' : 'interrupted',
    completedAt: completed ? 123 : null, items: [user(message), ...(completed
      ? [{ type: 'agentMessage', phase: mode === 'queue-null-phase' ? null : mode === 'no-final-phase' ? undefined : 'final_answer', text: 'protocol-result-✓' }]
      : [])] };
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.method) return;
  log(request.method);
  const { id, method, params } = request;
  if (method === 'initialize') {
    if (mode === 'no-initialize') return;
    if (mode === 'malformed') { process.stdout.write('invalid-json\n'); return; }
    respond(id, { userAgent: 'protocol-test' });
  } else if (method === 'initialized') {
    return;
  } else if (method === 'thread/read') {
    if (mode === 'target-unavailable') send({ id, error: { code: -32600, message: `thread not loaded: ${threadId}` } });
    else respond(id, { thread: { id: threadId, path: mode === 'target-unknown' ? null : `/codex/${mode === 'target-archived' ? 'archived_sessions' : 'sessions'}/test.jsonl` } });
  } else if (method === 'thread/resume') {
    if (mode.startsWith('queue')) send({ id, error: { code: -32600, message: 'thread already has an active writer' } });
    else if (mode === 'denied') send({ id, error: { code: -32600, message: 'Access denied' } });
    else respond(id, { thread: { id: threadId } });
  } else if (method === 'turn/start') {
    writeFileSync(path.join(directory, 'input.json'), JSON.stringify(params));
    turn = makeTurn(params.input[0].text, false);
    if (mode !== 'before-ack') respond(id, { turn: { id: turn.id } });
    if (mode === 'no-completion') return;
    if (mode === 'host-request') send({ id: 'host-call', method: 'item/tool/call', params: {} });
    setTimeout(() => {
      turn = makeTurn(params.input[0].text, true);
      log('fixture/completed');
      send({ method: 'turn/completed', params: { threadId: 'other-thread', turn } });
      send({ method: 'turn/completed', params: { threadId, turn } });
      if (mode === 'before-ack') respond(id, { turn: { id: turn.id } });
    }, 30);
  } else if (method === 'thread/turns/list') {
    const queuedFile = path.join(directory, 'queue.json');
    if (mode.startsWith('queue') && existsSync(queuedFile)) {
      if (!params.cursor) polls += 1;
      if (mode === 'queue-pages' && !params.cursor) {
        respond(id, { data: [{ id: 'unrelated-turn', items: [] }], nextCursor: 'page-2' });
        return;
      }
      const submitted = JSON.parse(readFileSync(queuedFile, 'utf8'));
      const complete = mode === 'queue-late' ? existsSync(path.join(directory, 'complete.flag')) : polls > 1;
      const data = [makeTurn(submitted.message, complete), { id: 'baseline', items: [] }];
      if (mode === 'queue-ambiguous') data.unshift({ ...data[0], id: 'second-matching-turn' });
      respond(id, { data, nextCursor: null });
    } else {
      const saved = path.join(directory, 'turn.json');
      const data = turn ? [turn] : existsSync(saved) ? [JSON.parse(readFileSync(saved, 'utf8'))] : [{ id: 'baseline', items: [] }];
      respond(id, { data, nextCursor: null });
    }
  } else if (method === 'turn/interrupt') {
    respond(id, {});
  } else send({ id, error: { code: -32601, message: 'Unsupported fixture method' } });
});
process.stdin.on('end', () => process.exit(0));
