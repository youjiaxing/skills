/**
 * 20260806-1636/03 — Grok/Claude session-end adapters + AFK morph seams.
 * Fake event streams only; never opens a real agent window.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import {
  mapGrokStreamEvent,
  mapClaudeSessionEvent,
  reduceSessionEndFromStream,
  resolveWorkerMorph,
  attachSessionEndWatcher,
} from '../scripts/session-end-adapters.mjs';
import {
  buildWorkerInvocation,
  createRealLauncher,
} from '../scripts/real-launcher.mjs';
import { buildLaunchContract } from '../scripts/build-launch-contract.mjs';

const FIXED_SESSION = '11111111-1111-4111-8111-111111111111';

// ── pure mapping: Grok ──────────────────────────────────────────────

test('Grok: intermediate thought/text/tool_call/usage map to null', () => {
  assert.equal(mapGrokStreamEvent({ type: 'thought', data: 'x' }), null);
  assert.equal(mapGrokStreamEvent({ type: 'text', data: 'hi' }), null);
  assert.equal(mapGrokStreamEvent({ type: 'tool_call', name: 'run' }), null);
  assert.equal(mapGrokStreamEvent({ type: 'usage', usage: {} }), null);
  assert.equal(mapGrokStreamEvent({ type: 'available_commands' }), null);
});

test('Grok: single-turn stop_reason without type:end is not success', () => {
  // Mid-conversation assistant stop must not look like session success.
  assert.equal(
    mapGrokStreamEvent({ stopReason: 'end_turn', type: 'message' }),
    null,
  );
  assert.equal(
    mapGrokStreamEvent({ stop_reason: 'end_turn' }),
    null,
  );
  assert.equal(
    mapGrokStreamEvent({ type: 'assistant', stopReason: 'end_turn' }),
    null,
  );
});

test('Grok: type:end + end_turn is session success terminal', () => {
  const mapped = mapGrokStreamEvent({
    type: 'end',
    stopReason: 'end_turn',
    sessionId: 'sess-1',
  });
  assert.equal(mapped.outcome, 'success');
  assert.equal(mapped.detail?.sessionId, 'sess-1');
  assert.equal(mapped.detail?.stopReason, 'end_turn');
});

test('Grok: type:end with error-like stopReason is failure', () => {
  const mapped = mapGrokStreamEvent({
    type: 'end',
    stopReason: 'error',
    error: 'api blew up',
  });
  assert.equal(mapped.outcome, 'failure');
  assert.match(String(mapped.detail?.lastError || ''), /api blew up|error/i);
});

test('Grok: type:end with interrupt/abort/cancel is interrupted', () => {
  assert.equal(
    mapGrokStreamEvent({ type: 'end', stopReason: 'interrupted' }).outcome,
    'interrupted',
  );
  assert.equal(
    mapGrokStreamEvent({ type: 'end', stopReason: 'user_abort' }).outcome,
    'interrupted',
  );
});

test('Grok: NDJSON line string is accepted', () => {
  const line = JSON.stringify({
    type: 'end',
    stopReason: 'end_turn',
    sessionId: 'abc',
  });
  assert.equal(mapGrokStreamEvent(line).outcome, 'success');
});

// ── pure mapping: Claude ────────────────────────────────────────────

test('Claude: mid-stream / single-turn stop_reason without result is not success', () => {
  assert.equal(
    mapClaudeSessionEvent({ type: 'assistant', stop_reason: 'end_turn' }),
    null,
  );
  assert.equal(
    mapClaudeSessionEvent({ stop_reason: 'end_turn' }),
    null,
  );
  assert.equal(
    mapClaudeSessionEvent({ type: 'content_block_stop' }),
    null,
  );
});

test('Claude: type:result success / completed is session success', () => {
  const mapped = mapClaudeSessionEvent({
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: 'completed',
    stop_reason: 'end_turn',
    session_id: 'claude-sess',
  });
  assert.equal(mapped.outcome, 'success');
  assert.equal(mapped.detail?.sessionId, 'claude-sess');
});

test('Claude: type:result error / max_turns is failure with reason', () => {
  const mapped = mapClaudeSessionEvent({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    terminal_reason: 'max_turns',
    errors: ['Reached maximum number of turns (3)'],
    stop_reason: 'tool_use',
  });
  assert.equal(mapped.outcome, 'failure');
  assert.match(String(mapped.detail?.lastError || ''), /maximum number of turns/i);
  assert.equal(mapped.detail?.failureClass, 'error_max_turns');
});

test('Claude: type:error envelope is failure', () => {
  const mapped = mapClaudeSessionEvent({
    type: 'error',
    error: { message: 'auth failed' },
  });
  assert.equal(mapped.outcome, 'failure');
});

test('Claude: interrupted terminal reasons map to interrupted', () => {
  assert.equal(
    mapClaudeSessionEvent({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'interrupted',
      errors: ['user cancelled'],
    }).outcome,
    'interrupted',
  );
});

// ── stream reduce ───────────────────────────────────────────────────

test('reduceSessionEndFromStream: last terminal wins; ignores single-turn stops', () => {
  const ndjson = [
    '{"type":"thought","data":"x"}',
    '{"type":"assistant","stop_reason":"end_turn"}',
    '{"type":"end","stopReason":"end_turn","sessionId":"g1"}',
  ].join('\n');

  const reduced = reduceSessionEndFromStream('grok', ndjson);
  assert.equal(reduced.outcome, 'success');
  assert.equal(reduced.detail?.sessionId, 'g1');
});

test('reduceSessionEndFromStream: claude result at end of stream', () => {
  const events = [
    { type: 'assistant', stop_reason: 'end_turn' },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      session_id: 'c1',
    },
  ];
  const reduced = reduceSessionEndFromStream('claude', events);
  assert.equal(reduced.outcome, 'success');
  assert.equal(reduced.detail?.sessionId, 'c1');
});

test('reduceSessionEndFromStream: empty / no terminal → null', () => {
  assert.equal(reduceSessionEndFromStream('grok', ''), null);
  assert.equal(
    reduceSessionEndFromStream('claude', [{ type: 'assistant', stop_reason: 'end_turn' }]),
    null,
  );
});

// ── morph resolution ────────────────────────────────────────────────

test('resolveWorkerMorph: impl + autoAdvance → observable; wayfinder/人闸/resume → interactive', () => {
  assert.equal(
    resolveWorkerMorph({ entryClass: 'impl', autoAdvance: true, kind: 'initial' }),
    'observable',
  );
  assert.equal(
    resolveWorkerMorph({ entryClass: 'impl', autoAdvance: false, kind: 'initial' }),
    'interactive',
  );
  assert.equal(
    resolveWorkerMorph({ entryClass: 'wayfinder', autoAdvance: true, kind: 'initial' }),
    'interactive',
  );
  assert.equal(
    resolveWorkerMorph({ entryClass: 'impl', autoAdvance: true, kind: 'resume' }),
    'interactive',
  );
  assert.equal(
    resolveWorkerMorph({ entryClass: 'human', autoAdvance: true, kind: 'initial' }),
    'interactive',
  );
});

// ── buildWorkerInvocation morph argv ────────────────────────────────

test('observable morph: Grok gets -p + streaming-json; interactive still forbids headless flags', () => {
  const base = buildLaunchContract({
    runtime: 'grok',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: {
      id: '03-session-end.md',
      path: '.scratch/demo/issues/03-session-end.md',
    },
    mode: 'vibe',
    entryClass: 'impl',
  });

  const interactive = buildWorkerInvocation(
    { ...base, morph: 'interactive' },
    { generateSessionId: () => FIXED_SESSION },
  );
  assert.equal(interactive.args.includes('-p'), false);
  assert.equal(interactive.args.includes('--output-format'), false);
  assert.equal(interactive.morph, 'interactive');

  const observable = buildWorkerInvocation(
    { ...base, morph: 'observable' },
    { generateSessionId: () => FIXED_SESSION },
  );
  assert.equal(observable.morph, 'observable');
  assert.ok(observable.args.includes('-p'));
  const fmtIdx = observable.args.indexOf('--output-format');
  assert.ok(fmtIdx >= 0);
  assert.equal(observable.args[fmtIdx + 1], 'streaming-json');
  // still session-persistent
  assert.equal(observable.args.includes('--no-session-persistence'), false);
});

test('observable morph: Claude gets -p + json output format', () => {
  const base = buildLaunchContract({
    runtime: 'claude',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: {
      id: '03-session-end.md',
      path: '.scratch/demo/issues/03-session-end.md',
    },
    mode: 'vibe',
    entryClass: 'impl',
  });
  const inv = buildWorkerInvocation(
    { ...base, morph: 'observable' },
    { generateSessionId: () => FIXED_SESSION },
  );
  assert.ok(inv.args.includes('-p') || inv.args.includes('--print'));
  const fmtIdx = inv.args.indexOf('--output-format');
  assert.ok(fmtIdx >= 0);
  assert.equal(inv.args[fmtIdx + 1], 'stream-json');
});

// ── attachSessionEndWatcher + launcher fake stream ──────────────────

function fakeChildWithStdout() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('attachSessionEndWatcher: maps Grok stream then reports on close', async () => {
  const child = fakeChildWithStdout();
  /** @type {Array<object>} */
  const reported = [];
  const done = new Promise((resolve) => {
    attachSessionEndWatcher(child, {
      runtime: 'grok',
      onSessionEnded(outcome, detail) {
        reported.push({ outcome, detail });
        resolve();
      },
    });
  });

  child.stdout.emit(
    'data',
    Buffer.from(`${JSON.stringify({ type: 'text', data: 'working' })}\n`),
  );
  // single-turn stop mid-stream must not fire early
  child.stdout.emit(
    'data',
    Buffer.from(`${JSON.stringify({ type: 'assistant', stopReason: 'end_turn' })}\n`),
  );
  assert.equal(reported.length, 0);

  child.stdout.emit(
    'data',
    Buffer.from(
      `${JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 's1' })}\n`,
    ),
  );
  child.emit('close', 0);
  await done;

  assert.equal(reported.length, 1);
  assert.equal(reported[0].outcome, 'success');
  assert.equal(reported[0].detail?.sessionId, 's1');
  assert.equal(reported[0].detail?.exitCode, 0);
});

