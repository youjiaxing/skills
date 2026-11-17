import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateEvidence } from '../scripts/validate-evidence.mjs';
import { summarizeYtdlpMeta } from '../scripts/summarize-ytdlp-meta.mjs';
import { verifyNotionReadback } from '../scripts/verify-notion-readback.mjs';
import { captureBilibiliSubtitle } from '../scripts/browser-adapters.mjs';

function makePngBuffer(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test('validateEvidence enforces explicit disposition, foreign keys, PNG IHDR dimensions and legacy mode', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yjx-vc-ev-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'fig1.png'), makePngBuffer(1920, 1080));

  const baseEvidence = {
    source: { source_id: 'yt:abc', duration_seconds: 100 },
    segments: [{ segment_id: 'seg1', time_start: 0, time_end: 10, evidence: ['ev1'] }],
    claims: [{ claim_id: 'c1', segment_ids: ['seg1'], evidence_ids: ['ev1'] }],
    raw_evidence: [{
      evidence_id: 'ev1',
      type: 'video_frame',
      time_start: 2,
      time_end: 5,
      visual_claim: 'CLI output',
      knowledge_segment: 'seg1',
      information_added: 'shows flag',
      why_text_evidence_is_insufficient: 'flag omitted in speech',
      duplicate_of_existing_image: false,
      disposition: 'keep',
      keep_or_discard_reason: 'necessary',
      file: 'fig1.png',
      embedded_file: 'fig1.png',
      final_image_size: { width: 1920, height: 1080 },
    }],
    visual_coverage: { embedded_files: ['fig1.png'] },
  };
  assert.equal((await validateEvidence(baseEvidence, dir)).valid, true);

  const legacy = structuredClone(baseEvidence);
  delete legacy.raw_evidence[0].disposition;
  assert.equal((await validateEvidence(legacy, dir)).valid, false);
  const legacyWarn = await validateEvidence(legacy, dir, { allowLegacyMissingDisposition: true });
  assert.equal(legacyWarn.valid, true);
  assert.match(legacyWarn.warnings[0], /legacy_missing_disposition/);

  const badDim = structuredClone(baseEvidence);
  badDim.raw_evidence[0].final_image_size = { width: 1280, height: 720 };
  assert.equal((await validateEvidence(badDim, dir)).valid, false);
});

test('summarizeYtdlpMeta strips signed format URLs and lists subtitle tracks', () => {
  const summary = summarizeYtdlpMeta({
    id: 'vid1',
    webpage_url: 'https://www.youtube.com/watch?v=vid1',
    title: 'Demo',
    uploader: 'Channel',
    duration: 120,
    formats: [{ url: 'https://signed.example.com/secret?sig=123' }],
    subtitles: { en: [{ ext: 'vtt', name: 'English' }] },
    automatic_captions: { 'zh-Hans': [{ ext: 'vtt', name: 'Chinese (auto)' }] },
  });
  assert.equal(summary.id, 'vid1');
  assert.equal(Object.hasOwn(summary, 'formats'), false);
  assert.equal(summary.subtitles[0].lang, 'en');
  assert.equal(summary.automatic_captions[0].lang, 'zh-Hans');
});

test('verifyNotionReadback checks image order, status and pending notices', () => {
  const ev = { visual_coverage: { embedded_files: ['frames/fig-01.png', 'frames/fig-02.png'] } };
  const okPage = {
    status: '已整理',
    content: '![a](notion-file-block://b1/fig-01.png)\n![b](notion-file-block://b2/fig-02.png)',
  };
  const ok = verifyNotionReadback(ev, okPage, { expectedStatus: '已整理', pageId: 'p1' });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.notion.actual_image_filenames, ['fig-01.png', 'fig-02.png']);

  const bad = verifyNotionReadback(ev, { status: '草稿', content: '![a](file-upload://u1/fig-01.png)' });
  assert.equal(bad.valid, false);
});

test('captureBilibiliSubtitle requires explicit track selection when multiple tracks exist', async () => {
  const identity = { status: 'identity_verified', bvid: 'BVmulti', page: 1, cid: '333', aid: '100', duration: 60 };
  const metaUrl = 'https://api.bilibili.com/x/player/wbi/v2?aid=100&cid=333';
  const zhUrl = 'https://aisubtitle.hdslb.com/custom/zh.json';
  const enUrl = 'https://aisubtitle.hdslb.com/custom/en.json';
  const makeTab = () => {
    let reads = 0;
    return {
      reload: async () => {},
      playwright: { waitForTimeout: async () => {}, locator: () => ({ count: async () => 0 }) },
      capabilities: {
        get: async () => ({
          send: async (method, params) => {
            if (method === 'Network.getResponseBody' && params.requestId === 'm') {
              return { body: JSON.stringify({ data: { subtitle: { subtitles: [
                { lan: 'zh-CN', lan_doc: '中文', subtitle_url: zhUrl },
                { lan: 'en-US', lan_doc: 'English', subtitle_url: enUrl },
              ] } } }) };
            }
            if (method === 'Network.getResponseBody' && params.requestId === 'en') {
              return { body: JSON.stringify({ body: [{ from: 0, to: 1, content: 'Hello' }] }) };
            }
            return {};
          },
          readEvents: async () => {
            if (reads++ === 0) return { events: [], cursor: 0, hasMore: false };
            if (reads === 2) {
              return {
                events: [
                  { params: { requestId: 'm', response: { url: metaUrl, status: 200 } } },
                  { params: { requestId: 'en', response: { url: enUrl, status: 200 } } },
                ],
                cursor: 1,
                hasMore: false,
              };
            }
            return { events: [], cursor: reads, hasMore: false };
          },
        }),
      },
    };
  };
  const needPick = await captureBilibiliSubtitle(makeTab(), { waitMs: 1, resolveIdentity: async () => identity });
  assert.equal(needPick.status, 'subtitle_track_selection_required');
  assert.equal(needPick.tracks.length, 2);

  const picked = await captureBilibiliSubtitle(makeTab(), { waitMs: 1, track: 'en-US', resolveIdentity: async () => identity });
  assert.equal(picked.status, 'subtitle_exported');
  assert.equal(picked.value.body[0].content, 'Hello');
});
