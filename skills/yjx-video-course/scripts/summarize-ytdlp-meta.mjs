#!/usr/bin/env node
/**
 * Redacted yt-dlp metadata & subtitle track summarizer.
 * Reads --dump-single-json output without exposing short-lived signed media URLs.
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { isMainModule } from './is-main.mjs';

function summarizeTrackMap(trackMap = {}, { automatic = false } = {}) {
  if (!trackMap || typeof trackMap !== 'object') return [];
  return Object.entries(trackMap).map(([lang, entries]) => {
    const list = Array.isArray(entries) ? entries : [];
    const exts = [...new Set(list.map((e) => e?.ext).filter(Boolean))];
    const names = [...new Set(list.map((e) => e?.name).filter(Boolean))];
    const isOriginal = automatic && /-orig$/i.test(lang);
    const isLikelyTranslated = automatic && !isOriginal && names.some((n) => /translat/i.test(n));
    return {
      lang,
      formats: exts,
      names,
      ...(automatic ? { track_type: isLikelyTranslated ? 'automatic_translated_candidate' : 'automatic_caption', is_orig: isOriginal } : { track_type: 'manual_or_author' }),
    };
  });
}

export function summarizeYtdlpMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('yt-dlp metadata object is required');
  if (meta._type === 'playlist' && Array.isArray(meta.entries)) {
    throw new Error('yt-dlp metadata is a playlist, not a single video');
  }
  return {
    id: meta.id ?? null,
    webpage_url: meta.webpage_url ?? null,
    title: meta.title ?? null,
    channel: meta.channel ?? meta.uploader ?? null,
    duration_seconds: Number.isFinite(meta.duration) ? meta.duration : null,
    language: meta.language ?? null,
    subtitles: summarizeTrackMap(meta.subtitles, { automatic: false }),
    automatic_captions: summarizeTrackMap(meta.automatic_captions, { automatic: true }),
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: summarize-ytdlp-meta.mjs <meta.json>');
  const raw = JSON.parse(await readFile(input, 'utf8'));
  process.stdout.write(JSON.stringify(summarizeYtdlpMeta(raw), null, 2) + '\n');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
