#!/usr/bin/env node

/**
 * Minimal runnable entry for yjx-issue-crusher.
 *
 * Commands:
 *   recommend     — print auto-next candidate from local-md tracker (no spawn)
 *   probe-launch  — dry-run (default) or foreground-spawn real Worker argv (ticket 12)
 *   chain         — start one chain process bound to cwd + feature (ticket 13)
 *   --help
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { buildLaunchContract, buildResumeContract } from './build-launch-contract.mjs';
import { createChainRun } from './chain-run.mjs';
import { createDispatchSurface } from './dispatch-surface.mjs';
import { runDispatchOnce, runDispatchTui } from './dispatch-tui.mjs';
import { createFakeLauncher } from './fake-launcher.mjs';
import {
  resolveFeatureOrPrompt,
  resolveRuntimeOrPrompt,
} from './interactive-prompts.mjs';
import { createLocalMarkdownTracker } from './local-md-tracker.mjs';
import {
  createFileModeConfig,
  DEFAULT_RUNTIME,
  normalizeRuntime,
} from './mode-config.mjs';
import {
  buildWorkerInvocation,
  createRealLauncher,
} from './real-launcher.mjs';
import {
  createFullscreenSelectItems,
  shouldUseFullscreenStartupPrompt,
} from './startup-select.mjs';

const KNOWN_COMMANDS = new Set(['recommend', 'probe-launch', 'chain']);

function printHelp() {
  console.log(`Issue Crusher — 按看板一张张串行开 Agent 做 issue

【你最常用】先 cd 到产品仓根目录，再：
  ic <功能目录名>

  例：.scratch/pay-refactor/issues 对应功能名 pay-refactor
      ic pay-refactor

  会打开调度界面，并按规则用 Grok/Claude 前台做 ready 的实现票。

【等价写法】
  issue-crusher <功能名>          与 ic 相同
  ic chain <功能名>               同上（显式写 chain）

【其它命令】
  ic recommend <功能名>           只打印「下一张该做谁」，不开会话
  ic probe-launch --runtime grok  调试：看启动参数（默认不真开窗）

【可选参数】
  --runtime grok|claude   用哪个 Agent（可省略；仓配置或交互询问）
  --mode review|vibe      审码 / 可自动关票（可省略；默认 review）
  --model 名称             本进程后续 Worker 的模型（省略：仓分桶或运行时默认）
  --effort 档位            本进程后续 Worker 的 effort（省略：仓分桶或运行时默认）
  --cwd 路径              产品仓目录（默认：当前目录）
  --fake-launcher         假启动，不真开 Grok/Claude（冒烟用）
  --once / --stop         非交互跑一下就退（测试用）
  -h, --help              显示本说明

【仓级默认】产品仓可建 .issue-crusher/config.json：
  { "mode": "vibe", "runtime": "claude" }
  可选 workers.<runtime>.model / effort（grok|claude 分桶；缺省=运行时默认不传 flag）

【调度界面按键】m review|vibe  f强制推进  r恢复  y/n确认  s停链  t刷新  q退出

只敲 ic（不带功能名）：扫描本仓 feature，提示你选取后再开链。
未指定 runtime 且仓里也没有：会先问 Grok 还是 Claude，再开第一张票。
`);
}

function createStdinAsk(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
  return {
    ask(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer));
      });
    },
    close() {
      rl.close();
    },
  };
}

function parseArgs(argv) {
  const options = {
    command: null,
    projectRoot: null,
    feature: null,
    help: false,
    runtime: null,
    cwd: process.cwd(),
    issue: null,
    model: null,
    effort: null,
    title: null,
    resume: null,
    run: false,
    killAfter: null,
    mode: null,
    fakeLauncher: false,
    once: false,
    stop: false,
  };
  const positionals = [];
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === '--project-root') {
      options.projectRoot = args.shift();
      if (!options.projectRoot) throw new Error('--project-root requires a value');
    } else if (argument === '--feature') {
      options.feature = args.shift();
      if (!options.feature) throw new Error('--feature requires a value');
    } else if (argument === '--runtime') {
      options.runtime = args.shift();
      if (!options.runtime) throw new Error('--runtime requires a value');
    } else if (argument === '--cwd') {
      options.cwd = args.shift();
      if (!options.cwd) throw new Error('--cwd requires a value');
    } else if (argument === '--issue') {
      options.issue = args.shift();
      if (!options.issue) throw new Error('--issue requires a value');
    } else if (argument === '--model') {
      options.model = args.shift();
      if (options.model == null) throw new Error('--model requires a value');
    } else if (argument === '--effort') {
      options.effort = args.shift();
      if (options.effort == null) throw new Error('--effort requires a value');
    } else if (argument === '--title') {
      options.title = args.shift();
      if (!options.title) throw new Error('--title requires a value');
    } else if (argument === '--resume') {
      options.resume = args.shift();
      if (!options.resume) throw new Error('--resume requires a value');
    } else if (argument === '--mode') {
      options.mode = args.shift();
      if (options.mode !== 'review' && options.mode !== 'vibe') {
        throw new Error("--mode must be 'review' or 'vibe'");
      }
    } else if (argument === '--run') {
      options.run = true;
    } else if (argument === '--fake-launcher') {
      options.fakeLauncher = true;
    } else if (argument === '--once') {
      options.once = true;
    } else if (argument === '--stop') {
      options.stop = true;
    } else if (argument === '--kill-after') {
      const raw = args.shift();
      if (raw == null) throw new Error('--kill-after requires a value');
      options.killAfter = Number(raw);
      if (!Number.isFinite(options.killAfter) || options.killAfter < 0) {
        throw new Error('--kill-after must be a non-negative number of ms');
      }
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument?.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }

  // Short forms:
  //   ic <feature> [...]              → chain + feature
  //   ic chain <feature> [...]
  //   ic recommend <feature> [...]
  //   ic probe-launch [...]
  if (positionals.length > 0) {
    const first = positionals[0];
    if (KNOWN_COMMANDS.has(first)) {
      options.command = first;
      if (positionals[1] && options.feature == null) {
        options.feature = positionals[1];
      }
      if (positionals.length > 2) {
        throw new Error(`unexpected argument: ${positionals[2]}`);
      }
    } else {
      options.command = 'chain';
      if (options.feature == null) options.feature = first;
      if (positionals.length > 1) {
        throw new Error(`unexpected argument: ${positionals[1]}`);
      }
    }
  }

  if (options.projectRoot == null) {
    options.projectRoot = options.cwd || process.cwd();
  }
  return options;
}
function resolveProbeIssue(options) {
  const feature = options.feature || 'demo';
  if (options.issue) {
    const base = path.basename(options.issue);
    const id = base.endsWith('.md') ? base : `${base}.md`;
    const issuePath = options.issue.includes('/') || options.issue.includes('\\')
      ? options.issue.replace(/\\/g, '/')
      : `.scratch/${feature}/issues/${id}`;
    return {
      feature,
      issue: {
        id,
        path: issuePath,
      },
    };
  }
  return {
    feature,
    issue: {
      id: '00-probe-launch.md',
      path: `.scratch/${feature}/issues/00-probe-launch.md`,
    },
  };
}

async function runRecommend(options) {
  if (!options.feature) throw new Error('--feature is required for recommend');
  const tracker = createLocalMarkdownTracker({
    projectRoot: path.resolve(options.projectRoot),
    feature: options.feature,
  });
  const candidates = await tracker.listAutoCandidates();
  const recommended = await tracker.recommendNext();
  const payload = {
    feature: options.feature,
    candidates,
    recommended,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProbeLaunch(options) {
  if (!options.runtime) throw new Error('--runtime is required for probe-launch');
  if (options.runtime !== 'grok' && options.runtime !== 'claude') {
    throw new Error("--runtime must be 'grok' or 'claude'");
  }

  const { feature, issue } = resolveProbeIssue(options);
  const cwd = path.resolve(options.cwd);

  let contract;
  if (options.resume) {
    contract = buildResumeContract({
      runtime: options.runtime,
      feature,
      cwd,
      issue,
      title: options.title || undefined,
      sessionId: options.resume,
      model: options.model,
      effort: options.effort,
    });
  } else {
    contract = buildLaunchContract({
      runtime: options.runtime,
      feature,
      cwd,
      issue,
      model: options.model,
      effort: options.effort,
    });
    if (options.title) {
      contract = { ...contract, title: options.title };
    }
  }

  const payload = {
    mode: options.run ? 'run' : 'dry-run',
    contract: {
      kind: contract.kind,
      runtime: contract.runtime,
      cwd: contract.cwd,
      feature: contract.feature,
      title: contract.title,
      model: contract.model,
      effort: contract.effort,
      sessionId: contract.sessionId ?? null,
    },
  };

  if (!options.run) {
    // Single invocation build for dry-run so preallocated session id is stable in output.
    const invocation = buildWorkerInvocation(contract);
    payload.invocation = {
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      sessionId: invocation.sessionId,
      sessionIdStatus: invocation.sessionIdStatus,
      sessionIdNote: invocation.sessionIdNote,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  const launcher = createRealLauncher();
  const result = await launcher.launch(contract);
  // Prefer launcher-returned invocation so session id matches the spawned process.
  const invocation = result.invocation;
  payload.invocation = {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    sessionId: invocation.sessionId,
    sessionIdStatus: invocation.sessionIdStatus,
    sessionIdNote: invocation.sessionIdNote,
  };
  payload.result = {
    pid: result.pid,
    sessionId: result.sessionId,
    sessionIdStatus: result.sessionIdStatus,
    sessionIdNote: result.sessionIdNote,
    alive: launcher.isAlive(result.pid),
  };

  if (options.killAfter != null) {
    await sleep(options.killAfter);
    await launcher.kill(result.pid);
    payload.result.killedAfterMs = options.killAfter;
    payload.result.aliveAfterKill = launcher.isAlive(result.pid);
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

/**
 * Start one chain process: product cwd + feature slug + dispatch surface.
 * Default launcher is real foreground Worker; --fake-launcher for smoke.
 */
