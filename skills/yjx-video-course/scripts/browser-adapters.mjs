import {
  classifyBilibiliSession,
  nextActionForSessionOutcome,
  sessionOutcomeForMissingQuality,
} from './bilibili-session-status.mjs';
import { resolveBilibiliIdentity, sameBilibiliPage } from './bilibili-identity.mjs';

function status(value, detail = null) {
  return { status: value, ...(detail ? { detail } : {}) };
}

function decodeResponseBody(body) {
  if (!body?.base64Encoded) return Buffer.from(body?.body ?? '', 'utf8');
  return Buffer.from(body.body ?? '', 'base64');
}

export function classifyBilibiliSubtitleBody(body) {
  if (typeof body?.body !== 'string') return { status: 'subtitle_response_unavailable' };
  const bytes = decodeResponseBody(body);
  if (bytes.length === 0 || (bytes.length === 2 && bytes[0] === 0x0a && bytes[1] === 0x00)) {
    return { status: 'subtitle_empty_response', bytes: bytes.length };
  }
  const text = bytes.toString('utf8').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const value = JSON.parse(text);
      if (Array.isArray(value?.body) && value.body.length === 0) return { status: 'subtitle_empty_response', bytes: bytes.length };
      if (Array.isArray(value?.body) && value.body.length > 0 && value.body.every((cue) => (
        Number.isFinite(cue.from) && cue.from >= 0 && Number.isFinite(cue.to) && cue.to > cue.from
        && typeof cue.content === 'string' && cue.content.trim().length > 0
      ))) return { status: 'subtitle_exported', format: 'json', value };
      return { status: 'subtitle_response_unparsed', format: 'json', bytes: bytes.length };
    } catch {
      return { status: 'subtitle_response_unparsed', format: 'json', bytes: bytes.length };
    }
  }
  return {
    status: 'subtitle_response_unparsed',
    format: 'protobuf_or_binary',
    bytes: bytes.length,
    base64: bytes.toString('base64'),
  };
}

function metadataMatches(url, identity) {
  const parsed = new URL(url);
  const params = parsed.searchParams;
  const player = ['/x/player/v2', '/x/player/wbi/v2'].includes(parsed.pathname);
  const subtitle = parsed.pathname === '/x/v2/subtitle/web/view';
  // On subtitle/web/view only, the observed oid/pid pair means CID/aid.
  const target = params.has('cid') ? params.get('cid') === String(identity.cid)
    : subtitle && params.get('oid') === String(identity.cid) && params.get('pid') === String(identity.aid);
  return parsed.hostname === 'api.bilibili.com' && (player || subtitle) && target
    && (!params.has('oid') || !subtitle || params.get('oid') === String(identity.cid))
    && (!params.has('pid') || !subtitle || params.get('pid') === String(identity.aid))
    && (!parsed.searchParams.has('bvid') || parsed.searchParams.get('bvid') === identity.bvid)
    && (!parsed.searchParams.has('aid') || parsed.searchParams.get('aid') === String(identity.aid));
}

export function matchesBilibiliSubtitleFile(url, identity, linkedUrls = []) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'aisubtitle.hdslb.com') return false;
  if (linkedUrls.includes(parsed.href)) return true;
  // Observed Bilibili AI-subtitle filenames bind aid + cid + a 32-hex hash.
  // Match the entire path, never a CID substring or the domain alone.
  if (!/^\d+$/.test(String(identity.aid)) || !/^\d+$/.test(String(identity.cid))) return false;
  return new RegExp(`^/bfs/ai_subtitle/prod/${identity.aid}${identity.cid}[a-f0-9]{32}$`, 'i').test(parsed.pathname);
}

async function activateBilibiliSubtitleTrack(tab) {
  const button = tab.playwright.locator('.bpx-player-ctrl-subtitle-result');
  if (await button.count() === 0) return false;
  await button.click();
  await tab.playwright.waitForTimeout(250);
  const language = tab.playwright.getByText('中文', { exact: true });
  if (await language.count() > 0 && await language.isVisible()) {
    await language.click();
    return true;
  }
  const track = tab.playwright.locator('.bpx-player-ctrl-subtitle-language-item').first();
  if (await track.count() > 0 && await track.isVisible()) {
    await track.click();
    return true;
  }
  return false;
}

