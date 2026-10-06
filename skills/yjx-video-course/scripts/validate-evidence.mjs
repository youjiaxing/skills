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

function fail(errors, message) {
  errors.push(message);
}

export async function validateEvidence(value, rootDir = process.cwd()) {
  const errors = [];
  const source = value?.source;
  if (!source?.source_id) fail(errors, 'source.source_id is required');
  if (!Number.isFinite(source?.duration_seconds) || source.duration_seconds < 0) {
    fail(errors, 'source.duration_seconds must be a non-negative number');
  }
  if (!Array.isArray(value?.segments)) fail(errors, 'segments must be an array');
  if (!Array.isArray(value?.claims)) fail(errors, 'claims must be an array');

  const segmentIds = new Set();
  for (const segment of value?.segments ?? []) {
    if (segmentIds.has(segment.segment_id)) fail(errors, `duplicate segment_id: ${segment.segment_id}`);
    segmentIds.add(segment.segment_id);
    if (!Number.isFinite(segment.time_start) || !Number.isFinite(segment.time_end)
      || segment.time_start < 0 || segment.time_start > segment.time_end
      || segment.time_end > source.duration_seconds) {
      fail(errors, `invalid segment time: ${segment.segment_id}`);
    }
  }

  for (const claim of value?.claims ?? []) {
    for (const segmentId of claim.segment_ids ?? []) {
      if (!segmentIds.has(segmentId)) fail(errors, `claim ${claim.claim_id} references missing segment ${segmentId}`);
    }
  }

  for (const evidence of value?.raw_evidence ?? []) {
    if (!evidence.file) continue;
    if (!await exists(path.join(rootDir, evidence.file))) fail(errors, `missing evidence file: ${evidence.file}`);
  }

  return { valid: errors.length === 0, errors };
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: validate-evidence.mjs <evidence.json> [root-dir]');
  const value = JSON.parse(await readFile(input, 'utf8'));
  const result = await validateEvidence(value, process.argv[3] ?? path.dirname(input));
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
