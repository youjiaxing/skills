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
  const args = { step: 2, workers: 8, output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--video' || arg === '-v') args.video = argv[++i];
    else if (arg === '--step' || arg === '-s') args.step = Number(argv[++i]) || 2;
    else if (arg === '--workers' || arg === '-w') args.workers = Number(argv[++i]) || 8;
    else if (arg === '--output' || arg === '-o') args.output = argv[++i];
  }
  return args;
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
    console.error('用法: node extract-hard-subtitles.mjs --video <视频路径> [--step 2] [--workers 8] [--output <输出json>]');
    process.exit(1);
  }

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
import cv2, subprocess, os, sys, json, time
from concurrent.futures import ThreadPoolExecutor

video_path = sys.argv[1]
step = int(sys.argv[2])
workers = int(sys.argv[3])
output_json = sys.argv[4]
ocr_tool = sys.argv[5]

cap = cv2.VideoCapture(video_path)
fps = cap.get(cv2.CAP_PROP_FPS)
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
duration = int(total_frames / fps) if fps > 0 else 0
print(f"视频时长: {duration}s, 采样步长: {step}s, 并发线程: {workers}")

times = list(range(0, duration, step))
all_raw = []

def process_frame(t):
    cap_local = cv2.VideoCapture(video_path)
    cap_local.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
    ret, frame = cap_local.read()
    cap_local.release()
    if not ret: return None

    tmp_path = f"/tmp/hsub_{os.getpid()}_{t}.png"
    cv2.imwrite(tmp_path, frame)
    try:
        res = subprocess.run([ocr_tool, tmp_path], capture_output=True, text=True)
        zh, en, screen = [], [], []
        for line in res.stdout.strip().split("\\n"):
            if not line or "\\t" not in line: continue
            coords, text = line.split("\\t", 1)
            text = text.strip()
            if not text: continue
            y = float(coords.split(",")[1])
            # y 坐标自底向上：0.08~0.15 中文字幕，0.01~0.08 英文字幕，>=0.28 画面主体
            if 0.08 <= y <= 0.15: zh.append(text)
            elif 0.01 <= y < 0.08: en.append(text)
            elif y >= 0.28: screen.append(text)
        return { "time": t, "zh": " ".join(zh), "en": " ".join(en), "screen": " | ".join(screen) }
    finally:
        if os.path.exists(tmp_path): os.remove(tmp_path)

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
        same = (zh and cur["zh"] and (zh == cur["zh"] or zh in cur["zh"] or cur["zh"] in zh)) or (not zh and not cur["zh"] and en == cur["en"])
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
    "video_info": { "path": video_path, "duration": duration, "total_segments": len(merged) },
    "body": merged
}
with open(output_json, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"成功导出 {len(merged)} 条合并字幕至 {output_json}")
`;

  await fs.writeFile(helperPy, pyCode, 'utf8');
  const outFile = args.output || path.join(path.dirname(args.video), 'subtitles.zh.json');

  const child = spawn('python3', [helperPy, args.video, String(args.step), String(args.workers), outFile, ocrTool], {
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
