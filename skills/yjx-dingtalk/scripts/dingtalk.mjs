#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { cleanArtifacts, ensureCacheRoot, newTaskId, pruneEmptyTaskDirs, readManifest, registerEntry, resolveCacheRoot, taskPaths, writeManifest, FILE_MODE, DIR_MODE } from './cache.mjs';
import { candidateDataRoots, describeDiscovery, discoverAccounts } from './paths.mjs';
import { attachSenderNames, findConversations, messageWithContext, openSnapshot, queryMessages, searchMessages } from './query.mjs';
import { renderLines, renderMessage } from './messages.mjs';
import { acquireSnapshot } from './snapshot.mjs';

const USAGE = [
  'yjx-dingtalk - read and search the local DingTalk cache (read-only)',
  '',
  'Commands:',
  '  discover                         list data roots and accounts',
  '  conversations [--query <text>] [--limit N]',
  '  messages --account <id> --conversation <cid> [--since <ms>] [--until <ms>] [--limit N]',
  '  search --keyword <text> [--account <id>] [--conversation <cid>] [--limit N]',
  '  context --account <id> --conversation <cid> --message <mid> [--before N] [--after N]',
  '  clean [--force] [--idle-hours N]      remove only manifest-registered artifacts',
  '',
  'Options:',
  '  --json        machine-readable output',
  '  --refresh     ignore any cached copy and re-acquire',
  '  --task <id>   reuse or name a task cache identity',
  '  --full        do not truncate message bodies in text output',
  '',
].join('\n');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { args[name] = true; continue; }
    args[name] = next; index += 1;
  }
  return args;
}

function requireOption(args, name) {
  const value = args[name];
  if (value === undefined || value === true) throw new Error('missing required option --' + name);
  return value;
}

function pickAccount(args) {
  const discovery = discoverAccounts();
  if (discovery.accounts.length === 0) throw new Error('no DingTalk account found.\n' + describeDiscovery(discovery));
  if (args.account) {
    const wanted = String(args.account);
    const account = discovery.accounts.find((item) => item.id === wanted);
    if (!account) throw new Error('account not found: ' + wanted);
    return { account, discovery };
  }
  if (discovery.accounts.length > 1) {
    throw new Error('multiple accounts found; pass --account <id>: ' + discovery.accounts.map((item) => item.id).join(', '));
  }
  return { account: discovery.accounts[0], discovery };
}

/** Cache the acquired image so repeated queries in one task reuse it. */
function materialise(account, root, taskId, { refresh = false } = {}) {
  const manifest = readManifest(root);
  let entries = manifest.entries;
  const cached = entries.find((entry) => entry.accountId === account.id && entry.taskId === taskId && entry.kind === 'snapshot');
  if (cached && !refresh && fs.existsSync(cached.path)) {
    return { dbPath: cached.path, reused: true, copiedAt: cached.createdAt, walReport: cached.walReport ?? null, taskId };
  }
  const paths = taskPaths(root, { taskId, accountId: account.id });
  fs.mkdirSync(paths.accountDir, { recursive: true, mode: DIR_MODE });
  const dataRoot = path.dirname(account.dir);
  const snapshot = acquireSnapshot({ account, dataRoot });
  const dbPath = path.join(paths.accountDir, 'dingtalk.db');
  fs.writeFileSync(dbPath, snapshot.image, { mode: FILE_MODE });
  if (process.platform !== 'win32') fs.chmodSync(dbPath, FILE_MODE);
  snapshot.image.fill(0);
  entries = registerEntry(entries, {
    kind: 'snapshot', taskId, accountId: account.id, path: dbPath,
    createdAt: snapshot.copiedAt, lastUsedAt: Date.now(),
    retained: false, walReport: snapshot.walReport,
  });
  writeManifest(root, entries);
  return { dbPath, reused: false, copiedAt: snapshot.copiedAt, walReport: snapshot.walReport, notes: snapshot.notes, attemptsUsed: snapshot.attemptsUsed, taskId };
}

function touchEntry(root, taskId, accountId) {
  const manifest = readManifest(root);
  if (manifest.missing || manifest.corrupt) return;
  const entries = manifest.entries.map((entry) =>
    entry.taskId === taskId && entry.accountId === accountId ? { ...entry, lastUsedAt: Date.now() } : entry);
  writeManifest(root, entries);
}

