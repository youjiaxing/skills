import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLaunchContract, buildResumeContract } from '../scripts/build-launch-contract.mjs';
import {
  buildWorkerInvocation,
  createRealLauncher,
  windowsArgvToCommandLine,
} from '../scripts/real-launcher.mjs';
import { createChainRun } from '../scripts/chain-run.mjs';
import { createFakeTracker } from '../scripts/fake-tracker.mjs';

const FIXED_SESSION = '11111111-1111-4111-8111-111111111111';

function baseIssue() {
  return {
    id: '12-real-worker-launcher.md',
    path: '.scratch/demo/issues/12-real-worker-launcher.md',
    number: '12',
  };
}

function initialContract(overrides = {}) {
  return buildLaunchContract({
    runtime: 'grok',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: baseIssue(),
    mode: 'review',
    ...overrides,
  });
}

test('grok initial: argv is foreground (no -p/--single), optional model/effort omitted', () => {
  const inv = buildWorkerInvocation(initialContract({ runtime: 'grok' }), {
    generateSessionId: () => FIXED_SESSION,
  });

  assert.equal(inv.command, 'grok');
  assert.equal(inv.cwd, 'D:/proj');
  assert.ok(inv.args.includes('--cwd'));
  assert.ok(inv.args.includes('D:/proj'));
  assert.ok(inv.args.includes('--session-id'));
  assert.ok(inv.args.includes(FIXED_SESSION));
  assert.equal(inv.sessionId, FIXED_SESSION);
  assert.equal(inv.sessionIdStatus, 'preallocated');

  // model/effort omitted → no flags
  assert.equal(inv.args.includes('-m'), false);
  assert.equal(inv.args.includes('--model'), false);
  assert.equal(inv.args.includes('--effort'), false);
  assert.equal(inv.args.includes('--reasoning-effort'), false);

  // Not headless main path
  assert.equal(inv.args.includes('-p'), false);
  assert.equal(inv.args.includes('--single'), false);
  assert.equal(inv.args.includes('--print'), false);
  assert.equal(inv.args.includes('--no-session-persistence'), false);

  const prompt = inv.args[inv.args.length - 1];
  assert.match(prompt, /\/rename\s+demo\/12-real-worker-launcher/);
  assert.match(prompt, /\/implement\b/);
});

test('grok initial: model and effort flags only when provided', () => {
  const inv = buildWorkerInvocation(
    initialContract({ runtime: 'grok', model: 'grok-4', effort: 'high' }),
    { generateSessionId: () => FIXED_SESSION },
  );
  const modelIdx = inv.args.indexOf('-m');
  assert.ok(modelIdx >= 0);
  assert.equal(inv.args[modelIdx + 1], 'grok-4');
  const effortIdx = inv.args.indexOf('--effort');
  assert.ok(effortIdx >= 0);
  assert.equal(inv.args[effortIdx + 1], 'high');
});

test('claude initial: uses -n title contract and cwd via spawn options', () => {
  const inv = buildWorkerInvocation(
    initialContract({ runtime: 'claude', model: 'sonnet', effort: 'medium' }),
    { generateSessionId: () => FIXED_SESSION },
  );

  assert.equal(inv.command, 'claude');
  assert.equal(inv.cwd, 'D:/proj');
  // Claude has no --cwd flag; working directory is spawn cwd.
  assert.equal(inv.args.includes('--cwd'), false);

  const nameIdx = inv.args.indexOf('-n');
  assert.ok(nameIdx >= 0);
  assert.equal(inv.args[nameIdx + 1], 'demo/12-real-worker-launcher');

  const modelIdx = inv.args.indexOf('--model');
  assert.ok(modelIdx >= 0);
  assert.equal(inv.args[modelIdx + 1], 'sonnet');
  const effortIdx = inv.args.indexOf('--effort');
  assert.ok(effortIdx >= 0);
  assert.equal(inv.args[effortIdx + 1], 'medium');

  assert.equal(inv.args.includes('-p'), false);
  assert.equal(inv.args.includes('--print'), false);
  assert.equal(inv.args.includes('--no-session-persistence'), false);
  assert.ok(inv.args.includes('--session-id'));
  assert.ok(inv.args.includes(FIXED_SESSION));
});

