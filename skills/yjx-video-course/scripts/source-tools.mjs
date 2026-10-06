#!/usr/bin/env node

import process from 'node:process';

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
  }

  return result;
}

function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error('Usage: source-tools.mjs <video-url> [<video-url> ...]');
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(urls.map(inspectSourceUrl), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
