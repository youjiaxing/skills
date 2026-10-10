#!/usr/bin/env node

// Capture Bilibili frames through the selected browser tab's authenticated
// session.
//
// This is the preferred path for software-demo courses. The page itself calls
// the playurl endpoint with the browser's normal credentials, so 1080P/720P
// availability reflects the actual in-app browser login state. The direct CLI
// capture-bilibili-frames.mjs is an anonymous diagnostic only and must not be
// used to decide that the user needs to sign in.
//
// The module never reads or exports cookies, session storage, or authorization
// tokens. It only uses same-origin fetches and the already-playing media element
// inside the browser page.

import fs from 'node:fs/promises';
import path from 'node:path';
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

export async function resolveBilibiliIdentity(tab) {
  if (!tab?.playwright?.evaluate) {
    throw new Error('resolveBilibiliIdentity requires a browser tab with playwright.evaluate');
  }

  return tab.playwright.evaluate(async () => {
    const url = new URL(location.href);
    const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] ?? null;
    const episode = url.searchParams.get('p') ?? null;
    const video = document.querySelector('video');
    const initial = window.__INITIAL_STATE__ ?? {};
    const pageList = initial.cidMap?.[initial.p]?.cid
      ? [{page: initial.p, cid: initial.cidMap[initial.p].cid}]
      : Array.isArray(initial.videoData?.pages)
        ? initial.videoData.pages
        : [];
    let cid = initial.cid ?? pageList.find((page) => String(page.page ?? page.p) === String(episode))?.cid ?? null;

    if (!cid && bvid) {
      try {
        const response = await fetch(`/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, {
          credentials: 'include',
          headers: {Accept: 'application/json'},
        });
        if (response.ok) {
          const payload = await response.json();
          const pages = Array.isArray(payload?.data) ? payload.data : [];
          const selected = pages.find((page) => String(page.page ?? page.p) === String(episode))
            ?? (episode ? null : pages[0]);
          cid = selected?.cid ?? null;
        }
      } catch {
        // The caller receives an explicit identity_unavailable result.
      }
    }

    return {
      bvid,
      episode,
      cid: cid == null ? null : String(cid),
      title: document.querySelector('h1')?.innerText?.trim() ?? document.title ?? null,
      duration: Number.isFinite(video?.duration) ? video.duration : null,
      url: location.href,
    };
  });
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

  const pageResult = await tab.playwright.evaluate(
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
      const bvid = expectedBvid ?? initial.bvid ?? currentUrl().pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1] ?? null;
      const cid = expectedCid ?? initial.cidMap?.[initial.p]?.cid ?? initial.cid ?? null;
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
      const response = await fetch(`/x/player/playurl?${params}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
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

      if (typeof player?.requestQuality === 'function') {
        try {
          await player.requestQuality(quality);
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

      // Measure the delivered frame rate instead of trusting the manifest or
      // the quality label. A 1080P/30fps stream must not silently stand in for
      // an available 1080P high-frame-rate variant.
      video.muted = true;
      const qualityBefore = video.getVideoPlaybackQuality?.();
      const timeBefore = video.currentTime;
      await video.play().catch(() => {});
      await sleep(sampleSeconds * 1000);
      video.pause();
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
      if (measuredFrameRate != null && measuredFrameRate < requiredFrameRate) {
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
        video.pause();
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('could not create a 2D canvas context');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        framesOut.push({
          time: targetTime,
          current_time: video.currentTime,
          data_url: canvas.toDataURL('image/png'),
          decoded_frame_size: { width: canvas.width, height: canvas.height },
        });
      }

      return {
        status: 'captured',
        bvid,
        cid,
        requested_quality: quality,
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

  await fs.mkdir(outputDir, { recursive: true });
  const writtenFrames = [];
  for (const frame of pageResult.frames) {
    const outputPath = path.join(outputDir, `frame-${String(Math.round(frame.time)).padStart(4, '0')}.png`);
    await fs.writeFile(outputPath, decodePngDataUrl(frame.data_url));
    writtenFrames.push({
      time: frame.time,
      current_time: frame.current_time,
      path: outputPath,
      width: frame.decoded_frame_size.width,
      height: frame.decoded_frame_size.height,
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
