/**
 * Ink fullscreen dispatch shell (tickets 01–05).
 *
 * Interactive TTY path: alternate-screen layout with regions
 * 顶栏 / 中部 / 当前槽 / 底栏. Keyboard drives the same Dispatch Surface
 * actions as the printable TUI (`m` mode dial, `f` force, `r` resume,
 * `y`/`n` HITL, `s` toggle auto-open-next, `t` tick, `q` quit;
 * `j`/`k`/digits select executable list highlight; **Enter** starts
 * highlighted (or board default). Orchestration contract is unchanged:
 * board is read-only, single slot, dual-condition handoff still owned by
 * Chain Run / surface.tick. No graph dispatch, no embedded Worker terminal.
 *
 * Ticket 05 polish: full-height column layout (middle flexGrow), product
 * copy without debug bracket labels, primary/secondary field hierarchy,
 * long-field truncation, alternate-screen enter/leave cleanup.
 *
 * 20260804-1006 / 02 hard layout: Ink root uses numeric terminal rows
 * (percent height collapses to content), multi-line top bar keeps auto dial
 * discoverable after wrap, footer pins via stretch middle.
 */

import { createElement, useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

import { handleDispatchCommand } from './dispatch-commands.mjs';
import {
  renderDependencyGraph,
  statusLabelZh,
} from './dependency-graph.mjs';
import {
  claudeModelItems,
  defaultEffortItems,
  degradedModelItems,
  resolveModelItems,
} from './model-catalog.mjs';
import {
  applyStartupSelectKey,
  mapStartupSelectKey,
  renderStartupSelectFrame,
} from './startup-select.mjs';

export { defaultEffortItems, resolveModelItems };

/** Alternate-screen enter (hide cursor). Exported for cleanup contract tests. */
export const ALT_ENTER = '\u001b[?1049h\u001b[?25l';
/** Alternate-screen leave (show cursor). Exported for cleanup contract tests. */
export const ALT_LEAVE = '\u001b[?1049l\u001b[?25h';
/** Clear screen + home cursor — used on enter/refresh/leave to drop residual glyphs. */
export const CLEAR_SCREEN = '\u001b[2J\u001b[H';

const GRAPH_LEGEND = '图例: ★可执行  ▶进行中  ·阻塞/未完成  ✓已完成  ··· 上游──►下游';

/** Default max display width for secondary/long slot fields (chars). */
const DEFAULT_FIELD_MAX = 48;
/** Top-bar secondary field budget (feature / long status fragments). */
const TOP_FIELD_MAX = 40;
/**
 * Minimum usable shell height (rows). Below this, fall back so four regions
 * still fit; Ink percent height cannot recover a content-shrunk root.
 */
const SHELL_HEIGHT_FLOOR = 12;

/**
 * Resolve terminal row budget for the shell root as a **numeric** Yoga height.
 * Ink only sets root width from stdout; `height: '100%'` of an auto parent
 * collapses to content and leaves dead black below the footer.
 *
 * @param {number | null | undefined} rows
 * @returns {number}
 */
export function resolveShellHeight(rows) {
  const n = Number(rows);
  if (!Number.isFinite(n) || n < 8) return SHELL_HEIGHT_FLOOR;
  return Math.floor(n);
}

/**
 * Write alternate-screen enter + clear (drops prior frame / residual bare text).
 * @param {{ write?: (s: string) => void } | null | undefined} output
 * @returns {boolean} true if enter sequence was written
 */
export function enterAlternateScreen(output) {
  if (!output || typeof output.write !== 'function') return false;
  output.write(ALT_ENTER + CLEAR_SCREEN);
  return true;
}

/**
 * Clear then leave alternate-screen (exit cleanup contract).
 * @param {{ write?: (s: string) => void } | null | undefined} output
 * @returns {boolean} true if leave sequence was written
 */
export function leaveAlternateScreen(output) {
  if (!output || typeof output.write !== 'function') return false;
  output.write(CLEAR_SCREEN + ALT_LEAVE);
  return true;
}

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

/**
 * Drop already-buffered stdin so a prior fullscreen select Enter/confirm
 * cannot become an unintended start key on dispatch mount. The stream is
 * resumed before returning because the next Ink mount must own a live TTY.
 * Safe no-op when stream is null or not readable.
 *
 * @param {NodeJS.ReadableStream | null | undefined} input
 * @returns {number} approximate drained unit count (bytes/chars/chunks)
 */
export function drainPendingInput(input) {
  if (!input || typeof input.read !== 'function') return 0;

  if (typeof input.isPaused === 'function' && !input.isPaused()) {
    if (typeof input.pause === 'function') input.pause();
  }

  let drained = 0;
  try {
    // Node Readable: read() in paused mode empties the internal buffer.
    // Limit iterations so a pathological stream cannot spin forever.
    for (let i = 0; i < 10_000; i += 1) {
      const chunk = input.read();
      if (chunk == null) break;
      if (typeof chunk === 'string') drained += chunk.length;
      else if (Buffer.isBuffer(chunk)) drained += chunk.length;
      else drained += 1;
    }
  } catch {
    // Best-effort only — never block fullscreen mount on drain failure.
  } finally {
    // Restore the readable state before handing stdin to Ink. This must also
    // undo a paused state left by the previous Ink mount during a menu handoff;
    // otherwise the next fullscreen select/dispatch receives no keypresses.
    if (typeof input.resume === 'function') input.resume();
  }
  return drained;
}

/**
 * Operator-facing status line for the top bar.
 * Edge states must stay distinguishable without reading SKILL.md:
 * - awaiting-worker-exit → wait for natural Worker exit (never auto-kill)
 * - awaiting-worker-exit + auto off → may use f after Closed
 * - awaiting-session-end → Closed/exited but no sessionEnded success; no auto next
 * - handoff-countdown → seconds left; press c to cancel auto next
 * - needs-resume + r available → press r (history, not next ticket)
 * - needs-resume + no session id → explicit dead-end, no silent empty window
 *
 * @param {object | null | undefined} snap
 * @returns {string}
 */
function statusLine(snap) {
  if (!snap) return '状态: （启动中）';
  const status = snap.status;
  const label = status ? statusLabelZh(status) : '—';
  // Avoid "已停链 [已停链]" when status is already the stopped label.
  const stoppedMark = snap.stopped && status !== 'stopped' ? ' [已停链]' : '';

  let hint = '';
  if (status === 'awaiting-worker-exit') {
    hint = snap.autoAdvance === false
      ? '（等进程自退；可按 f 强制推进）'
      : '（等进程自退，不强制杀）';
  } else if (status === 'awaiting-session-end') {
    hint = '（缺会话结束信号；可按 f 或 Enter）';
  } else if (status === 'handoff-countdown') {
    const remMs = Number(snap.handoffCountdownRemainingMs);
    const sec = Number.isFinite(remMs)
      ? Math.max(0, Math.ceil(remMs / 1000))
      : null;
    hint = sec != null
      ? `（${sec}s 后开下一张；按 c 取消）`
      : '（倒计时后开下一张；按 c 取消）';
  } else if (status === 'needs-resume') {
    // Prefer action projection (same gate as footer [r]); fall back to slot id.
    const resume = snap.actions?.resume;
    if (resume?.reason === 'no-session-id') {
      hint = '（无 session id）';
    } else if (resume?.available === true) {
      hint = '（按 r）';
    } else if (resume?.available === false) {
      // Unavailable for a reason other than no-id: do not advertise r.
      hint = resume.reason ? `（${resume.reason}）` : '';
    } else if (snap.slot?.sessionId) {
      hint = '（按 r）';
    } else {
      hint = '（无 session id）';
    }
  }

  return `状态: ${label}${hint}${stoppedMark}`;
}

function modeHint(mode) {
  if (mode === 'review') return '（审码）';
  if (mode === 'vibe') return '（可自动关票）';
  return '';
}

/**
 * Truncate a display field for TUI layout safety.
 * Keeps head content and appends an ellipsis when over budget.
 * Pure — independent of terminal size; callers pass max chars.
 *
 * @param {string | null | undefined} value
 * @param {number} [max]
 * @returns {string}
 */
export function truncateDisplayField(value, max = DEFAULT_FIELD_MAX) {
  const text = String(value ?? '');
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_FIELD_MAX;
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  if (limit <= 1) return '…';
  return `${chars.slice(0, limit - 1).join('')}…`;
}

/**
 * Structural layout contract for the fullscreen shell (CI-assertable).
 * Middle is the stretch main region; other bands stay content-sized.
 * No animation — static four-region column only.
 *
 * When `rows` is provided, root height is a numeric terminal line budget so
 * Yoga can flex-grow the middle and pin the footer. Without `rows`, height
 * stays declarative `'100%'` for callers that only need region names.
 *
 * @param {{ rows?: number | null }} [opts]
 * @returns {{
 *   regions: string[],
 *   root: { height: string | number, width: string, flexDirection: string },
 *   top: { flexGrow: number },
 *   middle: { flexGrow: number, stretch: boolean },
 *   slot: { flexGrow: number },
 *   footer: { flexGrow: number },
 *   animation: boolean,
 * }}
 */
export function describeShellLayout({ rows } = {}) {
  return {
    regions: ['top', 'middle', 'slot', 'footer'],
    root: {
      height: rows != null ? resolveShellHeight(rows) : '100%',
      width: '100%',
      flexDirection: 'column',
    },
    top: { flexGrow: 0 },
    middle: { flexGrow: 1, stretch: true },
    slot: { flexGrow: 0 },
    footer: { flexGrow: 0 },
    animation: false,
  };
}

/**
 * Display label for subsequent model/effort (null/empty → 运行时默认).
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function subsequentFlagLabel(value) {
  if (value == null || String(value).trim() === '') return '运行时默认';
  return String(value);
}

/**
 * Top bar: feature / runtime / subsequent mode / model / effort /
 * auto-open-next / chain status.
 * Pure — safe for unit tests without a terminal.
 * Product copy only (no `[顶栏]` debug prefix).
 *
 * Two lines so model/effort, 「自动开下一张」and chain status stay discoverable
 * after wrap on narrow terminals.
 *
 * @param {object | null | undefined} snap
 * @returns {string}
 */
export function renderTopBar(snap) {
  if (!snap) {
    return 'Issue Crusher · 调度（启动中…）';
  }
  const mode = snap.subsequentMode ?? '—';
  // Default true when field omitted (older fakes / once path projection).
  const autoLabel = snap.autoAdvance === false ? '关' : '开';
  const feature = truncateDisplayField(snap.feature ?? '—', TOP_FIELD_MAX);
  const modelLabel = subsequentFlagLabel(snap.subsequentModel);
  const effortLabel = subsequentFlagLabel(snap.subsequentEffort);
  const primary = [
    'Issue Crusher · 调度',
    `功能: ${feature}`,
    `runtime: ${snap.runtime ?? '—'}`,
    `后续 mode: ${mode}${modeHint(mode)}`,
  ].join('  ·  ');
  // Critical operator dials on their own line — short enough for narrow TTYs.
  // subsequent model/effort stay here so operators can trust the o-flow source.
  const critical = [
    `后续 model: ${modelLabel}`,
    `后续 effort: ${effortLabel}`,
    `自动开下一张: ${autoLabel}`,
    statusLine(snap),
  ].join('  ·  ');
  return `${primary}\n${critical}`;
}

/**
 * Middle panel: Chinese dependency graph legend + graph + 「现在可执行」.
 * Board remains read-only display; no graph dispatch.
 * Optional selectedIndex highlights an executable list row (keyboard ↑↓/j/k/digits).
 * Selected vs current-slot use distinct marks.
 *
 * @param {object | null | undefined} snap
 * @param {{ selectedIndex?: number | null }} [opts]
 * @returns {string}
 */
export function renderMiddlePanel(snap, { selectedIndex = null } = {}) {
  const lines = ['依赖图（只读 · 不可图上派票）', `  ${GRAPH_LEGEND}`];

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
 * Primary fields on the first line; session is a secondary indented line.
 * Long title/session values are truncated so the band does not collapse layout.
 *
 * @param {object | null | undefined} snap
 * @param {{ maxFieldWidth?: number }} [opts]
 * @returns {string}
 */
export function renderSlotPanel(snap, { maxFieldWidth = DEFAULT_FIELD_MAX } = {}) {
  const lines = [];
  const max = maxFieldWidth;

  if (!snap || !snap.slot) {
    lines.push('当前槽 （空）');
  } else {
    const slot = snap.slot;
    // Long issue ids / titles must not blow the primary slot row (pid/closed stay visible).
    const issueId = truncateDisplayField(slot.issueId ?? '—', max);
    const title = slot.title
      ? `标题: ${truncateDisplayField(slot.title, max)}`
      : null;
    lines.push(
      [
        '当前槽',
        `票: ${issueId}`,
        title,
        `pid: ${slot.pid ?? '-'}`,
        `mode: ${slot.mode ?? '—'}`,
        `已关票: ${slot.closed ? '是' : '否'}`,
      ].filter(Boolean).join('  '),
    );
    if (slot.sessionId) {
      lines.push(`  session: ${truncateDisplayField(slot.sessionId, max)}`);
    }
  }

  if (snap?.pendingHitl) {
    const hitl = snap.pendingHitl;
    lines.push('需人工确认后才开票:');
    lines.push(
      `  票: ${hitl.issueId ?? '—'}  类型: ${hitl.entryClass ?? '—'}`,
    );
    if (hitl.title) {
      lines.push(`  标题: ${truncateDisplayField(hitl.title, max)}`);
    }
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
 * Product key help only (no `[底栏]` debug prefix). Dimmed in the shell.
 *
 * @param {object | null | undefined} snap
 * @returns {string}
 */
export function renderFooter(snap) {
  const actions = snap?.actions || {};
  const keys = [];
  if (actions.setMode?.available !== false) keys.push('[m] mode 拨杆');
  // o opens model→effort transactional menu (subsequent only; no live hot-switch).
  if (actions.setModelEffort?.available !== false) keys.push('[o] model/effort');
  if (actions.forceAdvance?.available) keys.push('[f] 强制推进');
  if (actions.cancelHandoffCountdown?.available) keys.push('[c] 取消倒计时');
  if (actions.resume?.available) keys.push('[r] 恢复历史');
  if (actions.confirmHitl?.available) keys.push('[y] 同意');
  if (actions.rejectHitl?.available) keys.push('[n] 拒绝');
  // s is the auto-open-next dial (not chain stop). Show current state plainly.
  const autoLabel = snap?.autoAdvance === false ? '关' : '开';
  keys.push(`[s] 自动开下一张(${autoLabel})`);
  // Navigation moves highlight only; Enter starts. Arrows ≡ j/k.
  keys.push('[t] 刷新', '[↑↓/j/k|数字] 导航', '[Enter] 开始', '[q] 退出');
  return keys.join('  ');
}

/**
 * Sync model list fallback for the fullscreen `o` flow.
 * Prefer async {@link resolveModelItems} (injectable Grok discovery) at open time.
 * - claude: static alias hints + 运行时默认
 * - grok (sync, no discovery): 运行时默认 only — real list comes from discovery
 *
 * @param {string | null | undefined} runtime
 * @returns {Array<{ value: string | null, label: string }>}
 */
export function defaultModelItems(runtime = 'grok') {
  const rt = String(runtime || 'grok').toLowerCase();
  if (rt === 'claude') return claudeModelItems();
  return degradedModelItems();
}

/**
 * Open a pure model→effort transactional menu state (no surface write until both confirm).
 *
 * @param {{
 *   runtime?: string | null,
 *   modelItems?: Array<{ value: string | null, label?: string }>,
 *   effortItems?: Array<{ value: string | null, label?: string }>,
 * }} [options]
 */
export function openModelEffortMenu({
  runtime = 'grok',
  modelItems = null,
  effortItems = null,
} = {}) {
  const models = Array.isArray(modelItems) && modelItems.length > 0
    ? modelItems
    : defaultModelItems(runtime);
  const efforts = Array.isArray(effortItems) && effortItems.length > 0
    ? effortItems
    : defaultEffortItems();
  return {
    open: true,
    stage: 'model',
    selectedIndex: 0,
    pendingModel: undefined,
    modelItems: models,
    effortItems: efforts,
    done: false,
    cancelled: false,
    submitted: null,
  };
}

/**
 * Pure key transition for the model→effort transaction.
 * Reuses startup-select key contract (j/k/arrows/digits + Enter / q|Esc).
 * Cancel at either stage abandons the whole transaction (no half-write).
 *
 * @param {ReturnType<typeof openModelEffortMenu>} state
 * @param {string | null | undefined} input
 * @param {{ escape?: boolean, return?: boolean, upArrow?: boolean, downArrow?: boolean } | null} [key]
 */
export function applyModelEffortMenuKey(state, input, key = null) {
  if (!state || !state.open || state.done) return state;

  const command = key?.ctrl && String(input).toLowerCase() === 'c'
    ? { type: 'cancel' }
    : mapStartupSelectKey(input, key);
  if (!command) return state;

  const items = state.stage === 'model' ? state.modelItems : state.effortItems;
  const next = applyStartupSelectKey(
    {
      selectedIndex: state.selectedIndex,
      done: false,
      cancelled: false,
      value: null,
    },
    command,
    items,
  );

  if (next.cancelled) {
    return {
      ...state,
      open: false,
      done: true,
      cancelled: true,
      submitted: null,
      selectedIndex: next.selectedIndex,
    };
  }

  if (next.done) {
    if (state.stage === 'model') {
      return {
        ...state,
        stage: 'effort',
        selectedIndex: 0,
        pendingModel: next.value,
      };
    }
    return {
      ...state,
      open: false,
      done: true,
      cancelled: false,
      selectedIndex: next.selectedIndex,
      submitted: {
        model: state.pendingModel === undefined ? null : state.pendingModel,
        effort: next.value,
      },
    };
  }

  return { ...state, selectedIndex: next.selectedIndex };
}

/**
 * Text frame for the in-shell model/effort overlay (no second alt-screen).
 *
 * @param {ReturnType<typeof openModelEffortMenu> | null | undefined} state
 * @returns {string}
 */
export function renderModelEffortMenuFrame(state) {
  if (!state || !state.open) return '';
  const items = state.stage === 'model' ? state.modelItems : state.effortItems;
  const title = state.stage === 'model'
    ? '选择 subsequent model（确认后选 effort；整次 o 事务）'
    : '选择 subsequent effort（确认后提交；q/Esc 取消整次事务）';
  // Reuse startup list chrome so j/k/digits/Enter/q match operator muscle memory.
  return renderStartupSelectFrame({
    title,
    items,
    selectedIndex: state.selectedIndex,
  }).replace('[启动选单]', '[model/effort]');
}

/**
 * One-line operator notice (last action tip or surface message).
 * Short feedback only — no heavy animation.
 *
 * @param {object | null | undefined} snap
 * @param {string | null | undefined} notice
 * @returns {string}
 */
export function renderNotice(snap, notice = null) {
  if (notice) return String(notice);
  const last = Array.isArray(snap?.messages) && snap.messages.length > 0
    ? snap.messages[snap.messages.length - 1]
    : null;
  if (last) {
    const text = last.text || last.message || last.type;
    if (text) return String(text);
  }
  return '';
}

/**
 * Map one fullscreen keypress to a dispatch command or list-selection intent.
 * Mode dial: bare `m` toggles subsequent review ↔ vibe (no readline args).
 * Enter / return → start (highlighted id resolved by handleFullscreenKey).
 * Arrow ↓ ≡ j (selectNext); arrow ↑ ≡ k (selectPrev) — highlight only.
 *
 * @param {string | null | undefined} input
 * @param {{
 *   subsequentMode?: string | null,
 *   key?: { return?: boolean, upArrow?: boolean, downArrow?: boolean } | null,
 * }} [ctx]
 * @returns {{ type: string, arg?: string | number } | null}
 */
export function mapFullscreenKey(input, { subsequentMode = null, key = null } = {}) {
  // Enter starts a ticket (highlight or board default). Ink often sends
  // empty input + key.return; raw terminals may send \r / \n.
  if (key?.return || input === '\r' || input === '\n') {
    return { type: 'start' };
  }
  // Ink arrow keys: empty input + key.upArrow / key.downArrow.
  // Same direction as j/k: ↓/j → next, ↑/k → prev.
  if (key?.downArrow) return { type: 'selectNext' };
  if (key?.upArrow) return { type: 'selectPrev' };
  if (input == null || input === '') return null;
  // Ignore multi-char pastes / control sequences.
  if (String(input).length !== 1) return null;
  const lower = String(input).toLowerCase();

  if (lower === 'q') return { type: 'quit' };
  // Fullscreen s toggles auto-open-next (printable TUI still uses s/stop for stop).
  if (lower === 's') return { type: 'toggleAutoAdvance' };
  if (lower === 't') return { type: 'tick' };
  if (lower === 'f') return { type: 'forceAdvance' };
  if (lower === 'c') return { type: 'cancelHandoffCountdown' };
  if (lower === 'r') return { type: 'resume' };
  if (lower === 'y') return { type: 'confirmHitl' };
  if (lower === 'n') return { type: 'rejectHitl' };
  if (lower === 'm') {
    const next = subsequentMode === 'vibe' ? 'review' : 'vibe';
    return { type: 'setMode', arg: next };
  }
  // o opens model→effort transactional menu (not mode; m stays mode-only).
  if (lower === 'o') return { type: 'openModelEffort' };
  if (lower === 'j') return { type: 'selectNext' };
  if (lower === 'k') return { type: 'selectPrev' };
  if (/^[1-9]$/.test(lower)) return { type: 'selectIndex', arg: Number(lower) - 1 };
  return null;
}

/**
 * Pure list-selection update for executable rows. Highlight only — never spawns.
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
 *   key?: { return?: boolean, upArrow?: boolean, downArrow?: boolean } | null,
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

  // openModelEffort is shell-owned (in-app overlay); pure handle only signals intent.
  if (command.type === 'openModelEffort') {
    return { openModelEffort: true };
  }

  return handleDispatchCommand(surface, command);
}

/**
 * Presentational shell: four fixed regions filling terminal height.
 * Middle flexGrow=1 eats remaining vertical space. Safe for renderToString.
 * Hierarchy: top/status primary; middle content; footer dim; session secondary
 * (already dimmed in pure text via indent); selection bold; current-slot green.
 *
 * Pass `terminalRows` (stdout.rows) so root height is numeric — required for
 * middle stretch + footer pin. Without it, height stays `'100%'` (content-sized
 * under renderToString / callers that only assert copy).
 *
 * @param {{
 *   snap?: object | null,
 *   notice?: string | null,
 *   selectedIndex?: number | null,
 *   terminalRows?: number | null,
 * }} props
 */
export function DispatchShell({
  snap = null,
  notice = null,
  selectedIndex = null,
  terminalRows = null,
  modelEffortMenu = null,
} = {}) {
  const layout = describeShellLayout(
    terminalRows != null ? { rows: terminalRows } : {},
  );
  const middleLines = renderMiddlePanel(snap, { selectedIndex }).split('\n');
  const slotLines = renderSlotPanel(snap).split('\n');
  const noticeLine = renderNotice(snap, notice);
  const topLines = renderTopBar(snap).split('\n');
  const footer = renderFooter(snap);

  // In-app overlay reuses the same alt-screen session (no nested DECSET on Windows).
  if (modelEffortMenu?.open) {
    const menuLines = renderModelEffortMenuFrame(modelEffortMenu).split('\n');
    return createElement(
      Box,
      {
        flexDirection: layout.root.flexDirection,
        width: layout.root.width,
        height: layout.root.height,
      },
      createElement(
        Box,
        {
          flexGrow: layout.top.flexGrow,
          borderStyle: 'single',
          paddingX: 1,
          flexDirection: 'column',
          width: '100%',
        },
        ...topLines.map((line, index) => createElement(
          Text,
          { key: `t${index}`, bold: true },
          line || ' ',
        )),
      ),
      createElement(
        Box,
        {
          flexGrow: layout.middle.flexGrow,
          borderStyle: 'single',
          paddingX: 1,
          flexDirection: 'column',
          width: '100%',
        },
        ...menuLines.map((line, index) => createElement(
          Text,
          {
            key: `me${index}`,
            bold: index === 0 || /◀选中/.test(line),
            dimColor: index === menuLines.length - 1,
          },
          line || ' ',
        )),
      ),
      createElement(
        Box,
        {
          flexGrow: layout.footer.flexGrow,
          borderStyle: 'single',
          paddingX: 1,
          width: '100%',
        },
        createElement(
          Text,
          { dimColor: true },
          'model→effort 事务：两级都确认才写 subsequent/仓；q/Esc 取消整次',
        ),
      ),
    );
  }

  return createElement(
    Box,
    {
      flexDirection: layout.root.flexDirection,
      width: layout.root.width,
      height: layout.root.height,
    },
    createElement(
      Box,
      {
        flexGrow: layout.top.flexGrow,
        borderStyle: 'single',
        paddingX: 1,
        flexDirection: 'column',
        width: '100%',
      },
      // Primary band: multi-line product title + auto/status (bold).
      ...topLines.map((line, index) => createElement(
        Text,
        { key: `t${index}`, bold: true },
        line || ' ',
      )),
    ),
    createElement(
      Box,
      {
        flexGrow: layout.middle.flexGrow,
        borderStyle: 'single',
        paddingX: 1,
        flexDirection: 'column',
        width: '100%',
      },
      ...middleLines.map((line, index) => {
        const isSelected = /◀选中/.test(line);
        const isCurrentSlot = /◀当前槽/.test(line) && !isSelected;
        const isBoth = /◀当前槽/.test(line) && isSelected;
        // Selected row: bold + cyan; current-slot-only: green; both: cyan bold.
        if (isSelected || isBoth) {
          return createElement(Text, { key: `m${index}`, bold: true, color: 'cyan' }, line || ' ');
        }
        if (isCurrentSlot) {
          return createElement(Text, { key: `m${index}`, color: 'green' }, line || ' ');
        }
        // Legend / secondary graph chrome stays dim.
        if (index === 1 || line.startsWith('  图例')) {
          return createElement(Text, { key: `m${index}`, dimColor: true }, line || ' ');
        }
        return createElement(Text, { key: `m${index}` }, line || ' ');
      }),
    ),
    createElement(
      Box,
      {
        flexGrow: layout.slot.flexGrow,
        borderStyle: 'single',
        paddingX: 1,
        flexDirection: 'column',
        width: '100%',
      },
      ...slotLines.map((line, index) => {
        // Secondary: session line is indented + dim.
        if (/^\s+session:/.test(line)) {
          return createElement(Text, { key: `s${index}`, dimColor: true }, line || ' ');
        }
        return createElement(Text, { key: `s${index}` }, line || ' ');
      }),
      noticeLine
        ? createElement(Text, { key: 'notice', color: 'yellow' }, noticeLine)
        : null,
    ),
    createElement(
      Box,
      {
        flexGrow: layout.footer.flexGrow,
        borderStyle: 'single',
        paddingX: 1,
        width: '100%',
      },
      // Weak band: key help.
      createElement(Text, { dimColor: true }, footer),
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
 * `terminalRows` comes from the mount stdout (numeric Yoga height). Optional
 * `output` stream is watched for `resize` so the shell re-pins after window
 * changes without holding Ink's useStdout (keeps test PassThrough exits clean).
 *
 * @param {{
 *   surface: object,
 *   autoTick?: boolean,
 *   pollIntervalMs?: number,
 *   ticksRef?: { current: number },
 *   terminalRows?: number | null,
 *   output?: { rows?: number, on?: Function, off?: Function, removeListener?: Function } | null,
 *   discoverModels?: (() => Promise<string[] | Iterable<string>>) | null,
 *   resolveModelItemsFn?: typeof resolveModelItems,
 * }} props
 */
function DispatchFullscreenApp({
  surface,
  autoTick = true,
  pollIntervalMs = 2000,
  ticksRef = null,
  terminalRows = null,
  discoverModels = null,
  resolveModelItemsFn = resolveModelItems,
} = {}) {
  const { exit } = useApp();
  const [snap, setSnap] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(null);
  // In-app model→effort overlay (same alt-screen; no nested DECSET).
  const [modelEffortMenu, setModelEffortMenu] = useState(null);
  // Numeric height from mount stdout.rows (resolved once). Resize re-pin is
  // optional polish; keep mount path free of stream listeners so PassThrough
  // tests can exit cleanly on q.
  const resolvedRows = resolveShellHeight(terminalRows);
  const busyRef = useRef(false);
  const quittingRef = useRef(false);
  const snapRef = useRef(null);
  const selectedRef = useRef(null);
  const menuRef = useRef(null);

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
      // Freeze poll while the o-menu owns the keyboard (avoid mid-menu redraw races).
      if (cancelled || busyRef.current || quittingRef.current || menuRef.current?.open) return;
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

    // model→effort overlay owns keys until cancel/submit (no second Ink mount).
    if (menuRef.current?.open) {
      void (async () => {
        while (busyRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (quittingRef.current) return;
        // A queued key can outlive a cancel/submit from an earlier key. Read
        // the ref only after waiting and ignore that stale key if the overlay
        // has already closed; never dereference a null menu.
        const currentMenu = menuRef.current;
        if (!currentMenu?.open) return;
        busyRef.current = true;
        try {
          const nextMenu = applyModelEffortMenuKey(currentMenu, input, key);
          if (!nextMenu.done) {
            menuRef.current = nextMenu;
            setModelEffortMenu(nextMenu);
            return;
          }
          menuRef.current = null;
          setModelEffortMenu(null);
          if (nextMenu.cancelled || !nextMenu.submitted) {
            setNotice('已取消 model/effort（未改 subsequent/仓）');
            return;
          }
          if (typeof surface.setModelEffort !== 'function') {
            setNotice('当前表面不支持 setModelEffort');
            return;
          }
          const result = await surface.setModelEffort(nextMenu.submitted);
          if (!result?.ok) {
            setNotice(`无法设置 model/effort: ${result?.reason ?? 'unknown'}`);
            return;
          }
          const modelLabel = subsequentFlagLabel(nextMenu.submitted.model);
          const effortLabel = subsequentFlagLabel(nextMenu.submitted.effort);
          setNotice(`subsequent model/effort → ${modelLabel} / ${effortLabel}（已写仓；仅影响后续票）`);
          try {
            setSnap(surface.snapshot());
          } catch {
            // keep last frame
          }
        } finally {
          busyRef.current = false;
        }
      })();
      return;
    }

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

        if (result.openModelEffort) {
          // Gate on surface action availability when projection is ready.
          if (currentSnap?.actions?.setModelEffort?.available === false) {
            setNotice('当前不可设置 model/effort（已停链）');
            return;
          }
          const runtime = currentSnap?.runtime ?? 'grok';
          // Best-effort discovery (injectable); fail/timeout → 运行时默认 only.
          let modelItems;
          try {
            modelItems = await resolveModelItemsFn({
              runtime,
              discoverModels,
            });
          } catch {
            modelItems = defaultModelItems(runtime);
          }
          const nextMenu = openModelEffortMenu({
            runtime,
            modelItems,
            effortItems: defaultEffortItems(),
          });
          // Publish the ref synchronously with React state so a fast next
          // key sees the newly opened menu rather than a stale prior one.
          menuRef.current = nextMenu;
          setModelEffortMenu(nextMenu);
          setNotice(null);
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

  return createElement(DispatchShell, {
    snap,
    notice,
    selectedIndex,
    terminalRows: resolvedRows,
    modelEffortMenu,
  });
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
 *   discoverModels?: (() => Promise<string[] | Iterable<string>>) | null,
 *   resolveModelItemsFn?: typeof resolveModelItems,
 * }} options
 */
export async function runFullscreenDispatch({
  surface,
  input = process.stdin,
  output = process.stdout,
  autoTick = true,
  pollIntervalMs = 2000,
  alternateScreen = Boolean(output?.isTTY),
  discoverModels = null,
  resolveModelItemsFn = resolveModelItems,
} = {}) {
  if (!surface) throw new Error('surface is required');

  // Fullscreen: restore repo auto preference with handoff-only (never idle cold-fire).
  // --once does not enter here. Mock surfaces may omit the port — skip quietly.
  if (typeof surface.applyFullscreenAutoPreference === 'function') {
    await surface.applyFullscreenAutoPreference();
  } else if (typeof surface.setAutoAdvance === 'function') {
    await surface.setAutoAdvance(false);
  }

  // Startup select (feature/runtime) confirms with Enter on the same stdin.
  // Any leftover \r/\n would otherwise hit useInput as start → false occupy.
  drainPendingInput(input);

  const ticksRef = { current: 0 };
  let enteredAlt = false;

  if (alternateScreen) {
    enteredAlt = enterAlternateScreen(output);
  }

  const instance = render(
    createElement(DispatchFullscreenApp, {
      surface,
      discoverModels,
      resolveModelItemsFn,
      autoTick,
      pollIntervalMs,
      ticksRef,
      // Numeric rows so middle flexGrow actually eats leftover terminal height.
      terminalRows: resolveShellHeight(output?.rows),
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
    // Clear residual framed/bare glyphs, then leave alt-screen buffer.
    if (enteredAlt) {
      leaveAlternateScreen(output);
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
