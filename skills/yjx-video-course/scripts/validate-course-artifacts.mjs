#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelative(file) {
  return file.split(path.sep).join('/');
}

function extractLocalImages(courseText) {
  const images = [];
  const pattern = /!\[[^\]]*\]\(([^)\n]+)\)/g;
  for (const match of courseText.matchAll(pattern)) {
    const source = match[1].trim();
    if (
      source
      && !source.startsWith('http://')
      && !source.startsWith('https://')
      && !source.startsWith('file-upload://')
      && !source.startsWith('notion-file-block://')
    ) {
      images.push(source);
    }
  }
  return images;
}

export async function validateCourseArtifacts(evidence, courseText, {
  courseFile,
  evidenceDir,
} = {}) {
  const errors = [];
  const expected = evidence?.visual_coverage?.embedded_files;
  if (!Array.isArray(expected)) {
    errors.push('visual_coverage.embedded_files must be an array');
    return { valid: false, errors };
  }

  const courseImages = extractLocalImages(courseText);
  const expectedNormalized = expected.map(normalizeRelative);
  const courseRelativeToEvidence = courseImages.map((source) => normalizeRelative(
    path.relative(evidenceDir, path.resolve(path.dirname(courseFile), source)),
  ));

  if (courseRelativeToEvidence.length !== expectedNormalized.length) {
    errors.push(
      `course image count ${courseRelativeToEvidence.length} does not match `
      + `visual_coverage.embedded_files count ${expectedNormalized.length}`,
    );
  }

  for (let index = 0; index < Math.max(courseRelativeToEvidence.length, expectedNormalized.length); index += 1) {
    if (courseRelativeToEvidence[index] !== expectedNormalized[index]) {
      errors.push(
        `embedded image mismatch at index ${index + 1}: `
        + `course=${courseRelativeToEvidence[index] ?? '<missing>'}, `
        + `evidence=${expectedNormalized[index] ?? '<missing>'}`,
      );
    }
  }

  for (const relativeFile of expectedNormalized) {
    if (!await exists(path.join(evidenceDir, relativeFile))) {
      errors.push(`missing embedded image file: ${relativeFile}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function main() {
  const [evidenceFile, courseFile, evidenceDirArg] = process.argv.slice(2);
  if (!evidenceFile || !courseFile) {
    throw new Error(
      'Usage: validate-course-artifacts.mjs <evidence.json> <course.md> [evidence-dir]',
    );
  }

  const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
  const courseText = await readFile(courseFile, 'utf8');
  const evidenceDir = path.resolve(
    evidenceDirArg ?? path.dirname(evidenceFile),
  );
  const result = await validateCourseArtifacts(evidence, courseText, {
    courseFile: path.resolve(courseFile),
    evidenceDir,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
