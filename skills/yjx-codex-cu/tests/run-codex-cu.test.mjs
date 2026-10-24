import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyResult,
  createObservation,
  exitCodeForStatus,
  isComputerUseItem,
  observeEvent,
} from '../scripts/run-codex-cu.mjs';

test('Computer Use evidence accepts current and semantic tool surfaces', () => {
  assert.equal(isComputerUseItem({ type: 'mcp_tool_call', server: 'cua_repl', tool: 'js' }), true);
  assert.equal(isComputerUseItem({
    type: 'mcp_tool_call',
    server: 'future-ui',
    tool: 'operate',
    metadata: { toolSurface: { kind: 'computerUse' } },
  }), true);
  assert.equal(isComputerUseItem({ type: 'mcp_tool_call', server: 'github', tool: 'search' }), false);
});

test('PASS requires completion, reported pass, and Computer Use evidence', () => {
  const observation = createObservation();
  observeEvent(observation, { type: 'thread.started', thread_id: 'thread-1' });
  observeEvent(observation, {
    type: 'item.completed',
    item: { type: 'mcp_tool_call', server: 'cua_repl', tool: 'js' },
  });
  observeEvent(observation, {
    type: 'item.completed',
    item: { type: 'agent_message', text: 'STATUS: PASS\nThe GUI matched.' },
  });
  observeEvent(observation, { type: 'turn.completed' });

  assert.equal(classifyResult({ exitCode: 0, observation }), 'PASS');
  assert.equal(observation.threadId, 'thread-1');
  assert.equal(observation.computerUseCalls, 1);
});

test('a textual pass without Computer Use evidence is BLOCKED', () => {
  const observation = createObservation();
  observeEvent(observation, {
    type: 'item.completed',
    item: { type: 'agent_message', text: 'STATUS: PASS\nLooks good.' },
  });
  observeEvent(observation, { type: 'turn.completed' });
  assert.equal(classifyResult({ exitCode: 0, observation }), 'BLOCKED');
});

test('a failed Computer Use call cannot satisfy PASS evidence', () => {
  const observation = createObservation();
  observeEvent(observation, {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'cua_repl',
      tool: 'js',
      status: 'failed',
      error: { message: 'permission denied' },
    },
  });
  observeEvent(observation, {
    type: 'item.completed',
    item: { type: 'agent_message', text: 'STATUS: PASS\nLooks good.' },
  });
  observeEvent(observation, { type: 'turn.completed' });

  assert.equal(observation.computerUseCalls, 0);
  assert.equal(observation.computerUseFailedCalls, 1);
  assert.equal(classifyResult({ exitCode: 0, observation }), 'BLOCKED');
});

test('an exercised GUI failure remains FAIL', () => {
  const observation = createObservation();
  observeEvent(observation, {
    type: 'item.completed',
    item: { type: 'mcp_tool_call', server: 'computer-use', tool: 'operate' },
  });
  observeEvent(observation, {
    type: 'item.completed',
    item: { type: 'agent_message', text: 'STATUS: FAIL\nThe value did not update.' },
  });
  observeEvent(observation, { type: 'turn.completed' });
  assert.equal(classifyResult({ exitCode: 0, observation }), 'FAIL');
});

test('status exit codes distinguish PASS, FAIL, and BLOCKED', () => {
  assert.equal(exitCodeForStatus('PASS'), 0);
  assert.equal(exitCodeForStatus('FAIL'), 1);
  assert.equal(exitCodeForStatus('BLOCKED'), 2);
});
