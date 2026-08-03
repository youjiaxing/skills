/**
 * Shared dispatch command parse + apply (printable TUI and fullscreen Ink).
 * Board/graph stays read-only: no graph-dispatch commands exist here.
 */

/**
 * Parse one command line from the operator (readline / non-fullscreen path).
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
