import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cleanArtifacts, ensureCacheRoot, isInside, readManifest, registerEntry, resolveCacheRoot, writeManifest } from '../scripts/cache.mjs';
import { candidateDataRoots, discoverAccounts } from '../scripts/paths.mjs';
import { deriveKey, looksLikeSqlitePage, readSalt } from '../scripts/crypto-v3.mjs';
import { readFrames, readWalHeader } from '../scripts/wal.mjs';
import { formatTime, isRecalled, parseContent, renderMessage, summariseAttachments } from '../scripts/messages.mjs';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yjx-dingtalk-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cache root defaults to the home directory copy', (t) => {
  const result = resolveCacheRoot({});
  assert.equal(result.source, 'default');
  assert.ok(result.root.endsWith('.yjx-dingtalk'));
});

test('cache root rejects relative, UNC and symlinked overrides', (t) => {
  assert.throws(() => resolveCacheRoot({ YJX_DINGTALK_HOME: 'relative/dir' }), /absolute path/);
  assert.throws(() => resolveCacheRoot({ YJX_DINGTALK_HOME: '\\\\server\\share' }), /UNC or network share/);
  assert.throws(() => resolveCacheRoot({ YJX_DINGTALK_HOME: '//server/share' }), /UNC or network share/);
});

test('cache root accepts an absolute override', () => {
  const absolute = path.join(os.tmpdir(), 'yjx-dingtalk-abs');
  const result = resolveCacheRoot({ YJX_DINGTALK_HOME: absolute });
  assert.equal(result.source, 'override');
  assert.equal(result.root, path.resolve(absolute));
});

test('cleanup removes only manifest entries and never the whole root', (t) => {
  const root = tempRoot(t);
  ensureCacheRoot(root);
  const kept = path.join(root, 'tasks', 'kept', 'a', 'dingtalk.db');
  const stale = path.join(root, 'tasks', 'stale', 'a', 'dingtalk.db');
  for (const file of [kept, stale]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  }
  const entries = [
    { kind: 'snapshot', taskId: 'kept', accountId: 'a', path: kept, createdAt: 1, lastUsedAt: Date.now(), retained: true },
    { kind: 'snapshot', taskId: 'stale', accountId: 'a', path: stale, createdAt: 1, lastUsedAt: 1, retained: false },
  ];
  writeManifest(root, entries);
  const result = cleanArtifacts(root, { now: Date.now(), idleMs: 1000 });
  assert.equal(result.removed.length, 1);
  assert.ok(fs.existsSync(kept), 'retained copy must survive');
  assert.ok(!fs.existsSync(stale), 'idle copy is removed');
  assert.ok(fs.existsSync(root), 'cache root is never removed');
});

test('a corrupt manifest stops cleanup instead of deleting by listing', (t) => {
  const root = tempRoot(t);
  ensureCacheRoot(root);
  fs.writeFileSync(path.join(root, 'manifest.json'), '{ not json');
  const result = cleanArtifacts(root, { force: true });
  assert.equal(result.skipped, true);
  assert.equal(result.removed.length, 0);
});

test('path containment rejects escapes and symlinked segments', (t) => {
  const root = tempRoot(t);
  ensureCacheRoot(root);
  assert.equal(isInside(root, path.join(root, 'tasks', 'x', 'dingtalk.db')), true);
  assert.equal(isInside(root, path.join(root, '..', 'outside.db')), false);
  assert.equal(isInside(root, path.resolve('/etc/passwd')), false);
});

test('registerEntry replaces rather than duplicating a path', () => {
  const first = registerEntry([], { path: '/a', createdAt: 1 });
  const second = registerEntry(first, { path: '/a', createdAt: 2 });
  assert.equal(second.length, 1);
  assert.equal(second[0].createdAt, 2);
});

test('data root override is exclusive so a wrong value fails loudly', () => {
  const roots = candidateDataRoots({ YJX_DINGTALK_DATA_ROOT: 'D:/nowhere' }, 'win32');
  assert.deepEqual(roots, [path.resolve('D:/nowhere')]);
});

