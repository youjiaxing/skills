import { DatabaseSync } from 'node:sqlite';
import { formatTime, isRecalled, labelForContentType, parseContent, renderMessage, summariseAttachments } from './messages.mjs';

const SHARD_PATTERN = /^tbmsg_[0-9]{3}$/;

export function listShards(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tbmsg\\_%' ESCAPE '\\' ORDER BY name")
    .all()
    .map((row) => row.name)
    .filter((name) => SHARD_PATTERN.test(name));
}

export function openSnapshot(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * Conversation search matches a title fragment and never merges across accounts.
 * When the id or title is ambiguous the caller must present the candidates and
 * let the user choose rather than picking one silently.
 */
export function findConversations(db, { query, limit = 20, timeZone = 'Asia/Shanghai' }) {
  const rows = db
    .prepare('SELECT cid, title, type, lastModify, memberCount, ownerId FROM tbconversation ORDER BY lastModify DESC')
    .all();
  const needle = query === undefined || query === null ? '' : String(query).toLowerCase();
  const matched = needle === ''
    ? rows
    : rows.filter((row) =>
        String(row.cid).toLowerCase().includes(needle) ||
        String(row.title ?? '').toLowerCase().includes(needle));
  return {
    matches: matched.slice(0, limit).map((row) => ({
      ...row,
      lastModifyLocal: formatTime(row.lastModify, timeZone),
    })),
    total: matched.length,
    ambiguous: matched.length > 1,
  };
}

/**
 * Messages are collected across every shard, then ordered by creation time with
 * the shard name and primary key as tie-breakers so paging is stable.
 */
export function queryMessages(db, {
  conversationId,
  since = null,
  until = null,
  senderId = null,
  kind = null,
  limit = 50,
  offset = 0,
  order = 'asc',
  latest = false,
  preferShard = null,
}) {
  if (!['asc', 'desc'].includes(order)) throw new Error(`invalid order: ${order} (expected asc or desc)`);
  const normalizedKind = kind ? String(kind).toLowerCase() : null;
  const shards = listShards(db);
  const collected = [];
  for (const shard of shards) {
    if (preferShard && shard !== preferShard) continue;
    const conditions = ['cid = ?'];
    const params = [conversationId];
    if (since !== null) { conditions.push('createdAt >= ?'); params.push(since); }
    if (until !== null) { conditions.push('createdAt <= ?'); params.push(until); }
    if (senderId !== null && senderId !== undefined) { conditions.push('CAST(senderId AS TEXT) = ?'); params.push(String(senderId)); }
    const sql = 'SELECT primaryKey, cid, mid, senderId, type, contentType, createdAt, lastModify, ' +
      'recallStatus, content, attachments FROM "' + shard + '" WHERE ' + conditions.join(' AND ');
    for (const row of db.prepare(sql).all(...params)) {
      if (normalizedKind && labelForContentType(row.contentType) !== normalizedKind) continue;
      collected.push({ ...row, shard });
    }
  }
  const compareAsc = (left, right) =>
    (left.createdAt - right.createdAt) ||
    left.shard.localeCompare(right.shard) ||
    (left.primaryKey - right.primaryKey);
  collected.sort(compareAsc);
  let sliced;
  if (latest) {
    const end = Math.max(0, collected.length - offset);
    const start = Math.max(0, end - limit);
    sliced = collected.slice(start, end);
    if (order === 'desc') sliced.reverse();
  } else {
    if (order === 'desc') collected.reverse();
    sliced = collected.slice(offset, offset + limit);
  }
  return {
    total: collected.length,
    messages: sliced,
    shardsScanned: preferShard ? 1 : shards.length,
  };
}

/** Locate one message and return a window of context around it. */
export function messageWithContext(db, { conversationId, messageId, before = 5, after = 5 }) {
  const all = queryMessages(db, { conversationId, limit: Number.MAX_SAFE_INTEGER }).messages;
  const target = String(messageId);
  const index = all.findIndex((row) => String(row.mid) === target);
  if (index < 0) return { found: false, total: all.length };
  const start = Math.max(0, index - before);
  return {
    found: true,
    index,
    total: all.length,
    messages: all.slice(start, Math.min(all.length, index + after + 1)),
    targetMessageId: target,
  };
}

function readableSearchHaystack(row) {
  const parsed = parseContent(row);
  const attachments = summariseAttachments(row.attachments);
  const parts = [];
  if (typeof parsed.text === 'string' && parsed.text !== '') parts.push(parsed.text);
  if (typeof parsed.ocrText === 'string' && parsed.ocrText !== '') parts.push(parsed.ocrText);
  for (const att of attachments) {
    for (const field of ['f_name', 'file_name', 'title', 'b_tl', 'desc', 'markdownPreview', 'filepath']) {
      if (typeof att[field] === 'string' && att[field] !== '') parts.push(att[field]);
    }
  }
  return parts.join('\n');
}

/**
 * Keyword search parses readable text, OCR, and attachment titles/filenames rather
 * than matching raw JSON key names or internal extension noise.
 */
export function searchMessages(db, {
  keyword,
  conversationId = null,
  since = null,
  until = null,
  senderId = null,
  kind = null,
  limit = 50,
  offset = 0,
  includeRecalled = false,
}) {
  const needle = String(keyword ?? '');
  if (needle === '') throw new Error('keyword must not be empty');
  const lowered = needle.toLowerCase();
  const normalizedKind = kind ? String(kind).toLowerCase() : null;
  const shards = listShards(db);
  const hits = [];
  let scanned = 0;
  const failures = [];
  for (const shard of shards) {
    const conditions = [];
    const params = [];
    if (conversationId) { conditions.push('cid = ?'); params.push(conversationId); }
    if (since !== null) { conditions.push('createdAt >= ?'); params.push(since); }
    if (until !== null) { conditions.push('createdAt <= ?'); params.push(until); }
    if (senderId !== null && senderId !== undefined) { conditions.push('CAST(senderId AS TEXT) = ?'); params.push(String(senderId)); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    let rows;
    try {
      rows = db.prepare('SELECT primaryKey, cid, mid, senderId, type, contentType, createdAt, ' +
        'recallStatus, content, attachments FROM "' + shard + '"' + where).all(...params);
    } catch (error) {
      failures.push({ shard, error: error.message });
      continue;
    }
    for (const row of rows) {
      scanned += 1;
      if (isRecalled(row) && !includeRecalled) continue;
      if (normalizedKind && labelForContentType(row.contentType) !== normalizedKind) continue;
      const haystack = readableSearchHaystack(row);
      if (!haystack.toLowerCase().includes(lowered)) continue;
      hits.push({ ...row, shard });
    }
  }
  hits.sort((left, right) =>
    (right.createdAt - left.createdAt) ||
    left.shard.localeCompare(right.shard) ||
    (right.primaryKey - left.primaryKey));
  return { matches: hits.slice(offset, offset + limit), total: hits.length, scanned, shards: shards.length, failures };
}

/** Read-only contact lookup from tbuser_profile_v2. */
export function findContacts(db, { query = '', limit = 50 } = {}) {
  const needle = query === undefined || query === null ? '' : String(query).toLowerCase();
  let rows;
  try {
    rows = db.prepare('SELECT uid, nick, realName, alias FROM tbuser_profile_v2').all();
  } catch (error) {
    if (/no such table/i.test(error.message)) {
      return { matches: [], total: 0, tableMissing: true };
    }
    throw error;
  }
  const matched = needle === ''
    ? rows
    : rows.filter((row) =>
        [row.uid, row.nick, row.realName, row.alias]
          .some((field) => field !== null && field !== undefined && String(field).toLowerCase().includes(needle)));
  return {
    matches: matched.slice(0, limit).map((row) => ({
      uid: row.uid === null || row.uid === undefined ? null : String(row.uid),
      nick: row.nick ?? null,
      realName: row.realName ?? null,
      alias: row.alias ?? null,
    })),
    total: matched.length,
    tableMissing: false,
  };
}

/** Deterministic read-only message summary grouped by conversation, sender, and kind. */
export function summariseMessages(db, {
  conversationId = null,
  since = null,
  until = null,
  senderId = null,
  kind = null,
  includeRecalled = false,
  timeZone = 'Asia/Shanghai',
} = {}) {
  const normalizedKind = kind ? String(kind).toLowerCase() : null;
  const shards = listShards(db);
  const convTitles = new Map();
  try {
    for (const row of db.prepare('SELECT cid, title FROM tbconversation').all()) {
      convTitles.set(String(row.cid), row.title ?? null);
    }
  } catch { /* optional */ }
  const byConversation = new Map();
  const bySender = new Map();
  const byKind = new Map();
  const failures = [];
  let total = 0;
  let recalledCount = 0;
  let firstCreatedAt = null;
  let lastCreatedAt = null;

  for (const shard of shards) {
    const conditions = [];
    const params = [];
    if (conversationId) { conditions.push('cid = ?'); params.push(conversationId); }
    if (since !== null) { conditions.push('createdAt >= ?'); params.push(since); }
    if (until !== null) { conditions.push('createdAt <= ?'); params.push(until); }
    if (senderId !== null && senderId !== undefined) { conditions.push('CAST(senderId AS TEXT) = ?'); params.push(String(senderId)); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    let rows;
    try {
      rows = db.prepare('SELECT cid, senderId, contentType, createdAt, recallStatus FROM "' + shard + '"' + where).all(...params);
    } catch (error) {
      failures.push({ shard, error: error.message });
      continue;
    }
    for (const row of rows) {
      const recalled = isRecalled(row);
      if (recalled && !includeRecalled) { recalledCount += 1; continue; }
      const rowKind = labelForContentType(row.contentType);
      if (normalizedKind && rowKind !== normalizedKind) continue;
      total += 1;
      if (recalled) recalledCount += 1;
      const ts = Number(row.createdAt);
      if (Number.isFinite(ts)) {
        if (firstCreatedAt === null || ts < firstCreatedAt) firstCreatedAt = ts;
        if (lastCreatedAt === null || ts > lastCreatedAt) lastCreatedAt = ts;
      }
      const cid = String(row.cid);
      const convEntry = byConversation.get(cid) ?? { cid, title: convTitles.get(cid) ?? null, count: 0, firstCreatedAt: null, lastCreatedAt: null };
      convEntry.count += 1;
      if (Number.isFinite(ts)) {
        if (convEntry.firstCreatedAt === null || ts < convEntry.firstCreatedAt) convEntry.firstCreatedAt = ts;
        if (convEntry.lastCreatedAt === null || ts > convEntry.lastCreatedAt) convEntry.lastCreatedAt = ts;
      }
      byConversation.set(cid, convEntry);

      const sid = row.senderId === null || row.senderId === undefined ? 'unknown' : String(row.senderId);
      bySender.set(sid, (bySender.get(sid) ?? 0) + 1);
      byKind.set(rowKind, (byKind.get(rowKind) ?? 0) + 1);
    }
  }

  const senderNames = new Map();
  if (bySender.size > 0) {
    try {
      const stmt = db.prepare('SELECT uid, nick, realName, alias FROM tbuser_profile_v2 WHERE uid = ?');
      for (const sid of bySender.keys()) {
        if (sid === 'unknown') continue;
        const profile = stmt.get(sid);
        if (profile) senderNames.set(sid, profile.realName || profile.nick || profile.alias || null);
      }
    } catch { /* optional */ }
  }

  return {
    total,
    recalledCount,
    firstCreatedAt,
    firstCreatedAtLocal: formatTime(firstCreatedAt, timeZone),
    lastCreatedAt,
    lastCreatedAtLocal: formatTime(lastCreatedAt, timeZone),
    byConversation: [...byConversation.values()].sort((a, b) => b.count - a.count).map((entry) => ({
      ...entry,
      firstCreatedAtLocal: formatTime(entry.firstCreatedAt, timeZone),
      lastCreatedAtLocal: formatTime(entry.lastCreatedAt, timeZone),
    })),
    bySender: [...bySender.entries()].sort((a, b) => b[1] - a[1]).map(([sid, count]) => ({
      senderId: sid === 'unknown' ? null : sid,
      senderName: senderNames.get(sid) ?? null,
      count,
    })),
    byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, count]) => ({ kind: k, count })),
    shards: shards.length,
    failures,
  };
}

/** Sender display names come from the local profile and per-conversation nick tables. */
export function attachSenderNames(db, messages) {
  const uids = [...new Set(messages.map((row) => row.senderId).filter((v) => v !== null && v !== undefined))];
  if (uids.length === 0) return messages;
  const names = new Map();
  try {
    const statement = db.prepare('SELECT uid, nick, realName, alias FROM tbuser_profile_v2 WHERE uid = ?');
    for (const uid of uids) {
      const row = statement.get(uid);
      if (row) names.set(String(row.uid), row.realName || row.nick || row.alias || null);
    }
  } catch { /* profile table is optional; ids remain sufficient */ }
  return messages.map((row) => ({ ...row, senderName: names.get(String(row.senderId)) ?? null }));
}

export function renderAll(db, messages, options) {
  const named = attachSenderNames(db, messages);
  return named.map((row) => renderMessage(row, options));
}
