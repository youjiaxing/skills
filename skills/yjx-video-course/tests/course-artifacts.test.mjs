import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

import { validateCourseArtifacts } from '../scripts/validate-course-artifacts.mjs';

const evidence = {
  visual_coverage: {
    embedded_files: [
      'focused/frame-0100-focused.png',
      'focused/frame-1200-focused.png',
    ],
  },
};

test('accepts matching course images and evidence index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yjx-video-course-'));
  const courseFile = path.join(root, 'course.md');
  const evidenceDir = path.join(root, 'evidence');
  await mkdir(path.join(evidenceDir, 'focused'), { recursive: true });
  await writeFile(path.join(evidenceDir, 'focused/frame-0100-focused.png'), '');
  await writeFile(path.join(evidenceDir, 'focused/frame-1200-focused.png'), '');

  const result = await validateCourseArtifacts(
    evidence,
    [
      '![first](evidence/focused/frame-0100-focused.png)',
      '![second](evidence/focused/frame-1200-focused.png)',
    ].join('\n'),
    {
      courseFile,
      evidenceDir,
    },
  );

  assert.deepEqual(result, { valid: true, errors: [] });
});

test('detects a missing image in the course body', async () => {
  const result = await validateCourseArtifacts(
    evidence,
    '![first](evidence/focused/frame-0100-focused.png)',
    {
      courseFile: '/tmp/course.md',
      evidenceDir: '/tmp/evidence',
    },
  );

  assert.equal(result.valid, false);
  assert.match(result.errors[0], /course image count 1/);
  assert.match(result.errors[1], /embedded image mismatch at index 2/);
});

test('accepts a course with no images when no visual evidence is required', async () => {
  const result = await validateCourseArtifacts(
    { visual_coverage: { embedded_files: [] } },
    '# 纯字幕课程\n\n文字证据已足够。',
    {
      courseFile: '/tmp/course.md',
      evidenceDir: '/tmp/evidence',
    },
  );

  assert.deepEqual(result, { valid: true, errors: [] });
});
