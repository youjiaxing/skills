#!/usr/bin/env node

// Capture selected video frames from a Bilibili episode at a real quality tier.
//
// Why this exists: anonymous DASH requests often advertise 1080P/720P in
// `accept_quality` but only deliver 480P/360P streams. Page-player screenshots
// are also scaled down to the CSS player size. For software-demo courses, that
// produces unreadable terminal text. This script asks the Bilibili playurl API
// for an explicit `qn`, prefers the matching DASH variant, verifies the actual
// decoded dimensions and frame rate, and extracts exact frames with ffmpeg/ffprobe
// (preferred) or OpenCV (fallback). Tool availability is checked before any download.
//
// IMPORTANT: this CLI request has no browser cookies. Its quality result is
// anonymous-only and MUST NOT be used to decide whether the user is logged in.
// For login-sensitive quality decisions, run bilibili-browser-frames.mjs in the
// actual browser tab first.
//
// It writes files locally only. It does not upload anything, read cookies, or
// bypass login/permission gates. If the API refuses the requested quality, the
// script reports anonymous capability only; the caller must check the actual
// browser session before deciding whether a sign-in request is appropriate.

import fs from 'node:fs/promises';
import { isMainModule } from './is-main.mjs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const QUALITY = {
  16: '360P',
  32: '480P',
  64: '720P',
  80: '1080P',
};

const EXPECTED_HEIGHT = {
  16: 360,
  32: 480,
  64: 720,
  80: 1080,
};

function frameRateNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const next = argv[index + 1];
    args[key.slice(2)] = next == null || next.startsWith('--') ? true : next;
    if (next != null && !next.startsWith('--')) index += 1;
  }
  return args;
}

