import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { lockThread, validateRequestId } from './state.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
}

export function outboundPaths(stateDir, appId) {
  const root = path.join(stateDir, 'outbound-v1', hash(appId));
  return { root, request: id => path.join(root, 'requests', `${hash(validateRequestId(id))}.json`),
    target: id => path.join(root, 'messages', `${hash(validateRequestId(id))}.json`) };
}

export async function prepareContent(input, directory = process.cwd()) {
  if (!['text', 'post', 'interactive'].includes(input.msgType)) throw new Error('msgType must be text, post or interactive');
  if (!input.content || typeof input.content !== 'object' || Array.isArray(input.content)) throw new Error('content must be a JSON object');
  const content = JSON.parse(JSON.stringify(input.content));
  if (input.msgType === 'text' && (typeof content.text !== 'string' || !content.text.trim())) throw new Error('text content is empty');
  if (input.msgType === 'interactive' && content.config?.update_multi === false) throw new Error('Shared card required: update_multi must not be false');
  if (input.msgType === 'interactive') content.config = { ...content.config, update_multi: true };
  const images = {};
  for (const [name, file] of Object.entries(input.images ?? {})) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || typeof file !== 'string') throw new Error('Invalid image mapping');
    const bytes = await readFile(path.resolve(directory, file));
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('Images must contain 1 byte to 10 MB');
    images[name] = { bytes, digest: hash(bytes) };
  }
  const used = new Set();
  function inspect(value, key) {
    if (typeof value === 'string' && value.startsWith('local:')) {
      const name = value.slice(6);
      if (!['image_key', 'img_key'].includes(key) || !images[name]) throw new Error('Invalid local image reference');
      used.add(name);
    } else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) inspect(v, k);
  }
  inspect(content);
  if (Object.keys(images).some(name => !used.has(name))) throw new Error('Unused image mapping');
  return { content, images, fingerprint: hash(canonical({ ...input, content,
    images: Object.fromEntries(Object.entries(images).map(([name, image]) => [name, image.digest])) })) };
}

function replaceImages(value, keys) {
  if (typeof value === 'string' && value.startsWith('local:')) return keys[value.slice(6)];
  if (Array.isArray(value)) return value.map(v => replaceImages(v, keys));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, replaceImages(v, keys)]));
  return value;
}

export async function outboundStatus({ stateDir, appId, requestId }) {
  return json(outboundPaths(stateDir, appId).request(requestId));
}

// transport is an injected API boundary, not a model/skill simulation.
export async function deliver(input, { stateDir, appId, directory, transport }) {
  const id = validateRequestId(input.requestId);
  if (!['send', 'update'].includes(input.operation)) throw new Error('operation must be send or update');
  if (input.operation === 'send' && !/^oc_[\w]+$/.test(input.chatId ?? '')) throw new Error('Explicit chatId required');
  if (input.operation === 'update') {
    validateRequestId(input.targetRequestId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('expectedRevision required');
    if (input.msgType !== 'interactive') throw new Error('Only card updates are supported');
  }
  const prepared = await prepareContent(input, directory);
  const paths = outboundPaths(stateDir, appId);
  // Lock request first, then original send target; concurrent repeats never duplicate writes.
  const releaseRequest = await lockThread(paths.root, `request-${hash(id)}`, performance.now() + 5000);
  if (!releaseRequest) throw new Error('Request locked; inspect owner before recovery');
  let releaseTarget;
  let releaseDependency;
  try {
    let prior;
    try { prior = await json(paths.request(id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (prior) {
      if (prior.fingerprint !== prepared.fingerprint) throw new Error('Request ID belongs to different input');
      return { ...prior, deduplicated: true };
    }
    const targetId = input.operation === 'update' ? input.targetRequestId : id;
    releaseTarget = await lockThread(paths.root, `target-${hash(targetId)}`, performance.now() + 5000);
    if (!releaseTarget) throw new Error('Target locked; inspect owner before recovery');
    let target;
    if (input.operation === 'update') {
      target = await json(paths.target(targetId));
      if (target.msgType !== 'interactive' || target.revision !== input.expectedRevision) throw new Error('Target type or revision conflict');
      if (target.content.config?.update_multi !== true) throw new Error('Original card was not shared');
      if (target.pending) throw new Error('Previous update unresolved; inspect original message before recovery');
    }
    if (input.requiresUpdate) {
      const dependency = await json(paths.request(validateRequestId(input.requiresUpdate)));
      if (input.operation !== 'send' || dependency.operation !== 'update' || dependency.status !== 'sent' || dependency.chatId !== input.chatId) {
        throw new Error('Required update is not confirmed for this group');
      }
      releaseDependency = await lockThread(paths.root, `target-${hash(dependency.targetRequestId)}`, performance.now() + 5000);
      if (!releaseDependency) throw new Error('Required update target is busy');
      const latest = await json(paths.target(dependency.targetRequestId));
      if (latest.pending || latest.lastRequestId !== dependency.requestId) throw new Error('Required update is no longer the confirmed latest revision');
    }
    const record = { version: 1, requestId: id, operation: input.operation, fingerprint: prepared.fingerprint,
      chatId: target?.chatId ?? input.chatId, targetRequestId: targetId, status: 'preparing',
      createdAt: new Date().toISOString(), submitted: false };
    await save(paths.request(id), record);
    if (target) { target.pending = id; await save(paths.target(targetId), target); }
    try {
      const keys = {};
      for (const [name, image] of Object.entries(prepared.images)) keys[name] = await transport.upload(image.bytes);
      const content = replaceImages(prepared.content, keys);
      if (input.msgType === 'interactive' && Buffer.byteLength(JSON.stringify(content), 'utf8') > 30000) {
        throw new Error('Card content exceeds 30 KB');
      }
      record.content = content;
      record.status = 'submitting'; record.submitted = true;
      await save(paths.request(id), record);
      const uuid = hash(`${appId}:${id}`).slice(0,32);
      const messageId = target ? await transport.update(target.messageId, content) :
        await transport.send(record.chatId, input.msgType, content, uuid);
      const next = { chatId: record.chatId, messageId: target?.messageId ?? messageId, msgType: input.msgType,
        revision: (target?.revision ?? 0) + 1, content, lastRequestId: id, pending: null };
      // Leave an unresolved gate if either journal write fails after an external effect.
      await save(paths.target(targetId), { ...next, pending: id });
      record.status = 'sent'; record.messageId = next.messageId; record.revision = next.revision;
      record.confirmedAt = new Date().toISOString();
      await save(paths.request(id), record);
      await save(paths.target(targetId), next);
    } catch (error) {
      record.status = record.submitted ? 'unconfirmed' : 'blocked';
      record.error = { code: Number.isSafeInteger(error.apiCode) ? error.apiCode : null,
        message: record.submitted ? 'Delivery unknown; inspect message and journal, do not resend' : 'Preparation failed; no message submitted' };
      await save(paths.request(id), record);
      // Preparation has no message side effect; allow a corrected new operation.
      if (target && !record.submitted) { target.pending = null; await save(paths.target(targetId), target); }
    }
    return record;
  } finally {
    if (releaseDependency) await releaseDependency();
    if (releaseTarget) await releaseTarget();
    await releaseRequest();
  }
}
