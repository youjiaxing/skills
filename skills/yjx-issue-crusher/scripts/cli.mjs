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
import { fileURLToPath } from 'node:url';

import { buildLaunchContract, buildResumeContract } from './build-launch-contract.mjs';
import { createChainRun } from './chain-run.mjs';
import { createDispatchSurface } from './dispatch-surface.mjs';
import { runDispatchOnce, runDispatchTui } from './dispatch-tui.mjs';
import { createFakeLauncher } from './fake-launcher.mjs';
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

const KNOWN_COMMANDS = new Set(['recommend', 'probe-launch', 'chain']);

function printHelp() {
  console.log(`Usage:
  ic <feature>                      # short: open chain in current repo (alias: issue-crusher)
  ic chain <feature> [options]
  ic recommend <feature>
  ic probe-launch --runtime grok|claude [options]

Daily path (from product repo root):
  ic my-feature
  ic my-feature --runtime claude

Defaults:
  --cwd / --project-root   process.cwd()
  --runtime                flag → repo .issue-crusher/config.json "runtime" → grok
  --mode                   flag → repo config "mode" → review

Commands:
  recommend      List auto-relay candidates and recommend next (local-md)
  probe-launch   Build (and optionally spawn) a real foreground Worker launch
  chain          Start one orchestrator chain (cwd + feature); dispatch TUI
                 (default when the first arg is a feature slug, not a command)

chain / recommend options:
  --feature SLUG        Or positional: ic <feature> / ic chain <feature>
  --cwd PATH            Product repo cwd (default: process cwd)
  --project-root PATH   Tracker root (default: same as --cwd)
  --runtime grok|claude Worker binary (chain; see Defaults above)
  --mode review|vibe    Process-only override (default: not set → repo/review)
  --model ID            Optional model for spawns
  --effort LEVEL        Optional effort for spawns
  --fake-launcher       Fake launcher (smoke; no real Worker)
  --once                Non-interactive tick + print frame
  --stop                With --once: stop after first tick

probe-launch options:
  --runtime grok|claude Runtime binary (required)
  --cwd PATH            Working directory (default: cwd)
  --feature SLUG        Feature slug (default: demo)
  --issue PATH          Issue path or id (default: synthetic probe)
  --model ID / --effort LEVEL / --title TITLE
  --resume SESSION_ID   Resume launch instead of initial
  --run                 Actually spawn (default: dry-run)
  --kill-after MS       With --run, kill after MS

  -h, --help            Show help

One chain process = one product cwd + one feature. Multi-feature = multi process.
Board/graph is read-only. Workers stay in their own foreground windows.
Install short names: from skills monorepo run  npm link  (bins: ic, issue-crusher)
`);
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
 * Resolve chain runtime: CLI flag → repo config → DEFAULT_RUNTIME (grok).
 * Fake launcher still accepts missing runtime (falls back to grok for bookkeeping).
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
  return DEFAULT_RUNTIME;
}

export async function runChain(options) {
  if (!options.feature) {
    throw new Error('feature is required (ic <feature> or --feature SLUG)');
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const projectRoot = path.resolve(options.projectRoot || cwd);
  const modeConfig = createFileModeConfig({ projectRoot });
  const runtime = resolveChainRuntime({
    flagRuntime: options.runtime,
    repoRuntime: typeof modeConfig.readRuntime === 'function' ? modeConfig.readRuntime() : null,
    fakeLauncher: options.fakeLauncher,
  });
  if (runtime !== 'grok' && runtime !== 'claude') {
    throw new Error("--runtime must be 'grok' or 'claude'");
  }

  const tracker = createLocalMarkdownTracker({
    projectRoot,
    feature: options.feature,
  });
  const launcher = options.fakeLauncher
    ? createFakeLauncher({ pid: 9000, sessionId: 'fake-chain-session' })
    : createRealLauncher();

  const chain = createChainRun({
    tracker,
    launcher,
    feature: options.feature,
    cwd,
    runtime,
    mode: options.mode ?? undefined,
    modeConfig,
    model: options.model,
    effort: options.effort,
  });
  const surface = createDispatchSurface({ chain, tracker });

  if (options.once) {
    const result = await runDispatchOnce({
      surface,
      output: process.stdout,
      maxSteps: 2,
      stopWhenIdle: true,
    });
    if (options.stop) {
      await surface.stop();
      process.stdout.write(`${renderStoppedNote(surface)}\n`);
    }
    const snap = surface.snapshot();
    process.stdout.write(`${JSON.stringify({
      feature: snap.feature,
      status: snap.status,
      stopped: snap.stopped,
      subsequentMode: snap.subsequentMode,
      slot: snap.slot,
      pendingHitl: snap.pendingHitl,
      boardIssueCount: snap.board?.issues?.length ?? 0,
    }, null, 2)}\n`);
    return 0;
  }

  await runDispatchTui({ surface });
  return 0;
}

function renderStoppedNote(surface) {
  const snap = surface.snapshot();
  return `[chain] stopped=${snap.stopped} status=${snap.status}`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    printHelp();
    return options.help || !options.command ? 0 : 1;
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
