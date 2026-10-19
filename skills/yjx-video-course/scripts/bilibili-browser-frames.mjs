#!/usr/bin/env node

// Capture Bilibili frames through the selected browser tab's authenticated
// session, when the host provides a mutable page/media execution capability.
//
// This is the preferred path for software-demo courses. The page itself calls
// the site's playurl endpoint with the browser's normal credentials, so 1080P/720P
// availability reflects the actual in-app browser login state. The direct CLI
// capture-bilibili-frames.mjs is an anonymous diagnostic only and must not be
// used to decide that the user needs to sign in.
//
// The module never reads or exports cookies, session storage, or authorization
// tokens. It only uses the site's normal API and the already-playing media element
// inside the browser page.

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBilibiliIdentity, sameBilibiliPage } from './bilibili-identity.mjs';
export { resolveBilibiliIdentity } from './bilibili-identity.mjs';
import {
  classifyBilibiliSession,
  nextActionForSessionOutcome,
  qualityUnavailableStatusForOutcome,
  sessionOutcomeForMissingQuality,
} from './bilibili-session-status.mjs';

const QUALITY_LABEL = {
  16: '360P',
  32: '480P',
  64: '720P',
  80: '1080P',
};

const QUALITY_HEIGHT = {
  16: 360,
  32: 480,
  64: 720,
  80: 1080,
};

const MINIMUM_FRAME_RATE = 30;
const FRAME_RATE_TOLERANCE = 5;

function decodePngDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl ?? '').trim());
  if (!match) throw new Error('expected a PNG data URL from the browser frame capture');
  return Buffer.from(match[1], 'base64');
}

async function executeFrameCapture(tab, capture, options) {
  try {
    const result = await tab.playwright.evaluate(capture, options);
    if (result?.status !== 'frame_capture_capability_unavailable') {
      return { ...result, execution_backend: 'page_evaluate' };
    }
  } catch {
    // Some hosts expose a read-only DOM scope. Try the same operation in the
    // bound tab's native page context, without exporting browser credentials.
  }
  let cdp;
  try { cdp = await tab.capabilities?.get('cdp'); } catch { /* unavailable */ }
  if (!cdp?.send) return { status: 'frame_capture_capability_unavailable' };
  try {
    const response = await cdp.send('Runtime.evaluate', {
      expression: `(${capture.toString()})(${JSON.stringify(options)})`,
      awaitPromise: true,
      returnByValue: true,
    }, { timeoutMs: Math.min(60000, (options.times.length + 1) * options.seekTimeoutMs + options.frameRateSampleSeconds * 1000 + 2000) });
    if (response.exceptionDetails || !response.result?.value?.status) {
      return { status: 'frame_capture_failed', execution_backend: 'native_cdp', reason: 'page capture did not complete' };
    }
    return { ...response.result.value, execution_backend: 'native_cdp' };
  } catch {
    return { status: 'frame_capture_failed', execution_backend: 'native_cdp', reason: 'native execution failed or timed out' };
  }
}

