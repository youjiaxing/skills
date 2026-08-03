/**
 * Ink fullscreen dispatch shell (tickets 01–03).
 *
 * Interactive TTY path: alternate-screen layout with regions
 * 顶栏 / 中部 / 当前槽 / 底栏. Keyboard drives the same Dispatch Surface
 * actions as the printable TUI (`m` mode dial, `f` force, `r` resume,
 * `y`/`n` HITL, `s` stop, `t` tick, `q` quit; `j`/`k`/digits select
 * executable list highlight; **Enter** starts highlighted (or board default).
 * Orchestration contract is unchanged: board is read-only, single slot,
 * dual-condition handoff still owned by Chain Run / surface.tick.
 * No graph dispatch, no embedded Worker terminal.
 */

import { createElement, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

import { handleDispatchCommand } from './dispatch-commands.mjs';
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
 * Optional selectedIndex highlights an executable list row (keyboard j/k/digits).
 *
 * @param {object | null | undefined} snap
 * @param {{ selectedIndex?: number | null }} [opts]
 * @returns {string}
 */
export function renderMiddlePanel(snap, { selectedIndex = null } = {}) {
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
    for (let i = 0; i < graph.executable.length; i += 1) {
      const item = graph.executable[i];
      const marks = [];
      if (snap.slot?.issueId === item.id) marks.push('◀当前槽');
      if (selectedIndex === i) marks.push('◀选中');
      const suffix = marks.length ? `  ${marks.join(' ')}` : '';
      lines.push(`  ★ ${item.id}${suffix}`);
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

/**
 * Bottom bar: available keys from snapshot.actions (+ always t/q and list nav).
 *
 * @param {object | null | undefined} snap
 * @returns {string}
 */
export function renderFooter(snap) {
  const actions = snap?.actions || {};
  const keys = [];
  if (actions.setMode?.available !== false) keys.push('[m] mode 拨杆');
  if (actions.forceAdvance?.available) keys.push('[f] 强制推进');
  if (actions.resume?.available) keys.push('[r] 恢复');
  if (actions.confirmHitl?.available) keys.push('[y] 同意');
  if (actions.rejectHitl?.available) keys.push('[n] 拒绝');
  if (actions.stop?.available !== false) keys.push('[s] 停链');
  keys.push('[t] 刷新', '[j/k|数字] 选择', '[Enter] 开始', '[q] 退出并停链');
  return `[底栏]  ${keys.join('  ')}`;
}

/**
 * One-line operator notice (last action tip or surface message).
 *
 * @param {object | null | undefined} snap
 * @param {string | null | undefined} notice
 * @returns {string}
 */
export function renderNotice(snap, notice = null) {
  if (notice) return `[提示] ${notice}`;
  const last = Array.isArray(snap?.messages) && snap.messages.length > 0
    ? snap.messages[snap.messages.length - 1]
    : null;
  if (last) {
    const text = last.text || last.message || last.type;
    if (text) return `[提示] ${text}`;
  }
  return '';
}

/**
 * Map one fullscreen keypress to a dispatch command or list-selection intent.
 * Mode dial: bare `m` toggles subsequent review ↔ vibe (no readline args).
 * Enter / return → start (highlighted id resolved by handleFullscreenKey).
 *
 * @param {string | null | undefined} input
 * @param {{ subsequentMode?: string | null, key?: { return?: boolean } | null }} [ctx]
 * @returns {{ type: string, arg?: string | number } | null}
 */
export function mapFullscreenKey(input, { subsequentMode = null, key = null } = {}) {
  // Enter starts a ticket (highlight or board default). Ink often sends
  // empty input + key.return; raw terminals may send \r / \n.
  if (key?.return || input === '\r' || input === '\n') {
    return { type: 'start' };
  }
  if (input == null || input === '') return null;
  // Ignore multi-char pastes / control sequences.
  if (String(input).length !== 1) return null;
  const lower = String(input).toLowerCase();

  if (lower === 'q') return { type: 'quit' };
  if (lower === 's') return { type: 'stop' };
  if (lower === 't') return { type: 'tick' };
  if (lower === 'f') return { type: 'forceAdvance' };
  if (lower === 'r') return { type: 'resume' };
  if (lower === 'y') return { type: 'confirmHitl' };
  if (lower === 'n') return { type: 'rejectHitl' };
  if (lower === 'm') {
    const next = subsequentMode === 'vibe' ? 'review' : 'vibe';
    return { type: 'setMode', arg: next };
  }
  if (lower === 'j') return { type: 'selectNext' };
  if (lower === 'k') return { type: 'selectPrev' };
  if (/^[1-9]$/.test(lower)) return { type: 'selectIndex', arg: Number(lower) - 1 };
  return null;
}

/**
 * Pure list-selection update for executable rows. Display-only — never dispatches.
 *
 * @param {{ type: string, arg?: number } | null} command
 * @param {number | null} current
 * @param {number} count
 * @returns {number | null}
 */
export function nextListSelection(command, current, count) {
  if (!command || count <= 0) return null;
  if (command.type === 'selectIndex') {
    const index = Number(command.arg);
    if (!Number.isInteger(index) || index < 0 || index >= count) return null;
    return index;
  }
  const base = current == null ? 0 : current;
  if (command.type === 'selectNext') return (base + 1) % count;
  if (command.type === 'selectPrev') return (base - 1 + count) % count;
  return current;
}

/**
 * Apply one fullscreen key against the surface (same semantics as printable TUI).
 * List-nav keys return selection-only results and do not touch the surface.
 * Enter (`start`) uses selectedIssueId when set; otherwise board default next.
 *
 * @param {object} surface
 * @param {string | null | undefined} input
 * @param {{
 *   subsequentMode?: string | null,
 *   selectedIndex?: number | null,
 *   executableCount?: number,
 *   selectedIssueId?: string | null,
 *   key?: { return?: boolean } | null,
 * }} [ctx]
 * @returns {Promise<{
 *   quit?: boolean,
 *   message?: string,
 *   selectedIndex?: number | null,
 *   selectionOnly?: boolean,
 *   ok?: boolean,
 *   spawned?: boolean,
 *   reason?: string,
 * }>}
 */
export async function handleFullscreenKey(surface, input, ctx = {}) {
  const command = mapFullscreenKey(input, {
    subsequentMode: ctx.subsequentMode
      ?? (() => {
        try {
          return surface.snapshot().subsequentMode;
        } catch {
          return null;
        }
      })(),
    key: ctx.key ?? null,
  });
  if (!command) return {};

  if (
    command.type === 'selectNext'
    || command.type === 'selectPrev'
    || command.type === 'selectIndex'
  ) {
    const count = Number(ctx.executableCount) || 0;
    return {
      selectionOnly: true,
      selectedIndex: nextListSelection(command, ctx.selectedIndex ?? null, count),
    };
  }

  if (command.type === 'start') {
    const issueId = ctx.selectedIssueId != null && ctx.selectedIssueId !== ''
      ? ctx.selectedIssueId
      : null;
    return handleDispatchCommand(surface, { type: 'start', arg: issueId ?? undefined });
  }

  return handleDispatchCommand(surface, command);
}

/**
 * Presentational shell: four fixed regions. Safe for renderToString tests.
 *
 * @param {{
 *   snap?: object | null,
 *   notice?: string | null,
 *   selectedIndex?: number | null,
 * }} props
 */
export function DispatchShell({
  snap = null,
  notice = null,
  selectedIndex = null,
} = {}) {
  const middleLines = renderMiddlePanel(snap, { selectedIndex }).split('\n');
  const slotLines = renderSlotPanel(snap).split('\n');
  const noticeLine = renderNotice(snap, notice);

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
      noticeLine
        ? createElement(Text, { key: 'notice', color: 'yellow' }, noticeLine)
        : null,
    ),
    createElement(
      Box,
      {
        borderStyle: 'single',
        paddingX: 1,
        width: '100%',
      },
      createElement(Text, { dimColor: true }, renderFooter(snap)),
    ),
  );
}

function executableFromSnap(snap) {
  if (!snap?.board?.issues) return [];
  try {
    return renderDependencyGraph({
      issues: snap.board.issues,
      slotIssueId: snap.slot?.issueId ?? null,
    }).executable;
  } catch {
    return [];
  }
}

function executableCountFromSnap(snap) {
  return executableFromSnap(snap).length;
}

function selectedIssueIdFromSnap(snap, selectedIndex) {
  if (selectedIndex == null) return null;
  const list = executableFromSnap(snap);
  const index = Number(selectedIndex);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  return list[index]?.id ?? null;
}

/**
 * Live fullscreen app: poll surface, redraw shell, keyboard → surface actions.
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
  const [notice, setNotice] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const busyRef = useRef(false);
  const quittingRef = useRef(false);
  const snapRef = useRef(null);
  const selectedRef = useRef(null);

  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);
  useEffect(() => {
    selectedRef.current = selectedIndex;
  }, [selectedIndex]);

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

  useInput((input, key) => {
    if (quittingRef.current) return;
    // Ctrl+C matches q: stop chain then leave fullscreen (do not bare-exit).
    const effectiveInput = key?.ctrl && String(input).toLowerCase() === 'c'
      ? 'q'
      : input;
    const mapped = mapFullscreenKey(effectiveInput, {
      subsequentMode: snapRef.current?.subsequentMode ?? null,
      key,
    });
    if (!mapped) return;

    void (async () => {
      // Serialize with in-flight poll / other keys.
      while (busyRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (quittingRef.current) return;
      busyRef.current = true;
      try {
        const currentSnap = snapRef.current;
        const selectedIndex = selectedRef.current;
        const result = await handleFullscreenKey(surface, effectiveInput, {
          subsequentMode: currentSnap?.subsequentMode ?? null,
          selectedIndex,
          executableCount: executableCountFromSnap(currentSnap),
          selectedIssueId: selectedIssueIdFromSnap(currentSnap, selectedIndex),
          key,
        });

        if (result.selectionOnly) {
          setSelectedIndex(result.selectedIndex ?? null);
          return;
        }

        if (result.message) setNotice(result.message);

        try {
          const next = surface.snapshot();
          setSnap(next);
        } catch {
          // keep last frame
        }

        if (result.quit) {
          quittingRef.current = true;
          exit();
        }
      } finally {
        busyRef.current = false;
      }
    })();
  });

  return createElement(DispatchShell, { snap, notice, selectedIndex });
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

  // Fullscreen start model: never auto-fire on mount. --once does not enter here.
  // Mock surfaces used in pure poll tests may omit setAutoAdvance — skip quietly.
  if (typeof surface.setAutoAdvance === 'function') {
    await surface.setAutoAdvance(false);
  }

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
      // Handled in useInput as quit (stop + exit); avoid bare process leave.
      exitOnCtrlC: false,
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
