import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeTranscript, parseTimestamp } from '../scripts/normalize-transcript.mjs';

test('VTT keeps cue milliseconds, gaps, overlaps, IDs and settings', () => {
  const result = normalizeTranscript('\uFEFFWEBVTT\r\nKind: captions\r\n\r\n' +
    'intro\r\n00:01.125 --> 00:04.250 align:start position:0%\r\nHello\r\nworld\r\n\r\n' +
    '00:02.000 --> 00:03.000\r\nOverlapping voice\r\n\r\n' +
    'last\r\n00:07.001 --> 00:08.002\r\nDone\r\n', { durationSeconds: 60, language: 'en', captions: 'manual' });
  assert.deepEqual(result.body, [
    { from: 1.125, to: 4.25, text: 'Hello\nworld' },
    { from: 2, to: 3, text: 'Overlapping voice' },
    { from: 7.001, to: 8.002, text: 'Done' },
  ]);
  assert.deepEqual(result.coverage, { from: 1.125, to: 8.002, entries: 3 });
  assert.equal(result.language, 'en');
  assert.equal(result.captions, 'manual');
  assert.equal(result.normalization.timing, 'explicit');
});

test('SRT keeps explicit hours and end times instead of expanding to video duration', () => {
  const result = normalizeTranscript('1\n01:02:03,456 --> 01:02:04,789\nA\n\n2\n01:02:10,000 --> 01:02:11,100\nB', { durationSeconds: 5000 });
  assert.deepEqual(result.body, [
    { from: 3723.456, to: 3724.789, text: 'A' },
    { from: 3730, to: 3731.1, text: 'B' },
  ]);
  assert.equal(result.normalization.format, 'srt');
});

test('VTT metadata blocks are excluded and encoded code survives tag removal', () => {
  const result = normalizeTranscript(`WEBVTT

NOTE ignored --> not a cue
annotation

STYLE\x20
::cue { color: red }

REGION\t
id:main

00:00.000 --> 00:02.000
<v Speaker><c.green>Hello</c><00:00.500> &amp; &lt;code&gt; &#x4e2d;&#25991;</v>`);
  assert.equal(result.body[0].text, 'Hello & <code> 中文');
  assert.equal(result.body.length, 1);
});

test('coverage includes an earlier long cue when the last overlapping cue ends sooner', () => {
  const result = normalizeTranscript('WEBVTT\n\n00:00.000 --> 00:10.000\nLong\n\n00:02.000 --> 00:03.000\nShort');
  assert.equal(result.coverage.to, 10);
});

const automatic = { captions: 'automatic', dedupeRolling: true };

test('opt-in rolling cleanup removes only overlapping suffix/prefix display repetition', () => {
  const result = normalizeTranscript(`WEBVTT

00:00.000 --> 00:03.000
<c>Hello</c> <00:00.500>world

00:02.000 --> 00:05.000
Hello world again

00:04.000 --> 00:06.000
world again today`, automatic);
  assert.deepEqual(result.body, [
    { from: 0, to: 3, text: 'Hello world' },
    { from: 2, to: 5, text: 'again' },
    { from: 4, to: 6, text: 'today' },
  ]);
  assert.deepEqual(result.normalization.cue_map, [
    { cue: 1, entry: 1 },
    { cue: 2, entry: 2, removed_prefix: 'Hello world' },
    { cue: 3, entry: 3, removed_prefix: 'world again' },
  ]);
});

test('rolling cleanup handles Chinese and multiline windows without retiming new text', () => {
  const result = normalizeTranscript('WEBVTT\n\n00:00.000 --> 00:04.000\n第一行\n你好世界\n\n' +
    '00:02.500 --> 00:05.000\n你好世界\n下一行\n\n00:04.500 --> 00:07.000\n下一行继续', automatic);
  assert.deepEqual(result.body, [
    { from: 0, to: 4, text: '第一行\n你好世界' },
    { from: 2.5, to: 5, text: '下一行' },
    { from: 4.5, to: 7, text: '继续' },
  ]);
});

test('duplicate overlapping cues are mapped to raw source without extending another cue', () => {
  const result = normalizeTranscript('WEBVTT\n\n00:00.000 --> 00:02.000\nSame\n\n00:01.000 --> 00:03.000\nSame', automatic);
  assert.deepEqual(result.body, [{ from: 0, to: 2, text: 'Same' }]);
  assert.deepEqual(result.normalization.cue_map[1], { cue: 2, entry: null, removed_prefix: 'Same' });
  assert.deepEqual(result.coverage, { from: 0, to: 3, entries: 1 });
});

test('cleanup preserves separate repeated speech, within-cue repetition and partial words', () => {
  const result = normalizeTranscript(`WEBVTT

00:00.000 --> 00:01.000
very very

00:01.000 --> 00:02.000
very very

00:03.000 --> 00:05.000
Hello

00:04.000 --> 00:06.000
long`, automatic);
  assert.deepEqual(result.body.map((cue) => cue.text), ['very very', 'very very', 'Hello', 'long']);
});

test('automatic captions are unchanged unless rolling cleanup is explicitly enabled', () => {
  const input = 'WEBVTT\n\n00:00.000 --> 00:03.000\nAgain\n\n00:02.000 --> 00:04.000\nAgain';
  assert.equal(normalizeTranscript(input, { captions: 'automatic' }).body.length, 2);
  assert.throws(() => normalizeTranscript(input, { dedupeRolling: true, captions: 'manual' }), /requires automatic/);
  assert.throws(() => normalizeTranscript('[0:00] again', automatic), /requires automatic/);
});

