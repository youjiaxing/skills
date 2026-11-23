import assert from 'node:assert/strict';
import test from 'node:test';
import { safeFailure, safeMetadata } from '../scripts/safe-output.mjs';

test('diagnostics cannot forward credential fields, nested config, URL auth or query', () => {
  const value = { provider: 'codex', model: 'openrouter/free', supported: true,
    base_url: 'https://user:secret@example.com/private-token?q=api-key#password',
    MYSQL_PASS: 'never-output', env: { API_KEY: 'never-output' }, error: 'never-output' };
  assert.deepEqual(safeMetadata(value), { provider: 'codex', model: 'openrouter/free',
    supported: true, origin: 'https://example.com' });
});
test('arbitrary exception text is not a diagnostic code', () => {
  const result = safeFailure('connection failed: bearer private-token', { password: 'private-token' });
  assert.deepEqual(result, { code: 'unknown_failure' });
  assert.deepEqual(safeMetadata({ base_url: 'invalid-secret-url' }), {});
});
