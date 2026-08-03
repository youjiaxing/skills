/**
 * Ink fullscreen dispatch shell (ticket 01).
 *
 * Interactive TTY path: alternate-screen layout with regions
 * 顶栏 / 中部 / 当前槽 / 底栏. `q` stops the chain and exits cleanly.
 * Real snapshot content lands in later tickets; this shell may show placeholders.
 */

import { createElement, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

import { statusLabelZh } from './dependency-graph.mjs';

const ALT_ENTER = '\u001b[?1049h\u001b[?25l';
const ALT_LEAVE = '\u001b[?1049l\u001b[?25h';

/**
 * Whether the interactive path should mount the Ink fullscreen shell.
 * --once and any non-TTY stream stay on the printable non-fullscreen path.
 *
 * @param {{
 *   input?: { isTTY?: boolean } | null,
 *   output?: { isTTY?: boolean } | null,
 *   once?: boolean,
 * }} [options]
 * @returns {boolean}
 */
export function shouldUseFullscreenDispatch({
  input = process.stdin,
  output = process.stdout,
  once = false,
} = {}) {
  if (once) return false;
  return Boolean(input?.isTTY && output?.isTTY);
}

function statusLine(snap) {
  if (!snap) return '状态: （启动中）';
  const stopped = snap.stopped ? ' [已停链]' : '';
  const label = snap.status ? statusLabelZh(snap.status) : '—';
  return `状态: ${label}${stopped}`;
}

function topBarText(snap) {
  if (!snap) {
    return '[顶栏] Issue Crusher · 调度（启动中…）';
  }
  return [
    '[顶栏] Issue Crusher · 调度',
    `功能: ${snap.feature ?? '—'}`,
    `runtime: ${snap.runtime ?? '—'}`,
    `后续 mode: ${snap.subsequentMode ?? '—'}`,
    statusLine(snap),
  ].join('  ·  ');
}

function middleText(snap) {
  // Ticket 02 fills real dependency graph; keep an explicit region marker.
  void snap;
  return '[中部] 依赖图与可执行清单（占位）';
}

function slotText(snap) {
  if (!snap || !snap.slot) {
    return '[当前槽] （空）';
  }
  const slot = snap.slot;
  return [
    '[当前槽]',
    `票: ${slot.issueId ?? '—'}`,
    `pid: ${slot.pid ?? '-'}`,
    `mode: ${slot.mode ?? '—'}`,
    `已关票: ${slot.closed ? '是' : '否'}`,
  ].join('  ');
}

function footerText() {
  return '[底栏]  [q] 退出全屏并停链';
}

/**
 * Presentational shell: four fixed regions. Safe for renderToString tests.
 *
 * @param {{ snap?: object | null }} props
 */
export function DispatchShell({ snap = null } = {}) {
  return createElement(
    Box,
    {
      flexDirection: 'column',
      width: '100%',
      height: '100%',
    },
    createElement(
      Box,
      {
        borderStyle: 'single',
        paddingX: 1,
        width: '100%',
      },
      createElement(Text, null, topBarText(snap)),
    ),
    createElement(
      Box,
      {
        flexGrow: 1,
        borderStyle: 'single',
        paddingX: 1,
        flexDirection: 'column',
        width: '100%',
      },
      createElement(Text, null, middleText(snap)),
    ),
    createElement(
      Box,
      {
        borderStyle: 'single',
        paddingX: 1,
        width: '100%',
      },
      createElement(Text, null, slotText(snap)),
    ),
    createElement(
      Box,
      {
        borderStyle: 'single',
        paddingX: 1,
        width: '100%',
      },
      createElement(Text, { dimColor: true }, footerText()),
    ),
  );
}

/**
 * Live fullscreen app: poll surface, redraw shell, quit on `q`.
 *
 * @param {{
 *   surface: object,
 *   autoTick?: boolean,
 *   pollIntervalMs?: number,
 *   ticksRef?: { current: number },
 * }} props
 */
function DispatchFullscreenApp({
  surface,
  autoTick = true,
  pollIntervalMs = 2000,
  ticksRef = null,
} = {}) {
  const { exit } = useApp();
  const [snap, setSnap] = useState(null);
  const busyRef = useRef(false);
  const quittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        if (autoTick) {
          const next = await surface.tick();
          if (ticksRef) ticksRef.current += 1;
          if (!cancelled) setSnap(next);
        } else if (typeof surface.refresh === 'function') {
          const next = await surface.refresh();
          if (!cancelled) setSnap(next);
        } else {
          if (!cancelled) setSnap(surface.snapshot());
        }
      } catch (error) {
        if (!cancelled) {
          setSnap({
            feature: '?',
            status: 'error',
            stopped: false,
            slot: null,
            messages: [{ type: 'error', text: error.message }],
          });
        }
      }
    }

    void bootstrap();

    const intervalMs = Math.max(250, pollIntervalMs);
    const pollId = setInterval(() => {
      if (cancelled || busyRef.current || quittingRef.current) return;
      busyRef.current = true;
      (async () => {
        try {
          let next;
          const current = (() => {
            try {
              return surface.snapshot();
            } catch {
              return null;
            }
          })();
          if (current?.stopped) {
            next = typeof surface.refresh === 'function'
              ? await surface.refresh()
              : current;
          } else {
            next = await surface.tick();
            if (ticksRef) ticksRef.current += 1;
          }
          if (!cancelled) setSnap(next);
        } catch {
          // Keep last frame on poll errors; later tickets can surface them.
        } finally {
          busyRef.current = false;
        }
      })();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(pollId);
    };
  }, [surface, autoTick, pollIntervalMs, ticksRef]);

  useInput((input) => {
    if (input !== 'q' && input !== 'Q') return;
    if (quittingRef.current) return;
    quittingRef.current = true;

    void (async () => {
      try {
        // Serialize with in-flight poll.
        while (busyRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        busyRef.current = true;
        try {
          let stopped = false;
          try {
            stopped = Boolean(surface.snapshot().stopped);
          } catch {
            stopped = false;
          }
          if (!stopped && typeof surface.stop === 'function') {
            await surface.stop();
          }
        } finally {
          busyRef.current = false;
        }
      } finally {
        exit();
      }
    })();
  });

  return createElement(DispatchShell, { snap });
}

