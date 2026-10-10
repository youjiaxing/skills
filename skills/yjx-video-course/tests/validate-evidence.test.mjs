import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

import { validateEvidence } from '../scripts/validate-evidence.mjs';

function baseEvidence(rawEvidence) {
  return {
    source: { source_id: 'bilibili:BV-test:p1', duration_seconds: 60 },
    segments: [{ segment_id: 'seg-1', time_start: 0, time_end: 30 }],
    claims: [{ claim_id: 'claim-1', segment_ids: ['seg-1'] }],
    raw_evidence: rawEvidence,
  };
}

test('accepts a frame with explicit visual increment metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-video-course-evidence-'));
  await mkdir(path.join(root, 'frames'));
  await writeFile(path.join(root, 'frames/frame.png'), '');

  const result = await validateEvidence(baseEvidence([{
    evidence_id: 'frame-1',
    type: 'video_frame',
    file: 'frames/frame.png',
    visual_claim: '画面显示按钮从禁用变为可用',
    knowledge_segment: 'seg-1',
    information_added: '字幕只说明操作成功，画面显示了状态变化',
    why_text_evidence_is_insufficient: '仅靠字幕无法核对界面状态',
    duplicate_of_existing_image: false,
    keep_or_discard_reason: '保留，因为它覆盖了关键状态变化',
  }]), root);

  assert.deepEqual(result, { valid: true, errors: [] });
});

test('rejects a frame without visual increment metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-video-course-evidence-'));
  await mkdir(path.join(root, 'frames'));
  await writeFile(path.join(root, 'frames/frame.png'), '');

  const result = await validateEvidence(baseEvidence([{
    evidence_id: 'frame-1',
    type: 'video_frame',
    file: 'frames/frame.png',
  }]), root);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /visual_claim/.test(error)));
  assert.ok(result.errors.some((error) => /duplicate_of_existing_image/.test(error)));
});

test('rejects a duplicate frame that is still embedded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-video-course-evidence-'));
  await mkdir(path.join(root, 'frames'));
  await writeFile(path.join(root, 'frames/frame.png'), '');

  const result = await validateEvidence(baseEvidence([{
    evidence_id: 'frame-duplicate',
    type: 'video_frame',
    file: 'frames/frame.png',
    embedded_file: 'frames/frame.png',
    visual_claim: '重复画面',
    knowledge_segment: 'seg-1',
    information_added: '无',
    why_text_evidence_is_insufficient: '无',
    duplicate_of_existing_image: true,
    keep_or_discard_reason: '保留备用',
  }]), root);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /must be discarded/.test(error)));
});
