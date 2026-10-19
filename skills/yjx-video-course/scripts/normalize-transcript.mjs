#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { isMainModule } from './is-main.mjs';
import process from 'node:process';

const TIMESTAMP_RE = /^\[(?<time>\d+:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]\s*(?<text>.*)$/;
const FORMATS = new Set(['auto', 'text', 'vtt', 'srt']);
const INLINE_TIME = /<\d{2,}:\d{2}(?::\d{2})?\.\d{3}>/;
const HELP = `Usage: normalize-transcript.mjs --input <file> [--output <file>]
  --format auto|text|vtt|srt   Default: auto
  --duration <seconds>        Infer the final end time for [mm:ss] text only
  --language <code>           Selected track language
  --captions <type>           manual, automatic, translated, or a source label
  --dedupe-rolling            Opt in for automatic subtitle display cleanup;
                            requires --captions automatic and VTT/SRT input

Times are seconds (including milliseconds). Keep the original subtitle file;
normalization.cue_map uses one-based source cue and output entry numbers.
`;

export function parseTimestamp(value) {
  const match = String(value).match(/^(?:(\d+):)?(\d+):([0-5]\d)(?:[.,](\d{1,3}))?$/);
  if (!match || (match[1] !== undefined && Number(match[2]) >= 60)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  const milliseconds = Number((match[4] ?? '').padEnd(3, '0'));
  const seconds = (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) + milliseconds / 1000;
  if (!Number.isFinite(seconds)) throw new Error(`invalid timestamp: ${value}`);
  return seconds;
}

function cleanCueText(value) {
  // Strip subtitle markup BEFORE decoding entities: &lt;code&gt; is spoken
  // technical content, not a markup tag to discard.
  const entities = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '\u200e', rlm: '\u200f' };
  return value
    .replace(new RegExp(INLINE_TIME.source, 'g'), '')
    .replace(/<\/?(?:b|i|u|c(?:\.[\w-]+)*|v|lang|ruby|rt)(?:\s+[^<>]*)?>/g, '')
    .replace(/<\/?font(?:\s+[^<>]*)?>/gi, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos|lrm|rlm);/gi, (raw, entity) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? raw;
      const point = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : raw;
    })
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

function parseCues(text, format) {
  // YouTube VTT uses a space-only payload line to hold an empty display row.
  // Only truly empty lines separate VTT cues; SRT tolerates padded separators.
  const blocks = text.trim().split(format === 'vtt' ? /\n{2,}/ : /\n[\t ]*\n/);
  if (format === 'vtt' && /^WEBVTT(?:[\t ]|$)/.test(blocks[0]?.split('\n')[0])) blocks.shift();
  const cues = [];
  for (const block of blocks) {
    if (format === 'vtt' && /^(?:NOTE(?:[\t ]|\n|$)|(?:STYLE|REGION)[\t ]*(?:\n|$))/.test(block)) continue;
    const lines = block.split('\n');
    const timingIndex = lines[0].includes('-->') ? 0 : 1;
    const match = lines[timingIndex]?.trim().match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
    if (!match || timingIndex > lines.length - 2) throw new Error(`invalid ${format} cue ${cues.length + 1}`);
    const from = parseTimestamp(match[1]);
    const to = parseTimestamp(match[2]);
    if (to <= from) throw new Error(`cue ${cues.length + 1}: end must follow start`);
    if (cues.length && from < cues.at(-1).from) throw new Error(`cue ${cues.length + 1}: start times must be nondecreasing`);
    const payload = lines.slice(timingIndex + 1);
    const displayLines = payload.map((line) => ({
      text: cleanCueText(line), timed: INLINE_TIME.test(line), plain: !/<[^>]+>/.test(line),
    })).filter((line) => line.text);
    cues.push({ from, to, text: cleanCueText(payload.join('\n')), displayLines });
  }
  return cues;
}

function touchingDisplayPrefixes(cues) {
  const prefixes = new Map();
  for (let index = 1; index < cues.length - 1; index += 1) {
    const previous = cues[index - 1];
    const snapshot = cues[index];
    const next = cues[index + 1];
    const priorLine = previous.displayLines.at(-1);
    const [snapshotLine] = snapshot.displayLines;
    const [carriedLine, freshLine] = next.displayLines;
    // Real YouTube ASR VTT uses a 10ms plain redisplay between timed rows.
    // Require the entire three-cue pattern, not merely touching equal text.
    if (previous.to !== snapshot.from || snapshot.to !== next.from
      || Math.abs(snapshot.to - snapshot.from - 0.01) > 1e-6
      || !priorLine?.timed || snapshot.displayLines.length !== 1 || !snapshotLine?.plain
      || next.displayLines.length !== 2 || !carriedLine.plain || !freshLine.timed
      || priorLine.text !== snapshotLine.text || carriedLine.text !== snapshotLine.text) continue;
    prefixes.set(index, snapshot.text);
    prefixes.set(index + 1, `${carriedLine.text}\n`);
  }
  return prefixes;
}

