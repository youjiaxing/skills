#!/usr/bin/env node
/**
 * Deterministic verifier for Notion single-fetch readback against evidence.json.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isMainModule } from './is-main.mjs';

export function extractNotionImageNames(pageContent) {
  const text = typeof pageContent === 'string' ? pageContent : JSON.stringify(pageContent ?? '');
  const actual = [];
  const pattern = /!\[[^\]]*\]\((notion-file-block:\/\/[^)\s]+|file-upload:\/\/[^)\s]+)\)|"(?:name|filename)"\s*:\s*"([^"]+\.(?:png|jpe?g|webp|gif))"/gi;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) {
      const url = match[1];
      const base = path.basename(url.split('?')[0]);
      actual.push(base);
    } else if (match[2]) {
      actual.push(path.basename(match[2]));
    }
  }
  const pendingNotices = (text.match(/file-upload:\/\/|uploading|upload_pending|正在上传/gi) ?? []).length;
  return { actualImageFilenames: actual, pendingNotices };
}

export function verifyNotionReadback(evidence, pagePayload, { expectedStatus = '已整理', pageId = null } = {}) {
  const errors = [];
  const expectedFiles = (evidence?.visual_coverage?.embedded_files ?? []).map((f) => path.basename(f));
  const pageText = typeof pagePayload === 'string'
    ? pagePayload
    : (pagePayload?.text ?? pagePayload?.content ?? JSON.stringify(pagePayload ?? {}));
  const actualStatus = typeof pagePayload === 'object' && pagePayload !== null
    ? (pagePayload.status ?? pagePayload.properties?.['状态'] ?? pagePayload.properties?.Status ?? null)
    : null;

  const { actualImageFilenames, pendingNotices } = extractNotionImageNames(pagePayload);
  const imagesMatch = actualImageFilenames.length === expectedFiles.length &&
    actualImageFilenames.every((name, idx) => name === expectedFiles[idx]);
  if (!imagesMatch) {
    errors.push(`actual_image_filenames ${JSON.stringify(actualImageFilenames)} != expected ${JSON.stringify(expectedFiles)}`);
  }
  if (pendingNotices > 0) {
    errors.push(`detected ${pendingNotices} pending upload notice(s) in readback`);
  }
  const statusMatched = expectedStatus ? actualStatus === expectedStatus : true;
  if (expectedStatus && !statusMatched) {
    errors.push(`actual status ${JSON.stringify(actualStatus)} != expected ${JSON.stringify(expectedStatus)}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    notion: {
      requested: true,
      ...(pageId ? { page_id: pageId } : {}),
      status: actualStatus ?? expectedStatus ?? null,
      content_readback: Boolean(pageText && pageText.trim().length > 0),
      status_readback: statusMatched,
      pending_image_notices: pendingNotices,
      expected_image_filenames: expectedFiles,
      actual_image_filenames: actualImageFilenames,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const evidencePath = args[0];
  const pagePath = args[1];
  if (!evidencePath || !pagePath) {
    throw new Error('Usage: verify-notion-readback.mjs <evidence.json> <notion-page.json> [--expected-status 已整理] [--page-id ID]');
  }
  const statusIdx = args.indexOf('--expected-status');
  const pageIdIdx = args.indexOf('--page-id');
  const expectedStatus = statusIdx >= 0 ? args[statusIdx + 1] : '已整理';
  const pageId = pageIdIdx >= 0 ? args[pageIdIdx + 1] : null;
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const rawPage = await readFile(pagePath, 'utf8');
  let pagePayload;
  try { pagePayload = JSON.parse(rawPage); } catch { pagePayload = rawPage; }
  const result = verifyNotionReadback(evidence, pagePayload, { expectedStatus, pageId });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.valid) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
