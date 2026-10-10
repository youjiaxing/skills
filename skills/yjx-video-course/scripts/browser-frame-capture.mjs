#!/usr/bin/env node

// Capture a decoded video frame through a live browser tab.
//
// This module intentionally depends on an injected browser tab object instead of
// importing Browser Use internals. The caller (usually a Node REPL session with
// the in-app browser bound) passes the tab that already has the video open.
//
// The returned frame is the video element's decoded frame at
// `video.videoWidth x video.videoHeight`, which is what course screenshots need
// for software demos. A viewport screenshot of the player is not a substitute.

import fs from 'node:fs/promises';
import path from 'node:path';

export function decodeCanvasDataUrl(dataUrl) {
  const match = /^data:(image\/png);base64,(.+)$/s.exec(String(dataUrl ?? '').trim());
  if (!match) throw new Error('expected a PNG data URL from the decoded-frame capture');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) throw new Error('decoded frame contained no PNG bytes');
  return { contentType: match[1], bytes };
}

export async function captureDecodedVideoFrame(
  tab,
  {
    timeSeconds,
    outputPath,
    seekTimeoutMs = 8000,
    settleMs = 200,
  },
) {
  if (!tab?.playwright?.evaluate) throw new Error('captureDecodedVideoFrame requires a browser tab with playwright.evaluate');
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) throw new Error('timeSeconds must be a non-negative finite number');
  if (typeof outputPath !== 'string' || outputPath.length === 0) throw new Error('outputPath is required');

  const result = await tab.playwright.evaluate(
    async ({ timeSeconds: targetTime, seekTimeoutMs: timeout, settleMs: settle }) => {
      const video = document.querySelector('video');
      if (!video) throw new Error('no <video> element found on the page');
      if (!video.videoWidth || !video.videoHeight) throw new Error('video has no decoded dimensions yet');

      const wasPaused = video.paused;
      if (!wasPaused) video.pause();

      if (Math.abs(video.currentTime - targetTime) > 0.05) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            video.removeEventListener('seeked', onSeeked);
            reject(new Error(`timed out seeking video to ${targetTime}s`));
          }, timeout);
          const onSeeked = () => {
            clearTimeout(timer);
            video.removeEventListener('seeked', onSeeked);
            resolve();
          };
          video.addEventListener('seeked', onSeeked);
          video.currentTime = targetTime;
        });
      }

      if (settle > 0) {
        await new Promise((resolve) => setTimeout(resolve, settle));
      }

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('could not create a 2D canvas context');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      return {
        dataUrl: canvas.toDataURL('image/png'),
        decodedFrameSize: { width: canvas.width, height: canvas.height },
        renderedPlayerSize: { width: video.clientWidth, height: video.clientHeight },
        devicePixelRatio: window.devicePixelRatio,
        currentTime: video.currentTime,
        wasPaused,
      };
    },
    { timeSeconds, seekTimeoutMs, settleMs },
  );

  const { bytes, contentType } = decodeCanvasDataUrl(result.dataUrl);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);

  return {
    outputPath,
    contentType,
    bytes: bytes.length,
    decodedFrameSize: result.decodedFrameSize,
    renderedPlayerSize: result.renderedPlayerSize,
    devicePixelRatio: result.devicePixelRatio,
    currentTime: result.currentTime,
    wasPaused: result.wasPaused,
  };
}

export function auditFrameResolution({
  decodedFrameSize,
  renderedPlayerSize,
  devicePixelRatio,
  finalImageSize,
  selectedQuality = null,
  selectedFrameRate = null,
  minimumDecodedWidth = 1200,
  minimumDecodedHeight = 720,
  minimumTextHeight = 12,
  minimumEffectiveTextHeight = null,
}) {
  const issues = [];
  if (!decodedFrameSize || decodedFrameSize.width < minimumDecodedWidth) {
    issues.push(`decoded frame width ${decodedFrameSize?.width ?? 0} is below ${minimumDecodedWidth}`);
  }
  if (!decodedFrameSize || decodedFrameSize.height < minimumDecodedHeight) {
    issues.push(`decoded frame height ${decodedFrameSize?.height ?? 0} is below ${minimumDecodedHeight}`);
  }
  if (renderedPlayerSize && decodedFrameSize && renderedPlayerSize.width > 0) {
    const downscaleRatio = renderedPlayerSize.width / decodedFrameSize.width;
    if (downscaleRatio < 0.8) {
      issues.push(`rendered player width ${renderedPlayerSize.width} is ${(downscaleRatio * 100).toFixed(1)}% of decoded width ${decodedFrameSize.width}`);
    }
  }
  if (minimumEffectiveTextHeight != null && minimumEffectiveTextHeight < minimumTextHeight) {
    issues.push(`effective text height ${minimumEffectiveTextHeight.toFixed(1)} is below ${minimumTextHeight}`);
  }
  return {
    ok: issues.length === 0,
    issues,
    selectedQuality,
    selectedFrameRate,
    decodedFrameSize: decodedFrameSize ?? null,
    renderedPlayerSize: renderedPlayerSize ?? null,
    devicePixelRatio: devicePixelRatio ?? null,
    finalImageSize: finalImageSize ?? null,
  };
}
