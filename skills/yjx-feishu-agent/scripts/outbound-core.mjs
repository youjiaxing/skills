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

// Feishu card 2.0 keeps elements under "body"; card 1.0 keeps them at the root.
// Mixing the two is rejected at submit time with 230099/200621, so fail early instead.
export function validateCard(content) {
  const isV2 = content.schema === '2.0';
  if (isV2 && content.elements !== undefined) {
    throw new Error('Card schema 2.0 must nest elements under body.elements');
  }
  if (isV2 && !content.body) throw new Error('Card schema 2.0 requires body');
  if (!isV2 && content.body !== undefined && content.elements === undefined) {
    throw new Error('Card body requires schema 2.0');
  }
  if (isV2 && !Array.isArray(content.body?.elements)) throw new Error('Card elements must be an array');
  if (!isV2 && !Array.isArray(content.elements)) throw new Error('Card elements must be an array');
  return content;
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
  if (input.msgType === 'interactive') validateCard(content);
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

export function submissionOutcome(record) {
  if ((record.status === 'sent' && record.messageId) ||
      (record.version === 2 && record.acknowledgement?.messageId)) return 'sent';
  if (record.version === 2 && record.status === 'blocked' && record.submitted === false && !record.acknowledgement) {
    const proof=record.failureProof;
    if (proof?.kind==='message-not-called' && !record.firstSubmittedAt && record.error?.stage==='prepare') return 'not_submitted';
    if (proof?.kind==='provider-rejected' && proof.apiCode===230099 && record.error?.code===230099 &&
        record.error?.rejected===true && record.error?.stage==='submit' && record.firstSubmittedAt) return 'not_submitted';
  }
  return 'unknown';
}

// This path never prepares attachments, uploads, sends, or changes the journals.
export async function recheckOutbound({ stateDir, appId, requestId, transport }) {
  let record;
  try { record = await outboundStatus({stateDir,appId,requestId}); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {requestId,status:'missing',code:'receipt-missing',submitted:null,
      outcome:'unknown',readOnly:true,retried:false};
  }
  const outcome=submissionOutcome(record);
  const result = {requestId,status:record.status,
    submitted:outcome==='unknown' && record.submitted!==true ? null : record.submitted ?? null,
    outcome,readOnly:true,retried:false};
  result.attentionKey = hash(canonical({appId,requestId,status:record.status,outcome:result.outcome,
    firstSubmittedAt:record.firstSubmittedAt ?? record.createdAt}));
  const messageId = record.acknowledgement?.messageId ?? record.messageId ?? record.targetMessageId;
  if (messageId) result.messageId = messageId;
  if (messageId && transport?.get) {
    try {
      const remote = await transport.get(messageId);
      result.remote = remote?.message_id === messageId && remote.chat_id === record.chatId
        ? {visible:true,deleted:Boolean(remote.deleted)} : {visible:false,reason:'identity-mismatch'};
    } catch { result.remote = {visible:false,reason:'unavailable'}; }
  }
  // A missing/deleted message cannot establish that an earlier send never happened.
  return result;
}

// Repair only a durable successful acknowledgement, under the same lock order as deliver().
export async function reconcileOutbound({stateDir,appId,requestId}) {
  const paths = outboundPaths(stateDir,appId);
  const release = await lockThread(paths.root,`request-${hash(validateRequestId(requestId))}`,performance.now()+5000);
  if (!release) throw new Error('Request locked; inspect owner before recovery');
  let releaseTarget;
  try {
    const record = await json(paths.request(requestId));
    if (record.version!==2 || !['text','post','interactive'].includes(record.msgType)) {
      throw new Error('Legacy or incomplete journal requires manual evidence; not migrated');
    }
    const messageId = record.acknowledgement?.messageId ?? record.messageId;
    if (submissionOutcome(record) !== 'sent' || !messageId) throw new Error('No durable successful acknowledgement');
    const targetId = record.targetRequestId;
    validateRequestId(targetId);
    releaseTarget = await lockThread(paths.root,`target-${hash(targetId)}`,performance.now()+5000);
    if (!releaseTarget) throw new Error('Target locked; inspect owner before recovery');
    let target;
    try { target = await json(paths.target(targetId)); } catch(e) { if(e.code!=='ENOENT')throw e; }
    const revision = record.revision ?? (record.operation==='send' ? 1 : record.expectedRevision+1);
    if (!Number.isSafeInteger(revision) || revision<1) throw new Error('Unknown revision');
    const next = {chatId:record.chatId,messageId,msgType:record.msgType,revision,
      content:record.content,lastRequestId:requestId,pending:null};
    if (target) {
      const same = target.lastRequestId===requestId && target.revision===revision &&
        target.messageId===messageId && target.chatId===record.chatId &&
        canonical(target.content)===canonical(record.content);
      const predecessor = record.operation==='update' && target.revision===revision-1 &&
        target.messageId===messageId && target.chatId===record.chatId;
      if ((!same && !predecessor) || (target.pending && target.pending!==requestId)) {
        throw new Error('Target changed; preserve current revision and pending gate');
      }
      if (same && !target.pending && record.status==='sent') {
        return {requestId,status:'sent',messageId,revision,reconciled:false,retried:false};
      }
    } else if (record.operation!=='send') throw new Error('Update target missing');
    await save(paths.target(targetId),{...next,pending:requestId});
    await save(paths.request(requestId),{...record,status:'sent',messageId,revision,
      reconciledAt:new Date().toISOString()});
    await save(paths.target(targetId),next);
    return {requestId,status:'sent',messageId,revision,reconciled:true,retried:false};
  } finally { if(releaseTarget)await releaseTarget();await release(); }
}

// transport is an injected API boundary, not a model/skill simulation.
export async function deliver(input, { stateDir, appId, directory, transport, recheckUnknown = false }) {
  const id = validateRequestId(input.requestId);
  // Older callers using this option get a read-only result too.
  if (recheckUnknown) return recheckOutbound({stateDir,appId,requestId:id,transport});
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
    const imageDigests = Object.fromEntries(Object.entries(prepared.images)
      .map(([name, image]) => [name, image.digest]));
    const record = { version: 2, requestId: id, operation: input.operation, fingerprint: prepared.fingerprint,
      chatId: target?.chatId ?? input.chatId, targetRequestId: targetId, status: 'preparing',
      createdAt: new Date().toISOString(), submitted: false, msgType: input.msgType,
      ...(input.operation==='update' ? {expectedRevision:input.expectedRevision} : {}),
      ...(target ? {targetMessageId:target.messageId} : {}),
      content: prepared.content, imageDigests, images: Object.fromEntries(Object.entries(input.images ?? {})
        .map(([name, file]) => [name, path.relative(directory, path.resolve(directory, file))])) };
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
      record.firstSubmittedAt = new Date().toISOString();
      await save(paths.request(id), record);
      const uuid = hash(`${appId}:${id}`).slice(0,32);
      const messageId = target ? await transport.update(target.messageId, content) :
        await transport.send(record.chatId, input.msgType, content, uuid);
      record.acknowledgement = {messageId:target?.messageId ?? messageId,receivedAt:new Date().toISOString()};
      await save(paths.request(id),record);
      const next = { chatId: record.chatId, messageId: target?.messageId ?? messageId, msgType: input.msgType,
        revision: (target?.revision ?? 0) + 1, content, lastRequestId: id, pending: null };
      // Leave an unresolved gate if either journal write fails after an external effect.
      await save(paths.target(targetId), { ...next, pending: id });
      record.status = 'sent'; record.messageId = next.messageId; record.revision = next.revision;
      record.confirmedAt = new Date().toISOString();
      await save(paths.request(id), record);
      await save(paths.target(targetId), next);
    } catch (error) {
      // Only a verified invalid-card rejection proves this message call had no effect.
      // Unknown business errors, HTTP failures and local commit failures stay unresolved.
      const apiCode = Number.isSafeInteger(error?.apiCode) ? error.apiCode
        : Number.isSafeInteger(error?.response?.data?.code) ? error.response.data.code : null;
      const messageCalled = record.submitted;
      const rejected = !record.acknowledgement && messageCalled && apiCode === 230099;
      record.status = messageCalled && !rejected ? 'unconfirmed' : 'blocked';
      record.submitted = record.status === 'unconfirmed';
      if (record.status==='blocked') record.failureProof = {
        kind:rejected ? 'provider-rejected' : 'message-not-called',
        ...(rejected ? {apiCode} : {}),recordedAt:new Date().toISOString()};
      record.error = { code: apiCode, rejected,
        stage: messageCalled ? 'submit' : 'prepare',
        message: record.status === 'unconfirmed'
          ? 'Delivery unknown; inspect message and journal, do not resend'
          : rejected ? 'Provider rejected the request; no message submitted'
          : 'Preparation failed; no message submitted' };
      await save(paths.request(id), record);
      // No message side effect; allow a corrected new operation.
      if (target && !record.submitted) { target.pending = null; await save(paths.target(targetId), target); }
    }
    return record;
  } finally {
    if (releaseDependency) await releaseDependency();
    if (releaseTarget) await releaseTarget();
    await releaseRequest();
  }
}