test('resume: uses recorded session id + original runtime/cwd; no skill entry injection', () => {
  const resume = buildResumeContract({
    runtime: 'claude',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: baseIssue(),
    title: 'demo/12-real-worker-launcher',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    mode: 'review',
  });
  const inv = buildWorkerInvocation(resume);

  assert.equal(inv.command, 'claude');
  assert.equal(inv.cwd, 'D:/proj');
  assert.equal(inv.sessionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(inv.sessionIdStatus, 'provided');

  const resumeIdx = inv.args.indexOf('--resume');
  assert.ok(resumeIdx >= 0);
  assert.equal(inv.args[resumeIdx + 1], 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

  // No fresh skill entry / implement prompt.
  const joined = inv.args.join(' ');
  assert.equal(/\/implement\b/.test(joined), false);
  assert.equal(/\/wayfinder\b/.test(joined), false);
  assert.equal(inv.args.includes('--no-session-persistence'), false);
  assert.equal(inv.args.includes('-p'), false);
  assert.equal(inv.args.includes('--print'), false);
});

test('resume grok: --resume + --cwd, no preallocated new session-id fork', () => {
  const resume = buildResumeContract({
    runtime: 'grok',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: baseIssue(),
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  const inv = buildWorkerInvocation(resume, {
    generateSessionId: () => 'should-not-be-used',
  });

  assert.equal(inv.command, 'grok');
  assert.ok(inv.args.includes('--cwd'));
  assert.ok(inv.args.includes('--resume'));
  assert.ok(inv.args.includes('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  // Do not pass a fresh --session-id on resume (would require --fork-session).
  assert.equal(inv.args.includes('--session-id'), false);
  assert.equal(inv.sessionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
});

test('resumable path never enables session-persistence-off switches', () => {
  for (const runtime of ['grok', 'claude']) {
    const initial = buildWorkerInvocation(initialContract({ runtime }), {
      generateSessionId: () => FIXED_SESSION,
    });
    const resume = buildWorkerInvocation(
      buildResumeContract({
        runtime,
        feature: 'demo',
        cwd: 'D:/proj',
        issue: baseIssue(),
        sessionId: FIXED_SESSION,
      }),
    );
    for (const inv of [initial, resume]) {
      assert.equal(inv.args.includes('--no-session-persistence'), false);
      assert.equal(inv.args.includes('--no-session'), false);
    }
  }
});

test('createRealLauncher shares launch port with fake: records pid + sessionId via injected spawn', async () => {
  const spawns = [];
  const launcher = createRealLauncher({
    generateSessionId: () => FIXED_SESSION,
    spawnWorker(command, args, options) {
      spawns.push({ command, args, options });
      return { pid: 9001 };
    },
    isProcessAlive(pid) {
      return pid === 9001;
    },
  });

  const result = await launcher.launch(initialContract({ runtime: 'claude' }));
  assert.equal(result.pid, 9001);
  assert.equal(result.sessionId, FIXED_SESSION);
  assert.equal(result.sessionIdStatus, 'preallocated');
  assert.equal(launcher.isAlive(9001), true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, 'claude');
  assert.equal(spawns[0].options.cwd, 'D:/proj');
  assert.equal(spawns[0].options.detached, true);
  // Foreground / visible window: never hide the console.
  assert.equal(spawns[0].options.windowsHide, false);
});

test('createRealLauncher resume returns recorded session id and does not invent a new one', async () => {
  const launcher = createRealLauncher({
    generateSessionId: () => 'must-not-appear',
    spawnWorker() {
      return { pid: 42 };
    },
  });
  const result = await launcher.launch(
    buildResumeContract({
      runtime: 'grok',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: baseIssue(),
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }),
  );
  assert.equal(result.pid, 42);
  assert.equal(result.sessionId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(result.sessionIdStatus, 'provided');
});

test('Chain Run can inject real launcher in place of fake (same launch shape)', async () => {
  const launches = [];
  const launcher = createRealLauncher({
    generateSessionId: () => FIXED_SESSION,
    spawnWorker(command, args, options) {
      launches.push({ command, args, options });
      return { pid: 7007 };
    },
    isProcessAlive() {
      return true;
    },
  });
  const tracker = createFakeTracker({
    candidates: [baseIssue()],
    completions: {},
  });
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: 'D:/proj',
    runtime: 'claude',
    model: null,
    effort: null,
  });

  const step = await chain.step();
  assert.equal(step.spawned, true);
  assert.equal(chain.slot?.pid, 7007);
  assert.equal(chain.slot?.sessionId, FIXED_SESSION);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, 'claude');
  // Omitted model/effort → no flags on real argv
  assert.equal(launches[0].args.includes('--model'), false);
  assert.equal(launches[0].args.includes('--effort'), false);
  assert.ok(launches[0].args.includes('-n'));
});

test('session id degradation: when preallocate disabled, do not pretend id was captured', async () => {
  const launcher = createRealLauncher({
    preallocateSessionId: false,
    spawnWorker() {
      return { pid: 55 };
    },
  });
  const result = await launcher.launch(initialContract({ runtime: 'grok' }));
  assert.equal(result.pid, 55);
  assert.equal(result.sessionId, null);
  assert.equal(result.sessionIdStatus, 'unavailable');
  assert.match(result.sessionIdNote || '', /not captured|unavailable|foreground/i);
});

test('session title truncation keeps feature/ and NN- prefixes', async () => {
  const { truncateSessionTitle } = await import('../scripts/build-launch-contract.mjs');
  const longSlug = `12-${'very-long-slug-segment-'.repeat(10)}tail`;
  const title = truncateSessionTitle(`issue-chain-orchestrator/${longSlug}`, 120);
  assert.ok(Array.from(title).length <= 120);
  assert.match(title, /^issue-chain-orchestrator\/12-/);
  assert.equal(title.endsWith('-'), false);
});

test('windowsArgvToCommandLine quotes spaces and preserves simple tokens', () => {
  assert.equal(windowsArgvToCommandLine(['--cwd', 'D:\\proj']), '--cwd D:\\proj');
  assert.equal(
    windowsArgvToCommandLine(['-n', 'feat/01-title', 'hello world']),
    '-n feat/01-title "hello world"',
  );
  assert.match(windowsArgvToCommandLine(['say "hi"']), /\\"/);
});