export async function inspectYouTubeTab(tab) {
  const url = await tab.url();
  const title = await tab.title();
  const dom = await tab.playwright.domSnapshot();
  const video = await tab.playwright.evaluate(() => {
    const element = document.querySelector('video');
    return element ? { duration: element.duration, currentTime: element.currentTime, paused: element.paused } : null;
  });
  const access = dom.includes('请登录，以便我们确认你不是聊天机器人') || dom.includes('登录')
    ? status('login_or_verification_required')
    : dom.includes('账号菜单')
      ? status('confirmed')
      : status('unverified');
  return {
    platform: 'youtube',
    url,
    title,
    access,
    identity: status(title ? 'page_loaded' : 'unverified'),
    duration_seconds: Number.isFinite(video?.duration) ? video.duration : null,
    subtitle_ui: /button "[^"]*字幕[^"]*"/.test(dom) ? status('visible') : status('unverified'),
    player: video,
  };
}

export async function exportYouTubeTranscript(tab) {
  const path = await tab.content.exportYouTubeTranscript();
  return {
    platform: 'youtube',
    transcript: status('exported'),
    path,
  };
}

export async function inspectBilibiliTab(tab) {
  const url = await tab.url();
  const title = await tab.title();
  const dom = await tab.playwright.domSnapshot();
  const state = await tab.playwright.evaluate(() => {
    const element = document.querySelector('video');
    // Bilibili keeps multiple copies of the user state. The page-level
    // __INITIAL_STATE__.user can lag behind login or reflect a server-rendered
    // anonymous shell. Cross-check the runtime player/store before concluding
    // that a logged-in Codex browser session is anonymous.
    return {
      session_signals: {
        initialStateUser: window.__INITIAL_STATE__?.user ?? null,
        playinfoUser: window.__playinfo__?.user ?? null,
        playerUser: window.player?.getUserInfo?.() ?? null,
        hasAvatar: Boolean(document.querySelector('.header-avatar-wrap, .bili-avatar, .header-entry-avatar')),
        hasLoginEntry: Boolean(document.querySelector('.header-login-entry, .go-login-btn, .login-btn')),
      },
      video: element ? { duration: element.duration, currentTime: element.currentTime, paused: element.paused } : null,
    };
  });
  const session = classifyBilibiliSession(state.session_signals);
  const access = session.state === 'logged_in'
    ? status('confirmed', { session: session.state, evidence: session.evidence })
    : session.state === 'logged_out'
      ? status('login_or_verification_required', { session: session.state, evidence: session.evidence })
      : status('unverified', { session: session.state, evidence: session.evidence });
  const sessionOutcome = sessionOutcomeForMissingQuality(session);
  return {
    platform: 'bilibili',
    url,
    title,
    access,
    session: {
      state: session.state,
      evidence: session.evidence,
      outcome_if_capability_missing: sessionOutcome,
      next_action: nextActionForSessionOutcome(sessionOutcome),
    },
    identity: status(title ? 'page_loaded' : 'unverified'),
    duration_seconds: Number.isFinite(state.video?.duration) ? state.video.duration : null,
    chapters: dom.includes('章节') ? status('visible') : status('unverified'),
    subtitle_ui: /button "[^"]*字幕[^"]*"/.test(dom) ? status('visible') : status('unverified'),
    player: state.video,
  };
}