test('an ambiguous shared word at an overlapping sentence boundary is preserved', () => {
  const result = normalizeTranscript('WEBVTT\n\n00:00.000 --> 00:02.000\nthis is very\n\n00:01.900 --> 00:03.000\nvery important', automatic);
  assert.deepEqual(result.body.map((cue) => cue.text), ['this is very', 'very important']);
});

test('YouTube VTT space-only display rows are payload, not cue separators', () => {
  const result = normalizeTranscript('WEBVTT\n\n00:00.000 --> 00:03.110\n \nFirst<00:00.320><c> line</c>\n\n' +
    '00:03.110 --> 00:03.120\nFirst line\n \n\n00:03.120 --> 00:06.309\nFirst line\nNext<00:03.520><c> words</c>');
  assert.deepEqual(result.body, [
    { from: 0, to: 3.11, text: 'First line' },
    { from: 3.11, to: 3.12, text: 'First line' },
    { from: 3.12, to: 6.309, text: 'First line\nNext words' },
  ]);
});

test('only the complete timed-row / 10ms snapshot / carried-row pattern enables touching cleanup', () => {
  const input = 'WEBVTT\n\n00:00.000 --> 00:03.110\n \nFirst<00:00.320><c> line</c>\n\n' +
    '00:03.110 --> 00:03.120\nFirst line\n \n\n00:03.120 --> 00:06.309\nFirst line\nNext<00:03.520><c> words</c>';
  const result = normalizeTranscript(input, automatic);
  assert.deepEqual(result.body, [
    { from: 0, to: 3.11, text: 'First line' },
    { from: 3.12, to: 6.309, text: 'Next words' },
  ]);
  assert.equal(result.normalization.cue_map[1].entry, null);
  assert.equal(result.normalization.cue_map[2].removed_prefix, 'First line\n');
  for (const changed of [
    input.replace('00:03.120', '00:03.125'),
    input.replace('First<00:00.320><c> line</c>', 'First line'),
    input.replace('Next<00:03.520><c> words</c>', 'Next words'),
  ]) {
    assert.equal(normalizeTranscript(changed, automatic).body.length, 3);
  }
});

test('a new timed utterance identical to the carried row survives display cleanup', () => {
  const result = normalizeTranscript('WEBVTT\n\n00:00.000 --> 00:02.000\nSay<00:00.500><c> again</c>\n\n' +
    '00:02.000 --> 00:02.010\nSay again\n \n\n00:02.010 --> 00:04.000\nSay again\nSay<00:02.500><c> again</c>', automatic);
  assert.deepEqual(result.body, [
    { from: 0, to: 2, text: 'Say again' },
    { from: 2.01, to: 4, text: 'Say again' },
  ]);
});

test('legacy timed text retains merging and inferred ends, and accepts millisecond starts', () => {
  const result = normalizeTranscript('[0:00] Hello\n[0:00] world\n[0:02.125] Next', { durationSeconds: 5 });
  assert.deepEqual(result.body, [
    { from: 0, to: 2.125, text: 'Hello world' },
    { from: 2.125, to: 5, text: 'Next' },
  ]);
  assert.equal(result.normalization.timing, 'inferred');
  assert.equal(normalizeTranscript('[0:00] flow A --> B').body[0].text, 'flow A --> B');
  assert.equal(normalizeTranscript('[00:00] Explain <!-- comment --> markup').normalization.format, 'text');
});

test('empty, unsupported and malformed subtitles fail explicitly instead of returning empty success', () => {
  for (const input of ['', 'plain untimed prose', '{"body":[]}', 'WEBVTT\n\nNOTE nothing',
    '1\n00:00:01,000 --> 00:00:00,000\nreversed',
    'WEBVTT\n\n00:00.000 --> 00:01.000\nvalid\n\nmalformed block',
    'WEBVTT\n\n00:00.000 --> 00:00.000\nzero',
    'WEBVTT\n\n00:99.000 --> 01:00.000\ninvalid',
    'WEBVTT\n\n00:02.000 --> 00:03.000\nA\n\n00:01.000 --> 00:02.000\nB',
    '[0:02] later\n[0:01] earlier']) {
    assert.throws(() => normalizeTranscript(input), undefined, input);
  }
  for (const durationSeconds of [NaN, Infinity, -1, '10']) {
    assert.throws(() => normalizeTranscript('[0:00] A', { durationSeconds }), /duration/);
  }
  assert.throws(() => normalizeTranscript('[0:02] A', { durationSeconds: 1 }), /duration/);
  assert.throws(() => normalizeTranscript('anything', { format: 'json' }), /unsupported format/);
  for (const timestamp of ['0:60', '1:60:00', '-1:00', '1:01.1234']) assert.throws(() => parseTimestamp(timestamp));
});

test('CLI reads VTT, writes JSON and exits nonzero on invalid input without writing output', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yjx-subtitles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/normalize-transcript.mjs', import.meta.url));
  const input = path.join(dir, 'sub titles.vtt');
  const output = path.join(dir, 'normalized.json');
  await writeFile(input, 'WEBVTT\n\n00:00.125 --> 00:01.750\nHello');
  const result = spawnSync(process.execPath, [script, '--input', input, '--output', output, '--captions', 'automatic', '--language', 'en', '--dedupe-rolling'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(saved.body, [{ from: 0.125, to: 1.75, text: 'Hello' }]);
  assert.equal(saved.language, 'en');
  await writeFile(input, 'untimed');
  const failed = spawnSync(process.execPath, [script, '--input', input, '--output', output], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /unsupported/);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), saved);
  const missing = spawnSync(process.execPath, [script, '--input'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing value/);
});