test('attachSessionEndWatcher: process exit without terminal event → interrupted', async () => {
  const child = fakeChildWithStdout();
  const reported = [];
  const done = new Promise((resolve) => {
    attachSessionEndWatcher(child, {
      runtime: 'claude',
      onSessionEnded(outcome, detail) {
        reported.push({ outcome, detail });
        resolve();
      },
    });
  });

  child.stdout.emit('data', Buffer.from('not even json\n'));
  child.emit('close', 1);
  await done;

  assert.equal(reported.length, 1);
  assert.equal(reported[0].outcome, 'interrupted');
  assert.equal(reported[0].detail?.exitCode, 1);
});

test('createRealLauncher observable morph: pipes stdout and fires onSessionEnded from fake child', async () => {
  const child = fakeChildWithStdout();
  /** @type {Array<object>} */
  const reported = [];
  const launcher = createRealLauncher({
    generateSessionId: () => FIXED_SESSION,
    applyGrokTitle: false,
    // Observable path uses spawnObservable (not the interactive spawnWorker).
    spawnObservable(command, args, options) {
      assert.equal(options?.stdio?.[1], 'pipe');
      assert.ok(args.includes('-p'));
      return { pid: 4242, child };
    },
  });

  const contract = buildLaunchContract({
    runtime: 'grok',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: {
      id: '03-session-end.md',
      path: '.scratch/demo/issues/03-session-end.md',
    },
    mode: 'vibe',
    entryClass: 'impl',
    morph: 'observable',
  });

  const result = await launcher.launch({
    ...contract,
    onSessionEnded(outcome, detail) {
      reported.push({ outcome, detail });
    },
  });
  assert.equal(result.pid, 4242);
  assert.equal(result.morph, 'observable');
  assert.equal(result.sessionEndCapable, true);

  child.stdout.emit(
    'data',
    Buffer.from(
      `${JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: FIXED_SESSION })}\n`,
    ),
  );
  child.emit('close', 0);

  // allow microtask for close handler
  await new Promise((r) => setImmediate(r));
  assert.equal(reported.length, 1);
  assert.equal(reported[0].outcome, 'success');
});

