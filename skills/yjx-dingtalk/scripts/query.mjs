import { DatabaseSync } from 'node:sqlite';
import { renderMessage } from './messages.mjs';

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
export function findConversations(db, { query, limit = 20 }) {
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
    matches: matched.slice(0, limit),
    total: matched.length,
    ambiguous: matched.length > 1,
  };
}

/**
 * Messages are collected across every shard, then ordered by creation time with
 * the shard name and primary key as tie-breakers so paging is stable.
 */
export function queryMessages(db, { conversationId, since = null, until = null, limit = 50, offset = 0, preferShard = null }) {
  const shards = listShards(db);
  const collected = [];
  for (const shard of shards) {
    if (preferShard && shard !== preferShard) continue;
    const conditions = ['cid = ?'];
    const params = [conversationId];
    if (since !== null) { conditions.push('createdAt >= ?'); params.push(since); }
    if (until !== null) { conditions.push('createdAt <= ?'); params.push(until); }
    const sql = 'SELECT primaryKey, cid, mid, senderId, type, contentType, createdAt, lastModify, ' +
      'recallStatus, content, attachments FROM "' + shard + '" WHERE ' + conditions.join(' AND ');
    for (const row of db.prepare(sql).all(...params)) collected.push({ ...row, shard });
  }
  collected.sort((left, right) =>
    (left.createdAt - right.createdAt) ||
    left.shard.localeCompare(right.shard) ||
    (left.primaryKey - right.primaryKey));
  return {
    total: collected.length,
    messages: collected.slice(offset, offset + limit),
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

/**
 * Keyword search reads each shard's text-like columns and filters in memory, so a
 * missing or unusable custom tokenizer cannot be mistaken for 'no messages'.
 */
export function searchMessages(db, { keyword, conversationId = null, since = null, until = null, limit = 50, includeRecalled = false }) {
  const needle = String(keyword ?? '');
  if (needle === '') throw new Error('keyword must not be empty');
  const lowered = needle.toLowerCase();
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
      const text = (row.content ?? '') + ' ' + (row.attachments ?? '');
      if (!text.toLowerCase().includes(lowered)) continue;
      if (Number(row.recallStatus ?? 0) !== 0 && !includeRecalled) continue;
      hits.push({ ...row, shard });
    }
  }
  hits.sort((left, right) => (right.createdAt - left.createdAt) || left.shard.localeCompare(right.shard));
  return { matches: hits.slice(0, limit), total: hits.length, scanned, shards: shards.length, failures };
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
