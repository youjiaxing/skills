/**
 * Runtime session-end adapters (Grok / Claude) → unified sessionEnded enum.
 *
 * Chain Run only consumes: success | failure | interrupted.
 * Single-turn assistant stop (mid-stream stop_reason without a session terminal
 * envelope) must NEVER map to success.
 *
 * 20260806-1636/03 — pure mappers + stream watcher for AFK observable morph.
 */

/** @typedef {'success'|'failure'|'interrupted'} SessionEndedOutcome */
/**
 * @typedef {{
 *   outcome: SessionEndedOutcome,
 *   detail: {
 *     sessionId?: string|null,
 *     stopReason?: string|null,
 *     failureClass?: string|null,
 *     lastError?: string|null,
 *     message?: string|null,
 *     exitCode?: number|string|null,
 *   },
 * }} SessionEndMapping
 */

/**
 * Worker launch morph:
 * - interactive: foreground intervenable TUI (wayfinder / 人闸 / resume)
 * - observable: piped headless/stream form that can emit session-end events (impl AFK)
 *
 * @typedef {'interactive'|'observable'} WorkerMorph
 */

export const WORKER_MORPH = Object.freeze({
  INTERACTIVE: 'interactive',
  OBSERVABLE: 'observable',
});

/**
 * @param {{
 *   entryClass?: string|null,
 *   autoAdvance?: boolean,
 *   kind?: string|null,
 * }} [input]
 * @returns {WorkerMorph}
 */
export function resolveWorkerMorph({
  entryClass = 'impl',
  autoAdvance = false,
  kind = 'initial',
} = {}) {
  if (kind === 'resume') return WORKER_MORPH.INTERACTIVE;
  if (entryClass !== 'impl') return WORKER_MORPH.INTERACTIVE;
  if (autoAdvance) return WORKER_MORPH.OBSERVABLE;
  return WORKER_MORPH.INTERACTIVE;
}

/**
 * @param {unknown} raw
 * @returns {object|null}
 */
function parseMaybeJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function firstErrorText(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.error === 'string' && event.error.trim()) return event.error.trim();
  if (event.error && typeof event.error === 'object') {
    if (typeof event.error.message === 'string' && event.error.message.trim()) {
      return event.error.message.trim();
    }
  }
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim();
  if (Array.isArray(event.errors)) {
    for (const item of event.errors) {
      if (typeof item === 'string' && item.trim()) return item.trim();
      if (item && typeof item.message === 'string' && item.message.trim()) {
        return item.message.trim();
      }
    }
  }
  return null;
}

/**
 * Map one Grok streaming-json event.
 * Only `type: "end"` is a session terminal. Mid-turn stopReason alone → null.
 *
 * @param {unknown} raw
 * @returns {SessionEndMapping|null}
 */
export function mapGrokStreamEvent(raw) {
  const event = parseMaybeJson(raw);
  if (!event) return null;

  const stop = event.stopReason ?? event.stop_reason ?? null;
  // Single-turn / mid-stream stop without session terminal envelope.
  if (event.type !== 'end') {
    return null;
  }

  const stopText = stop == null ? '' : String(stop);
  /** @type {SessionEndMapping['detail']} */
  const detail = {
    sessionId: event.sessionId ?? event.session_id ?? null,
    stopReason: stopText || null,
    failureClass: null,
    lastError: firstErrorText(event),
    message: null,
    exitCode: null,
  };

  if (/error|fail/i.test(stopText)) {
    return {
      outcome: 'failure',
      detail: {
        ...detail,
        failureClass: stopText || 'error',
        lastError: detail.lastError || stopText || 'session error',
      },
    };
  }
  if (/interrupt|abort|cancel|kill/i.test(stopText)) {
    return {
      outcome: 'interrupted',
      detail: {
        ...detail,
        failureClass: stopText || 'interrupted',
      },
    };
  }
  // Session terminal success (headless process end after agentic turn).
  // end_turn here is the *session* envelope type:end — not a mid-stream stop.
  if (
    stopText === ''
    || stopText === 'end_turn'
    || stopText === 'stop'
    || stopText === 'completed'
  ) {
    return { outcome: 'success', detail };
  }

  return {
    outcome: 'interrupted',
    detail: {
      ...detail,
      failureClass: stopText || 'unknown-stop',
    },
  };
}

/**
 * Map one Claude session/result event.
 * Only `type: "result"` / `type: "error"` are terminals. stop_reason alone → null.
 *
 * @param {unknown} raw
 * @returns {SessionEndMapping|null}
 */