async function fetchPlayurl({ bvid, cid, quality, fnval = 0 }) {
  const url = new URL('https://api.bilibili.com/x/player/playurl');
  url.searchParams.set('bvid', bvid);
  url.searchParams.set('cid', cid);
  url.searchParams.set('qn', String(quality));
  url.searchParams.set('fnval', String(fnval));
  url.searchParams.set('fourk', '1');
  const response = await fetch(url, {
    headers: {
      Referer: 'https://www.bilibili.com/',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (!response.ok) {
    throw new Error(`playurl request failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(`playurl request rejected: code=${payload.code} message=${payload.message}`);
  }
  return payload.data;
}

async function download(url, outputPath) {
  const response = await fetch(url, {
    headers: {
      Referer: 'https://www.bilibili.com/',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (!response.ok) throw new Error(`media download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);
  return { bytes: bytes.length, contentType: response.headers.get('content-type') };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function commandWorks(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// 探测可用的截帧工具：优先 ffmpeg + ffprobe，其次 OpenCV(cv2)。
export async function detectFrameTools({ check = commandWorks } = {}) {
  const ffmpeg = await check('ffmpeg', ['-version']);
  const ffprobe = await check('ffprobe', ['-version']);
  if (ffmpeg && ffprobe) return { status: 'frame_tools_ready', backend: 'ffmpeg' };
  const opencv = await check('python3', ['-c', 'import cv2']);
  if (opencv) return { status: 'frame_tools_ready', backend: 'opencv' };
  return {
    status: 'frame_tools_missing',
    blocked: true,
    checked: { ffmpeg, ffprobe, opencv },
    reason: 'neither ffmpeg+ffprobe nor python3 with cv2 is available',
    next_action: 'Install ffmpeg (includes ffprobe) or opencv-python-headless with user approval, then rerun. No media was downloaded.',
  };
}

export function parseFfprobeFrameRate(value) {
  if (!value || value === '0/0') return null;
  const [num, den] = String(value).split('/').map(Number);
  if (!Number.isFinite(num)) return null;
  if (!den) return num;
  return num / den;
}

async function probeWithFfprobe(videoPath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames',
    '-of', 'json', videoPath,
  ]);
  const stream = JSON.parse(stdout).streams?.[0] ?? {};
  return {
    ok: Boolean(stream.width),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    fps: parseFfprobeFrameRate(stream.avg_frame_rate) ?? parseFfprobeFrameRate(stream.r_frame_rate),
    frames: stream.nb_frames ? Number(stream.nb_frames) : null,
  };
}

async function captureWithFfmpeg(videoPath, outputDir, times) {
  const written = [];
  for (const value of times) {
    const output = path.join(outputDir, `frame-${String(Math.trunc(value)).padStart(4, '0')}.png`);
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(value), '-i', videoPath, '-frames:v', '1', output]);
      const probe = await probeWithFfprobe(output);
      written.push({ time: value, ok: true, path: output, width: probe.width, height: probe.height });
    } catch {
      written.push({ time: value, ok: false });
    }
  }
  return written;
}

let FRAME_BACKEND = 'opencv';
const probeMedia = (videoPath) => (FRAME_BACKEND === 'ffmpeg' ? probeWithFfprobe(videoPath) : probeWithOpenCV(videoPath));
const captureFrames = (videoPath, outputDir, times) => (FRAME_BACKEND === 'ffmpeg'
  ? captureWithFfmpeg(videoPath, outputDir, times)
  : captureWithOpenCV(videoPath, outputDir, times));

async function probeWithOpenCV(videoPath) {
  const script = [
    'import cv2, json, sys',
    'cap = cv2.VideoCapture(sys.argv[1])',
    'print(json.dumps({"ok": cap.isOpened(), "width": cap.get(cv2.CAP_PROP_FRAME_WIDTH), "height": cap.get(cv2.CAP_PROP_FRAME_HEIGHT), "fps": cap.get(cv2.CAP_PROP_FPS), "frames": cap.get(cv2.CAP_PROP_FRAME_COUNT)}))',
  ].join('\n');
  const { stdout } = await run('python3', ['-c', script, videoPath]);
  return JSON.parse(stdout.trim());
}

function selectDashVariant(playurl, requestedQuality) {
  const minimumHeight = EXPECTED_HEIGHT[requestedQuality];
  const variants = Array.isArray(playurl.dash?.video) ? playurl.dash.video : [];
  const eligible = variants
    .filter((variant) => Number(variant.height) >= minimumHeight)
    .sort((left, right) => (
      Number(right.height) - Number(left.height)
      || frameRateNumber(right.frameRate) - frameRateNumber(left.frameRate)
      || Number(right.bandwidth ?? 0) - Number(left.bandwidth ?? 0)
    ));
  return eligible[0] ?? null;
}

function describeDashVariants(playurl) {
  return (playurl.dash?.video ?? []).map((variant) => ({
    id: variant.id,
    width: variant.width,
    height: variant.height,
    frame_rate: frameRateNumber(variant.frameRate),
    bandwidth: variant.bandwidth,
    codecs: variant.codecs,
  }));
}

async function captureWithOpenCV(videoPath, outputDir, times) {
  const script = [
    'import cv2, json, os, sys',
    'video_path, output_dir = sys.argv[1], sys.argv[2]',
    'times = [float(value) for value in sys.argv[3:]]',
    'cap = cv2.VideoCapture(video_path)',
    'written = []',
    'for value in times:',
    '    cap.set(cv2.CAP_PROP_POS_MSEC, value * 1000)',
    '    ok, frame = cap.read()',
    '    if not ok:',
    '        written.append({"time": value, "ok": False})',
    '        continue',
    '    output = os.path.join(output_dir, f"frame-{int(value):04d}.png")',
    '    cv2.imwrite(output, frame)',
    '    written.append({"time": value, "ok": True, "path": output, "width": int(frame.shape[1]), "height": int(frame.shape[0])})',
    'print(json.dumps(written))',
  ].join('\n');
  const { stdout } = await run('python3', ['-c', script, videoPath, outputDir, ...times.map(String)]);
  return JSON.parse(stdout.trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bvid = args.bvid;
  const cid = args.cid;
  const quality = Number(args.quality ?? 80);
  const outputDir = args['output-dir'];
  const times = String(args.times ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));

  if (!bvid || !cid || !outputDir || times.length === 0) {
    console.error('Usage: capture-bilibili-frames.mjs --bvid BV... --cid CID --quality 80|64 --times 60,390 --output-dir DIR');
    process.exitCode = 2;
    return;
  }
  if (!QUALITY[quality]) {
    console.error(`Unsupported quality code ${quality}. Use one of ${Object.keys(QUALITY).join(', ')}.`);
    process.exitCode = 2;
    return;
  }

  const tools = await detectFrameTools();
  if (tools.status !== 'frame_tools_ready') {
    console.log(JSON.stringify({ bvid, cid, requested_quality: quality, ...tools }, null, 2));
    process.exitCode = 4;
    return;
  }
  FRAME_BACKEND = tools.backend;

  await fs.mkdir(outputDir, { recursive: true });
  const dashPlayurl = await fetchPlayurl({ bvid, cid, quality, fnval: 4048 });
  const dashVariant = selectDashVariant(dashPlayurl, quality);
  if (dashVariant) {
    const dashUrl = dashVariant.baseUrl ?? dashVariant.base_url;
    if (!dashUrl) throw new Error('selected DASH variant did not include a media URL');
    const mediaPath = path.join(outputDir, `source-${QUALITY[quality]}-${frameRateNumber(dashVariant.frameRate)}fps.mp4`);
    const downloaded = await download(dashUrl, mediaPath);
    const probe = await probeMedia(mediaPath);
    const manifest = {
      bvid,
      cid,
      requested_quality: quality,
      requested_label: QUALITY[quality],
      source_mode: 'dash',
      source_quality: Number(dashPlayurl.quality),
      source_accept_quality: dashPlayurl.accept_quality ?? null,
      selected_variant: {
        id: dashVariant.id,
        width: dashVariant.width,
        height: dashVariant.height,
        frame_rate: frameRateNumber(dashVariant.frameRate),
        bandwidth: dashVariant.bandwidth,
        codecs: dashVariant.codecs,
      },
      other_variants: describeDashVariants(dashPlayurl),
      media_url_basename: path.basename(new URL(dashUrl).pathname),
      media_path: mediaPath,
      downloaded_bytes: downloaded.bytes,
      content_type: downloaded.contentType,
      probe,
      frame_backend: FRAME_BACKEND,
      frame_rate: Number.isFinite(Number(probe.fps)) ? Number(probe.fps) : null,
    };
    if (probe.width < (quality === 80 ? 1920 : 1280) || probe.height < EXPECTED_HEIGHT[quality]) {
      manifest.blocked = true;
      manifest.reason = `selected DASH variant decoded to ${probe.width}x${probe.height}, below requested ${QUALITY[quality]}`;
      manifest.next_action = 'This anonymous CLI request cannot see browser cookies. Do not ask the user to sign in based on this result; verify login and quality with bilibili-browser-frames.mjs in the actual browser tab first.';
      console.log(JSON.stringify(manifest, null, 2));
      process.exitCode = 3;
      return;
    }
    if (!Number.isFinite(Number(probe.fps)) || Number(probe.fps) < 30) {
      manifest.blocked = true;
      manifest.reason = `selected DASH variant frame rate ${manifest.frame_rate} is below 30 fps`;
      console.log(JSON.stringify(manifest, null, 2));
      process.exitCode = 3;
      return;
    }
    manifest.frames = await captureFrames(mediaPath, outputDir, times);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const dashManifest = {
    bvid,
    cid,
    requested_quality: quality,
    requested_label: QUALITY[quality],
    source_mode: 'dash',
    source_quality: Number(dashPlayurl.quality),
    source_accept_quality: dashPlayurl.accept_quality ?? null,
    available_variants: describeDashVariants(dashPlayurl),
    reason: `no DASH variant met ${QUALITY[quality]}`,
  };
  if (quality === 80) {
    dashManifest.blocked = true;
    dashManifest.anonymous_quality_unavailable = true;
    dashManifest.browser_session_check_required = true;
    dashManifest.next_action = 'This anonymous CLI request cannot see browser cookies. Do not ask the user to sign in based on this result; verify login and quality with bilibili-browser-frames.mjs in the actual browser tab first.';
    console.log(JSON.stringify(dashManifest, null, 2));
    process.exitCode = 3;
    return;
  }

  const playurl = await fetchPlayurl({ bvid, cid, quality, fnval: 0 });
  const object = playurl.durl?.[0];
  if (!object?.url) {
    throw new Error('playurl response did not include a progressive MP4 URL; use fnval=4048 to inspect DASH tiers');
  }

  const requestedQuality = quality;
  const actualQuality = Number(playurl.quality);
  const actualHeight = EXPECTED_HEIGHT[actualQuality] ?? null;
  const manifest = {
    ...dashManifest,
    source_mode: 'progressive_fallback',
    bvid,
    cid,
    requested_quality: requestedQuality,
    requested_label: QUALITY[requestedQuality],
    actual_quality: actualQuality,
    actual_label: QUALITY[actualQuality] ?? null,
    actual_height: actualHeight,
    quality_honored: actualQuality === requestedQuality,
    media_url_basename: path.basename(new URL(object.url).pathname),
    media_bytes: object.size,
    media_duration_ms: object.length,
    frames: [],
  };

  const minimumWidth = requestedQuality === 80 ? 1920 : 1280;
  const minimumHeight = requestedQuality === 80 ? 1080 : 720;
  if (manifest.quality_honored !== true || (actualHeight ?? 0) < minimumHeight) {
    manifest.blocked = true;
    manifest.reason = `requested ${QUALITY[requestedQuality]} but API returned ${QUALITY[actualQuality] ?? actualQuality}`;
    manifest.next_action = 'This anonymous CLI request cannot see browser cookies. Do not ask the user to sign in based on this result; verify login and quality with bilibili-browser-frames.mjs in the actual browser tab first.';
    console.log(JSON.stringify(manifest, null, 2));
    process.exitCode = 3;
    return;
  }

  const mediaPath = path.join(outputDir, `source-${QUALITY[actualQuality]}.mp4`);
  const downloaded = await download(object.url, mediaPath);
  manifest.media_path = mediaPath;
  manifest.downloaded_bytes = downloaded.bytes;
  manifest.content_type = downloaded.contentType;
  manifest.frame_backend = FRAME_BACKEND;
  manifest.probe = await probeMedia(mediaPath);
  const mediaFrameRate = Number(manifest.probe.fps);
  manifest.frame_rate = Number.isFinite(mediaFrameRate) ? mediaFrameRate : null;
  const minimumFrameRate = 30;
  if (manifest.probe.width < minimumWidth || manifest.probe.height < minimumHeight) {
    manifest.blocked = true;
    manifest.reason = `downloaded media decoded to ${manifest.probe.width}x${manifest.probe.height}, below requested ${QUALITY[requestedQuality]} minimum ${minimumWidth}x${minimumHeight}`;
    console.log(JSON.stringify(manifest, null, 2));
    process.exitCode = 3;
    return;
  }
  if (!Number.isFinite(mediaFrameRate) || mediaFrameRate < minimumFrameRate) {
    manifest.blocked = true;
    manifest.reason = `downloaded media frame rate ${manifest.frame_rate} is below ${minimumFrameRate} fps`;
    console.log(JSON.stringify(manifest, null, 2));
    process.exitCode = 3;
    return;
  }

  manifest.frames = await captureFrames(mediaPath, outputDir, times);
  console.log(JSON.stringify(manifest, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
