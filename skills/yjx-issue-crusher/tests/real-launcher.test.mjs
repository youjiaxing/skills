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
  // Grok: skill slash first; no /rename in prompt (title is out-of-band).
  assert.match(prompt, /^\/implement\b/u);
  assert.equal(/\/rename\b/.test(prompt), false);
  assert.equal(/Scope is limited/i.test(prompt), false);
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

test('grokSessionDir encodes cwd the way Grok does on disk', async () => {
  const { grokSessionDir } = await import('../scripts/real-launcher.mjs');
  const dir = grokSessionDir('D:\\go_workspace\\proj', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', {
    grokHome: 'C:\\Users\\x\\.grok',
  });
  assert.match(dir, /sessions/);
  assert.match(dir, /D%3A%5Cgo_workspace%5Cproj/);
  assert.match(dir, /aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee$/);
});

test('applyGrokSessionTitle patches summary.json when it appears', async () => {
  const { applyGrokSessionTitle } = await import('../scripts/real-launcher.mjs');
  const files = new Map();
  let now = 0;
  const ok = await applyGrokSessionTitle({
    cwd: 'D:\\proj',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    title: 'demo/01-ticket',
    grokHome: 'C:\\fake-grok',
    timeoutMs: 500,
    intervalMs: 10,
    now: () => now,
    sleepFn: async () => {
      now += 50;
      if (now >= 50 && files.size === 0) {
        files.set(
          'summary',
          JSON.stringify({ info: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd: 'D:\\proj' } }),
        );
      }
    },
    access: async () => {
      if (!files.has('summary')) throw new Error('ENOENT');
    },
    readFile: async () => files.get('summary'),
    writeFile: async (_file, body) => {
      files.set('summary', body);
    },
  });
  assert.equal(ok, true);
  const written = JSON.parse(files.get('summary'));
  assert.equal(written.generated_title, 'demo/01-ticket');
  assert.equal(written.session_summary, 'demo/01-ticket');
  assert.equal(written.title_is_manual, true);
});

test('createRealLauncher applies grok title out-of-band after spawn', async () => {
  const titleCalls = [];
  const launcher = createRealLauncher({
    generateSessionId: () => FIXED_SESSION,
    spawnWorker() {
      return { pid: 4242 };
    },
    applySessionTitle: async (args) => {
      titleCalls.push(args);
      return true;
    },
  });
  const result = await launcher.launch(initialContract({ runtime: 'grok' }));
  assert.equal(result.pid, 4242);
  assert.equal(result.titleApplied, true);
  assert.equal(titleCalls.length, 1);
  assert.equal(titleCalls[0].sessionId, FIXED_SESSION);
  assert.equal(titleCalls[0].title, 'demo/12-real-worker-launcher');
  assert.equal(titleCalls[0].cwd, 'D:/proj');
});

test('createRealLauncher does not apply title hook for claude or resume', async () => {
  const titleCalls = [];
  const launcher = createRealLauncher({
    generateSessionId: () => FIXED_SESSION,
    spawnWorker() {
      return { pid: 1 };
    },
    applySessionTitle: async (args) => {
      titleCalls.push(args);
      return true;
    },
  });
  await launcher.launch(initialContract({ runtime: 'claude' }));
  await launcher.launch(
    buildResumeContract({
      runtime: 'grok',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: baseIssue(),
      sessionId: FIXED_SESSION,
      title: 'demo/12-real-worker-launcher',
    }),
  );
  assert.equal(titleCalls.length, 0);
});

// --- 20260805-1244 ticket 02: resume history non-blank probe ---

/** Observed blank bootstrap: system + one skills system-reminder user, no user_query. */
const BLANK_GROK_HISTORY = [
  JSON.stringify({ type: 'system', content: 'You are Grok released by xAI.' }),
  JSON.stringify({
    type: 'user',
    content: [{ type: 'text', text: '<system-reminder>\nThe following skills are available for use:\n</system-reminder>' }],
  }),
].join('\n');

/** Observed non-blank: real operator turn with /implement inside user_query. */
const NONBLANK_GROK_HISTORY = [
  JSON.stringify({ type: 'system', content: 'You are Grok released by xAI.' }),
  JSON.stringify({
    type: 'user',
    content: [{ type: 'text', text: '<system-reminder>\nskills list\n</system-reminder>' }],
  }),
  JSON.stringify({
    type: 'user',
    content: [{
      type: 'text',
      text: '<user_query>\n/implement .scratch/demo/issues/01-first.md\nHard constraints: completion requires Closed: true\n</user_query>',
    }],
  }),
].join('\n');

test('classifyGrokChatHistory marks system-reminder-only transcript as blank', async () => {
  const { classifyGrokChatHistory } = await import('../scripts/real-launcher.mjs');
  const verdict = classifyGrokChatHistory(BLANK_GROK_HISTORY);
  assert.equal(verdict.blank, true);
  assert.equal(verdict.exists, true);
  assert.ok(verdict.userCount >= 1);
  assert.equal(verdict.hasUserQuery, false);
  assert.equal(verdict.hasSkillEntry, false);
  assert.match(verdict.reason || '', /blank|bootstrap|no user_query|reminder-only/i);
});

