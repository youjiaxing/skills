#!/usr/bin/env node

/**
 * extract-hard-subtitles.mjs
 * 
 * 用于从视频流画面中提取烧录/压制的中英双语硬字幕。
 * 针对 B 站等平台无官方独立 CC 字幕轨道（subtitle.list 为空）的场景，
 * 优先利用 macOS 原生 Swift Vision 框架（无任何三方 Python 沉重依赖，全离线神经引擎硬件加速）
 * 进行毫秒级并发识别，并按坐标提取中英双语行与去重合并。
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { isMainModule } from './is-main.mjs';

function commandExists(command, env = process.env) {
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      execSync(`test -x "${path.join(dir, command)}"`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
}

// 检查本机是否具备 macOS Swift Vision OCR 能力。不可用时返回结构化状态，
// 由 Agent 按技能的降级路线处理，而不是抛出堆栈。
export function checkOcrAvailability({ platform = process.platform, env = process.env, hasCommand = commandExists } = {}) {
  if (platform !== 'darwin') {
    return {
      status: 'ocr_unavailable',
      reason: 'platform_not_macos',
      platform,
      next_action: 'Hard-subtitle OCR needs macOS Swift Vision. Record subtitle OCR as unavailable on this host and follow the no-browser / non-macOS fallback: local transcription plus targeted visual checks of decoded frames.',
    };
  }
  if (!hasCommand('swiftc', env)) {
    return {
      status: 'ocr_unavailable',
      reason: 'swiftc_not_found',
      platform,
      next_action: 'Install Xcode Command Line Tools (xcode-select --install) with user approval, or follow the non-OCR fallback.',
    };
  }
  if (!hasCommand('python3', env)) {
    return { status: 'ocr_unavailable', reason: 'python3_not_found', platform, next_action: 'python3 with OpenCV (cv2) is required for frame sampling.' };
  }
  return { status: 'ocr_available', platform };
}

function parseArgs(argv) {
  const args = { step: 2, workers: 8, output: null, preview: false, previewSamples: 12, zhBand: null, enBand: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--video' || arg === '-v') args.video = argv[++i];
    else if (arg === '--step' || arg === '-s') args.step = Number(argv[++i]) || 2;
    else if (arg === '--workers' || arg === '-w') args.workers = Number(argv[++i]) || 8;
    else if (arg === '--output' || arg === '-o') args.output = argv[++i];
    else if (arg === '--preview') args.preview = true;
    else if (arg === '--preview-samples') args.previewSamples = Number(argv[++i]) || 12;
    else if (arg === '--zh-band') args.zhBand = argv[++i];
    else if (arg === '--en-band') args.enBand = argv[++i];
  }
  return args;
}

function parseBand(raw, name) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || parts[0] < 0 || parts[1] > 1 || parts[0] >= parts[1]) {
    throw new Error(`invalid ${name} (expected min,max in [0,1], e.g. 0.08,0.15): ${raw}`);
  }
  return parts;
}

const SWIFT_OCR_SOURCE = `
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else { exit(1) }
let path = args[1]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    exit(1)
}

let request = VNRecognizeTextRequest { request, error in
    guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
    for observation in observations {
        if let topCandidate = observation.topCandidates(1).first {
            let box = observation.boundingBox
            print(String(format: "%.3f,%.3f,%.3f,%.3f\\t%@", box.origin.x, box.origin.y, box.size.width, box.size.height, topCandidate.string))
        }
    }
}
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.recognitionLevel = .accurate

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])
`;

async function ensureSwiftOcrTool() {
  const toolDir = path.join(os.tmpdir(), 'yjx_ocr_tool');
  await fs.mkdir(toolDir, { recursive: true });
  const toolBinary = path.join(toolDir, 'ocr_tool');

  try {
    await fs.access(toolBinary);
    return toolBinary;
  } catch {
    // 需要编译
  }

  const swiftSource = path.join(toolDir, 'ocr_tool.swift');
  await fs.writeFile(swiftSource, SWIFT_OCR_SOURCE, 'utf8');

  console.log('[extract-hard-subtitles] 正在编译原生 Swift Vision OCR 提取器...');
  execSync(`swiftc -O "${swiftSource}" -o "${toolBinary}"`, { stdio: 'inherit' });
  return toolBinary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.video) {
    console.error('用法: node extract-hard-subtitles.mjs --video <视频路径> [--preview [--preview-samples 12] | --zh-band 0.08,0.15 --en-band 0.01,0.08] [--step 2] [--workers 8] [--output <输出json>]');
    process.exit(1);
  }
  const zhBand = parseBand(args.zhBand, '--zh-band');
  const enBand = parseBand(args.enBand, '--en-band');
  const previewMode = Boolean(args.preview || (!zhBand && !enBand));

  const availability = checkOcrAvailability();
  if (availability.status !== 'ocr_available') {
    console.log(JSON.stringify(availability, null, 2));
    process.exitCode = 3;
    return;
  }

  const ocrTool = await ensureSwiftOcrTool();
  console.log(`[extract-hard-subtitles] OCR 工具就绪: ${ocrTool}`);

  const helperPy = path.join(os.tmpdir(), 'extract_helper.py');
  const pyCode = `
import cv2, subprocess, os, sys, json, time, difflib
from concurrent.futures import ThreadPoolExecutor

video_path = sys.argv[1]
step = int(sys.argv[2])
workers = int(sys.argv[3])
output_json = sys.argv[4]
ocr_tool = sys.argv[5]
mode = sys.argv[6]
preview_samples = int(sys.argv[7])
zh_band_raw = sys.argv[8]
en_band_raw = sys.argv[9]

def parse_band(raw):
    if not raw: return None
    a, b = [float(x) for x in raw.split(",")]
    return (a, b)

zh_band = parse_band(zh_band_raw)
en_band = parse_band(en_band_raw)

cap = cv2.VideoCapture(video_path)
fps = cap.get(cv2.CAP_PROP_FPS)
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
duration = int(total_frames / fps) if fps > 0 else 0
print(f"视频时长: {duration}s, 采样步长: {step}s, 并发线程: {workers}")

def ocr_lines(t):
    cap_local = cv2.VideoCapture(video_path)
    cap_local.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
    ret, frame = cap_local.read()
    cap_local.release()
    if not ret: return None
    tmp_path = f"/tmp/hsub_{os.getpid()}_{t}.png"
    cv2.imwrite(tmp_path, frame)
    try:
        res = subprocess.run([ocr_tool, tmp_path], capture_output=True, text=True)
        lines = []
        for line in res.stdout.strip().split("\\n"):
            if not line or "\\t" not in line: continue
            coords, text = line.split("\\t", 1)
            text = text.strip()
            if not text: continue
            parts = [float(x) for x in coords.split(",")]
            lines.append({ "x": parts[0], "y": parts[1], "w": parts[2], "h": parts[3], "text": text })
        return { "time": t, "lines": lines }
    finally:
        if os.path.exists(tmp_path): os.remove(tmp_path)

if mode == "preview":
    sample_count = max(1, min(preview_samples, max(1, duration)))
    if duration <= sample_count:
        sample_times = list(range(0, max(1, duration)))
    else:
        sample_times = sorted(set(int(i * duration / sample_count) for i in range(sample_count)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        sampled = [r for r in ex.map(ocr_lines, sample_times) if r]
    result = {
        "status": "band_selection_required",
        "next_action": "Inspect lines[].y (bottom-origin normalized [0,1]) and rerun with --zh-band min,max and/or --en-band min,max.",
        "video_info": { "path": video_path, "duration": duration, "sampled_frames": len(sampled) },
        "preview_samples": sampled,
    }
    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"已输出 {len(sampled)} 帧预览（含全区域文本与归一化 y 坐标）至 {output_json}")
    sys.exit(0)

times = list(range(0, duration, step))
all_raw = []

def process_frame(t):
    obs = ocr_lines(t)
    if not obs: return None
    zh, en, screen = [], [], []
    for item in obs["lines"]:
        y = item["y"]
        if zh_band and zh_band[0] <= y <= zh_band[1]: zh.append(item["text"])
        elif en_band and en_band[0] <= y <= en_band[1]: en.append(item["text"])
        else: screen.append(item["text"])
    return { "time": t, "zh": " ".join(zh), "en": " ".join(en), "screen": " | ".join(screen) }

def similar_text(a, b):
    if a == b: return True
    if not a or not b: return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.85

# 分批处理避免爆显存/内存
batch_size = 150
start_time = time.time()
for i in range(0, len(times), batch_size):
    batch = times[i:i+batch_size]
    with ThreadPoolExecutor(max_workers=workers) as ex:
        res = list(ex.map(process_frame, batch))
    all_raw.extend([r for r in res if r])
    done = len(all_raw)
    print(f"处理进度: {done}/{len(times)} ({done/len(times)*100:.1f}%) 耗时: {time.time()-start_time:.1f}s")

# 合并相邻相同行
merged = []
cur = None
for r in all_raw:
    zh = r["zh"].strip()
    en = r["en"].strip()
    if not zh and not en: continue
    t = r["time"]
    if cur is None:
        cur = { "from": t, "to": t + step, "zh": zh, "en": en, "screen": [r["screen"]] if r["screen"] else [] }
    else:
        zh_match = (bool(zh) and bool(cur["zh"]) and similar_text(zh, cur["zh"])) or (not zh and not cur["zh"])
        en_match = (bool(en) and bool(cur["en"]) and similar_text(en, cur["en"])) or (not en and not cur["en"])
        same = (zh_match and en_match) and (bool(zh) or bool(en))
        if same:
            cur["to"] = t + step
            if len(zh) > len(cur["zh"]): cur["zh"] = zh
            if len(en) > len(cur["en"]): cur["en"] = en
            if r["screen"] and r["screen"] not in cur["screen"]: cur["screen"].append(r["screen"])
        else:
            merged.append(cur)
            cur = { "from": t, "to": t + step, "zh": zh, "en": en, "screen": [r["screen"]] if r["screen"] else [] }
if cur: merged.append(cur)

result = {
    "status": "extracted",
    "bands": { "zh_band": zh_band, "en_band": en_band },
    "video_info": { "path": video_path, "duration": duration, "total_segments": len(merged) },
    "body": merged
}
with open(output_json, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"成功导出 {len(merged)} 条合并字幕至 {output_json}")
`;

  await fs.writeFile(helperPy, pyCode, 'utf8');
  const outFile = args.output || path.join(path.dirname(args.video), 'subtitles.zh.json');
  const mode = previewMode ? 'preview' : 'extract';
  const zhArg = zhBand ? zhBand.join(',') : '';
  const enArg = enBand ? enBand.join(',') : '';

  const child = spawn('python3', [helperPy, args.video, String(args.step), String(args.workers), outFile, ocrTool, mode, String(args.previewSamples), zhArg, enArg], {
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    process.exit(code);
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('[extract-hard-subtitles 错误]:', err?.message ?? String(err));
    process.exit(1);
  });
}
