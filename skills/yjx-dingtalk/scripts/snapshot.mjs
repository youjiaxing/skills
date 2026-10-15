import fs from 'node:fs';
import path from 'node:path';
import { decryptPages, PAGE_SIZE, resolveDatabaseKey } from './crypto-v3.mjs';
import { applyFrames, readFrames, readWalHeader } from './wal.mjs';

const DEFAULT_ATTEMPTS = 3;

/**
 * Source files must be opened without exclusive access so a running client keeps
 * working. Nothing here writes to, locks, or reopens the source for output.
 */
function readShared(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const chunk = fs.readSync(fd, buffer, read, size - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function sourceIdentity(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev };
  } catch {
    return { exists: false };
  }
}

function sameIdentity(left, right) {
  return left.exists === right.exists && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ino === right.ino && left.dev === right.dev;
}

/**
 * A run is stable when the source files carry the same identity before and after
 * the copy. This does not prove an atomic single-instant snapshot, and the code
 * never claims one: it only reports that no change was observed during the read.
 */
function copyOnce(dbPath) {
  const walPath = dbPath + '-wal';
  const before = { db: sourceIdentity(dbPath), wal: sourceIdentity(walPath) };
  const mainImage = readShared(dbPath);
  const walImage = before.wal.exists ? readShared(walPath) : null;
  const after = { db: sourceIdentity(dbPath), wal: sourceIdentity(walPath) };
  const stable = sameIdentity(before.db, after.db) && sameIdentity(before.wal, after.wal);
  return { mainImage, walImage, before, after, stable };
}

/**
 * Acquire a decrypted, WAL-merged image of the account database into memory. The
 * caller decides where (if anywhere) to persist it; this module writes nothing.
 */
export function acquireSnapshot({ account, dataRoot, attempts = DEFAULT_ATTEMPTS }) {
  if (!fs.existsSync(account.dbPath)) {
    throw new Error('database not found for account ' + account.id + ': ' + account.dbPath);
  }
  const notes = [];
  let lastFailure = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const copied = copyOnce(account.dbPath);
    if (!copied.stable) {
      notes.push('attempt ' + attempt + ': source changed during read, retrying');
      lastFailure = 'source files changed during read';
      copied.mainImage.fill(0);
      if (copied.walImage) copied.walImage.fill(0);
      continue;
    }
    const { key, uid } = resolveDatabaseKey({ dataRoot, accountDir: account.dir, dbPath: account.dbPath });
    let image = decryptPages(copied.mainImage, key);
    let walReport = { frames: 0, applied: 0, lastCommitIndex: -1, committedPageCount: image.length / PAGE_SIZE, truncatedBytes: 0, invalidAt: -1, reason: null, header: null };
    if (copied.walImage && copied.walImage.length >= 32) {
      try {
        const header = readWalHeader(copied.walImage);
        const walk = readFrames(copied.walImage, header);
        const committedBytes = walk.committedPageCount * header.pageSize;
        if (committedBytes > image.length) image = Buffer.concat([image, Buffer.alloc(committedBytes - image.length)]);
        const merged = applyFrames(image, decryptWalPages(copied.walImage, walk.frames, header, key), header, walk.frames, walk.lastCommitIndex);
        image = merged.image;
        walReport = {
          frames: walk.frames.length,
          applied: merged.applied,
          skipped: merged.skipped,
          lastCommitIndex: walk.lastCommitIndex,
          committedPageCount: walk.committedPageCount,
          truncatedBytes: walk.truncatedBytes,
          invalidAt: walk.invalidAt,
          reason: walk.reason,
          header: {
            magic: header.magic,
            version: header.version,
            pageSize: header.pageSize,
            checkpointSequence: header.checkpointSequence,
            headerChecksumValid: header.headerChecksumValid,
          },
        };
        if (!header.headerChecksumValid) {
          lastFailure = 'WAL header checksum mismatch';
          notes.push('attempt ' + attempt + ': ' + lastFailure + ', not publishing');
          key.fill(0);
          copied.mainImage.fill(0);
          copied.walImage.fill(0);
          image.fill(0);
          continue;
        }
        if (walk.invalidAt >= 0) {
          notes.push('attempt ' + attempt + ': WAL invalid at frame ' + walk.invalidAt + ' (' + walk.reason + '); merging only the last valid commit');
        }
      } catch (error) {
        lastFailure = 'WAL could not be validated: ' + error.message;
        notes.push('attempt ' + attempt + ': ' + lastFailure + ', not publishing');
        key.fill(0);
        copied.mainImage.fill(0);
        copied.walImage.fill(0);
        image.fill(0);
        continue;
      }
    }
    key.fill(0);
    copied.mainImage.fill(0);
    if (copied.walImage) copied.walImage.fill(0);
    return { image, uid, attemptsUsed: attempt, notes, walReport, copiedAt: Date.now() };
  }
  throw new Error('could not produce a reliable copy after ' + attempts + ' attempt(s): ' + (lastFailure ?? 'unknown failure'));
}

/** Decrypt only the WAL page images needed for the merge, in place on a copy. */
function decryptWalPages(walImage, frames, header, key) {
  const output = Buffer.from(walImage);
  for (const frame of frames) {
    const page = decryptPages(walImage.subarray(frame.offset, frame.offset + header.pageSize), key);
    page.copy(output, frame.offset);
    page.fill(0);
  }
  return output;
}

export { readShared, sourceIdentity, DEFAULT_ATTEMPTS };