export function mapClaudeSessionEvent(raw) {
  const event = parseMaybeJson(raw);
  if (!event) return null;

  const type = event.type == null ? null : String(event.type);

  // Single-turn / stream blocks without result envelope.
  if (type !== 'result' && type !== 'error') {
    return null;
  }

  if (type === 'error') {
    const errText = firstErrorText(event) || 'claude error';
    return {
      outcome: 'failure',
      detail: {
        sessionId: event.session_id ?? event.sessionId ?? null,
        stopReason: event.stop_reason ?? event.stopReason ?? null,
        failureClass: 'error',
        lastError: errText,
        message: errText,
        exitCode: null,
      },
    };
  }

  // type: result
  const subtype = event.subtype == null ? '' : String(event.subtype);
  const terminal = event.terminal_reason == null ? '' : String(event.terminal_reason);
  const stop = event.stop_reason ?? event.stopReason ?? null;
  const errText = firstErrorText(event);
  /** @type {SessionEndMapping['detail']} */
  const detail = {
    sessionId: event.session_id ?? event.sessionId ?? null,
    stopReason: stop == null ? null : String(stop),
    failureClass: subtype || terminal || null,
    lastError: errText,
    message: errText,
    exitCode: null,
  };

  if (/interrupt|abort|cancel/i.test(terminal) || /interrupt|abort|cancel/i.test(subtype)) {
    return {
      outcome: 'interrupted',
      detail: {
        ...detail,
        failureClass: subtype || terminal || 'interrupted',
      },
    };
  }

  if (
    event.is_error === true
    || /^error/i.test(subtype)
    || /max_turns|error/i.test(terminal)
  ) {
    return {
      outcome: 'failure',
      detail: {
        ...detail,
        failureClass: subtype || terminal || 'error',
        lastError: errText || subtype || terminal || 'session error',
      },
    };
  }

  if (
    subtype === 'success'
    || terminal === 'completed'
    || (event.is_error === false && (stop === 'end_turn' || terminal === 'success'))
  ) {
    return { outcome: 'success', detail };
  }

  // Unknown result shape — honest interrupt, not silent success.
  return {
    outcome: 'interrupted',
    detail: {
      ...detail,
      failureClass: subtype || terminal || 'unknown-result',
    },
  };
}

/**
 * @param {'grok'|'claude'|string} runtime
 * @param {unknown} event
 * @returns {SessionEndMapping|null}
 */
export function mapSessionEndEvent(runtime, event) {
  if (runtime === 'claude') return mapClaudeSessionEvent(event);
  return mapGrokStreamEvent(event);
}

/**
 * Reduce a fake or recorded stream to the last terminal session-end mapping.
 *
 * @param {'grok'|'claude'|string} runtime
 * @param {string|Iterable<unknown>} linesOrText NDJSON text or event list
 * @returns {SessionEndMapping|null}
 */
export function reduceSessionEndFromStream(runtime, linesOrText) {
  /** @type {unknown[]} */
  let items;
  if (typeof linesOrText === 'string') {
    items = linesOrText.split(/\r?\n/u).filter((line) => line.trim() !== '');
  } else if (linesOrText && typeof linesOrText[Symbol.iterator] === 'function') {
    items = [...linesOrText];
  } else {
    return null;
  }

  /** @type {SessionEndMapping|null} */
  let last = null;
  for (const item of items) {
    const mapped = mapSessionEndEvent(runtime, item);
    if (mapped) last = mapped;
  }
  return last;
}

/**
 * Subscribe to a child process stdout and fire onSessionEnded once at close.
 * Uses the last mapped terminal event; if none, reports interrupted with exit code.
 *
 * @param {import('node:events').EventEmitter & {
 *   stdout?: import('node:events').EventEmitter,
 *   stderr?: import('node:events').EventEmitter,
 * }} child
 * @param {{
 *   runtime: string,
 *   onSessionEnded: (outcome: SessionEndedOutcome, detail: object) => void|Promise<void>,
 * }} options
 * @returns {{ dispose: () => void }}
 */
export function attachSessionEndWatcher(child, { runtime, onSessionEnded } = {}) {
  if (!child || typeof onSessionEnded !== 'function') {
    return { dispose() {} };
  }

  let buffer = '';
  /** @type {SessionEndMapping|null} */
  let last = null;
  let finished = false;

  const onData = (chunk) => {
    buffer += String(chunk ?? '');
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      const mapped = mapSessionEndEvent(runtime, line);
      if (mapped) last = mapped;
    }
  };

  const finish = (exitCode) => {
    if (finished) return;
    finished = true;
    // Flush residual buffer (final line without trailing newline).
    if (buffer.trim()) {
      const mapped = mapSessionEndEvent(runtime, buffer);
      if (mapped) last = mapped;
      buffer = '';
    }
    if (last) {
      const detail = {
        ...last.detail,
        exitCode: exitCode ?? last.detail?.exitCode ?? null,
      };
      Promise.resolve(onSessionEnded(last.outcome, detail)).catch(() => {});
      return;
    }
    Promise.resolve(
      onSessionEnded('interrupted', {
        exitCode: exitCode ?? null,
        failureClass: 'process-exit-without-session-end',
        lastError: null,
        message: 'process exited without a session-end event',
        sessionId: null,
        stopReason: null,
      }),
    ).catch(() => {});
  };

  if (child.stdout && typeof child.stdout.on === 'function') {
    child.stdout.on('data', onData);
  }
  if (typeof child.on === 'function') {
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => {
      // Prefer close (stdio drained); exit is a fallback if close never fires.
      if (!finished) finish(code);
    });
  }

  return {
    dispose() {
      finished = true;
      if (child.stdout && typeof child.stdout.off === 'function') {
        child.stdout.off('data', onData);
      }
    },
  };
}
