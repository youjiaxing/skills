/**
 * Fullscreen Ink startup prompts for feature / runtime selection (ticket 04).
 *
 * Interactive dual-TTY path: list picker with j/k/digits + Enter confirm / q cancel.
 * --once / non-TTY never mount this shell (callers keep explicit-arg / throw contract).
 * Pure key + frame helpers are unit-testable without a real terminal.
 */

import { createElement, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

import { drainPendingInput } from './dispatch-fullscreen.mjs';

const ALT_ENTER = '\u001b[?1049h\u001b[?25l';
const ALT_LEAVE = '\u001b[?1049l\u001b[?25h';

/**
 * Whether startup feature/runtime prompts should use the fullscreen Ink picker.
 * Same dual-TTY gate as the dispatch shell; never for --once / nonInteractive.
 *
 * @param {{
 *   input?: { isTTY?: boolean } | null,
 *   output?: { isTTY?: boolean } | null,
 *   once?: boolean,
 *   nonInteractive?: boolean,
 * }} [options]
 * @returns {boolean}
 */
export function shouldUseFullscreenStartupPrompt({
  input = process.stdin,
  output = process.stdout,
  once = false,
  nonInteractive = false,
} = {}) {
  if (once || nonInteractive) return false;
  return Boolean(input?.isTTY && output?.isTTY);
}

/**
 * Map one keypress to a startup-select intent.
 *
 * @param {string} input
 * @param {{ escape?: boolean, return?: boolean, upArrow?: boolean, downArrow?: boolean } | null} [key]
 * @returns {{ type: string, arg?: number } | null}
 */
export function mapStartupSelectKey(input, key = null) {
  if (key?.escape) return { type: 'cancel' };
  if (key?.return) return { type: 'confirm' };
  if (key?.downArrow) return { type: 'next' };
  if (key?.upArrow) return { type: 'prev' };

  if (input == null || input === '') return null;
  const raw = String(input);
  if (raw === '\r' || raw === '\n') return { type: 'confirm' };
  if (raw.length !== 1) return null;

  const lower = raw.toLowerCase();
  if (lower === 'q') return { type: 'cancel' };
  if (lower === 'j') return { type: 'next' };
  if (lower === 'k') return { type: 'prev' };
  if (/^[1-9]$/.test(lower)) return { type: 'index', arg: Number(lower) - 1 };
  return null;
}

/**
 * Pure state transition for the startup list picker.
 *
 * @param {{
 *   selectedIndex: number,
 *   done: boolean,
 *   cancelled: boolean,
 *   value: string | null,
 * }} state
 * @param {{ type: string, arg?: number } | null} command
 * @param {Array<{ value: string, label?: string }>} items
 * @returns {{
 *   selectedIndex: number,
 *   done: boolean,
 *   cancelled: boolean,
 *   value: string | null,
 * }}
 */
export function applyStartupSelectKey(state, command, items) {
  if (!state || state.done) return state;
  const count = Array.isArray(items) ? items.length : 0;
  if (!command || count <= 0) return state;

  if (command.type === 'cancel') {
    return {
      ...state,
      done: true,
      cancelled: true,
      value: null,
    };
  }

  if (command.type === 'confirm') {
    const index = clampIndex(state.selectedIndex, count);
    const item = items[index];
    return {
      ...state,
      selectedIndex: index,
      done: true,
      cancelled: false,
      value: item ? item.value : null,
    };
  }

  if (command.type === 'index') {
    const index = Number(command.arg);
    if (!Number.isInteger(index) || index < 0 || index >= count) return state;
    return { ...state, selectedIndex: index };
  }

  const base = clampIndex(state.selectedIndex, count);
  if (command.type === 'next') {
    return { ...state, selectedIndex: (base + 1) % count };
  }
  if (command.type === 'prev') {
    return { ...state, selectedIndex: (base - 1 + count) % count };
  }
  return state;
}

function clampIndex(index, count) {
  if (count <= 0) return 0;
  if (!Number.isInteger(index) || index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/**
 * Pure text frame for startup select (tests + shell body).
 *
 * @param {{
 *   title: string,
 *   items: Array<{ value: string, label?: string }>,
 *   selectedIndex?: number,
 * }} options
 * @returns {string}
 */
export function renderStartupSelectFrame({
  title,
  items = [],
  selectedIndex = 0,
} = {}) {
  const lines = [
    `[启动选单] ${title || '请选择'}`,
    '',
  ];
  const index = clampIndex(selectedIndex, items.length);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const label = item.label ?? item.value;
    const mark = i === index ? '◀选中' : '  ';
    lines.push(`  ${i + 1}) ${label}  ${mark}`);
  }
  lines.push('');
  lines.push('[底栏] [j]/[k]/移动  数字直达  Enter 确认  [q] 取消');
  return lines.join('\n');
}

/**
 * Presentational shell for renderToString / Ink mount.
 *
 * @param {{
 *   title?: string,
 *   items?: Array<{ value: string, label?: string }>,
 *   selectedIndex?: number,
 * }} props
 */
export function StartupSelectShell({
  title = '请选择',
  items = [],
  selectedIndex = 0,
} = {}) {
  const frameLines = renderStartupSelectFrame({ title, items, selectedIndex }).split('\n');
  return createElement(
    Box,
    {
      flexDirection: 'column',
      width: '100%',
      paddingX: 1,
      paddingY: 1,
    },
    ...frameLines.map((line, i) => createElement(
      Text,
      {
        key: `l${i}`,
        bold: i === 0,
        dimColor: i === frameLines.length - 1,
      },
      line || ' ',
    )),
  );
}

/**
 * Live Ink picker until confirm or cancel.
 *
 * @param {{
 *   title: string,
 *   items: Array<{ value: string, label?: string }>,
 *   resultRef: { current: { cancelled: boolean, value: string | null } },
 * }} props
 */
function StartupSelectApp({ title, items, resultRef }) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    // Ctrl+C cancels like q (leave cleanly; do not bare-kill).
    const command = key?.ctrl && String(input).toLowerCase() === 'c'
      ? { type: 'cancel' }
      : mapStartupSelectKey(input, key);
    if (!command) return;

    const next = applyStartupSelectKey(
      {
        selectedIndex,
        done: false,
        cancelled: false,
        value: null,
      },
      command,
      items,
    );

    if (next.selectedIndex !== selectedIndex) {
      setSelectedIndex(next.selectedIndex);
    }

    if (next.done) {
      if (resultRef) {
        resultRef.current = {
          cancelled: Boolean(next.cancelled),
          value: next.cancelled ? null : next.value,
        };
      }
      exit();
    }
  });

  return createElement(StartupSelectShell, {
    title,
    items,
    selectedIndex,
  });
}

