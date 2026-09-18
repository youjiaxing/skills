import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CONFIG,
  buildCodexArgs,
  buildPrompt,
  buildSpawnOptions,
  classifyResult,
  createObservation,
  exitCodeForStatus,
  findRollout,
  isComputerUseItem,
  observeEvent,
  parseOptions,
  readStandardInput,
  readTurnContext,
} from '../scripts/run-codex-cu.mjs';

test('defaults to Luna, xhigh, and Fast', () => {
  const options = parseOptions([], { cwd: '/repo', env: {} });
  assert.equal(options.model, DEFAULT_CONFIG.model);
  assert.equal(options.reasoning, DEFAULT_CONFIG.reasoning);
  assert.equal(options.fast, true);
});

test('changing the model disables Fast by default', () => {
  const options = parseOptions(['--model', 'another-model'], { cwd: '/repo', env: {} });
  assert.equal(options.model, 'another-model');
  assert.equal(options.fast, false);
});

test('changing only reasoning preserves Fast', () => {
  const options = parseOptions(['--reasoning', 'high'], { cwd: '/repo', env: {} });
  assert.equal(options.reasoning, 'high');
  assert.equal(options.fast, true);
});

test('explicit Fast overrides model policy', () => {
  const enabled = parseOptions(['--model', 'another-model', '--fast', 'on'], { cwd: '/repo', env: {} });
  const disabled = parseOptions(['--fast', 'off'], { cwd: '/repo', env: {} });
  assert.equal(enabled.fast, true);
  assert.equal(disabled.fast, false);
});

test('Codex arguments carry resolved execution policy', () => {
  const options = parseOptions(['--model', 'another-model'], { cwd: '/repo', env: {} });
  const args = buildCodexArgs(options);
  assert.deepEqual(args.slice(0, 4), ['exec', '--json', '-m', 'another-model']);
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes('service_tier="default"'));
  assert.ok(args.includes('--disable'));
  assert.ok(args.includes('fast_mode'));
  assert.ok(args.includes('danger-full-access'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.equal(args.includes('-C'), false);
  assert.equal(args.at(-1), '-');
});

test('default Codex arguments request Fast', () => {
  const args = buildCodexArgs(parseOptions([], { cwd: '/repo', env: {} }));
  assert.ok(args.includes('service_tier="fast"'));
  assert.ok(args.includes('--enable'));
  assert.ok(args.includes('fast_mode'));
});

test('Windows uses a shell only for command shims', () => {
  const options = parseOptions([], { cwd: 'C:\\repo with spaces', env: {} });
  assert.equal(buildSpawnOptions(options, { platform: 'win32', env: {} }).shell, true);
  assert.equal(buildSpawnOptions({ ...options, codex: 'C:\\Program Files\\Codex\\codex.exe' }, {
    platform: 'win32',
    env: {},
  }).shell, false);
  assert.equal(buildSpawnOptions(options, { platform: 'darwin', env: {} }).shell, false);
  assert.throws(
    () => buildSpawnOptions({ ...options, codex: 'C:\\Program Files\\npm\\codex.cmd' }, {
      platform: 'win32',
      env: {},
    }),
    /put codex on PATH/,
  );
});

test('standard input preserves UTF-8 characters split across chunks', async () => {
  const encoded = Buffer.from('测试 brief 🧪', 'utf8');
  async function* splitInput() {
    yield encoded.subarray(0, 1);
    yield encoded.subarray(1, 5);
    yield encoded.subarray(5);
  }
  assert.equal(await readStandardInput(splitInput()), '测试 brief 🧪');
});

test('prompt stays outcome-oriented and requires a structured result', () => {
  const prompt = buildPrompt('Verify that saving a draft updates the list.');
  assert.match(prompt, /Use Computer Use/);
  assert.match(prompt, /STATUS: PASS/);
  assert.match(prompt, /Verify that saving a draft updates the list/);
  assert.doesNotMatch(prompt, /click the .*button/i);
});

test('prompt scopes the delegated tester and names only this skill as off-limits', () => {
  const prompt = buildPrompt('Verify that saving a draft updates the list.');
  assert.match(prompt, /delegated GUI test agent/);
  assert.match(prompt, /You are responsible for preparing, building, and launching/);
  assert.match(prompt, /You are not responsible for product code/);
  assert.match(prompt, /Do not use the `yjx-codex-cu` skill/);
  assert.match(prompt, /no nested Codex session, subagent, or Computer Use harness/);
  assert.match(prompt, /Never drive a different copy of the same product/);
  assert.match(prompt, /report STATUS: BLOCKED with what you found/);
  assert.doesNotMatch(prompt, /any Agent Skill/i);
  assert.doesNotMatch(prompt, /plugin, or rules file/i);
});

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

test('finds rollout and reads recorded model context', async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'yjx-codex-cu-test-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const sessions = path.join(codexHome, 'sessions');
  const nested = path.join(sessions, '2026', '09', '14');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(nested, { recursive: true }));
  const rollout = path.join(nested, 'rollout-thread-123.jsonl');
  await writeFile(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-123' } }),
    JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-example', effort: 'high' },
    }),
  ].join('\n'));

  const found = await findRollout('thread-123', { codexHome });
  assert.equal(found, rollout);
  assert.deepEqual(await readTurnContext(found), { model: 'gpt-example', reasoning: 'high' });
});

test('invalid or incomplete arguments fail closed', () => {
  assert.throws(() => parseOptions(['--fast', 'maybe']), /on or off/);
  assert.throws(() => parseOptions(['--model']), /requires a value/);
  assert.throws(() => parseOptions(['--unknown']), /unknown option/);
  assert.throws(() => buildPrompt('   '), /brief is required/);
});
