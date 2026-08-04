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
 * Normalize an optional model/effort value: trim; empty/blank → null
 * (omit the CLI flag and let the runtime product default apply).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeOptionalFlag(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  return trimmed === '' ? null : trimmed;
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
 * @param {{ mode?: 'review'|'vibe'|null, workers?: Record<string, {model?: string|null, effort?: string|null}> }} [options]
 */
export function createMemoryModeConfig({ mode = null, workers = {} } = {}) {
  let current = normalizeMode(mode);
  let writeCount = 0;
  /** @type {Record<string, {model: string|null, effort: string|null}>} */
  const buckets = {};
  for (const [rt, bucket] of Object.entries(workers || {})) {
    const normalizedRt = normalizeRuntime(rt);
    if (normalizedRt && bucket && typeof bucket === 'object') {
      buckets[normalizedRt] = {
        model: normalizeOptionalFlag(bucket.model),
        effort: normalizeOptionalFlag(bucket.effort),
      };
    }
  }

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
    /**
     * Read the workers.<runtime> model/effort bucket.
     * Missing/empty values read as null (omit flag; runtime product default).
     * @param {unknown} runtime
     * @returns {{ model: string|null, effort: string|null }}
     */
    readModelEffort(runtime) {
      const rt = normalizeRuntime(runtime);
      if (!rt) throw new Error(`invalid runtime: ${runtime}`);
      const bucket = buckets[rt] || { model: null, effort: null };
      return { model: bucket.model ?? null, effort: bucket.effort ?? null };
    },
    /**
     * Write the workers.<runtime> model/effort bucket.
     * Empty/blank values normalize to null (= omit flag on the read side).
     * @param {unknown} runtime
     * @param {{ model?: unknown, effort?: unknown }} next
     * @returns {{ model: string|null, effort: string|null }}
     */
    writeModelEffort(runtime, { model = null, effort = null } = {}) {
      const rt = normalizeRuntime(runtime);
      if (!rt) throw new Error(`invalid runtime: ${runtime}`);
      const normalized = {
        model: normalizeOptionalFlag(model),
        effort: normalizeOptionalFlag(effort),
      };
      buckets[rt] = normalized;
      writeCount += 1;
      return { ...normalized };
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
    /**
     * Read the workers.<runtime> model/effort bucket for this repo config.
     * Missing bucket or empty values → null (omit flag; runtime product default).
     * @param {unknown} runtime
     * @returns {{ model: string|null, effort: string|null }}
     */
    readModelEffort(runtime) {
      const rt = normalizeRuntime(runtime);
      if (!rt) throw new Error(`invalid runtime: ${runtime}`);
      const data = readFile();
      const bucket = data?.workers?.[rt];
      if (!bucket || typeof bucket !== 'object') {
        return { model: null, effort: null };
      }
      return {
        model: normalizeOptionalFlag(bucket.model),
        effort: normalizeOptionalFlag(bucket.effort),
      };
    },
    /**
     * Write the workers.<runtime> model/effort bucket, keeping `mode`,
     * `runtime` and the other runtime's bucket intact.
     * Empty/blank values omit the key; a fully-empty bucket is removed
     * (read side always treats absence as null → omit flag).
     * @param {unknown} runtime
     * @param {{ model?: unknown, effort?: unknown }} next
     * @returns {{ model: string|null, effort: string|null }}
     */
    writeModelEffort(runtime, { model = null, effort = null } = {}) {
      const rt = normalizeRuntime(runtime);
      if (!rt) throw new Error(`invalid runtime: ${runtime}`);
      const normalized = {
        model: normalizeOptionalFlag(model),
        effort: normalizeOptionalFlag(effort),
      };
      const existing = readFile() || {};
      const workers = existing.workers && typeof existing.workers === 'object'
        ? { ...existing.workers }
        : {};
      const bucket = workers[rt] && typeof workers[rt] === 'object'
        ? { ...workers[rt] }
        : {};
      if (normalized.model == null) {
        delete bucket.model;
      } else {
        bucket.model = normalized.model;
      }
      if (normalized.effort == null) {
        delete bucket.effort;
      } else {
        bucket.effort = normalized.effort;
      }
      if (Object.keys(bucket).length === 0) {
        delete workers[rt];
      } else {
        workers[rt] = bucket;
      }
      const nextData = { ...existing, workers };
      if (Object.keys(workers).length === 0) {
        delete nextData.workers;
      }
      mkdirSync(path.dirname(resolvedPath), { recursive: true });
      writeFileSync(resolvedPath, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8');
      return { ...normalized };
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