function printJson(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === 'help' || args.help) { process.stdout.write(USAGE); return; }

  if (command === 'discover') {
    const discovery = discoverAccounts();
    if (args.json) return printJson({ roots: candidateDataRoots(), ...discovery });
    process.stdout.write(describeDiscovery(discovery) + '\n');
    return;
  }

  const cacheRoot = resolveCacheRoot();
  ensureCacheRoot(cacheRoot.root);
  pruneEmptyTaskDirs(cacheRoot.root);

  if (command === 'clean') {
    const idleHours = args['idle-hours'] ? Number(args['idle-hours']) : 24;
    const result = cleanArtifacts(cacheRoot.root, { idleMs: idleHours * 3600 * 1000, force: Boolean(args.force) });
    pruneEmptyTaskDirs(cacheRoot.root);
    if (args.json) return printJson({ cacheRoot: cacheRoot.root, ...result });
    if (result.skipped) {
      process.stdout.write('cache root: ' + cacheRoot.root + '\ncleanup skipped: ' + result.reason + '; no directory-wide delete was performed.\n');
      return;
    }
    process.stdout.write('cache root: ' + cacheRoot.root + '\nremoved: ' + result.removed.length + '  kept: ' + result.kept + '\n');
    for (const entry of result.removed) process.stdout.write('  removed ' + entry.path + '\n');
    return;
  }

  const { account } = pickAccount(args);
  const taskId = args.task ? String(args.task) : newTaskId();
  const materialised = materialise(account, cacheRoot.root, taskId, { refresh: Boolean(args.refresh) });
  touchEntry(cacheRoot.root, taskId, account.id);
  const db = openSnapshot(materialised.dbPath);
  try {
    const meta = {
      accountId: account.id,
      taskId,
      dbPath: materialised.dbPath,
      copiedAt: new Date(materialised.copiedAt).toISOString(),
      reused: materialised.reused,
      wal: materialised.walReport ?? null,
    };
    if (command === 'conversations') {
      const result = findConversations(db, { query: args.query, limit: args.limit ? Number(args.limit) : 20 });
      if (args.json) return printJson({ ...meta, ...result });
      process.stdout.write('account ' + account.id + '  task ' + taskId + '  copied ' + meta.copiedAt + '\n');
      for (const row of result.matches) {
        process.stdout.write('  ' + row.cid + '  ' + (row.title || '(no title)') + '  lastModify=' + row.lastModify + '\n');
      }
      if (result.ambiguous) process.stdout.write('  (multiple matches; specify the id you mean)\n');
      return;
    }
    if (command === 'messages') {
      const result = queryMessages(db, {
        conversationId: requireOption(args, 'conversation'),
        since: args.since ? Number(args.since) : null,
        until: args.until ? Number(args.until) : null,
        limit: args.limit ? Number(args.limit) : 50,
        offset: args.offset ? Number(args.offset) : 0,
      });
      const named = attachSenderNames(db, result.messages);
      if (args.json) return printJson({ ...meta, total: result.total, shardsScanned: result.shardsScanned,
        messages: named.map((row) => renderMessage(row, { full: Boolean(args.full) })) });
      process.stdout.write('account ' + account.id + '  conversation ' + args.conversation +
        '  total ' + result.total + '  copied ' + meta.copiedAt + '\n');
      process.stdout.write(renderLines(named, { full: Boolean(args.full) }) + '\n');
      return;
    }
    if (command === 'context') {
      const result = messageWithContext(db, {
        conversationId: requireOption(args, 'conversation'),
        messageId: requireOption(args, 'message'),
        before: args.before ? Number(args.before) : 5,
        after: args.after ? Number(args.after) : 5,
      });
      if (!result.found) {
        process.stdout.write('message ' + args.message + ' not found in conversation ' + args.conversation +
          ' (' + result.total + ' messages scanned)\n');
        return;
      }
      const named = attachSenderNames(db, result.messages);
      if (args.json) return printJson({ ...meta, ...result, messages: named.map((row) => renderMessage(row, { full: Boolean(args.full) })) });
      process.stdout.write('account ' + account.id + '  conversation ' + args.conversation +
        '  target ' + result.targetMessageId + ' at index ' + result.index + ' of ' + result.total + '\n');
      process.stdout.write(renderLines(named, { full: Boolean(args.full) }) + '\n');
      return;
    }
    if (command === 'search') {
      const result = searchMessages(db, {
        keyword: requireOption(args, 'keyword'),
        conversationId: args.conversation ?? null,
        since: args.since ? Number(args.since) : null,
        until: args.until ? Number(args.until) : null,
        limit: args.limit ? Number(args.limit) : 50,
      });
      const named = attachSenderNames(db, result.matches);
      if (args.json) return printJson({ ...meta, total: result.total, scanned: result.scanned,
        shards: result.shards, failures: result.failures,
        matches: named.map((row) => renderMessage(row, { full: Boolean(args.full) })) });
      process.stdout.write('account ' + account.id + '  keyword ' + args.keyword +
        '  matches ' + result.total + ' of ' + result.scanned + ' scanned  copied ' + meta.copiedAt + '\n');
      if (result.failures.length > 0) {
        process.stdout.write('shards that could not be read: ' +
          result.failures.map((item) => item.shard + ' (' + item.error + ')').join(', ') + '\n');
      }
      process.stdout.write(renderLines(named, { full: Boolean(args.full) }) + '\n');
      return;
    }
    throw new Error('unknown command: ' + command + '\n' + USAGE);
  } finally {
    db.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write('error: ' + error.message + '\n');
  process.exitCode = 1;
}
