function status(value, detail = null) {
  return { status: value, ...(detail ? { detail } : {}) };
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
  const video = await tab.playwright.evaluate(() => {
    const element = document.querySelector('video');
    return element ? { duration: element.duration, currentTime: element.currentTime, paused: element.paused } : null;
  });
  const access = dom.includes('登录') && !dom.includes('稍后再看')
    ? status('login_or_verification_required')
    : status('confirmed');
  return {
    platform: 'bilibili',
    url,
    title,
    access,
    identity: status(title ? 'page_loaded' : 'unverified'),
    duration_seconds: Number.isFinite(video?.duration) ? video.duration : null,
    chapters: dom.includes('章节') ? status('visible') : status('unverified'),
    subtitle_ui: /button "[^"]*字幕[^"]*"/.test(dom) ? status('visible') : status('unverified'),
    player: video,
  };
}

export async function inspectVideoTab(tab) {
  const url = await tab.url();
  if (/youtube\.com|youtu\.be/i.test(url)) return inspectYouTubeTab(tab);
  if (/bilibili\.com|b23\.tv/i.test(url)) return inspectBilibiliTab(tab);
  return { platform: 'generic', url, access: status('unverified') };
}
