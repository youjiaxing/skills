import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { analyzeTranscript } from './audit-transcript.mjs';
import { scoreCandy } from './score-candy.mjs';
import { validatePelican } from './validate-pelican.mjs';
import { buildGallery } from './generate-gallery.mjs';
import { safeMetadata } from './safe-output.mjs';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const PELICAN_CRITERIA = ['runtime', 'identity', 'bicycle', 'pose', 'motion'];
export async function buildPrompt(question) {
  if (!['candy', 'pelican'].includes(question)) throw new Error('invalid_arguments');
  const instructions = await readFile(new URL('../bank/instructions.md', import.meta.url), 'utf8');
  const body = await readFile(new URL('../bank/' + question + '/question.md', import.meta.url), 'utf8');
  return instructions.trimEnd() + '\n\n' + body.trimEnd() + '\n';
}
async function evidenceExists(root, name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  try {
    const base = await realpath(root);
    const file = await realpath(resolve(root, name));
    const rel = relative(base, file);
    if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) return false;
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch { return false; }
}
async function scorePelican(html, review, evidenceRoot) {
  const visual = review.visual ?? {};
  const frames = Array.isArray(visual.frames) ? visual.frames : [];
  const validFrames = [];
  for (const frame of frames) {
    if (Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= 0
      && await evidenceExists(evidenceRoot, frame.file)) validFrames.push(frame);
  }
  const period = visual.primaryPeriodSeconds;
  const phasesCovered = Number.isFinite(period) && period > 0
    && [0, 0.25, 0.5, 0.75].every((phase) => validFrames.some((frame) => {
      const p = (frame.timeSeconds % period) / period;
      return Math.min(Math.abs(p - phase), 1 - Math.abs(p - phase)) <= 0.05;
    }));
  const isolated = visual.observer?.freshContext === true && typeof visual.observer?.link === 'string'
    && visual.observer.link.trim().length > 0;
  const originalMatches = visual.originalHtmlSha256 === sha256(html);
  const criteria = [];
  for (const id of PELICAN_CRITERIA) {
    const item = Array.isArray(review.criteria) ? review.criteria.find((criterion) => criterion?.id === id) : null;
    const files = Array.isArray(item?.evidence) ? item.evidence : [];
    let evidenced = Boolean(typeof item?.reason === 'string' && item.reason.trim() && files.length);
    for (const name of files) evidenced = evidenced && await evidenceExists(evidenceRoot, name);
    if (id === 'runtime') evidenced = evidenced && originalMatches && visual.originalRuntime === true;
    else evidenced = evidenced && isolated && validFrames.length > 0;
    if (id === 'motion' && item?.status === 'pass') evidenced = evidenced && phasesCovered;
    criteria.push({ id, status: evidenced && ['pass', 'fail'].includes(item.status) ? item.status : 'review',
      reason: evidenced ? item.reason : '缺少本项原文运行或隔离视觉证据',
      evidence: evidenced ? item.evidence : [] });
  }
  const states = criteria.map((item) => item.status);
  return { question: 'pelican', criteria, overall: states.includes('fail') ? 'fail'
    : states.every((state) => state === 'pass') ? 'pass' : 'review', userExperience: '待用户体验' };
}
const put = (root, name, value) => writeFile(resolve(root, name), value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
export async function recordAttempt({ root, evidenceRoot = root, id, provider, model, question, prompt,
  raw, protocolProvider, review = {}, exitCode = 0, timedOut = false, complete = true, sourceLink = null, failureCode = null }) {
  if (!['candy', 'pelican'].includes(question) || typeof prompt !== 'string') throw new Error('invalid_arguments');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await buildPrompt(question);
  const captureText = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
  const parsed = analyzeTranscript(raw, { provider: protocolProvider, complete });
  const { answer, ...audit } = parsed;
  let capturedPrompt = null;
  if (parsed.provider === 't3') {
    let capture = raw;
    if (typeof capture === 'string') { try { capture = JSON.parse(capture); } catch { capture = null; } }
    const messages = capture?.items?.filter((item) => item.type === 'user_message') ?? [];
    if (messages.length === 1 && typeof messages[0].text === 'string') capturedPrompt = messages[0].text;
  }
  const hostPrefix = 'Act as the test sub-agent for this task.\n\n';
  const promptMatchesCapture = parsed.provider !== 't3' || capturedPrompt === prompt || capturedPrompt === hostPrefix + prompt;
  const status = exitCode === 0 && !timedOut && parsed.terminalStatus === 'completed' && answer.trim()
    ? 'completed' : 'incomplete';
  const record = {
    id, ...safeMetadata({ provider, model }), question, sourceLink, status,
    auditStatus: parsed.auditStatus, auditPath: resolve(root, 'audit.json'),
    promptSha256: sha256(prompt), canonicalPromptSha256: sha256(canonical),
    strictPrompt: prompt === canonical && promptMatchesCapture, promptMatchesCapture,
    capturedPromptSha256: capturedPrompt === null ? null : sha256(capturedPrompt), answerSha256: sha256(answer),
    answerPath: resolve(root, 'answer.txt'), exitCode, timedOut,
    evidenceRoot: resolve(evidenceRoot),
    localProcess: parsed.provider !== 't3',
    failureCode: timedOut ? 'timeout' : status === 'incomplete'
      ? parsed.failureCode ?? (['execution_failed', 'executable_unavailable'].includes(failureCode) ? failureCode : 'execution_failed') : null,
  };
  // Reserve the attempt before writing evidence: the same target can never be overwritten or retried in place.
  await put(root, 'reservation.json', JSON.stringify({ id, question, at: new Date().toISOString() }));
  await put(root, 'prompt.txt', prompt);
  await put(root, 'transcript.json', captureText);
  await put(root, 'answer.txt', answer);
  await put(root, 'audit.json', JSON.stringify(audit, null, 2));
  const reviewed = review.answerSha256 === sha256(answer) ? review : {};
  if (status === 'completed' && parsed.auditStatus !== 'violation') {
    if (question === 'candy') record.score = scoreCandy(answer, reviewed);
    else {
      const validation = validatePelican(answer);
      const { html, ...staticEvidence } = validation;
      await put(root, 'static.json', JSON.stringify(staticEvidence, null, 2));
      if (html) {
        await put(root, 'answer.html', html);
        record.htmlPath = resolve(root, 'answer.html');
      }
      record.score = validation.completeDocument ? await scorePelican(html, reviewed, evidenceRoot)
        : { question, overall: 'incomplete' };
    }
  }
  if (question === 'pelican') {
    const referenced = new Set();
    for (const item of Array.isArray(reviewed.criteria) ? reviewed.criteria : []) {
      for (const file of Array.isArray(item?.evidence) ? item.evidence : []) referenced.add(file);
    }
    for (const frame of Array.isArray(reviewed.visual?.frames) ? reviewed.visual.frames : []) referenced.add(frame.file);
    const evidenceManifest = [];
    for (const file of referenced) {
      if (await evidenceExists(evidenceRoot, file)) {
        const path = await realpath(resolve(evidenceRoot, file));
        evidenceManifest.push({ file, path, sha256: sha256(await readFile(path)) });
      }
    }
    record.evidenceManifestPath = resolve(root, 'evidence-manifest.json');
    await put(root, 'evidence-manifest.json', JSON.stringify(evidenceManifest, null, 2));
  }
  record.outcome = parsed.auditStatus === 'violation' ? 'violation' : status === 'incomplete' ? 'incomplete'
    : !record.strictPrompt ? 'sample' : record.score?.overall ?? 'review';
  await put(root, 'assessment.json', JSON.stringify({ at: new Date().toISOString(), record, review }, null, 2));
  return record;
}
const label = { pass: '通过', fail: '不通过', review: '待复核', violation: '违规作废',
  incomplete: '未完成', sample: '提示不同的样例', clean: '审计完整', unverified: '未审计', completed: '运行完成' };
const md = (value) => String(value ?? '').replace(/[\r\n|]/g, ' ').replace(/[<>]/g, '');
export async function writeRunReport(root, records, { planned = records.length } = {}) {
  const summary = { planned, recorded: records.length, missing: Math.max(0, planned - records.length),
    completed: 0, pass: 0, fail: 0, review: 0, violation: 0, incomplete: 0, sample: 0, unverified: 0, pendingReview: 0 };
  for (const record of records) {
    if (record.status === 'completed') summary.completed++;
    if (Object.hasOwn(summary, record.outcome)) summary[record.outcome]++;
    if (record.auditStatus === 'unverified') summary.unverified++;
    if (record.score?.overall === 'review') summary.pendingReview++;
  }
  const lines = ['# Agent 测试结果', '', '生成时间：' + new Date().toISOString(), '',
    '计划 ' + planned + ' 次；已记录 ' + records.length + ' 次；缺记录 ' + summary.missing + ' 次。',
    '运行完成 ' + summary.completed + '；通过 ' + summary.pass + '；不通过 ' + summary.fail
      + '；待复核 ' + summary.pendingReview + '；违规 ' + summary.violation + '；未完成 ' + summary.incomplete
      + '；提示不同样例 ' + summary.sample + '；未审计 ' + summary.unverified + '。', '',
    '未审计与待复核为独立标记，可与样例等结果重叠；单次结果不证明稳定能力或智商。', ''];
  for (const record of records) {
    lines.push('- ' + md(record.id) + '：' + (label[record.outcome] ?? '未知')
      + '；' + (label[record.auditStatus] ?? '未知') + '；作答 ' + md(record.answerPath));
    if (record.sourceLink) lines.push('  子会话：' + record.sourceLink);
    if (record.failureCode) lines.push('  失败分类：' + record.failureCode);
    if (record.question === 'pelican') lines.push('  视觉证据根目录：' + md(record.evidenceRoot));
    if (record.score?.numeric) lines.push('  数字引用：' + md(record.score.numeric.quote)
      + '；判定：' + (label[record.score.numeric.status] ?? '未知'));
    for (const item of record.score?.criteria ?? []) lines.push('  ' + md(item.id) + '：'
      + (label[item.status] ?? '未知') + '；' + md(item.reason)
      + (item.quote ? '；引用：' + md(item.quote) : '')
      + (item.evidence?.length ? '；证据：' + item.evidence.map(md).join(', ') : ''));
  }
  await put(root, 'manifest.json', JSON.stringify({ summary, records }, null, 2));
  await put(root, 'report.md', lines.join('\n') + '\n');
  const items = records.filter((record) => record.htmlPath).map((record) => ({
    id: record.id, label: record.id + ' · ' + (label[record.outcome] ?? '未知'), htmlPath: record.htmlPath,
  }));
  if (items.length) await put(root, 'gallery.html', buildGallery(items));
  return summary;
}
