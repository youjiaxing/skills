#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

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

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('Usage: source-tools.mjs <video-url> [<video-url> ...]');
    process.exitCode = 2;
    return;
  }
  const results = await Promise.all(urls.map(resolveAndInspectSourceUrl));
  console.log(JSON.stringify(results, null, 2));
}

const isMain = Boolean(
  process.argv[1] && (
    pathToFileURL(process.argv[1]).href === import.meta.url ||
    process.argv[1].endsWith('source-tools.mjs')
  )
);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
