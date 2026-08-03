/**
 * Repo-level mode config (persistent source of truth for review|vibe).
 *
 * Selection layers (ticket 10 / spec):
 *   startup --mode (process only, default not written) >
 *   repo config >
 *   hard default review
 *
 * Explicitly NOT supported: user-home defaults, feature-level mode.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_MODE = 'review';

/** CLI chain default when neither flag nor repo config sets runtime. */
export const DEFAULT_RUNTIME = 'grok';

export const VIBE_CONSEQUENCE_MESSAGE =
  'Mode is now vibe: subsequent workers may auto-commit and set Closed: true.';

/**
 * Normalize a raw mode string. Unknown/empty → null (caller applies default).
 * @param {unknown} raw
 * @returns {'review'|'vibe'|null}
 */
export function normalizeMode(raw) {
  if (raw === 'vibe') return 'vibe';
  if (raw === 'review') return 'review';
  return null;
}

/**
 * Normalize Worker runtime. Unknown/empty → null.
 * @param {unknown} raw
 * @returns {'grok'|'claude'|null}
 */
export function normalizeRuntime(raw) {
  if (raw === 'grok' || raw === 'claude') return raw;
  return null;
}

/**
 * Resolve subsequent-ticket mode for one Chain Run process.
 *
 * Spec order at spawn:
 * 1. startup --mode if still not superseded by a TUI/scheduler setMode
 * 2. else repo config (TUI setMode writes repo immediately)
 * 3. else hard default review
 *
 * When TUI has chosen, prefer the in-process tuiMode first so a missing
 * write port cannot let a stale repo value hide the human dial (tests and
 * no-config edges). After a successful write, tuiMode and repoMode match.
 *
 * userMode / featureMode / userHome are intentionally ignored.
 */
export function resolveSubsequentMode({
  startupMode = null,
  startupSupersededByTui = false,
  repoMode = null,
  tuiMode = null,
} = {}) {
  if (!startupSupersededByTui) {
    const startup = normalizeMode(startupMode);
    if (startup) return startup;
  }
  // Human dial for this process wins once it has superseded startup.
  const tui = normalizeMode(tuiMode);
  if (startupSupersededByTui && tui) return tui;
  const repo = normalizeMode(repoMode);
  if (repo) return repo;
  return DEFAULT_MODE;
}

/**
 * In-memory ModeConfig for Chain Run tests (no filesystem).
 * @param {{ mode?: 'review'|'vibe'|null }} [options]
 */
export function createMemoryModeConfig({ mode = null } = {}) {
  let current = normalizeMode(mode);
  let writeCount = 0;

  return {
    get writeCount() {
      return writeCount;
    },
    readMode() {
      return current;
    },
    writeMode(next) {
      const normalized = normalizeMode(next);
      if (!normalized) {
        throw new Error(`invalid mode: ${next}`);
      }
      current = normalized;
      writeCount += 1;
      return current;
    },
  };
}

/**
 * File-backed repo config.
 * Default path: <projectRoot>/.issue-crusher/config.json
 * Keys: `mode` (review|vibe), optional `runtime` (grok|claude) for CLI defaults.
 * Startup --mode must not call writeMode.
 *
 * @param {{ projectRoot: string, configPath?: string }} options
 */
export function createFileModeConfig({ projectRoot, configPath } = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(projectRoot, '.issue-crusher', 'config.json');

  function readFile() {
    if (!existsSync(resolvedPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(resolvedPath, 'utf8'));
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  return {
    path: resolvedPath,
    readMode() {
      const data = readFile();
      return normalizeMode(data?.mode);
    },
    /** Optional default Worker runtime for CLI when --runtime omitted. */
    readRuntime() {
      const data = readFile();
      return normalizeRuntime(data?.runtime);
    },
    writeMode(next) {
      const normalized = normalizeMode(next);
      if (!normalized) {
        throw new Error(`invalid mode: ${next}`);
      }
      const existing = readFile() || {};
      const nextData = { ...existing, mode: normalized };
      mkdirSync(path.dirname(resolvedPath), { recursive: true });
      writeFileSync(resolvedPath, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8');
      return normalized;
    },
  };
}