export async function captureBilibiliFramesFromBrowser(
  tab,
  {
    times,
    outputDir,
    requestedQuality = 80,
    seekTimeoutMs = 10000,
    frameRateSampleSeconds = 1.5,
  },
) {
  if (!tab?.playwright?.evaluate) throw new Error('captureBilibiliFramesFromBrowser requires a browser tab with playwright.evaluate');
  if (!Array.isArray(times) || times.length === 0) throw new Error('times must be a non-empty array of seconds');
  if (times.some((time) => !Number.isFinite(time) || time < 0)) throw new Error('times must contain finite non-negative seconds');
  if (typeof outputDir !== 'string' || outputDir.length === 0) throw new Error('outputDir is required');
  if (!QUALITY_LABEL[requestedQuality]) throw new Error(`unsupported quality code ${requestedQuality}`);

  const requestedHeight = QUALITY_HEIGHT[requestedQuality];
  const requestedWidth = requestedQuality === 80 ? 1920 : 1280;
  const identity = await resolveBilibiliIdentity(tab);
  if (!identity.bvid || !identity.cid) {
    return {
      status: 'identity_unavailable',
      bvid: identity.bvid,
      episode: identity.episode,
      cid: identity.cid,
      title: identity.title,
      duration: identity.duration,
      url: identity.url,
    };
  }
  if (Number.isFinite(identity.duration) && times.some((time) => time >= identity.duration)) {
    return { status: 'invalid_capture_time', duration: identity.duration };
  }

  const pageResult = await executeFrameCapture(tab,
    async ({
      times: targetTimes,
      requestedQuality: quality,
      requestedHeight: targetHeight,
      requestedWidth: targetWidth,
      seekTimeoutMs: timeoutMs,
      frameRateSampleSeconds: sampleSeconds,
      minimumFrameRate,
      frameRateTolerance,
      expectedBvid,
      expectedEpisode,
      expectedCid,
      expectedTitle,
      expectedDuration,
    }) => {
      const describeVariant = (variant) => ({
        id: Number(variant.id),
        width: Number(variant.width),
        height: Number(variant.height),
        frame_rate: Number(variant.frameRate),
        bandwidth: Number(variant.bandwidth),
        codecs: variant.codecs ?? null,
      });
      const qualityLabel = {
        16: '360P',
        32: '480P',
        64: '720P',
        80: '1080P',
      };
      const currentUrl = () => new URL(location.href);
      const initial = window.__INITIAL_STATE__ ?? {};
      const bvid = currentUrl().pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] ?? null;
      const cid = expectedCid;
      const episode = currentUrl().searchParams.get('p') ?? null;
      if (!bvid || !cid) return { status: 'identity_unavailable', bvid, episode, cid };
      const title = document.querySelector('h1')?.innerText?.trim() ?? document.title ?? null;
      const duration = Number.isFinite(document.querySelector('video')?.duration)
        ? document.querySelector('video').duration
        : null;
      if (
        bvid !== expectedBvid
        || String(episode ?? '') !== String(expectedEpisode ?? '')
        || (expectedTitle && title && title !== expectedTitle)
        || (Number.isFinite(expectedDuration) && Number.isFinite(duration)
          && Math.abs(duration - expectedDuration) > 1)
      ) {
        return {
          status: 'source_changed',
          bvid,
          episode,
          title,
          duration,
          expected_bvid: expectedBvid,
          expected_episode: expectedEpisode,
          expected_title: expectedTitle,
          expected_duration: expectedDuration,
        };
      }

      const params = new URLSearchParams({
        bvid,
        cid: String(cid),
        qn: String(quality),
        fnval: '4048',
        fourk: '1',
      });
      if (typeof fetch !== 'function') return { status: 'frame_capture_capability_unavailable', bvid, cid };
      const response = await fetch(`https://api.bilibili.com/x/player/playurl?${params}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { status: 'playurl_http_error', http_status: response.status, bvid, cid };
      const payload = await response.json();
      if (payload.code !== 0) return { status: 'playurl_rejected', code: payload.code, message: payload.message, bvid, cid };

      const variants = Array.isArray(payload.data?.dash?.video) ? payload.data.dash.video.map((variant) => ({
        id: Number(variant.id),
        width: Number(variant.width),
        height: Number(variant.height),
        frameRate: Number(variant.frameRate),
        bandwidth: Number(variant.bandwidth),
        codecs: variant.codecs ?? null,
      })) : [];
      const eligible = variants
        .filter((variant) => variant.width >= targetWidth && variant.height >= targetHeight)
        .sort((left, right) => (
          right.height - left.height
          || right.frameRate - left.frameRate
          || right.bandwidth - left.bandwidth
        ));
      const selected = eligible[0] ?? null;
      if (!selected) {
        const sessionSignals = {
          initialStateUser: initial.user ?? null,
          playinfoUser: window.__playinfo__?.user ?? null,
          playerUser: window.player?.getUserInfo?.() ?? null,
          hasAvatar: Boolean(document.querySelector('.header-avatar-wrap, .bili-avatar, .header-entry-avatar')),
          hasLoginEntry: Boolean(document.querySelector('.header-login-entry, .go-login-btn, .login-btn')),
        };
        return {
          status: 'quality_unavailable',
          bvid,
          cid,
          requested_quality: quality,
          requested_height: targetHeight,
          accept_quality: payload.data?.accept_quality ?? null,
          session_signals: sessionSignals,
          available_variants: variants.map(describeVariant),
        };
      }

      const player = window.player;
      const video = document.querySelector('video');
      if (!video) return { status: 'video_element_unavailable', bvid, cid };

      const sourceStillMatches = () => (
        currentUrl().pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] === expectedBvid
        && String(currentUrl().searchParams.get('p') ?? '') === String(expectedEpisode ?? '')
        && document.querySelector('video') === video
        && (!Number.isFinite(expectedDuration) || Math.abs(video.duration - expectedDuration) <= 1)
      );
      if (!sourceStillMatches()) return { status: 'source_changed', bvid, cid };

      const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      if (typeof video.pause === 'function') video.pause();
      const waitForQuality = async () => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          if (video.videoWidth >= targetWidth && video.videoHeight >= targetHeight) return true;
          await sleep(250);
        }
        return false;
      };

      const currentQuality = player?.getQuality?.()?.nowQ;
      if (typeof player?.requestQuality === 'function' && Number(currentQuality) !== selected.id) {
        try {
          await player.requestQuality(selected.id);
        } catch (error) {
          return { status: 'quality_request_failed', error: String(error), bvid, cid, selected_variant: describeVariant(selected) };
        }
      }
      if (!(await waitForQuality())) {
        return {
          status: 'quality_not_honored',
          bvid,
          cid,
          requested_quality: quality,
          selected_variant: describeVariant(selected),
          actual: { width: video.videoWidth, height: video.videoHeight },
        };
      }
      if (!sourceStillMatches()) return { status: 'source_changed', bvid, cid };

      // Measure the delivered frame rate instead of trusting the manifest or
      // the quality label. A 1080P/30fps stream must not silently stand in for
      // an available 1080P high-frame-rate variant.
      const wasMuted = video.muted;
      video.muted = true;
      const qualityBefore = video.getVideoPlaybackQuality?.();
      const timeBefore = video.currentTime;
      await video.play().catch(() => {});
      await sleep(sampleSeconds * 1000);
      video.pause();
      video.muted = wasMuted;
      if (!sourceStillMatches()) return { status: 'source_changed', bvid, cid };
      const qualityAfter = video.getVideoPlaybackQuality?.();
      const timeAfter = video.currentTime;
      const elapsed = timeAfter - timeBefore;
      const frames = qualityAfter && qualityBefore
        ? qualityAfter.totalVideoFrames - qualityBefore.totalVideoFrames
        : null;
      const measuredFrameRate = frames != null && elapsed > 0 ? frames / elapsed : null;
      const requiredFrameRate = Math.max(
        minimumFrameRate,
        selected.frameRate - frameRateTolerance,
      );
      if (!Number.isFinite(measuredFrameRate) || elapsed < 1 || frames <= 0) {
        return { status: 'frame_rate_unverified', bvid, cid, selected_variant: describeVariant(selected) };
      }
      // A short counter sample has a one-frame boundary uncertainty.
      if (measuredFrameRate + 1 / elapsed < requiredFrameRate) {
        return {
          status: 'frame_rate_not_honored',
          bvid,
          cid,
          selected_variant: describeVariant(selected),
          measured_frame_rate: measuredFrameRate,
          required_frame_rate: requiredFrameRate,
          actual: { width: video.videoWidth, height: video.videoHeight },
        };
      }

      const rendered = {
        width: video.clientWidth,
        height: video.clientHeight,
      };
      const decoded = {
        width: video.videoWidth,
        height: video.videoHeight,
      };
      const framesOut = [];
      for (const targetTime of targetTimes) {
        const loopUrl = currentUrl();
        if (
          loopUrl.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] !== expectedBvid
          || String(loopUrl.searchParams.get('p') ?? '') !== String(expectedEpisode ?? '')
          || (expectedTitle
            && (document.querySelector('h1')?.innerText?.trim() ?? document.title ?? null) !== expectedTitle)
        ) {
          return {
            status: 'source_changed',
            bvid,
            cid,
            expected_bvid: expectedBvid,
            expected_episode: expectedEpisode,
            expected_title: expectedTitle,
            expected_duration: expectedDuration,
            actual_url: loopUrl.href,
          };
        }
        if (Math.abs(video.currentTime - targetTime) > 0.05) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              video.removeEventListener('seeked', onSeeked);
              reject(new Error(`timed out seeking video to ${targetTime}s`));
            }, timeoutMs);
            const onSeeked = () => {
              clearTimeout(timer);
              video.removeEventListener('seeked', onSeeked);
              resolve();
            };
            video.addEventListener('seeked', onSeeked);
            video.currentTime = targetTime;
          });
        }
        await sleep(500);
        if (!sourceStillMatches()) return { status: 'source_changed', bvid, cid };
        video.pause();
        if (video.seeking || video.readyState < 2 || Math.abs(video.currentTime - targetTime) > 0.1) {
          return { status: 'frame_not_ready', bvid, cid, time: targetTime, current_time: video.currentTime };
        }
        if (video.videoWidth < targetWidth || video.videoHeight < targetHeight) {
          return { status: 'quality_not_honored', bvid, cid, actual: { width: video.videoWidth, height: video.videoHeight } };
        }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('could not create a 2D canvas context');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        framesOut.push({
          time: targetTime,
          current_time: video.currentTime,
          paused: video.paused,
          data_url: canvas.toDataURL('image/png'),
          decoded_frame_size: { width: canvas.width, height: canvas.height },
        });
      }

      return {
        status: 'captured',
        bvid,
        cid,
        requested_quality: quality,
        capture_surface: 'video_decoded_frame',
        selected_variant: describeVariant(selected),
        available_variants: variants.map(describeVariant),
        selected_quality: qualityLabel[selected.id] ?? `${selected.height}P`,
        selected_frame_rate: selected.frameRate,
        measured_frame_rate: measuredFrameRate,
        decoded_frame_size: decoded,
        rendered_player_size: rendered,
        device_pixel_ratio: window.devicePixelRatio,
        frames: framesOut,
      };
    },
    {
      times,
      requestedQuality,
      requestedHeight,
      requestedWidth,
      seekTimeoutMs,
      frameRateSampleSeconds,
      minimumFrameRate: MINIMUM_FRAME_RATE,
      frameRateTolerance: FRAME_RATE_TOLERANCE,
      expectedBvid: identity.bvid,
      expectedEpisode: identity.episode,
      expectedCid: identity.cid,
      expectedTitle: identity.title,
      expectedDuration: identity.duration,
    },
  );

  if (pageResult.status === 'quality_unavailable') {
    const session = classifyBilibiliSession(pageResult.session_signals);
    const sessionOutcome = sessionOutcomeForMissingQuality(session);
    return {
      ...pageResult,
      status: qualityUnavailableStatusForOutcome(sessionOutcome),
      session_state: session.state,
      session_evidence: session.evidence,
      session_outcome: sessionOutcome,
      next_action: nextActionForSessionOutcome(sessionOutcome),
    };
  }
  if (pageResult.status !== 'captured') return pageResult;
  const after = await resolveBilibiliIdentity(tab);
  if (after.status !== 'identity_verified' || !sameBilibiliPage(identity, after) || after.cid !== identity.cid) {
    return { status: 'source_changed' };
  }

  await fs.mkdir(outputDir, { recursive: true });
  const writtenFrames = [];
  for (const frame of pageResult.frames) {
    const outputPath = path.join(outputDir, `frame-${String(frame.time).padStart(4, '0').replace('.', '-')}.png`);
    await fs.writeFile(outputPath, decodePngDataUrl(frame.data_url));
    writtenFrames.push({
      time: frame.time,
      current_time: frame.current_time,
      paused: frame.paused,
      path: outputPath,
      width: frame.decoded_frame_size.width,
      height: frame.decoded_frame_size.height,
      final_image_size: frame.decoded_frame_size,
    });
  }

  return {
    ...pageResult,
    episode: identity.episode,
    title: identity.title,
    duration: identity.duration,
    frames: writtenFrames,
  };
}