function rollingPrefix(previous, current) {
  // Only overlapping display windows can roll. Touching or disjoint cues may
  // be genuine repeated speech and must remain separate.
  if (!previous || previous.to <= current.from) return '';
  for (let size = Math.min(previous.text.length, current.text.length); size > 0; size -= 1) {
    const prefix = current.text.slice(0, size);
    if (!previous.text.endsWith(prefix)) continue;
    const before = previous.text.at(-size - 1) ?? '';
    const after = current.text[size] ?? '';
    const wordChar = (char) => /[\p{L}\p{N}_]/u.test(char) && !/\p{Script=Han}/u.test(char);
    if ((wordChar(before) && wordChar(prefix[0])) || (wordChar(prefix.at(-1)) && wordChar(after))) continue;
    // A single shared word at a sentence boundary can be real emphasis.
    // Leave that ambiguous case intact unless the entire old cue repeats.
    if (prefix !== previous.text && /^[\p{L}\p{N}_]+$/u.test(prefix) && !/\p{Script=Han}/u.test(prefix)) continue;
    if (prefix.trim().length < 2 && prefix !== previous.text && prefix !== current.text) continue;
    return prefix;
  }
  return '';
}

function parseTimedText(text, durationSeconds) {
  const body = [];
  for (const line of text.split('\n')) {
    const match = line.match(TIMESTAMP_RE);
    if (!match) continue;
    const from = parseTimestamp(match.groups.time);
    const value = match.groups.text.trim();
    if (!value) continue;
    const previous = body.at(-1);
    if (previous && from < previous.from) throw new Error('text start times must be nondecreasing');
    if (previous?.from === from) previous.text += ` ${value}`;
    else body.push({ from, to: null, text: value });
  }
  for (let index = 0; index < body.length - 1; index += 1) {
    body[index].to = body[index + 1].from;
  }
  if (body.length > 0) {
    if (durationSeconds !== null && durationSeconds < body.at(-1).from) throw new Error('duration precedes the final text timestamp');
    body.at(-1).to = durationSeconds ?? body.at(-1).from;
  }
  return body;
}

export function normalizeTranscript(text, {
  durationSeconds = null, language = null, captions = null, format = 'auto', dedupeRolling = false,
} = {}) {
  if (!FORMATS.has(format)) throw new Error(`unsupported format: ${format}`);
  if (durationSeconds !== null && (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    throw new Error('duration must be a finite nonnegative number');
  }
  const input = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (format === 'auto') {
    if (/^WEBVTT(?:[\t ]|\n|$)/.test(input)) format = 'vtt';
    else if (/^\s*\d[\d:.,]*\s+-->/m.test(input)) format = /\d{2},\d{3}\s+-->/.test(input) ? 'srt' : 'vtt';
    else if (input.split('\n').some((line) => TIMESTAMP_RE.test(line))) format = 'text';
    else throw new Error('unsupported or empty transcript: expected VTT, SRT or [mm:ss] text');
  }
  if (dedupeRolling && (captions !== 'automatic' || format === 'text')) {
    throw new Error('rolling deduplication requires automatic VTT/SRT captions');
  }
  const cueMap = [];
  let body;
  let sourceCues;
  if (format === 'text') body = parseTimedText(input, durationSeconds);
  else {
    const cues = parseCues(input, format);
    sourceCues = cues;
    const displayPrefixes = dedupeRolling && format === 'vtt' ? touchingDisplayPrefixes(cues) : new Map();
    body = [];
    cues.forEach((cue, index) => {
      const prefix = dedupeRolling ? (displayPrefixes.get(index) ?? rollingPrefix(cues[index - 1], cue)) : '';
      const value = cue.text.slice(prefix.length).trim();
      if (value) body.push({ from: cue.from, to: cue.to, text: value });
      cueMap.push({ cue: index + 1, entry: value ? body.length : null, ...(prefix ? { removed_prefix: prefix } : {}) });
    });
  }
  if (body.length === 0) throw new Error('no non-empty timed subtitle content');
  const timeline = sourceCues ?? body;
  return {
    language,
    captions,
    body,
    normalization: {
      format, timing: format === 'text' ? 'inferred' : 'explicit',
      dedupe_rolling: dedupeRolling,
      ...(format === 'text' ? {} : { cue_map: cueMap }),
    },
    coverage: {
      from: timeline[0].from,
      to: timeline.reduce((end, cue) => Math.max(end, cue.to), 0),
      entries: body.length,
    },
  };
}

function parseArgs(argv) {
  const options = {};
  const values = new Set(['--input', '--output', '--duration', '--language', '--captions', '--format']);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') options.help = true;
    else if (name === '--dedupe-rolling') options.dedupeRolling = true;
    else if (values.has(name)) {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) throw new Error(`missing value for ${name}`);
      options[name.slice(2)] = argv[++index];
    } else throw new Error(`unknown option: ${name}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const { input, output } = options;
  if (!input) throw new Error(HELP);
  const value = normalizeTranscript(await readFile(input, 'utf8'), {
    durationSeconds: options.duration === undefined ? null : Number(options.duration),
    language: options.language ?? null,
    captions: options.captions ?? null,
    format: options.format ?? 'auto',
    dedupeRolling: options.dedupeRolling ?? false,
  });
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (output) await writeFile(output, rendered);
  else process.stdout.write(rendered);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