test('createRealLauncher interactive morph: no session-end watcher; not sessionEndCapable', async () => {
  const launcher = createRealLauncher({
    generateSessionId: () => FIXED_SESSION,
    spawnWorker() {
      return { pid: 7 };
    },
  });
  const contract = buildLaunchContract({
    runtime: 'claude',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: {
      id: '03-session-end.md',
      path: '.scratch/demo/issues/03-session-end.md',
    },
    entryClass: 'wayfinder',
    morph: 'interactive',
  });
  const result = await launcher.launch(contract);
  assert.equal(result.morph, 'interactive');
  assert.equal(result.sessionEndCapable, false);
});

test('buildLaunchContract defaults morph to interactive when omitted', () => {
  const contract = buildLaunchContract({
    runtime: 'grok',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: {
      id: '03-session-end.md',
      path: '.scratch/demo/issues/03-session-end.md',
    },
    entryClass: 'impl',
  });
  assert.equal(contract.morph, 'interactive');
});

test('buildLaunchContract preserves explicit morph', () => {
  const contract = buildLaunchContract({
    runtime: 'grok',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: {
      id: '03-session-end.md',
      path: '.scratch/demo/issues/03-session-end.md',
    },
    entryClass: 'impl',
    morph: 'observable',
  });
  assert.equal(contract.morph, 'observable');
});
