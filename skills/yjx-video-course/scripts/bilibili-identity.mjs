export async function readBilibiliPageIdentity(tab) {
  return tab.playwright.evaluate(() => {
    const url = new URL(location.href);
    const bvid = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)
      ? url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] ?? url.searchParams.get('bvid') : null;
    const episode = url.searchParams.get('p');
    const page = Number(episode ?? 1);
    const initial = window.__INITIAL_STATE__ ?? {};
    const initialBvid = initial.bvid ?? initial.videoData?.bvid;
    const selected = initialBvid === bvid
      ? (Array.isArray(initial.videoData?.pages) ? initial.videoData.pages.find((item) => Number(item.page) === page) : null)
        ?? initial.cidMap?.[page]
      : null;
    const directCid = initialBvid === bvid && Number(initial.p) === page ? initial.cid : null;
    const video = document.querySelector('video');
    return {
      bvid, episode, page,
      cid: selected?.cid != null ? String(selected.cid) : directCid != null ? String(directCid) : null,
      aid: initialBvid === bvid ? initial.aid ?? initial.videoData?.aid ?? null : null,
      part: selected?.part ?? null,
      source_duration: selected?.duration ?? null,
      title: document.querySelector('h1')?.innerText?.trim() ?? document.title ?? null,
      duration: Number.isFinite(video?.duration) ? video.duration : null,
      url: location.href,
    };
  });
}

export function sameBilibiliPage(left, right) {
  return left.bvid === right.bvid && left.page === right.page
    && (!left.title || !right.title || left.title === right.title)
    && !(Number.isFinite(left.duration) && Number.isFinite(right.duration) && Math.abs(left.duration - right.duration) > 1);
}

async function resolveFromBrowser(tab, bvid, page) {
  const cdp = await tab.capabilities.get('cdp');
  // The host's read-only DOM scope may omit fetch and initial state. Execute
  // the site's normal API request in the actual tab, returning public fields
  // only. No cookie/token values leave the browser.
  const lookup = async (expectedBvid, expectedPage) => {
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(expectedBvid)}`, {
      credentials: 'include', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { status: 'cid_unresolved', reason: `view API HTTP ${response.status}` };
    const payload = await response.json();
    if (payload.code !== 0 || payload.data?.bvid !== expectedBvid) return { status: 'cid_unresolved', reason: 'view API identity unavailable' };
    const selected = payload.data.pages?.find((item) => item.page === expectedPage);
    if (!selected?.cid) return { status: 'cid_unresolved', reason: 'requested part not found' };
    return { status: 'cid_resolved', cid: String(selected.cid), aid: payload.data.aid, part: selected.part, duration_seconds: selected.duration };
  };
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(${lookup.toString()})(${JSON.stringify(bvid)},${page})`,
    awaitPromise: true, returnByValue: true,
  });
  return result?.result?.value ?? { status: 'cid_unresolved', reason: 'browser part lookup failed' };
}

export async function resolveBilibiliIdentity(tab, { resolveCid } = {}) {
  if (!tab?.playwright?.evaluate) throw new Error('resolveBilibiliIdentity requires a browser tab with playwright.evaluate');
  const before = await readBilibiliPageIdentity(tab);
  if (!before.bvid || !/^\d+$/.test(String(before.episode ?? 1)) || !Number.isSafeInteger(before.page) || before.page < 1) {
    return { ...before, cid: null, status: 'identity_unavailable', reason: 'invalid BV or part number' };
  }
  let identity = before;
  let cidSource = 'page_mapping';
  if (!/^\d+$/.test(String(identity.cid))) {
    let resolved;
    try { resolved = resolveCid ? await resolveCid(before.bvid, before.page) : await resolveFromBrowser(tab, before.bvid, before.page); }
    catch { return { ...before, cid: null, status: 'identity_unavailable', reason: 'public part lookup failed' }; }
    if (resolved.status !== 'cid_resolved') return { ...before, cid: null, status: 'identity_unavailable', reason: resolved.reason };
    identity = { ...before, cid: resolved.cid, aid: resolved.aid ?? null, part: resolved.part, source_duration: resolved.duration_seconds };
    cidSource = resolveCid ? 'provided_lookup' : 'browser_view';
  }
  const after = await readBilibiliPageIdentity(tab);
  if (!sameBilibiliPage(before, after) || (after.cid && after.cid !== identity.cid)) {
    return { ...after, cid: null, status: 'source_changed' };
  }
  if (Number.isFinite(identity.source_duration) && Number.isFinite(after.duration)
    && Math.abs(identity.source_duration - after.duration) > 1) {
    return { ...identity, cid: null, status: 'player_identity_mismatch' };
  }
  return { ...identity, duration: after.duration, status: 'identity_verified', cid_source: cidSource };
}