/**
 * Sync resolve for tests: flag → repo → fake default → null (needs prompt).
 */
export function resolveChainRuntime({
  flagRuntime = null,
  repoRuntime = null,
  fakeLauncher = false,
} = {}) {
  const fromFlag = normalizeRuntime(flagRuntime);
  if (fromFlag) return fromFlag;
  const fromRepo = normalizeRuntime(repoRuntime);
  if (fromRepo) return fromRepo;
  if (fakeLauncher) return DEFAULT_RUNTIME;
  return null;
}

export async function runChain(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const projectRoot = path.resolve(options.projectRoot || cwd);
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const nonInteractive = Boolean(
    options.once
    || options.nonInteractive
    || !input.isTTY,
  );

  // Interactive dual-TTY: fullscreen Ink menus for missing feature/runtime.
  // Injected ask/selectItems (tests) win; --once / non-TTY never mount menus.
  const useFullscreenPrompts = shouldUseFullscreenStartupPrompt({
    input,
    output,
    once: options.once,
    nonInteractive,
  });
  const selectItems = nonInteractive
    ? null
    : (typeof options.selectItems === 'function'
      ? options.selectItems
      : (useFullscreenPrompts && typeof options.ask !== 'function'
        ? createFullscreenSelectItems({ input, output })
        : null));

  let promptSession = null;
  const ensureAsk = () => {
    if (typeof options.ask === 'function') return options.ask;
    // Fullscreen path owns stdin; do not also open readline.
    if (selectItems) return null;
    if (!promptSession) {
      promptSession = createStdinAsk(input, output);
    }
    return (q) => promptSession.ask(q);
  };

  try {
    const feature = await resolveFeatureOrPrompt({
      feature: options.feature,
      projectRoot,
      ask: nonInteractive ? null : ensureAsk(),
      selectItems,
      nonInteractive,
      listFeatures: options.listFeatures,
      output,
    });

    const modeConfig = createFileModeConfig({ projectRoot });
    const runtime = await resolveRuntimeOrPrompt({
      flagRuntime: options.runtime,
      repoRuntime: typeof modeConfig.readRuntime === 'function' ? modeConfig.readRuntime() : null,
      fakeLauncher: options.fakeLauncher,
      ask: nonInteractive ? null : ensureAsk(),
      selectItems,
      nonInteractive,
      output,
    });
    if (runtime !== 'grok' && runtime !== 'claude') {
      throw new Error("--runtime must be 'grok' or 'claude'");
    }

    const tracker = createLocalMarkdownTracker({
      projectRoot,
      feature,
    });
    const launcher = options.fakeLauncher
      ? createFakeLauncher({ pid: 9000, sessionId: 'fake-chain-session' })
      : createRealLauncher();

    const chain = createChainRun({
      tracker,
      launcher,
      feature,
      cwd,
      runtime,
      mode: options.mode ?? undefined,
      modeConfig,
      model: options.model,
      effort: options.effort,
    });
    const surface = createDispatchSurface({ chain, tracker });

    // --once / non-TTY: printable frames then exit — never mount Ink fullscreen.
    if (options.once || nonInteractive) {
      await runDispatchOnce({
        surface,
        output,
        maxSteps: 2,
        stopWhenIdle: true,
      });
      if (options.stop) {
        await surface.stop();
        output.write(`${renderStoppedNote(surface)}\n`);
      }
      const snap = surface.snapshot();
      output.write(`${JSON.stringify({
        feature: snap.feature,
        status: snap.status,
        stopped: snap.stopped,
        subsequentMode: snap.subsequentMode,
        subsequentModel: snap.subsequentModel,
        subsequentEffort: snap.subsequentEffort,
        slot: snap.slot,
        pendingHitl: snap.pendingHitl,
        boardIssueCount: snap.board?.issues?.length ?? 0,
      }, null, 2)}\n`);
      return 0;
    }

    // Close selection prompts before long-lived TUI takes stdin.
    if (promptSession) {
      promptSession.close();
      promptSession = null;
    }
    await runDispatchTui({ surface, input, output, once: false });
    return 0;
  } finally {
    if (promptSession) promptSession.close();
  }
}

function renderStoppedNote(surface) {
  const snap = surface.snapshot();
  return `[chain] stopped=${snap.stopped} status=${snap.status}`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  // Bare `ic` → chain + interactive feature pick (not just help).
  if (!options.command) {
    options.command = 'chain';
  }
  if (options.command === 'recommend') return runRecommend(options);
  if (options.command === 'probe-launch') return runProbeLaunch(options);
  if (options.command === 'chain') return runChain(options);
  throw new Error(`unknown command: ${options.command}`);
}

const isMain = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
