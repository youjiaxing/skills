import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveFeatureOrPrompt,
  resolveRuntimeOrPrompt,
} from '../scripts/interactive-prompts.mjs';
import { resolveChainRuntime } from '../scripts/cli.mjs';

test('resolveChainRuntime: no longer silent-defaults to grok for real chain', () => {
  assert.equal(resolveChainRuntime({}), null);
  assert.equal(resolveChainRuntime({ fakeLauncher: true }), 'grok');
  assert.equal(resolveChainRuntime({ flagRuntime: 'claude' }), 'claude');
  assert.equal(resolveChainRuntime({ repoRuntime: 'claude' }), 'claude');
});

test('resolveRuntimeOrPrompt asks when missing', async () => {
  const runtime = await resolveRuntimeOrPrompt({
    ask: async () => '2',
    output: { write() {} },
  });
  assert.equal(runtime, 'claude');
});

test('resolveRuntimeOrPrompt uses flag over ask', async () => {
  let asked = false;
  const runtime = await resolveRuntimeOrPrompt({
    flagRuntime: 'grok',
    ask: async () => {
      asked = true;
      return '2';
    },
  });
  assert.equal(runtime, 'grok');
  assert.equal(asked, false);
});

test('resolveRuntimeOrPrompt nonInteractive without value throws', async () => {
  await assert.rejects(
    () => resolveRuntimeOrPrompt({ nonInteractive: true }),
    /runtime/,
  );
});

test('resolveFeatureOrPrompt picks single feature without ask', async () => {
  const feature = await resolveFeatureOrPrompt({
    projectRoot: '/tmp',
    listFeatures: async () => ['only-one'],
  });
  assert.equal(feature, 'only-one');
});

test('resolveFeatureOrPrompt interactive number select', async () => {
  const feature = await resolveFeatureOrPrompt({
    projectRoot: '/tmp',
    listFeatures: async () => ['alpha', 'beta'],
    ask: async () => '2',
    output: { write() {} },
  });
  assert.equal(feature, 'beta');
});

test('resolveFeatureOrPrompt interactive name select', async () => {
  const feature = await resolveFeatureOrPrompt({
    projectRoot: '/tmp',
    listFeatures: async () => ['alpha', 'beta'],
    ask: async () => 'alpha',
    output: { write() {} },
  });
  assert.equal(feature, 'alpha');
});