export async function captureBilibiliSubtitle(
  tab,
  { reload = true, waitMs = 4000, activateTrack = true, resolveIdentity = resolveBilibiliIdentity, expectedIdentity = null } = {},
) {
  const identity = await resolveIdentity(tab);
  if (!identity.cid || identity.status !== 'identity_verified') return {
    status: 'subtitle_identity_unverified', identity_status: identity.status, reason: identity.reason,
    source_identity: { bvid: identity.bvid, page: identity.page, cid: identity.cid,
      duration: identity.duration, source_duration: identity.source_duration },
  };
  if (expectedIdentity && (!sameBilibiliPage(expectedIdentity, identity) || expectedIdentity.cid !== identity.cid)) {
    return { status: 'source_changed' };
  }
  const cdp = await tab.capabilities.get('cdp');
  await cdp.send('Network.enable');
  const before = await cdp.readEvents({ methods: ['Network.responseReceived'], limit: 1 });
  if (reload) await tab.reload();
  await tab.playwright.waitForTimeout(waitMs);
  const events = [];
  let cursor = before.cursor;
  const collect = async () => {
    for (let count = 0; count < 3; count += 1) {
      const page = await cdp.readEvents({ afterSequence: cursor, methods: ['Network.responseReceived'], limit: 1000 });
      events.push(...page.events);
      cursor = page.cursor;
      if (!page.hasMore) return;
    }
  };
  await collect();
  const responseOf = (event) => event.params?.response;
  const linkedUrls = [];
  let metadataResult = null;
  let metadataResponse = null;
  const processed = new Set();
  const processMetadata = async () => {
    for (const event of events) {
      if (processed.has(event.params?.requestId) || !responseOf(event)?.url || !metadataMatches(responseOf(event).url, identity)) continue;
      processed.add(event.params.requestId);
      const body = await cdp.send('Network.getResponseBody', { requestId: event.params.requestId });
      metadataResult = classifyBilibiliSubtitleBody(body);
      metadataResponse = responseOf(event);
      try {
        const value = JSON.parse(decodeResponseBody(body).toString('utf8'));
        const tracks = value.data?.subtitle?.subtitles ?? value.subtitle?.subtitles ?? value.subtitles ?? [];
        for (const track of tracks) if (track.subtitle_url) linkedUrls.push(new URL(track.subtitle_url, responseOf(event).url).href);
      } catch { /* Binary metadata may still be followed by a linked AI file. */ }
    }
  };
  await processMetadata();
  const files = () => events.filter((event) => responseOf(event)?.url && matchesBilibiliSubtitleFile(responseOf(event).url, identity, linkedUrls));
  let trackActivated = false;
  if (files().length === 0 && (linkedUrls.length > 0 || !['subtitle_exported', 'subtitle_empty_response'].includes(metadataResult?.status)) && activateTrack) {
    trackActivated = await activateBilibiliSubtitleTrack(tab);
    if (trackActivated) {
      await tab.playwright.waitForTimeout(1000);
      await collect();
      await processMetadata();
    }
  }
  const file = files().at(-1);
  const finalClassified = file
    ? classifyBilibiliSubtitleBody(await cdp.send('Network.getResponseBody', { requestId: file.params.requestId }))
    : metadataResult;
  const after = await resolveIdentity(tab);
  if (after.status !== 'identity_verified' || !sameBilibiliPage(identity, after) || identity.cid !== after.cid) return { status: 'source_changed' };
  if (!finalClassified) return { status: 'subtitle_request_not_observed', track_activated: trackActivated };
  if (!file && linkedUrls.length > 0 && finalClassified.status !== 'subtitle_exported') return {
    status: 'subtitle_track_not_loaded', track_activated: trackActivated,
    source_identity: { bvid: identity.bvid, page: identity.page, cid: identity.cid, aid: identity.aid },
  };
  const response = file ? responseOf(file) : metadataResponse;
  return {
    ...finalClassified,
    track_activated: trackActivated,
    source_identity: { bvid: identity.bvid, page: identity.page, cid: identity.cid, aid: identity.aid },
    source_url: new URL(response.url).origin + new URL(response.url).pathname,
    http_status: response.status,
  };
}

export async function inspectVideoTab(tab) {
  const url = await tab.url();
  if (/youtube\.com|youtu\.be/i.test(url)) return inspectYouTubeTab(tab);
  if (/bilibili\.com|b23\.tv/i.test(url)) return inspectBilibiliTab(tab);
  return { platform: 'generic', url, access: status('unverified') };
}
