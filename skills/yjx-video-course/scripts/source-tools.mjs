#!/usr/bin/env node

import process from 'node:process';
import { isMainModule } from './is-main.mjs';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'b23.tv']);

function parseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('source URL is required');
  return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
}

function platformFor(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (YOUTUBE_HOSTS.has(host)) return 'youtube';
  if (BILIBILI_HOSTS.has(host)) return 'bilibili';
  return 'generic';
}

function firstMatch(value, patterns) {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export async function resolveRedirect(rawUrl) {
  const url = parseUrl(rawUrl);
  // 针对短链接（如 b23.tv, youtu.be, t.co 等）跟随重定向获取真实目标地址
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'b23.tv' || host === 'youtu.be' || host === 't.co') {
    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': host === 'b23.tv' ? 'https://www.bilibili.com' : 'https://www.youtube.com'
        },
        redirect: 'follow'
      });
      if (response.url) {
        return response.url;
      }
    } catch {
      // 网络受限或不可达时降级使用原始地址
    }
  }
  return url.toString();
}

export function inspectSourceUrl(raw) {
  const url = parseUrl(raw);
  const platform = platformFor(url.hostname);
  const path = decodeURIComponent(url.pathname);
  const query = url.searchParams;
  const result = {
    platform,
    original_url: String(raw).trim(),
    normalized_url: url.toString(),
    host: url.hostname,
    video_id: null,
    episode: null,
    bvid: null,
    cid: null,
    access: 'unverified',
  };

  if (platform === 'youtube') {
    result.video_id = query.get('v')
      ?? (url.hostname.toLowerCase().replace(/^www\./, '') === 'youtu.be'
        ? path.split('/').filter(Boolean)[0]
        : firstMatch(path, [/\/shorts\/([^/?]+)/, /\/live\/([^/?]+)/]));
    result.playlist_id = query.get('list');
    result.normalized_url = result.video_id
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(result.video_id)}`
      : url.toString();
  }

  if (platform === 'bilibili') {
    result.bvid = firstMatch(path, [/(BV[0-9A-Za-z]+)/i])
      ?? query.get('bvid')
      ?? null;
    result.cid = query.get('cid') ?? query.get('oid') ?? null;
    result.episode = query.get('p') ?? null;
    result.normalized_url = result.bvid
      ? `https://www.bilibili.com/video/${result.bvid}${result.episode ? `?p=${encodeURIComponent(result.episode)}` : ''}`
      : url.toString();
    result.anti_leech_headers = {
      'Referer': 'https://www.bilibili.com',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
  }

  return result;
}

export async function resolveAndInspectSourceUrl(raw) {
  const resolvedUrl = await resolveRedirect(raw);
  const info = inspectSourceUrl(resolvedUrl);
  if (resolvedUrl !== String(raw).trim()) {
    info.redirected_from = String(raw).trim();
  }
  return info;
}

const BILIBILI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function anonymousCookieFrom(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  // 只保留匿名设备标识（buvid3/b_nut），不携带任何登录 Cookie。
  return raw
    .map((line) => String(line).split(';')[0])
    .filter((pair) => /^(buvid3|buvid4|b_nut)=/.test(pair))
    .join('; ');
}

// 用公开 view 接口解析 BV 号与分集对应的 cid、标题和时长。
// 遇到 HTTP 412（反爬）时，先访问首页取得匿名 buvid 设备 Cookie 再重试一次。
// 结果属于匿名请求（anonymous_request），只用于身份解析，不能用来判断登录态。
export async function resolveBilibiliCid(bvid, page = 1, { fetchImpl = fetch } = {}) {
  const headers = { 'User-Agent': BILIBILI_UA, Referer: 'https://www.bilibili.com/' };
  const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  let response = await fetchImpl(viewUrl, { headers });
  let usedAnonymousCookie = false;
  if (response.status === 412) {
    const home = await fetchImpl('https://www.bilibili.com/', { headers });
    const cookie = anonymousCookieFrom(home);
    if (cookie) {
      usedAnonymousCookie = true;
      response = await fetchImpl(viewUrl, { headers: { ...headers, Cookie: cookie } });
    }
  }
  if (!response.ok) {
    return { status: 'cid_unresolved', reason: `view API HTTP ${response.status}`, used_anonymous_cookie: usedAnonymousCookie };
  }
  const payload = await response.json();
  if (payload.code !== 0 || !payload.data) {
    return { status: 'cid_unresolved', reason: `view API code=${payload.code} message=${payload.message}`, used_anonymous_cookie: usedAnonymousCookie };
  }
  const pageNumber = Number(page) || 1;
  const entry = (payload.data.pages ?? []).find((item) => Number(item.page) === pageNumber);
  if (!entry) {
    return { status: 'cid_unresolved', reason: `page ${pageNumber} not found`, used_anonymous_cookie: usedAnonymousCookie };
  }
  return {
    status: 'cid_resolved',
    request_mode: 'anonymous_request',
    used_anonymous_cookie: usedAnonymousCookie,
    cid: String(entry.cid),
    page: pageNumber,
    part: entry.part,
    duration_seconds: entry.duration,
    title: payload.data.title,
    owner: payload.data.owner?.name ?? null,
    aid: payload.data.aid,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const resolveCid = args.includes('--resolve-cid');
  const urls = args.filter((arg) => arg !== '--resolve-cid');
  if (urls.length === 0) {
    console.error('Usage: source-tools.mjs [--resolve-cid] <video-url> [<video-url> ...]');
    process.exitCode = 2;
    return;
  }
  const results = await Promise.all(urls.map(resolveAndInspectSourceUrl));
  if (resolveCid) {
    for (const info of results) {
      if (info.platform !== 'bilibili' || !info.bvid || info.cid) continue;
      try {
        const identity = await resolveBilibiliCid(info.bvid, info.episode ?? 1);
        info.identity = identity;
        if (identity.status === 'cid_resolved') info.cid = identity.cid;
      } catch (error) {
        info.identity = { status: 'cid_unresolved', reason: error.message };
      }
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
