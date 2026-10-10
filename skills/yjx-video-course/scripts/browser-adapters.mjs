import {
  classifyBilibiliSession,
  nextActionForSessionOutcome,
  sessionOutcomeForMissingQuality,
} from './bilibili-session-status.mjs';

function status(value, detail = null) {
  return { status: value, ...(detail ? { detail } : {}) };
}

function decodeResponseBody(body) {
  if (!body?.base64Encoded) return Buffer.from(body?.body ?? '', 'utf8');
  return Buffer.from(body.body ?? '', 'base64');
}

export function classifyBilibiliSubtitleBody(body) {
  const bytes = decodeResponseBody(body);
  if (bytes.length === 0 || (bytes.length === 2 && bytes[0] === 0x0a && bytes[1] === 0x00)) {
    return { status: 'subtitle_empty_response', bytes: bytes.length };
  }
  const text = bytes.toString('utf8').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const value = JSON.parse(text);
      return { status: 'subtitle_exported', format: 'json', value };
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

function subtitleResponseUrl(url) {
  return /(?:\/x\/v2\/subtitle\/web\/view|aisubtitle\.hdslb\.com\/)/i.test(url ?? '');
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
  { reload = true, waitMs = 4000, activateTrack = true } = {},
) {
  const cdp = await tab.capabilities.get('cdp');
  await cdp.send('Network.enable');
  const before = await cdp.readEvents({ methods: ['Network.responseReceived'], limit: 1 });
  if (reload) await tab.reload();
  await tab.playwright.waitForTimeout(waitMs);
  let page = await cdp.readEvents({
    afterSequence: before.cursor,
    methods: ['Network.responseReceived'],
    limit: 1000,
  });
  let responses = page.events.filter((event) => /\/x\/v2\/subtitle\/web\/view(?:\?|$)/i.test(event.params?.response?.url ?? ''));
  let trackActivated = false;
  if (responses.length === 0 && activateTrack) {
    const afterActivation = await cdp.readEvents({ methods: ['Network.responseReceived'], limit: 1 });
    trackActivated = await activateBilibiliSubtitleTrack(tab);
    if (trackActivated) {
      await tab.playwright.waitForTimeout(1000);
      page = await cdp.readEvents({
        afterSequence: afterActivation.cursor,
        methods: ['Network.responseReceived'],
        limit: 1000,
      });
      responses = page.events.filter((event) => /\/x\/v2\/subtitle\/web\/view(?:\?|$)/i.test(event.params?.response?.url ?? ''));
    }
  }
  if (responses.length === 0) {
    return {
      status: 'subtitle_request_not_observed',
      track_activated: trackActivated,
    };
  }
  let response = responses.at(-1);
  let body = await cdp.send('Network.getResponseBody', { requestId: response.params.requestId });
  const classified = classifyBilibiliSubtitleBody(body);
  if (activateTrack && !trackActivated && classified.status === 'subtitle_response_unparsed') {
    const afterMetadata = await cdp.readEvents({ methods: ['Network.responseReceived'], limit: 1 });
    if (await activateBilibiliSubtitleTrack(tab)) {
      trackActivated = true;
      await tab.playwright.waitForTimeout(1000);
      const activated = await cdp.readEvents({
        afterSequence: afterMetadata.cursor,
        methods: ['Network.responseReceived'],
        limit: 1000,
      });
      const subtitleFiles = activated.events.filter((event) => subtitleResponseUrl(event.params?.response?.url));
      const fileResponse = subtitleFiles.find((event) => /aisubtitle\.hdslb\.com/i.test(event.params.response.url));
      if (fileResponse) {
        response = fileResponse;
        body = await cdp.send('Network.getResponseBody', { requestId: response.params.requestId });
      }
    }
  }
  const finalClassified = classifyBilibiliSubtitleBody(body);
  return {
    ...finalClassified,
    track_activated: trackActivated,
    source_url: new URL(response.params.response.url).origin + new URL(response.params.response.url).pathname,
    http_status: response.params.response.status,
  };
}

export async function inspectVideoTab(tab) {
  const url = await tab.url();
  if (/youtube\.com|youtu\.be/i.test(url)) return inspectYouTubeTab(tab);
  if (/bilibili\.com|b23\.tv/i.test(url)) return inspectBilibiliTab(tab);
  return { platform: 'generic', url, access: status('unverified') };
}
