import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { digest, writeJournal } from './feishu-core.mjs';

export const feedbackEmoji = { accepted: 'OnIt', completed: 'DONE', attention: 'CrossMark' };
export const feedbackOutcome = record => record.codexStatus === 'completed' && (record.deliveryVersion === 2 ? record.answerMessageId : record.replyMessageId)
  ? 'completed' : 'attention';

// Separate from task journals: the receiver never awaits network marker work.
// One chain per request owns all marker mutations, including late API receipts.
export function createProcessingFeedback({ stateDir, appId, transport, log = () => {} }) {
  const root = path.join(stateDir, 'feishu', digest(appId));
  const directory = path.join(root, 'feedback');
  const chains = new Map();
  const own = (item, emoji) => item.operator?.operator_type === 'app' &&
    item.operator.operator_id === appId && item.reaction_type?.emoji_type === emoji;
  const warning = (requestId, error) => log({ type:'feedback-warning', requestId,
    ...(Number.isSafeInteger(error?.apiCode) ? {apiCode:error.apiCode} : {}),
    ...(Number.isSafeInteger(error?.httpStatus) ? {httpStatus:error.httpStatus} : {}),
  });

  async function converge(state, save) {
    const emoji = feedbackEmoji[state.desired];
    if (state.attempts[state.desired]?.status === 'rejected') delete state.attempts[state.desired];
    if (!state.attempts[state.desired]) {
      const existing = (await transport.list(state.messageId, emoji)).filter(item => own(item, emoji));
      // Preexisting bot reactions belong to someone else; leave them untouched.
      if (existing.length) {
        state.attempts[state.desired] = { status:'preexisting' };
        await save();
      } else {
        const attempt = state.attempts[state.desired] = { status:'unknown', baselineEmpty:true };
        await save(); // Durable before a potentially ambiguous remote write.
        let result;
        try { result = await transport.create(state.messageId, emoji); }
        catch(error) {
          if (error.notSent === true) { attempt.status='rejected'; await save(); }
          throw error;
        }
        if (!result?.reaction_id || !own(result, emoji)) throw new Error('Unknown reaction receipt');
        attempt.id = result.reaction_id;
        attempt.status = 'created';
        await save();
      }
    }
    // Current feedback is independent of stale markers: an old OnIt read
    // failure must not prevent DONE/CrossMark from being shown.
    for (const [kind, attempt] of Object.entries(state.attempts)) {
      if (!['unknown','delete-unknown'].includes(attempt.status)) continue;
      try {
        const matches = (await transport.list(state.messageId, feedbackEmoji[kind]))
          .filter(item => own(item, feedbackEmoji[kind]));
        if (attempt.status === 'delete-unknown') {
          if (!matches.some(item => item.reaction_id === attempt.id)) attempt.status = 'deleted';
        } else if (attempt.baselineEmpty && matches.length === 1) {
          attempt.id = matches[0].reaction_id;
          attempt.status = 'created';
        }
        await save();
      } catch (error) { warning(state.requestId,error); }
    }
    const desired = state.attempts[state.desired];
    if (!['created','preexisting'].includes(desired?.status)) return;
    for (const [kind, attempt] of Object.entries(state.attempts)) {
      if (kind === state.desired || attempt.status !== 'created') continue;
      attempt.status = 'delete-unknown';
      await save();
      await transport.remove(state.messageId, attempt.id);
      attempt.status = 'deleted';
      await save();
    }
  }

  function update(record, desired) {
    const snapshot = { requestId:record.requestId, messageId:record.messageId, revision:record.feedbackRevision ?? 0 };
    const previous = chains.get(snapshot.requestId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(directory, {recursive:true, mode:0o700});
      const file = path.join(directory, `${snapshot.requestId}.json`);
      let state;
      try { state = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      state ??= { version:1, ...snapshot, desired:'accepted', attempts:{} };
      if ((state.revision ?? 0) > snapshot.revision) return;
      state.revision = snapshot.revision;
      if (state.desired === 'accepted' || desired !== 'accepted') state.desired = desired;
      const save = () => writeJournal(file, state);
      await save();
      await converge(state, save);
      state.delivered = state.attempts.accepted?.status === 'created' ||
        state.attempts.accepted?.status === 'preexisting';
      if (!Object.values(state.attempts).some(attempt=>['unknown','delete-unknown'].includes(attempt.status))) {
        delete state.lastWarning;
        await save();
      }
      return { delivered: state.delivered === true };
    }).catch(async error => {
      warning(snapshot.requestId, error);
      try {
        const file=path.join(directory,`${snapshot.requestId}.json`);
        const state=JSON.parse(await readFile(file,'utf8'));
        state.lastWarning={code:'MARKER_UNCONFIRMED',at:new Date().toISOString(),
          ...(Number.isSafeInteger(error?.apiCode) ? {apiCode:error.apiCode} : {}),
          ...(Number.isSafeInteger(error?.httpStatus) ? {httpStatus:error.httpStatus} : {}),
        };
        await writeJournal(file,state);
      } catch { /* Local diagnostic failure must not affect the request. */ }
    });
    chains.set(snapshot.requestId, next);
    return next.finally(() => { if (chains.get(snapshot.requestId) === next) chains.delete(snapshot.requestId); })
      .then(result => ({ delivered: result?.delivered === true })).catch(() => ({ delivered: false }));
  }

  return {
    enabled:true,
    update,
    async recover() {
      let files;
      const messages = path.join(root, 'messages');
      try { files = await readdir(messages); }
      catch (error) { if (error.code !== 'ENOENT') warning('recovery'); return; }
      for (const file of files.filter(name => /^fs-[a-f0-9]{64}\.json$/.test(name))) {
        try {
          const record = JSON.parse(await readFile(path.join(messages, file), 'utf8'));
          // Only this feature's known requests; never replay Codex or its replies.
          if (record.feedbackVersion !== 1 || file !== `${record.requestId}.json`) continue;
          update(record, feedbackOutcome(record));
        } catch { warning(file.slice(0,-5)); }
      }
    },
    async stop() { await Promise.all([...chains.values()]); },
  };
}
