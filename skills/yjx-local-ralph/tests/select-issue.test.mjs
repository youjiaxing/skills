import assert from 'node:assert/strict';
import test from 'node:test';

import { selectCandidates, selectionPayload } from '../scripts/select-issue.mjs';

function issue(id, overrides = {}) {
  const number = id.split('-')[0];
  return {
    id,
    number,
    title: id,
    closed: false,
    statusRole: 'ready-for-agent',
    metadataValid: true,
    blockedByOpen: [],
    blockedByMissing: [],
    blockedByInvalid: [],
    dependencyCycle: [],
    path: `.scratch/feature/issues/${id}`,
    ...overrides,
  };
}

test('filters exactly the legal agent frontier', () => {
  const payload = {
    issues: [
      issue('01-ready.md'),
      issue('02-closed.md', { closed: true }),
      issue('03-human.md', { statusRole: 'ready-for-human' }),
      issue('04-invalid.md', { metadataValid: false }),
      issue('05-blocked.md', { blockedByOpen: ['01-ready.md'] }),
      issue('06-missing.md', { blockedByMissing: ['99-missing.md'] }),
      issue('07-reference.md', { blockedByInvalid: ['unknown'] }),
      issue('08-cycle.md', { dependencyCycle: ['08-cycle.md'] }),
    ],
  };
  assert.deepEqual(selectCandidates(payload).map((candidate) => candidate.id), ['01-ready.md']);
});

test('recommends the smallest numeric issue then filename', () => {
  const result = selectionPayload({
    feature: 'feature',
    issues: [issue('10-later.md'), issue('02-b.md'), issue('02-a.md')],
    warnings: [],
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['02-a.md', '02-b.md', '10-later.md']);
  assert.equal(result.recommended.id, '02-a.md');
});

test('returns null recommendation when the frontier is empty', () => {
  const result = selectionPayload({ feature: 'feature', issues: [], warnings: [] });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.recommended, null);
});
