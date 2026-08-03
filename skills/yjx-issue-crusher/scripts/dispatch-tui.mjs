/**
 * Scheduler-side dispatch TUI (ticket 13).
 *
 * Thin terminal loop over Dispatch Surface. Worker stays in its own window;
 * this surface never embeds a worker terminal and never dispatches via the graph.
 */

import readline from 'node:readline';

import {
  renderDependencyGraph,
  statusLabelZh,
} from './dependency-graph.mjs';
import {
  runFullscreenDispatch,
  shouldUseFullscreenDispatch,
} from './dispatch-fullscreen.mjs';

export { shouldUseFullscreenDispatch } from './dispatch-fullscreen.mjs';

/**
 * Render one full frame from a surface snapshot (pure; testable).
 * Default language: Chinese (shared understanding).
 * @param {object} snap
 * @returns {string}
 */
export function renderDispatchFrame(snap) {
  const lines = [];
  lines.push('=== Issue Crusher · 调度 ===');
  lines.push(`功能: ${snap.feature}    目录: ${snap.cwd}`);
  lines.push(
    `运行时: ${snap.runtime}    后续 mode: ${snap.subsequentMode}`
    + (snap.subsequentMode === 'review' ? '（审码）' : snap.subsequentMode === 'vibe' ? '（可自动关票）' : ''),
  );
  if (snap.workerMode) {
    lines.push(`当前 Worker mode（已钉死）: ${snap.workerMode}`);
  }
  lines.push(`状态: ${statusLabelZh(snap.status)}${snap.stopped ? ' [已停链]' : ''}`);
  lines.push('');

  if (snap.slot) {
    lines.push('当前槽（正在做）:');
    lines.push(`  票: ${snap.slot.issueId}`);
    lines.push(`  标题: ${snap.slot.title}`);
    lines.push(`  pid: ${snap.slot.pid ?? '-'}    session: ${snap.slot.sessionId ?? '（无）'}`);
    lines.push(`  已关票: ${snap.slot.closed ? '是' : '否'}    mode: ${snap.slot.mode}`);
  } else {
    lines.push('当前槽: （空）');
  }
  lines.push('');

  if (snap.pendingHitl) {
    lines.push('需人工确认后才开票:');
    lines.push(`  票: ${snap.pendingHitl.issueId}  类型: ${snap.pendingHitl.entryClass}`);
    lines.push(`  标题: ${snap.pendingHitl.title}`);
    lines.push(`  runtime: ${snap.pendingHitl.runtime}  mode: ${snap.pendingHitl.mode}`);
    lines.push(`  model: ${snap.pendingHitl.model ?? '运行时默认'}  effort: ${snap.pendingHitl.effort ?? '运行时默认'}`);
    lines.push('');
  }

  const issues = snap.board?.issues ?? [];
  const graph = renderDependencyGraph({
    issues,
    slotIssueId: snap.slot?.issueId ?? null,
  });

  lines.push('依赖图（只读 · 不可图上派票）');
  lines.push('  图例: ★可执行  ▶进行中  ·阻塞/未完成  ✓已完成  ··· 上游──►下游');
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
  lines.push('');

  const actions = snap.actions || {};
  const available = [];
  if (actions.setMode?.available) available.push('[m] review|vibe 切换模式');
  if (actions.forceAdvance?.available) available.push('[f] 强制推进（仅已关票）');
  if (actions.resume?.available) available.push('[r] 恢复会话');
  if (actions.confirmHitl?.available) available.push('[y] 同意开票');
  if (actions.rejectHitl?.available) available.push('[n] 拒绝');
  if (actions.stop?.available) available.push('[s] 停链');
  available.push('[t] 刷新', '[q] 退出');
  lines.push(`操作: ${available.join('  ')}`);

  if (Array.isArray(snap.messages) && snap.messages.length > 0) {
    lines.push('');
    lines.push('消息:');
    for (const message of snap.messages.slice(-5)) {
      lines.push(`  • ${message.text || message.message || message.type}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Parse one command line from the operator.
 * @param {string} raw
 * @returns {{ type: string, arg?: string } | null}
 */
export function parseDispatchCommand(raw) {
  const line = String(raw || '').trim();
  if (!line) return null;
  const lower = line.toLowerCase();

  if (lower === 'q' || lower === 'quit' || lower === 'exit') return { type: 'quit' };
  if (lower === 's' || lower === 'stop') return { type: 'stop' };
  if (lower === 't' || lower === 'tick') return { type: 'tick' };
  if (lower === 'f' || lower === 'force' || lower === 'force-advance') return { type: 'forceAdvance' };
  if (lower === 'r' || lower === 'resume') return { type: 'resume' };
  if (lower === 'y' || lower === 'yes' || lower === 'confirm') return { type: 'confirmHitl' };
  if (lower === 'n' || lower === 'no' || lower === 'reject') return { type: 'rejectHitl' };

  if (lower === 'm' || lower === 'mode') return { type: 'setModeHelp' };
  const modeMatch = lower.match(/^(?:m|mode)\s+(review|vibe)$/);
  if (modeMatch) return { type: 'setMode', arg: modeMatch[1] };

  return { type: 'unknown', arg: line };
}

/**
 * Apply one parsed command against the surface.
 * @returns {Promise<{ quit?: boolean, message?: string }>}
 */
export async function handleDispatchCommand(surface, command) {
  if (!command) return {};
  switch (command.type) {
    case 'quit':
      if (!surface.snapshot().stopped) {
        await surface.stop();
      }
      return { quit: true };
    case 'stop': {
      const result = await surface.stop();
      return { message: result.ok ? '已停链。' : `停链失败: ${result.reason}` };
    }
    case 'tick':
      await surface.tick();
      return {};
    case 'forceAdvance': {
      const result = await surface.forceAdvance();
      if (result.ok) {
        await surface.tick();
        return { message: '已强制推进，继续接力。' };
      }
      return { message: `无法强制推进: ${result.reason}` };
    }
    case 'resume': {
      const result = await surface.resume();
      return {
        message: result.ok
          ? `已恢复会话（pid ${result.pid}）。`
          : `恢复失败: ${result.reason}`,
      };
    }
    case 'confirmHitl': {
      const result = await surface.confirmHitl();
      return {
        message: result.ok
          ? '已同意，正在开 Worker。'
          : `确认失败: ${result.reason}`,
      };
    }
    case 'rejectHitl': {
      const result = await surface.rejectHitl();
      return {
        message: result.ok
          ? '已拒绝；槽位为空。'
          : `拒绝失败: ${result.reason}`,
      };
    }
    case 'setMode': {
      const result = await surface.setMode(command.arg);
      if (!result.ok) return { message: `切换 mode 失败: ${result.reason}` };
      const tip = surface.snapshot().messages
        .filter((m) => m.type === 'mode-consequence')
        .map((m) => m.text)
        .pop();
      return {
        message: tip
          ? `mode → ${result.mode}。${tip}`
          : `mode → ${result.mode}（已写仓；仅影响后续票）。`,
      };
    }
    case 'setModeHelp':
      return { message: '用法: m review  或  m vibe' };
    case 'unknown':
      return { message: `未知命令: ${command.arg}` };
    default:
      return {};
  }
}

/**
 * Stable fingerprint of scheduler-visible state (for auto-poll redraw).
 * @param {object} snap
 */
export function snapshotFingerprint(snap) {
  return JSON.stringify({
    status: snap.status,
    stopped: snap.stopped,
    subsequentMode: snap.subsequentMode,
    slot: snap.slot,
    pendingHitl: snap.pendingHitl,
    messagesLen: snap.messages?.length ?? 0,
    lastMessage: snap.messages?.[snap.messages.length - 1]?.text ?? null,
  });
}

/**
 * Interactive dispatch loop. Worker windows are separate; this is scheduler only.
 *
 * While the chain is not stopped, a background poll calls surface.tick() so that
 * Closed∧exit (or force-advance) can open the next ticket without the operator
 * pressing `t` each time — AFK relay on the auto interval.
 *
 * @param {{
 *   surface: object,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   autoTick?: boolean,
 *   pollIntervalMs?: number,
 *   maxTicks?: number,
 * }} options
 */
export async function runDispatchTui({
  surface,
  input = process.stdin,
  output = process.stdout,
  autoTick = true,
  pollIntervalMs = 2000,
  maxTicks = Infinity,
  once = false,
  fullscreen = undefined,
  alternateScreen = undefined,
} = {}) {
  if (!surface) throw new Error('surface is required');

  const useFullscreen = fullscreen ?? shouldUseFullscreenDispatch({
    input,
    output,
    once,
  });

  // Interactive dual-TTY: Ink fullscreen shell (ticket 01). --once / non-TTY stay printable.
  if (useFullscreen && maxTicks === Infinity) {
    return runFullscreenDispatch({
      surface,
      input,
      output,
      autoTick,
      pollIntervalMs,
      alternateScreen: alternateScreen ?? Boolean(output?.isTTY),
    });
  }

  let ticks = 0;
  if (autoTick) {
    await surface.tick();
    ticks += 1;
  } else if (typeof surface.refresh === 'function') {
    await surface.refresh();
  }

  const write = (text) => {
    output.write(text.endsWith('\n') ? text : `${text}\n`);
  };

  write(renderDispatchFrame(surface.snapshot()));

  // Non-interactive / once mode: no readline when input is not a TTY and maxTicks bound.
  if (maxTicks <= ticks && (!input.isTTY || maxTicks === 1)) {
    return { ticks, stopped: surface.snapshot().stopped };
  }

  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const prompt = () => new Promise((resolve) => {
    rl.question('> ', (answer) => resolve(answer));
  });

  let commandBusy = false;
  let quit = false;
  let lastFingerprint = snapshotFingerprint(surface.snapshot());

  const pollId = setInterval(() => {
    // Fire-and-forget; re-entry guarded. Stopped chains only refresh projection.
    if (quit || commandBusy) return;
    commandBusy = true;
    (async () => {
      try {
        const stopped = surface.snapshot().stopped;
        if (stopped) {
          await surface.refresh();
        } else {
          await surface.tick();
          ticks += 1;
        }
        const snap = surface.snapshot();
        const nextFp = snapshotFingerprint(snap);
        if (nextFp !== lastFingerprint) {
          lastFingerprint = nextFp;
          write(renderDispatchFrame(snap));
          // Re-print prompt hint after background redraw.
          if (input.isTTY) output.write('> ');
        }
      } catch (error) {
        write(`[poll error] ${error.message}`);
      } finally {
        commandBusy = false;
      }
    })();
  }, Math.max(250, pollIntervalMs));

  try {
    while (ticks < maxTicks && !quit) {
      const raw = await prompt();
      // Serialize with background poll.
      while (commandBusy) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      commandBusy = true;
      try {
        const command = parseDispatchCommand(raw);
        const result = await handleDispatchCommand(surface, command);
        if (result.message) write(result.message);
        lastFingerprint = snapshotFingerprint(surface.snapshot());
        write(renderDispatchFrame(surface.snapshot()));
        if (result.quit) {
          quit = true;
          break;
        }
        if (command?.type === 'tick') ticks += 1;
      } finally {
        commandBusy = false;
      }
    }
  } finally {
    clearInterval(pollId);
    rl.close();
  }

  return { ticks, stopped: surface.snapshot().stopped };
}

/**
 * Non-interactive acceptance path: tick until idle/stopped or max steps, print frames.
 * Used for empty-chain / stop smoke without a human at the keyboard.
 */
export async function runDispatchOnce({
  surface,
  output = process.stdout,
  maxSteps = 3,
  stopWhenIdle = true,
} = {}) {
  const frames = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const snap = await surface.tick();
    const frame = renderDispatchFrame(snap);
    frames.push(frame);
    output.write(`${frame}\n`);
    if (snap.stopped) break;
    if (stopWhenIdle && (snap.status === 'idle' || snap.status === 'needs-confirmation')) {
      break;
    }
    // Occupied soft-stuck / awaiting / needs-resume: one frame is enough for smoke.
    if (snap.slot && snap.status !== 'idle') break;
  }
  return { frames, snapshot: surface.snapshot() };
}
