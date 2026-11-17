#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { isMainModule } from './is-main.mjs';
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

function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, idx) => buffer[idx] === b)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function checkPngFile(filePath, declaredSize, label, errors, { checkMinHeight = false } = {}) {
  let buf;
  try {
    buf = await readFile(filePath);
  } catch {
    fail(errors, `missing evidence file: ${label}`);
    return;
  }
  if (path.extname(filePath).toLowerCase() === '.png') {
    const dims = readPngDimensions(buf);
    if (!dims || dims.width <= 0 || dims.height <= 0) {
      fail(errors, `invalid PNG header in ${label}`);
      return;
    }
    if (declaredSize && Number.isFinite(declaredSize.width) && Number.isFinite(declaredSize.height)) {
      if (dims.width !== declaredSize.width || dims.height !== declaredSize.height) {
        fail(errors, `PNG dimensions mismatch for ${label}: actual ${dims.width}x${dims.height} != declared ${declaredSize.width}x${declaredSize.height}`);
      }
    }
    if (checkMinHeight && dims.height < 720) {
      fail(errors, `kept PNG ${label} height ${dims.height}px is below 720px minimum`);
    }
  }
}

export async function validateEvidence(value, rootDir = process.cwd(), { allowLegacyMissingDisposition = false } = {}) {
  const errors = [];
  const warnings = [];
  const source = value?.source;
  if (!source?.source_id) fail(errors, 'source.source_id is required');
  if (!Number.isFinite(source?.duration_seconds) || source.duration_seconds < 0) {
    fail(errors, 'source.duration_seconds must be a non-negative number');
  }
  if (!Array.isArray(value?.segments)) fail(errors, 'segments must be an array');
  if (!Array.isArray(value?.claims)) fail(errors, 'claims must be an array');

  const evidenceIds = new Set();
  const keptEmbeddedFiles = new Set();
  for (const evidence of value?.raw_evidence ?? []) {
    if (typeof evidence?.evidence_id !== 'string' || !evidence.evidence_id.trim()) {
      fail(errors, 'raw_evidence item requires evidence_id');
      continue;
    }
    if (evidenceIds.has(evidence.evidence_id)) {
      fail(errors, `duplicate evidence_id: ${evidence.evidence_id}`);
    }
    evidenceIds.add(evidence.evidence_id);
    if (evidence.time_start !== undefined || evidence.time_end !== undefined) {
      if (
        !Number.isFinite(evidence.time_start) ||
        !Number.isFinite(evidence.time_end) ||
        evidence.time_start < 0 ||
        evidence.time_start > evidence.time_end ||
        (Number.isFinite(source?.duration_seconds) && evidence.time_end > source.duration_seconds)
      ) {
        fail(errors, `invalid evidence time bounds: ${evidence.evidence_id}`);
      }
    }
  }

  const segmentIds = new Set();
  for (const segment of value?.segments ?? []) {
    if (segmentIds.has(segment.segment_id)) fail(errors, `duplicate segment_id: ${segment.segment_id}`);
    segmentIds.add(segment.segment_id);
    if (!Number.isFinite(segment.time_start) || !Number.isFinite(segment.time_end)
      || segment.time_start < 0 || segment.time_start > segment.time_end
      || segment.time_end > source.duration_seconds) {
      fail(errors, `invalid segment time: ${segment.segment_id}`);
    }
    if (Array.isArray(segment.evidence) && evidenceIds.size > 0) {
      for (const ref of segment.evidence) {
        if (typeof ref === 'string' && !evidenceIds.has(ref)) {
          fail(errors, `segment ${segment.segment_id} references missing evidence ${ref}`);
        }
      }
    }
  }

  for (const claim of value?.claims ?? []) {
    for (const segmentId of claim.segment_ids ?? []) {
      if (!segmentIds.has(segmentId)) fail(errors, `claim ${claim.claim_id} references missing segment ${segmentId}`);
    }
    if (Array.isArray(claim.evidence_ids) && evidenceIds.size > 0) {
      for (const ref of claim.evidence_ids) {
        if (!evidenceIds.has(ref)) fail(errors, `claim ${claim.claim_id} references missing evidence ${ref}`);
      }
    }
  }

  for (const evidence of value?.raw_evidence ?? []) {
    if (evidence.type === 'video_frame') {
      for (const field of [
        'visual_claim',
        'knowledge_segment',
        'information_added',
        'why_text_evidence_is_insufficient',
        'keep_or_discard_reason',
      ]) {
        if (typeof evidence[field] !== 'string' || evidence[field].trim() === '') {
          fail(errors, `video_frame ${evidence.evidence_id} requires ${field}`);
        }
      }
      if (typeof evidence.duplicate_of_existing_image !== 'boolean') {
        fail(errors, `video_frame ${evidence.evidence_id} requires boolean duplicate_of_existing_image`);
      }
      const hasDisposition = evidence.disposition !== undefined && evidence.disposition !== null;
      if (!hasDisposition) {
        if (allowLegacyMissingDisposition) {
          warnings.push(`legacy_missing_disposition: ${evidence.evidence_id}`);
        } else {
          fail(errors, `video_frame ${evidence.evidence_id} requires explicit disposition ("keep" or "discard"); legacy drafts without disposition are not inferred from prose`);
        }
      } else if (!['keep', 'discard'].includes(evidence.disposition)) {
        fail(errors, `video_frame ${evidence.evidence_id} disposition must be "keep" or "discard"`);
      }
      if (evidence.disposition === 'discard' && evidence.embedded_file) {
        fail(errors, `discarded video_frame ${evidence.evidence_id} must not set embedded_file`);
      }
      if (evidence.duplicate_of_existing_image === true && (evidence.embedded_file || (hasDisposition && evidence.disposition !== 'discard'))) {
        fail(errors, `duplicate video_frame ${evidence.evidence_id} must have disposition "discard" and no embedded_file`);
      }
      if (evidence.disposition === 'keep' && evidence.embedded_file) {
        keptEmbeddedFiles.add(evidence.embedded_file.split(path.sep).join('/'));
      }
    }
    if (evidence.file) {
      const full = path.join(rootDir, evidence.file);
      await checkPngFile(full, evidence.decoded_frame_size ?? null, evidence.file, errors);
    }
    if (evidence.embedded_file) {
      const fullEmbedded = path.join(rootDir, evidence.embedded_file);
      await checkPngFile(fullEmbedded, evidence.final_image_size ?? null, evidence.embedded_file, errors, {
        checkMinHeight: evidence.disposition === 'keep' && Boolean(evidence.enforce_min_height),
      });
    }
  }

  const embeddedFiles = value?.visual_coverage?.embedded_files;
  if (Array.isArray(embeddedFiles)) {
    for (const file of embeddedFiles) {
      const normalized = String(file).split(path.sep).join('/');
      if (!await exists(path.join(rootDir, normalized))) {
        fail(errors, `missing visual_coverage embedded file: ${normalized}`);
      }
      if (keptEmbeddedFiles.size > 0 && !keptEmbeddedFiles.has(normalized)) {
        fail(errors, `visual_coverage.embedded_files entry ${normalized} has no matching kept video_frame embedded_file`);
      }
    }
  }

  return { valid: errors.length === 0, errors, ...(warnings.length ? { warnings } : {}) };
}

async function main() {
  const args = process.argv.slice(2);
  const allowLegacy = args.includes('--allow-legacy-missing-disposition');
  const positional = args.filter((a) => a !== '--allow-legacy-missing-disposition');
  const input = positional[0];
  if (!input) throw new Error('Usage: validate-evidence.mjs <evidence.json> [root-dir] [--allow-legacy-missing-disposition]');
  const value = JSON.parse(await readFile(input, 'utf8'));
  const result = await validateEvidence(value, positional[1] ?? path.dirname(input), { allowLegacyMissingDisposition: allowLegacy });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
