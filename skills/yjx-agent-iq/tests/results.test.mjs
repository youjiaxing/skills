import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, recordAttempt, sha256, writeRunReport } from '../scripts/results.mjs';

// These tests verify persisted result-state integrity, not model reasoning or prompt behavior.
const answer = '21; shape; guarantee; lower bound';
const raw = (text = answer) => [
  { type: 'thread.started' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' },
].map(JSON.stringify).join('\n');
const review = (last = 'pass') => ({ answerSha256: sha256(answer),
  finalNumber: { value: 21, quote: '21' }, criteria: [
    { id: 'shape-choice', status: 'pass', quote: 'shape', reason: 'wire fixture' },
    { id: 'guarantee-21', status: 'pass', quote: 'guarantee', reason: 'wire fixture' },
    { id: 'lower-bound-20', status: last, quote: 'lower bound', reason: 'wire fixture' },
  ] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iq-result-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, options: { root: join(root, 'attempt'), id: 'fixture', provider: 'codex',
    model: 'fixture', question: 'candy', prompt: await buildPrompt('candy'), raw: raw() } };
}
test('a proof failure is durably fail even when numeric answer is correct', async (t) => {
  const { options } = await fixture(t);
  const record = await recordAttempt({ ...options, review: review('fail') });
  assert.equal(record.score.numeric.status, 'pass');
  assert.equal(record.outcome, 'fail');
  const saved = JSON.parse(await readFile(join(options.root, 'assessment.json'), 'utf8'));
  assert.equal(saved.record.outcome, 'fail');
});
test('execution failure has no score and error log is never an answer', async (t) => {
  const { options } = await fixture(t);
  const record = await recordAttempt({ ...options, exitCode: 1,
    raw: '{"type":"thread.started"}\n{"type":"turn.failed","error":{"message":"429"}}' });
  assert.equal(record.status, 'incomplete');
  assert.equal(record.score, undefined);
  assert.equal(await readFile(record.answerPath, 'utf8'), '');
});
test('tool violations never enter grading', async (t) => {
  const { options } = await fixture(t);
  const events = options.raw.split('\n');
  events.splice(2, 0, '{"type":"item.completed","item":{"type":"command_execution"}}');
  const record = await recordAttempt({ ...options, raw: events.join('\n'), review: review() });
  assert.equal(record.outcome, 'violation');
  assert.equal(record.score, undefined);
});
test('review tied to another answer hash cannot grant a pass', async (t) => {
  const { options } = await fixture(t);
  const record = await recordAttempt({ ...options, review: { ...review(), answerSha256: 'another-answer' } });
  assert.equal(record.outcome, 'review');
});
test('graded evidence and numeric selection must quote the actual answer', async (t) => {
  const { options } = await fixture(t);
  const assessment = review();
  assessment.finalNumber.quote = 'absent evidence';
  assessment.criteria[0].quote = 'also absent';
  const record = await recordAttempt({ ...options, review: assessment });
  assert.equal(record.outcome, 'review');
});
test('altered prompt produces a sample, not a strict benchmark pass', async (t) => {
  const { options } = await fixture(t);
  const record = await recordAttempt({ ...options, prompt: options.prompt + 'extra', review: review() });
  assert.equal(record.score.overall, 'pass');
  assert.equal(record.outcome, 'sample');
});
test('persisted evidence cannot be overwritten by a retry', async (t) => {
  const { options } = await fixture(t);
  await recordAttempt(options);
  const before = await readFile(join(options.root, 'transcript.json'), 'utf8');
  await assert.rejects(recordAttempt({ ...options, raw: raw('changed') }), { code: 'EEXIST' });
  assert.equal(await readFile(join(options.root, 'transcript.json'), 'utf8'), before);
});
test('batch summary includes failures, unknown audits and missing planned attempts', async (t) => {
  const { root, options } = await fixture(t);
  const complete = await recordAttempt({ ...options, review: review() });
  const incomplete = await recordAttempt({ ...options, root: join(root, 'failed'), exitCode: 1,
    raw: '{"type":"thread.started"}' });
  const summary = await writeRunReport(root, [complete, incomplete], { planned: 3 });
  assert.equal(summary.pass, 1);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.unverified, 1);
  assert.equal(summary.missing, 1);
});
test('HTML and claimed visual pass without actual evidence stay review', async (t) => {
  const { options } = await fixture(t);
  const html = '<html><body><svg><circle/><circle/></svg></body></html>';
  const record = await recordAttempt({ ...options, question: 'pelican', prompt: await buildPrompt('pelican'),
    raw: raw(html), review: { answerSha256: sha256(html), criteria:
      ['runtime', 'identity', 'bicycle', 'pose', 'motion'].map((id) => ({
        id, status: 'pass', reason: 'claimed', evidence: ['missing.png'],
      })) } });
  assert.equal(record.outcome, 'review');
  assert.ok(record.score.criteria.every((item) => item.status === 'review'));
});

test('conflicting terminal capture cannot be persisted as a completed pass', async (t) => {
  const { options } = await fixture(t);
  const stream = options.raw.split('\n');
  stream.splice(2, 0, '{"type":"turn.failed"}');
  const record = await recordAttempt({ ...options, raw: stream.join('\n'), review: review() });
  assert.equal(record.status, 'incomplete');
  assert.equal(record.score, undefined);
});

test('canonical prompt file cannot conceal additional hints in T3 activity', async (t) => {
  const { options } = await fixture(t);
  const capture = { provider: 't3', run: { id: 'run', status: 'completed' },
    coverage: { complete: true, hasMore: false, totalItems: 2 }, items: [
      { position: 0, runId: 'run', type: 'user_message', text: options.prompt + 'actual extra hint' },
      { position: 1, runId: 'run', type: 'assistant_message', text: answer },
    ] };
  const record = await recordAttempt({ ...options, raw: capture, protocolProvider: 't3', review: review() });
  assert.equal(record.score.overall, 'pass');
  assert.equal(record.promptMatchesCapture, false);
  assert.equal(record.outcome, 'sample');
});

test('external evidence is durably located and hashed for later review', async (t) => {
  const { root, options } = await fixture(t);
  const evidenceRoot = join(root, 'browser-evidence');
  await mkdir(evidenceRoot);
  await writeFile(join(evidenceRoot, 'runtime.log'), 'original browser run');
  const html = '<html><body><svg></svg></body></html>';
  const assessment = { answerSha256: sha256(html), visual: {
    originalHtmlSha256: sha256(html), originalRuntime: true,
  }, criteria: [{ id: 'runtime', status: 'pass', reason: 'captured original browser run', evidence: ['runtime.log'] }] };
  const record = await recordAttempt({ ...options, question: 'pelican', prompt: await buildPrompt('pelican'),
    raw: raw(html), review: assessment, evidenceRoot });
  assert.equal(record.score.criteria[0].status, 'pass');
  const saved = JSON.parse(await readFile(join(options.root, 'assessment.json'), 'utf8'));
  assert.equal(saved.record.evidenceRoot, evidenceRoot);
  const manifest = JSON.parse(await readFile(record.evidenceManifestPath, 'utf8'));
  assert.equal(manifest[0].path, await realpath(join(evidenceRoot, 'runtime.log')));
  assert.equal(manifest[0].sha256, sha256('original browser run'));
});
