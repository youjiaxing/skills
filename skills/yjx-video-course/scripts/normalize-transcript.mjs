#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const TIMESTAMP_RE = /^\[(?<time>\d{1,2}:\d{2}(?::\d{2})?)\]\s*(?<text>.*)$/;

export function parseTimestamp(value) {
  const parts = value.split(':').map(Number);
  if (parts.some(Number.isNaN) || parts.length < 2 || parts.length > 3) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function normalizeTranscript(text, { durationSeconds = null, language = null, captions = null } = {}) {
  const lines = String(text).split(/\r?\n/);
  const body = [];
  for (const line of lines) {
    const match = line.match(TIMESTAMP_RE);
    if (!match) continue;
    const from = parseTimestamp(match.groups.time);
    const value = match.groups.text.trim();
    if (!value) continue;
    const previous = body.at(-1);
    if (previous?.from === from) previous.text += ` ${value}`;
    else body.push({ from, to: null, text: value });
  }
  for (let index = 0; index < body.length - 1; index += 1) {
    body[index].to = body[index + 1].from;
  }
  if (body.length > 0) {
    body.at(-1).to = durationSeconds ?? body.at(-1).from;
  }
  return {
    language,
    captions,
    body,
    coverage: body.length === 0 ? null : {
      from: body[0].from,
      to: body.at(-1).to,
      entries: body.length,
    },
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function main() {
  const input = argument('--input');
  const output = argument('--output');
  if (!input) throw new Error('Usage: normalize-transcript.mjs --input <file> [--output <file>] [--duration <seconds>]');
  const value = normalizeTranscript(await readFile(input, 'utf8'), {
    durationSeconds: argument('--duration') ? Number(argument('--duration')) : null,
    language: argument('--language'),
    captions: argument('--captions'),
  });
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (output) await writeFile(output, rendered);
  else process.stdout.write(rendered);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
