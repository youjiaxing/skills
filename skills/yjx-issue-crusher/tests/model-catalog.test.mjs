/**
 * 20260804-1802-tui-model-effort / 03 — model discovery port + effort hints.
 *
 * Seams:
 * 1. resolveModelItems — injectable discoverer; Grok fail/timeout degrades
 * 2. defaultEffortItems — 运行时默认 + Claude public levels (passthrough strings)
 * 3. parseGrokModelsOutput — pure parse of `grok models` stdout
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGrokModelsDiscoverer,
  defaultEffortItems,
  parseGrokModelsOutput,
  resolveModelItems,
  RUNTIME_DEFAULT_ITEM,
} from '../scripts/model-catalog.mjs';

const SAMPLE_GROK_MODELS = `You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - api-grok-4-5
  - dc-gpt-5-6-sol
  - or-dp-flash
`;

test('parseGrokModelsOutput extracts ids from grok models listing', () => {
  const ids = parseGrokModelsOutput(SAMPLE_GROK_MODELS);
  assert.deepEqual(ids, [
    'grok-4.5',
    'api-grok-4-5',
    'dc-gpt-5-6-sol',
    'or-dp-flash',
  ]);
});

test('parseGrokModelsOutput tolerates empty / garbage output', () => {
  assert.deepEqual(parseGrokModelsOutput(''), []);
  assert.deepEqual(parseGrokModelsOutput(null), []);
  assert.deepEqual(parseGrokModelsOutput('not a list\nhello'), []);
});

test('resolveModelItems: Claude is static aliases + 运行时默认', async () => {
  const items = await resolveModelItems({ runtime: 'claude' });
  assert.equal(items[0].value, null);
  assert.match(items[0].label, /运行时默认/);
  const values = items.slice(1).map((item) => item.value);
  assert.ok(values.includes('sonnet'));
  assert.ok(values.includes('opus'));
  assert.ok(values.includes('haiku'));
  // No discoverer required for Claude.
});

test('resolveModelItems: Grok injects discoverer results after 运行时默认', async () => {
  const items = await resolveModelItems({
    runtime: 'grok',
    discoverModels: async () => ['grok-4.5', 'api-grok-4-5'],
  });
  assert.deepEqual(items[0], RUNTIME_DEFAULT_ITEM);
  assert.deepEqual(
    items.slice(1).map((item) => item.value),
    ['grok-4.5', 'api-grok-4-5'],
  );
});

test('resolveModelItems: Grok discoverer failure degrades to 运行时默认 only', async () => {
  const items = await resolveModelItems({
    runtime: 'grok',
    discoverModels: async () => {
      throw new Error('not logged in');
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].value, null);
  assert.match(items[0].label, /运行时默认/);
});

test('resolveModelItems: Grok discoverer timeout degrades without hanging', async () => {
  const started = Date.now();
  const items = await resolveModelItems({
    runtime: 'grok',
    timeoutMs: 40,
    discoverModels: () => new Promise(() => {
      // never resolves
    }),
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `discovery hang risk: ${elapsed}ms`);
  assert.equal(items.length, 1);
  assert.equal(items[0].value, null);
});

test('resolveModelItems: empty discoverer result degrades to 运行时默认 only', async () => {
  const items = await resolveModelItems({
    runtime: 'grok',
    discoverModels: async () => [],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].value, null);
});

test('resolveModelItems: dedupes and skips blank discoverer ids', async () => {
  const items = await resolveModelItems({
    runtime: 'grok',
    discoverModels: async () => ['grok-4', '  ', 'grok-4', null, 'api-x'],
  });
  assert.deepEqual(
    items.map((item) => item.value),
    [null, 'grok-4', 'api-x'],
  );
});

test('defaultEffortItems: 运行时默认 + Claude public levels as passthrough strings', () => {
  const items = defaultEffortItems();
  assert.equal(items[0].value, null);
  assert.match(items[0].label, /运行时默认/);
  const values = items.slice(1).map((item) => item.value);
  assert.deepEqual(values, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('createGrokModelsDiscoverer: uses runCommand and parses stdout', async () => {
  const calls = [];
  const discover = createGrokModelsDiscoverer({
    timeoutMs: 1000,
    runCommand: async (spec) => {
      calls.push(spec);
      return { stdout: SAMPLE_GROK_MODELS, stderr: '', code: 0 };
    },
  });
  const ids = await discover();
  assert.deepEqual(ids, [
    'grok-4.5',
    'api-grok-4-5',
    'dc-gpt-5-6-sol',
    'or-dp-flash',
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'grok');
  assert.deepEqual(calls[0].args, ['models']);
});

test('createGrokModelsDiscoverer: non-zero exit yields empty list (caller degrades)', async () => {
  const discover = createGrokModelsDiscoverer({
    runCommand: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
  });
  assert.deepEqual(await discover(), []);
});