test('classifyGrokChatHistory marks user_query /implement transcript as non-blank', async () => {
  const { classifyGrokChatHistory } = await import('../scripts/real-launcher.mjs');
  const verdict = classifyGrokChatHistory(NONBLANK_GROK_HISTORY);
  assert.equal(verdict.blank, false);
  assert.equal(verdict.exists, true);
  assert.equal(verdict.hasUserQuery, true);
  assert.equal(verdict.hasSkillEntry, true);
  assert.ok(verdict.userCount >= 2);
});

test('classifyGrokChatHistory missing or empty text is blank', async () => {
  const { classifyGrokChatHistory } = await import('../scripts/real-launcher.mjs');
  assert.equal(classifyGrokChatHistory('').blank, true);
  assert.equal(classifyGrokChatHistory(null).blank, true);
  assert.equal(classifyGrokChatHistory(undefined).exists, false);
});

test('readGrokChatHistory loads jsonl and classifies blank vs non-blank', async () => {
  const { readGrokChatHistory } = await import('../scripts/real-launcher.mjs');
  const files = new Map([
    ['blank', BLANK_GROK_HISTORY],
    ['full', NONBLANK_GROK_HISTORY],
  ]);
  const blank = await readGrokChatHistory({
    cwd: 'D:\\proj',
    sessionId: 'blank-sid',
    grokHome: 'C:\\fake-grok',
    readFile: async () => files.get('blank'),
    access: async () => {},
  });
  assert.equal(blank.blank, true);
  assert.equal(blank.exists, true);
  assert.match(blank.path || '', /chat_history\.jsonl$/);

  const full = await readGrokChatHistory({
    cwd: 'D:\\proj',
    sessionId: 'full-sid',
    grokHome: 'C:\\fake-grok',
    readFile: async () => files.get('full'),
    access: async () => {},
  });
  assert.equal(full.blank, false);
  assert.equal(full.hasSkillEntry, true);

  const missing = await readGrokChatHistory({
    cwd: 'D:\\proj',
    sessionId: 'missing-sid',
    grokHome: 'C:\\fake-grok',
    readFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    access: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(missing.exists, false);
  assert.equal(missing.blank, true);
});

test('buildResumeContract keeps empty prompt and never re-injects skill entry', () => {
  const resume = buildResumeContract({
    runtime: 'grok',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: baseIssue(),
    sessionId: FIXED_SESSION,
    mode: 'vibe',
  });
  assert.equal(resume.kind, 'resume');
  assert.equal(resume.initialPrompt, '');
  assert.equal(resume.sessionId, FIXED_SESSION);
  assert.equal(/\/implement\b/.test(resume.initialPrompt), false);
  assert.equal(/\/wayfinder\b/.test(resume.initialPrompt), false);
});

test('buildResumeContract requires sessionId', () => {
  assert.throws(
    () => buildResumeContract({
      runtime: 'grok',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: baseIssue(),
      sessionId: '',
    }),
    /sessionId/i,
  );
});

test('createRealLauncher resume attaches history probe (non-blank vs blank), not spawn alone', async () => {
  const calls = [];
  const launcher = createRealLauncher({
    spawnWorker() {
      return { pid: 8801 };
    },
    readHistory: async (args) => {
      calls.push(args);
      return {
        exists: true,
        blank: false,
        hasUserQuery: true,
        hasSkillEntry: true,
        userCount: 2,
        reason: null,
        path: 'fake/chat_history.jsonl',
      };
    },
  });

  const ok = await launcher.launch(
    buildResumeContract({
      runtime: 'grok',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: baseIssue(),
      sessionId: FIXED_SESSION,
    }),
  );
  assert.equal(ok.pid, 8801);
  assert.equal(ok.history?.blank, false);
  assert.equal(ok.history?.hasUserQuery, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, FIXED_SESSION);

  const blankLauncher = createRealLauncher({
    spawnWorker() {
      return { pid: 8802 };
    },
    readHistory: async () => ({
      exists: true,
      blank: true,
      hasUserQuery: false,
      hasSkillEntry: false,
      userCount: 1,
      reason: 'bootstrap-reminder-only',
    }),
  });
  const blank = await blankLauncher.launch(
    buildResumeContract({
      runtime: 'grok',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: baseIssue(),
      sessionId: FIXED_SESSION,
    }),
  );
  assert.equal(blank.pid, 8802, 'spawn may still succeed');
  assert.equal(blank.history?.blank, true, 'probe must still flag blank history');
  assert.match(blank.history?.reason || '', /blank|bootstrap|reminder/i);
});

test('createRealLauncher does not history-probe initial launches or claude resume by default', async () => {
  const calls = [];
  const launcher = createRealLauncher({
    generateSessionId: () => FIXED_SESSION,
    spawnWorker() {
      return { pid: 1 };
    },
    applySessionTitle: async () => true,
    readHistory: async (args) => {
      calls.push(args);
      return { exists: true, blank: false };
    },
  });
  await launcher.launch(initialContract({ runtime: 'grok' }));
  await launcher.launch(
    buildResumeContract({
      runtime: 'claude',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: baseIssue(),
      sessionId: FIXED_SESSION,
    }),
  );
  assert.equal(calls.length, 0);
});