/**
 * Mount the Ink fullscreen dispatch app until quit.
 *
 * @param {{
 *   surface: object,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   autoTick?: boolean,
 *   pollIntervalMs?: number,
 *   alternateScreen?: boolean,
 * }} options
 */
export async function runFullscreenDispatch({
  surface,
  input = process.stdin,
  output = process.stdout,
  autoTick = true,
  pollIntervalMs = 2000,
  alternateScreen = Boolean(output?.isTTY),
} = {}) {
  if (!surface) throw new Error('surface is required');

  const ticksRef = { current: 0 };
  let enteredAlt = false;

  if (alternateScreen && typeof output.write === 'function') {
    output.write(ALT_ENTER);
    enteredAlt = true;
  }

  const instance = render(
    createElement(DispatchFullscreenApp, {
      surface,
      autoTick,
      pollIntervalMs,
      ticksRef,
    }),
    {
      stdin: input,
      stdout: output,
      exitOnCtrlC: true,
      patchConsole: false,
    },
  );

  try {
    await instance.waitUntilExit();
  } finally {
    try {
      instance.unmount();
    } catch {
      // already unmounted on clean exit
    }
    if (enteredAlt && typeof output.write === 'function') {
      output.write(ALT_LEAVE);
    }
  }

  let stopped = false;
  try {
    stopped = Boolean(surface.snapshot().stopped);
  } catch {
    stopped = false;
  }

  return {
    ticks: ticksRef.current,
    stopped,
    mode: 'fullscreen',
  };
}