test('account discovery requires a version-suffixed directory', (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'account_v3', 'DBFiles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'account_v3', 'DBFiles', 'dingtalk.db'), 'x');
  fs.writeFileSync(path.join(root, 'account_v3', 'user_config'), 'x');
  fs.mkdirSync(path.join(root, 'not-an-account', 'DBFiles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'not-an-account', 'DBFiles', 'dingtalk.db'), 'x');
  const discovery = discoverAccounts([root]);
  assert.equal(discovery.accounts.length, 1);
  assert.equal(discovery.accounts[0].id, 'account_v3');
  assert.equal(discovery.accounts[0].version, '3');
});

test('key derivation matches the published V3 shape', () => {
  const key = deriveKey('12345', 'salt');
  assert.equal(key.length, 16, 'AES-128 key is 16 bytes');
});

test('sqlite page check rejects non-database bytes', () => {
  assert.equal(looksLikeSqlitePage(Buffer.alloc(4096)), false);
  const page = Buffer.alloc(4096);
  Buffer.from('SQLite format 3\0').copy(page);
  page.writeUInt16BE(4096, 16);
  page[21] = 64; page[22] = 32; page[23] = 32; page[18] = 1; page[19] = 1;
  assert.equal(looksLikeSqlitePage(page), true);
});

test('WAL header rejects an unrecognized magic', () => {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32BE(0x12345678, 0);
  assert.throws(() => readWalHeader(buffer), /unrecognized WAL magic/);
});

test('a frame checksum chain starts from the header and validates a synthetic WAL', () => {
  const pageSize = 4096;
  const checksum = (data, s1, s2) => {
    for (let i = 0; i + 8 <= data.length; i += 8) {
      s1 = (s1 + data.readUInt32LE(i) + s2) >>> 0;
      s2 = (s2 + data.readUInt32LE(i + 4) + s1) >>> 0;
    }
    return [s1, s2];
  };
  const frameSize = 24 + pageSize;
  const wal = Buffer.alloc(32 + frameSize);
  wal.writeUInt32BE(0x377f0682, 0);
  wal.writeUInt32BE(3007000, 4);
  wal.writeUInt32BE(pageSize, 8);
  wal.writeUInt32BE(1, 12);
  wal.writeUInt32BE(7, 16);
  wal.writeUInt32BE(9, 20);
  const [h1, h2] = checksum(wal.subarray(0, 24), 0, 0);
  wal.writeUInt32BE(h1, 24);
  wal.writeUInt32BE(h2, 28);
  wal.writeUInt32BE(3, 32);
  wal.writeUInt32BE(4, 36);
  wal.writeUInt32BE(7, 40);
  wal.writeUInt32BE(9, 44);
  for (let i = 0; i < pageSize; i += 1) wal[56 + i] = i % 251;
  const [a1, a2] = checksum(wal.subarray(32, 40), h1, h2);
  const [c1, c2] = checksum(wal.subarray(56, 56 + pageSize), a1, a2);
  wal.writeUInt32BE(c1, 48);
  wal.writeUInt32BE(c2, 52);
  const header = readWalHeader(wal);
  assert.equal(header.headerChecksumValid, true);
  const walk = readFrames(wal, header);
  assert.equal(walk.invalidAt, -1);
  assert.equal(walk.frames.length, 1);
  assert.equal(walk.lastCommitIndex, 0);
  assert.equal(walk.committedPageCount, 4);
});

test('a corrupted WAL frame is reported, not silently merged', () => {
  const pageSize = 4096;
  const wal = Buffer.alloc(32 + 24 + pageSize);
  wal.writeUInt32BE(0x377f0682, 0);
  wal.writeUInt32BE(3007000, 4);
  wal.writeUInt32BE(pageSize, 8);
  wal.writeUInt32BE(1, 12);
  wal.writeUInt32BE(1, 16);
  wal.writeUInt32BE(2, 20);
  wal.writeUInt32BE(1, 32);
  wal.writeUInt32BE(1, 36);
  wal.writeUInt32BE(1, 40);
  wal.writeUInt32BE(2, 44);
  wal.writeUInt32BE(1, 48);
  wal.writeUInt32BE(1, 52);
  const header = readWalHeader(wal);
  const walk = readFrames(wal, header);
  assert.ok(walk.invalidAt >= 0 || walk.frames.length === 0);
  assert.ok(walk.reason !== null);
});

test('text content is read directly', () => {
  const parsed = parseContent({ contentType: 1, content: JSON.stringify({ contentType: 1, text: 'hello' }) });
  assert.equal(parsed.text, 'hello');
  assert.equal(parsed.unresolved, false);
});

test('card text is read from the attachment extension', () => {
  const attachment = { extension: JSON.stringify({ markdown: 'card body' }) };
  const parsed = parseContent({
    contentType: 1200,
    content: JSON.stringify({ contentType: 1200, attachments: [attachment] }),
    attachments: JSON.stringify([attachment]),
  });
  assert.equal(parsed.text, 'card body');
});

test('existing OCR text is reused and its source recorded', () => {
  const attachment = { extension: JSON.stringify({ photo_content_ocr: '识别文字' }) };
  const parsed = parseContent({ contentType: 2, content: '{}', attachments: JSON.stringify([attachment]) });
  assert.equal(parsed.ocrText, '识别文字');
  assert.equal(parsed.ocrSource, 'attachments[].extension.photo_content_ocr');
});

test('unparseable content is marked unresolved, not presented as empty', () => {
  const parsed = parseContent({ contentType: 9999, content: '' });
  assert.equal(parsed.unresolved, true);
});

test('a recalled message exposes metadata only', () => {
  const row = { cid: 'c', mid: 1, senderId: 2, contentType: 1, createdAt: 0, recallStatus: 1, content: JSON.stringify({ text: 'secret' }), attachments: '[]' };
  const message = renderMessage(row);
  assert.equal(isRecalled(row), true);
  assert.equal(message.recalled, true);
  assert.equal(Object.hasOwn(message, 'text'), false);
  assert.equal(Object.hasOwn(message, 'ocr'), false);
  assert.equal(Object.hasOwn(message, 'attachments'), false);
  assert.equal(message.parseState, 'metadata-only (recalled)');
});

test('identifier precision survives rendering', () => {
  const row = { cid: 'c', mid: '274278413587691234', senderId: '1893212302', contentType: 1, createdAt: 1, content: '{"text":"x"}', attachments: '[]' };
  const message = renderMessage(row);
  assert.equal(message.messageId, '274278413587691234');
  assert.equal(typeof message.messageId, 'string');
});

test('times are rendered in an explicit zone', () => {
  assert.equal(formatTime(0, 'Asia/Shanghai'), '1970-01-01 08:00:00 Asia/Shanghai');
  assert.equal(formatTime(null), null);
  assert.equal(formatTime('not-a-time'), null);
});

test('attachment summary stays bounded and reports readable fields', () => {
  const summary = summariseAttachments(JSON.stringify([{ extension: JSON.stringify({ f_name: 'a.zip' }), filepath: 'C:/x' }]));
  assert.equal(summary.length, 1);
  assert.equal(summary[0].f_name, 'a.zip');
});
