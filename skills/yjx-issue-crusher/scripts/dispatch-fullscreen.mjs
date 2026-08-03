/**
 * Ink fullscreen dispatch shell (tickets 01–02).
 *
 * Interactive TTY path: alternate-screen layout with regions
 * 顶栏 / 中部 / 当前槽 / 底栏. `q` stops the chain and exits cleanly.
 * Regions render a live Dispatch Surface snapshot (graph, slot, HITL).
 * Orchestration contract is unchanged: board is read-only, single slot,
 * dual-condition handoff still owned by Chain Run / surface.tick.
 */

import { createElement, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

import {
  renderDependencyGraph,
  statusLabelZh,
} from './dependency-graph.mjs';

const ALT_ENTER = '\u001b[?1049h\u001b[?25l';
const ALT_LEAVE = '\u001b[?1049l\u001b[?25h';

const GRAPH_LEGEND = '图例: ★可执行  ▶进行中  ·阻塞/未完成  ✓已完成  ··· 上游──►下游';

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
  const label = snap.status ? statusLabelZh(snap.status) : '—';
  // Avoid "已停链 [已停链]" when status is already the stopped label.
  const stoppedMark = snap.stopped && snap.status !== 'stopped' ? ' [已停链]' : '';
  return `状态: ${label}${stoppedMark}`;
}

function modeHint(mode) {
  if (mode === 'review') return '（审码）';
  if (mode === 'vibe') return '（可自动关票）';
  return '';
}

/**
 * Top bar: feature / runtime / subsequent mode / chain status.
 * Pure — safe for unit tests without a terminal.
 *
 * @param {object | null | undefined} snap
 * @returns {string}
 */
export function renderTopBar(snap) {
  if (!snap) {
    return '[顶栏] Issue Crusher · 调度（启动中…）';
  }
  const mode = snap.subsequentMode ?? '—';
  return [
    '[顶栏] Issue Crusher · 调度',
    `功能: ${snap.feature ?? '—'}`,
    `runtime: ${snap.runtime ?? '—'}`,
    `后续 mode: ${mode}${modeHint(mode)}`,
    statusLine(snap),
  ].join('  ·  ');
}

/**
 * Middle panel: Chinese dependency graph legend + graph + 「现在可执行」.
 * Board remains read-only display; no graph dispatch.
 *
 * @param {object | null | undefined} snap
 * @returns {string}
 */
export function renderMiddlePanel(snap) {
  const lines = ['[中部] 依赖图（只读 · 不可图上派票）', `  ${GRAPH_LEGEND}`];

  if (!snap) {
    lines.push('  （启动中…）');
    lines.push('');
    lines.push('现在可执行:');
    lines.push('  （无）');
    return lines.join('\n');
  }

  const issues = snap.board?.issues ?? [];
  const graph = renderDependencyGraph({
    issues,
    slotIssueId: snap.slot?.issueId ?? null,
  });

  for (const line of graph.lines) lines.push(line);
  if (graph.warnings.length) {
    lines.push('警告:');
    for (const warning of graph.warnings) lines.push(`  ⚠ ${warning}`);
  }

  lines.push('');
  lines.push('现在可执行:');
  if (graph.executable.length === 0) {
    lines.push('  （无）');
  } else {
    for (const item of graph.executable) {
      const active = snap.slot?.issueId === item.id ? '  ◀当前槽' : '';
      lines.push(`  ★ ${item.id}${active}`);
    }
  }

  return lines.join('\n');
}

/**
 * Lower panel: current slot (empty or ticket/pid/closed/mode) + pending HITL.
 *
 * @param {object | null | undefined} snap
 * @returns {string}
 */
export function renderSlotPanel(snap) {
  const lines = [];

  if (!snap || !snap.slot) {
    lines.push('[当前槽] （空）');
  } else {
    const slot = snap.slot;
    lines.push(
      [
        '[当前槽]',
        `票: ${slot.issueId ?? '—'}`,
        slot.title ? `标题: ${slot.title}` : null,
        `pid: ${slot.pid ?? '-'}`,
        `mode: ${slot.mode ?? '—'}`,
        `已关票: ${slot.closed ? '是' : '否'}`,
      ].filter(Boolean).join('  '),
    );
    if (slot.sessionId) {
      lines.push(`  session: ${slot.sessionId}`);
    }
  }

  if (snap?.pendingHitl) {
    const hitl = snap.pendingHitl;
    lines.push('[HITL] 需人工确认后才开票:');
    lines.push(
      `  票: ${hitl.issueId ?? '—'}  类型: ${hitl.entryClass ?? '—'}`,
    );
    if (hitl.title) lines.push(`  标题: ${hitl.title}`);
    lines.push(
      [
        `  runtime: ${hitl.runtime ?? '—'}`,
        `mode: ${hitl.mode ?? '—'}`,
        `model: ${hitl.model ?? '运行时默认'}`,
        `effort: ${hitl.effort ?? '运行时默认'}`,
      ].join('  '),
    );
  }

  return lines.join('\n');
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
  const middleLines = renderMiddlePanel(snap).split('\n');
  const slotLines = renderSlotPanel(snap).split('\n');

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
      createElement(Text, null, renderTopBar(snap)),
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
      ...middleLines.map((line, index) => createElement(Text, { key: `m${index}` }, line || ' ')),
    ),
    createElement(
      Box,
      {
        borderStyle: 'single',
        paddingX: 1,
        flexDirection: 'column',
        width: '100%',
      },
      ...slotLines.map((line, index) => createElement(Text, { key: `s${index}` }, line || ' ')),
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