/**
 * Mount fullscreen (or test) startup select until confirm/cancel.
 *
 * @param {{
 *   title: string,
 *   items: Array<{ value: string, label?: string }>,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   alternateScreen?: boolean,
 * }} options
 * @returns {Promise<{ cancelled: boolean, value: string | null }>}
 */
export async function runFullscreenSelect({
  title,
  items,
  input = process.stdin,
  output = process.stdout,
  alternateScreen = Boolean(output?.isTTY),
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('startup select requires at least one item');
  }

  const resultRef = {
    current: { cancelled: true, value: null },
  };
  let enteredAlt = false;

  if (alternateScreen && typeof output.write === 'function') {
    output.write(ALT_ENTER);
    enteredAlt = true;
  }

  const instance = render(
    createElement(StartupSelectApp, {
      title: title || '请选择',
      items,
      resultRef,
    }),
    {
      stdin: input,
      stdout: output,
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
    // Confirm/cancel keys may still sit in the buffer; drop them so the
    // following dispatch fullscreen mount cannot treat them as start.
    drainPendingInput(input);
  }

  return {
    cancelled: Boolean(resultRef.current.cancelled),
    value: resultRef.current.cancelled ? null : resultRef.current.value,
  };
}

/**
 * Adapter for resolveFeatureOrPrompt / resolveRuntimeOrPrompt `selectItems`.
 *
 * @param {{
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   alternateScreen?: boolean,
 * }} [defaults]
 * @returns {(opts: { title: string, items: Array<{ value: string, label?: string }> }) => Promise<string | null>}
 */
export function createFullscreenSelectItems(defaults = {}) {
  return async ({ title, items }) => {
    const result = await runFullscreenSelect({
      title,
      items,
      input: defaults.input ?? process.stdin,
      output: defaults.output ?? process.stdout,
      alternateScreen: defaults.alternateScreen,
    });
    return result.cancelled ? null : result.value;
  };
}
