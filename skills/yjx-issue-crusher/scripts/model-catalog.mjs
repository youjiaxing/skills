/**
 * Model / effort catalog for fullscreen `o` selection (ticket 03).
 *
 * Orchestrator does **not** own a full universe of models. Lists are
 * hints + passthrough strings:
 * - model: first item always 运行时默认 (null = omit flag)
 * - grok: injectable discovery port; default best-effort `grok models`
 *   with timeout/fail → degrade to 运行时默认 only
 * - claude: static common aliases + default (no full directory API)
 * - effort: 运行时默认 + Claude public levels (passthrough for both runtimes)
 */

import { spawn } from 'node:child_process';

/** @typedef {{ value: string | null, label: string }} CatalogItem */

/** First list item: omit Worker flag (runtime product default). */
export const RUNTIME_DEFAULT_ITEM = Object.freeze({
  value: null,
  label: '运行时默认',
});

/** Claude alias-level hints (not a complete catalog). */
export const CLAUDE_MODEL_HINTS = Object.freeze([
  Object.freeze({ value: 'sonnet', label: 'sonnet' }),
  Object.freeze({ value: 'opus', label: 'opus' }),
  Object.freeze({ value: 'haiku', label: 'haiku' }),
]);

/** Claude public effort levels; Grok uses the same passthrough hint set. */
export const EFFORT_HINTS = Object.freeze([
  Object.freeze({ value: 'low', label: 'low' }),
  Object.freeze({ value: 'medium', label: 'medium' }),
  Object.freeze({ value: 'high', label: 'high' }),
  Object.freeze({ value: 'xhigh', label: 'xhigh' }),
  Object.freeze({ value: 'max', label: 'max' }),
]);

/** Default wall-clock budget for best-effort `grok models` discovery. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;

/**
 * @returns {CatalogItem[]}
 */
export function defaultEffortItems() {
  return [RUNTIME_DEFAULT_ITEM, ...EFFORT_HINTS.map((item) => ({ ...item }))];
}

/**
 * @returns {CatalogItem[]}
 */
export function claudeModelItems() {
  return [RUNTIME_DEFAULT_ITEM, ...CLAUDE_MODEL_HINTS.map((item) => ({ ...item }))];
}

/**
 * Degraded model list after discovery fail/timeout/empty.
 * @returns {CatalogItem[]}
 */
export function degradedModelItems() {
  return [{ ...RUNTIME_DEFAULT_ITEM }];
}

/**
 * Parse `grok models` stdout into model id strings.
 * Tolerates login banners and bullet styles (`* id (default)`, `- id`).
 *
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
export function parseGrokModelsOutput(text) {
  if (text == null || String(text).trim() === '') return [];
  const lines = String(text).split(/\r?\n/);
  /** @type {string[]} */
  const ids = [];
  const seen = new Set();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // "* grok-4.5 (default)" or "- api-grok-4-5"
    const bullet = line.match(/^[*•\-]\s+(\S+)/);
    if (!bullet) continue;
    const id = bullet[1];
    if (!id || seen.has(id)) continue;
    // Skip section headers mistaken as bullets.
    if (/^(available|default|models?)$/i.test(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Race a promise against a timeout. On timeout, rejects (caller degrades).
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
export function withTimeout(promise, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`model discovery timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Default process runner for discovery (injectable in tests).
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 * }} spec
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null }>}
 */
export function runDiscoverCommand(spec) {
  const {
    command,
    args = [],
    timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    env = process.env,
  } = spec;
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child;
    try {
      child = spawn(command, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`model discovery timed out after ${timeoutMs}ms`));
    }, Math.max(1, Number(timeoutMs) || DEFAULT_DISCOVERY_TIMEOUT_MS));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Build a best-effort Grok model discoverer (default production port).
 *
 * @param {{
 *   command?: string,
 *   args?: string[],
 *   timeoutMs?: number,
 *   runCommand?: typeof runDiscoverCommand,
 * }} [options]
 * @returns {() => Promise<string[]>}
 */
export function createGrokModelsDiscoverer({
  command = 'grok',
  args = ['models'],
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  runCommand = runDiscoverCommand,
} = {}) {
  return async () => {
    const result = await runCommand({ command, args, timeoutMs });
    if (result.code != null && result.code !== 0) {
      return [];
    }
    return parseGrokModelsOutput(result.stdout);
  };
}

/**
 * Build catalog items from raw model id strings (dedupe, skip blanks).
 *
 * @param {Iterable<unknown>} ids
 * @returns {CatalogItem[]}
 */
export function modelItemsFromIds(ids) {
  /** @type {CatalogItem[]} */
  const items = [{ ...RUNTIME_DEFAULT_ITEM }];
  const seen = new Set();
  for (const raw of ids || []) {
    if (raw == null) continue;
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({ value: id, label: id });
  }
  return items;
}

/**
 * Resolve the model list for the fullscreen `o` flow.
 *
 * - claude → static aliases + 运行时默认 (discoverer ignored)
 * - grok → injectable discoverModels(); default = createGrokModelsDiscoverer()
 *   fail / timeout / empty → 运行时默认 only
 *
 * @param {{
 *   runtime?: string | null,
 *   discoverModels?: (() => Promise<string[] | Iterable<string>>) | null,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<CatalogItem[]>}
 */
export async function resolveModelItems({
  runtime = 'grok',
  discoverModels = null,
  timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
} = {}) {
  const rt = String(runtime || 'grok').toLowerCase();
  if (rt === 'claude') {
    return claudeModelItems();
  }

  const discover = typeof discoverModels === 'function'
    ? discoverModels
    : createGrokModelsDiscoverer({ timeoutMs });

  try {
    const raw = await withTimeout(Promise.resolve().then(() => discover()), timeoutMs);
    const ids = Array.isArray(raw) ? raw : [...(raw || [])];
    const items = modelItemsFromIds(ids);
    // Empty discovery (only default) is already the degrade shape.
    return items;
  } catch {
    return degradedModelItems();
  }
}
