import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTranscript, auditTranscript } from '../scripts/audit-transcript.mjs';

// Wire-protocol fixtures only: no model calls or simulated evaluations of skill behavior.
const lines = (...records) => records.map((record) => JSON.stringify(record)).join('\n');
const codex = (items = []) => lines({ type: 'thread.started' }, { type: 'turn.started' },
  ...items, { type: 'item.completed', item: { type: 'agent_message', text: '21' } }, { type: 'turn.completed' });
const capture = () => ({ provider: 't3', run: { id: 'run-1', status: 'completed' },
  coverage: { complete: true, hasMore: false, totalItems: 2 },
  items: [{ position: 0, runId: 'run-1', type: 'user_message', text: 'payload' },
    { position: 1, runId: 'run-1', type: 'assistant_message', text: '21' }] });

test('Codex final item.text is the answer, not the complete JSON log', () => {
  const result = analyzeTranscript(codex());
  assert.equal(result.answer, '21');
  assert.equal(result.auditStatus, 'clean');
  assert.equal(result.terminalStatus, 'completed');
});
test('startup, unknown JSON, malformed and unterminated streams stay unverified', () => {
  for (const value of ['{"type":"thread.started"}', '{"type":"turn.started"}', '{}',
    codex() + '\nbroken', codex().split('\n').slice(0, -1).join('\n')]) {
    assert.equal(auditTranscript(value).auditStatus, 'unverified');
  }
});
test('explicit partial capture and unknown protocol events cannot pass audit', () => {
  assert.equal(auditTranscript(codex(), { complete: false }).auditStatus, 'unverified');
  assert.equal(auditTranscript(codex([{ type: 'new_wire_event' }])).auditStatus, 'unverified');
});
test('failed terminal is not a completed answer', () => {
  const result = analyzeTranscript(lines({ type: 'thread.started' }, { type: 'turn.failed',
    error: { message: '429' } }));
  assert.equal(result.terminalStatus, 'failed');
  assert.equal(result.answer, '');
});
test('actual command, MCP and search events are violations', () => {
  for (const type of ['command_execution', 'mcp_tool_call', 'web_search']) {
    const result = auditTranscript(codex([{ type: 'item.completed', item: { type } }]));
    assert.equal(result.auditStatus, 'violation');
  }
});
test('tool names in answer text and capability metadata are not calls', () => {
  const result = analyzeTranscript(lines({ type: 'system', subtype: 'init',
    tools: [{ type: 'function', name: 'Read' }] },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'tool_use Read' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'tool_use Read' }));
  assert.equal(result.auditStatus, 'clean');
});
test('Claude tool blocks and web request counters are violations', () => {
  const records = [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: {
    content: [{ type: 'tool_use', name: 'Read' }] } },
  { type: 'result', subtype: 'success', result: '21' }];
  assert.equal(auditTranscript(lines(...records)).auditStatus, 'violation');
  assert.equal(auditTranscript(lines({ type: 'system', subtype: 'init' },
    { type: 'result', subtype: 'success', result: '21', usage: { webSearchRequests: 1 } })).auditStatus, 'violation');
});
test('Gemini stream deltas assemble only assistant output and require result', () => {
  const raw = lines({ type: 'init' }, { type: 'message', role: 'user', content: 'ignored' },
    { type: 'message', role: 'assistant', content: '2', delta: true },
    { type: 'message', role: 'assistant', content: '1', delta: true },
    { type: 'result', status: 'success' });
  assert.equal(analyzeTranscript(raw).answer, '21');
  assert.equal(auditTranscript(raw).auditStatus, 'clean');
});
test('T3 coverage must match run, positions, total, truncation and pagination', () => {
  assert.equal(auditTranscript(capture()).auditStatus, 'clean');
  const mutations = [
    (value) => { value.coverage.complete = false; },
    (value) => { value.coverage.hasMore = true; },
    (value) => { value.coverage.totalItems = 3; },
    (value) => { value.items[1].position = 3; },
    (value) => { value.items[1].runId = 'another-run'; },
    (value) => { value.items[1].textTruncated = true; },
    (value) => { value.items[1].type = 'unknown-event'; },
    (value) => { value.run.status = 'running'; },
  ];
  for (const mutate of mutations) {
    const value = capture(); mutate(value);
    assert.equal(auditTranscript(value).auditStatus, 'unverified');
  }
});
test('T3 actual tool activity remains a violation even with incomplete coverage', () => {
  const value = capture();
  value.items[0].type = 'command_execution';
  value.coverage.complete = false;
  assert.equal(auditTranscript(value).auditStatus, 'violation');
});

test('Claude server-side fetch/search tools and counters cannot evade audit', () => {
  for (const block of [{ type: 'server_tool_use', name: 'web_fetch' }, { type: 'web_fetch_tool_result' }]) {
    assert.equal(auditTranscript(lines({ type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [block] } },
      { type: 'result', subtype: 'success', result: '21' })).auditStatus, 'violation');
  }
  assert.equal(auditTranscript(lines({ type: 'system', subtype: 'init' },
    { type: 'result', subtype: 'success', result: '21', usage: { web_fetch_requests: 1 } })).auditStatus, 'violation');
});

test('unknown Claude content blocks cannot be silently clean', () => {
  assert.equal(auditTranscript(lines({ type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'new_tool_or_content' }] } },
    { type: 'result', subtype: 'success', result: '21' })).auditStatus, 'unverified');
});

test('conflicting and out-of-order terminals are invalid for all CLI protocols', () => {
  const streams = [
    lines({ type: 'thread.started' }, { type: 'turn.started' }, { type: 'turn.failed' },
      { type: 'item.completed', item: { type: 'agent_message', text: '21' } }, { type: 'turn.completed' }),
    lines({ type: 'turn.completed' }, { type: 'thread.started' }, { type: 'turn.started' }),
    lines({ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'error' },
      { type: 'result', subtype: 'success', result: '21' }),
    lines({ type: 'result', status: 'success' }, { type: 'init' }),
  ];
  for (const raw of streams) {
    assert.equal(analyzeTranscript(raw).terminalStatus, 'invalid');
    assert.equal(auditTranscript(raw).auditStatus, 'unverified');
  }
});
