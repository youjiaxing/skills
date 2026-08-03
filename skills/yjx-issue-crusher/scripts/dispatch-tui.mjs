/**
 * Scheduler-side dispatch TUI (ticket 13).
 *
 * Thin terminal loop over Dispatch Surface. Worker stays in its own window;
 * this surface never embeds a worker terminal and never dispatches via the graph.
 */

import readline from 'node:readline';

/**
 * Render one full frame from a surface snapshot (pure; testable).
 * @param {object} snap
 * @returns {string}
 */
export function renderDispatchFrame(snap) {
  const lines = [];
  lines.push('=== Issue Crusher — dispatch (scheduler) ===');
  lines.push(`feature: ${snap.feature}    cwd: ${snap.cwd}`);
  lines.push(`runtime: ${snap.runtime}    mode: ${snap.subsequentMode} (subsequent)`);
  if (snap.workerMode) {
    lines.push(`worker mode (pinned): ${snap.workerMode}`);
  }
  lines.push(`status: ${snap.status}${snap.stopped ? ' [stopped]' : ''}`);
  lines.push('');

  if (snap.slot) {
    lines.push('Slot:');
    lines.push(`  issue: ${snap.slot.issueId}`);
    lines.push(`  title: ${snap.slot.title}`);
    lines.push(`  pid: ${snap.slot.pid ?? '-'}    session: ${snap.slot.sessionId ?? '(none)'}`);
    lines.push(`  closed: ${snap.slot.closed ? 'yes' : 'no'}    mode: ${snap.slot.mode}`);
  } else {
    lines.push('Slot: (empty)');
  }
  lines.push('');

  if (snap.pendingHitl) {
    lines.push('Needs confirmation (HITL):');
    lines.push(`  issue: ${snap.pendingHitl.issueId}  class: ${snap.pendingHitl.entryClass}`);
    lines.push(`  title: ${snap.pendingHitl.title}`);
    lines.push(`  runtime: ${snap.pendingHitl.runtime}  mode: ${snap.pendingHitl.mode}`);
    lines.push(`  model: ${snap.pendingHitl.model ?? 'runtime-default'}  effort: ${snap.pendingHitl.effort ?? 'runtime-default'}`);
    lines.push('');
  }

  lines.push('Board (read-only — no graph dispatch / 不可图上派票):');
  const issues = snap.board?.issues ?? [];
  if (issues.length === 0) {
    lines.push('  (no issues)');
  } else {
    for (const issue of issues) {
      const mark = issue.closed ? '✓' : '·';
      const blockers = issue.blockedBy?.length
        ? ` blockedBy=[${issue.blockedBy.join(', ')}]`
        : '';
      const unlocks = issue.unlocks?.length
        ? ` unlocks=[${issue.unlocks.join(', ')}]`
        : '';
      lines.push(`  ${mark} ${issue.id}  ${issue.status ?? ''}${blockers}${unlocks}`);
    }
  }
  lines.push('');

  const actions = snap.actions || {};
  const available = [];
  if (actions.setMode?.available) available.push('[m]ode review|vibe');
  if (actions.forceAdvance?.available) available.push('[f]orce-advance (Closed only)');
  if (actions.resume?.available) available.push('[r]esume');
  if (actions.confirmHitl?.available) available.push('[y] confirm HITL');
  if (actions.rejectHitl?.available) available.push('[n] reject HITL');
  if (actions.stop?.available) available.push('[s]top chain');
  available.push('[t]ick', '[q]uit');
  lines.push(`Actions: ${available.join('  ')}`);

  if (Array.isArray(snap.messages) && snap.messages.length > 0) {
    lines.push('');
    lines.push('Messages:');
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
      return { message: result.ok ? 'Chain stopped.' : `stop failed: ${result.reason}` };
    }
    case 'tick':
      await surface.tick();
      return {};
    case 'forceAdvance': {
      const result = await surface.forceAdvance();
      if (result.ok) {
        await surface.tick();
        return { message: 'Force-advance accepted; advanced chain.' };
      }
      return { message: `force-advance unavailable: ${result.reason}` };
    }
    case 'resume': {
      const result = await surface.resume();
      return {
        message: result.ok
          ? `Resumed session (pid ${result.pid}).`
          : `resume failed: ${result.reason}`,
      };
    }
    case 'confirmHitl': {
      const result = await surface.confirmHitl();
      return {
        message: result.ok
          ? 'HITL confirmed; worker spawned.'
          : `confirm failed: ${result.reason}`,
      };
    }
    case 'rejectHitl': {
      const result = await surface.rejectHitl();
      return {
        message: result.ok
          ? 'HITL rejected; slot empty.'
          : `reject failed: ${result.reason}`,
      };
    }
    case 'setMode': {
      const result = await surface.setMode(command.arg);
      if (!result.ok) return { message: `mode failed: ${result.reason}` };
      const tip = surface.snapshot().messages
        .filter((m) => m.type === 'mode-consequence')
        .map((m) => m.text)
        .pop();
      return {
        message: tip
          ? `Mode → ${result.mode}. ${tip}`
          : `Mode → ${result.mode} (writes repo; subsequent tickets only).`,
      };
    }
    case 'setModeHelp':
      return { message: 'Usage: m review | m vibe' };
    case 'unknown':
      return { message: `Unknown command: ${command.arg}` };
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
} = {}) {
  if (!surface) throw new Error('surface is required');

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
