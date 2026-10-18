import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateDelivery,
} from '../scripts/validate-delivery.mjs';

const baseManifest = {
  source_id: 'bilibili:BV-test:p=57',
  episode_id: '57',
  state: 'readback_verified',
  state_history: [
    { state: 'source_verified', at: '2026-10-09T10:00:00Z' },
    { state: 'evidence_ready', at: '2026-10-09T10:10:00Z' },
    { state: 'draft_audited', at: '2026-10-09T10:20:00Z' },
    { state: 'external_write', at: '2026-10-09T10:30:00Z' },
    { state: 'readback_verified', at: '2026-10-09T10:40:00Z' },
  ],
  audit: { method: 'independent_subagent', result: 'pass', at: '2026-10-09T10:20:00Z' },
  notion: {
    requested: true,
    page_id: 'page-57',
    content_readback: true,
    status_readback: true,
    pending_image_notices: 0,
    expected_image_filenames: ['frame-01.png', 'frame-02.png'],
    actual_image_filenames: ['frame-01.png', 'frame-02.png'],
  },
};

test('accepts a resumable manifest with monotonic state and matching Notion readback', async () => {
  const result = await validateDelivery(baseManifest);
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('rejects state regression and mismatched Notion images', async () => {
  const result = await validateDelivery({
    ...baseManifest,
    state_history: [
      { state: 'source_verified' },
      { state: 'draft_audited' },
      { state: 'evidence_ready' },
      { state: 'readback_verified' },
    ],
    state: 'readback_verified',
    notion: {
      ...baseManifest.notion,
      actual_image_filenames: ['frame-02.png', 'frame-01.png'],
    },
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /regresses/.test(error)));
  assert.ok(result.errors.some((error) => /filenames/.test(error)));
});

test('rejects credential-like data in failure events', async () => {
  const result = await validateDelivery({
    ...baseManifest,
    events: [
      { type: 'upload_failed', detail: 'Authorization: Bearer secret-value' },
    ],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /credential-like/.test(error)));
});

test('does not require Notion fields for a local-only completed course', async () => {
  const result = await validateDelivery({
    source_id: 'youtube:video-test',
    episode_id: 'single',
    state: 'completed',
    state_history: [
      { state: 'source_verified' },
      { state: 'evidence_ready' },
      { state: 'draft_audited' },
      { state: 'completed' },
    ],
    audit: {
      method: 'current_agent_review',
      reason: 'host has no subagent support',
      result: 'pass',
    },
    notion: { requested: false },
  });

  assert.deepEqual(result, { valid: true, errors: [] });
});

test('requires an audit record at or after draft_audited', async () => {
  const { audit, ...withoutAudit } = baseManifest;
  const result = await validateDelivery(withoutAudit);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /audit is required/.test(error)));
});

test('rejects an unknown audit method, a failing result, and current_agent_review without reason', async () => {
  const unknown = await validateDelivery({ ...baseManifest, audit: { method: 'self', result: 'pass' } });
  assert.ok(unknown.errors.some((error) => /audit.method/.test(error)));
  const failing = await validateDelivery({ ...baseManifest, audit: { method: 'independent_subagent', result: 'blocked' } });
  assert.ok(failing.errors.some((error) => /audit.result/.test(error)));
  const noReason = await validateDelivery({ ...baseManifest, audit: { method: 'current_agent_review', result: 'pass' } });
  assert.ok(noReason.errors.some((error) => /audit.reason/.test(error)));
});

test('does not require an audit record before draft_audited', async () => {
  const result = await validateDelivery({
    source_id: 's',
    episode_id: '1',
    state: 'evidence_ready',
    state_history: [{ state: 'source_verified' }, { state: 'evidence_ready' }],
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});
