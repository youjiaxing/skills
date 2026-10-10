#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const DELIVERY_STATES = [
  'source_verified',
  'evidence_ready',
  'draft_audited',
  'external_write',
  'readback_verified',
  'completed',
];

const STATE_INDEX = new Map(DELIVERY_STATES.map((state, index) => [state, index]));

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function addError(errors, message) {
  errors.push(message);
}

function containsCredential(value) {
  if (typeof value !== 'string') return false;
  return /bearer\s+[A-Za-z0-9._~+/=-]+|\/file_uploads\/[^/]+\/send|signature\s*[:=]|authorization\s*[:=]/i.test(value);
}

function arraysMatch(actual, expected) {
  return Array.isArray(actual)
    && Array.isArray(expected)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export async function validateDelivery(manifest, { rootDir = process.cwd() } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be an object'] };
  }

  for (const field of ['source_id', 'episode_id', 'state']) {
    if (typeof manifest[field] !== 'string' || !manifest[field]) {
      addError(errors, `${field} is required`);
    }
  }

  if (!STATE_INDEX.has(manifest.state)) {
    addError(errors, `unknown state: ${manifest.state}`);
  }

  const history = manifest.state_history;
  if (!Array.isArray(history) || history.length === 0) {
    addError(errors, 'state_history must be a non-empty array');
  } else {
    let previousIndex = -1;
    for (const [index, entry] of history.entries()) {
      if (!STATE_INDEX.has(entry?.state)) {
        addError(errors, `state_history[${index}].state is invalid`);
        continue;
      }
      const currentIndex = STATE_INDEX.get(entry.state);
      if (currentIndex < previousIndex) {
        addError(errors, `state_history regresses at index ${index}`);
      }
      previousIndex = currentIndex;
    }
    if (history.at(-1)?.state !== manifest.state) {
      addError(errors, 'state must equal the last state_history entry');
    }
  }

  if (manifest.evidence_file) {
    const evidenceFile = path.resolve(rootDir, manifest.evidence_file);
    if (!await exists(evidenceFile)) addError(errors, `missing evidence_file: ${manifest.evidence_file}`);
  }
  if (manifest.course_file) {
    const courseFile = path.resolve(rootDir, manifest.course_file);
    if (!await exists(courseFile)) addError(errors, `missing course_file: ${manifest.course_file}`);
  }

  const notion = manifest.notion;
  if (notion?.requested === true) {
    const currentIndex = STATE_INDEX.get(manifest.state);
    if (currentIndex >= STATE_INDEX.get('external_write')
      && typeof notion.page_id !== 'string') {
      addError(errors, 'notion.page_id is required after external_write');
    }
    if (currentIndex >= STATE_INDEX.get('readback_verified')) {
      if (notion.content_readback !== true) addError(errors, 'notion.content_readback must be true');
      if (notion.status_readback !== true) addError(errors, 'notion.status_readback must be true');
      if (notion.pending_image_notices !== 0) addError(errors, 'notion.pending_image_notices must be 0');
      if (!arraysMatch(notion.actual_image_filenames, notion.expected_image_filenames)) {
        addError(errors, 'Notion image filenames do not match expected order');
      }
    }
    if (manifest.state === 'completed' && typeof notion.status !== 'string') {
      addError(errors, 'notion.status is required for completed delivery');
    }
  }

  for (const [index, event] of (manifest.events ?? []).entries()) {
    if (containsCredential(JSON.stringify(event))) {
      addError(errors, `events[${index}] contains credential-like data`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function main() {
  const manifestFile = process.argv[2];
  if (!manifestFile) throw new Error('Usage: validate-delivery.mjs <delivery.json> [root-dir]');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const result = await validateDelivery(manifest, {
    rootDir: path.resolve(process.argv[3] ?? path.dirname(manifestFile)),
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
