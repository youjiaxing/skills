/**
 * 20260805-1244 ticket 04 — automated acceptance path.
 *
 * Covers the feature contract end-to-end at the Chain Run / launcher seams
 * (no real Grok/Claude window). Stages and failure codes are stable so a
 * red run can distinguish: not-closed / no-exit / resume-blank / wrong-kill.
 *
 * Run (skills monorepo root):
 *   node --test skills/yjx-issue-crusher/tests/vibe-handoff-acceptance.test.mjs
 * Full skill suite:
 *   node --test skills/yjx-issue-crusher/tests/*.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResumeContract } from '../scripts/build-launch-contract.mjs';
import { createChainRun } from '../scripts/chain-run.mjs';
import { createFakeLauncher } from '../scripts/fake-launcher.mjs';
import { createFakeTracker } from '../scripts/fake-tracker.mjs';
import {
  classifyGrokChatHistory,
  createRealLauncher,
} from '../scripts/real-launcher.mjs';

/** Stable stage ids — greppable in CI / agent logs. */
export const STAGE = {
  /** 20260806-1636/01: no kill + no auto without session end signal */
  HANDOFF: 'A-closed-no-kill-no-auto-without-end',
  RESUME: 'B-resume-nonblank',
  NO_MISKILL: 'C-not-closed-no-kill',
};

/**
 * Failure codes required by ticket 04:
 * - not-closed   没关票（闸门未过就推进/杀）
 * - no-exit      没退出（该收尾的旧进程仍活，或该活的被当成已退）
 * - resume-blank resume 历史空白
 * - wrong-kill   误关（未 Closed 却杀 / 杀了非本槽）
 * plus helpers for spawn / reinject regressions.
 */
export const FAIL = {
  NOT_CLOSED: 'not-closed',
  NO_EXIT: 'no-exit',
  RESUME_BLANK: 'resume-blank',
  WRONG_KILL: 'wrong-kill',
  NO_NEXT: 'no-next',
  REINJECT: 'reinject',
  BAD_STATUS: 'bad-status',
};

function candidate(id, overrides = {}) {
  const number = id.split('-')[0];
  return {
    id,
    number,
    title: overrides.title ?? id.replace(/\.md$/, ''),
    path: overrides.path ?? `.scratch/demo/issues/${id}`,
    ...overrides,
  };
}

function makeChain(overrides = {}) {
  const {
    candidates = [],
    completions = {},
    launcherOptions = {},
    ...chainOptions
  } = overrides;
  const tracker = createFakeTracker({ candidates, completions });
  const launcher = createFakeLauncher(launcherOptions);
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
    // Stage A: no-kill + no auto without session end; countdown dual-gate
    // covered in chain-run unit tests (injectable clock + reportSessionEnded).
    handoffCountdownMs: 0,
    ...chainOptions,
  });
  return { tracker, launcher, chain };
}

/**
 * Assert with stage + failure code + structured evidence.
 * On red, message is greppable: [acceptance <stage>/<code>]
 */
function assertStage(ok, stage, code, evidence, message) {
  if (ok) return;
  const payload = {
    feature: '20260805-1244-vibe-handoff-and-resume',
    stage,
    code,
    ...evidence,
  };
  const err = new Error(
    `[acceptance ${stage}/${code}] ${message}\n${JSON.stringify(payload, null, 2)}`,
  );
  err.acceptance = payload;
  throw err;
}

/** Observed blank bootstrap: system + skills system-reminder only. */
const BLANK_GROK_HISTORY = [
  JSON.stringify({ type: 'system', content: 'You are Grok released by xAI.' }),
  JSON.stringify({
    type: 'user',
    content: [{
      type: 'text',
      text: '<system-reminder>\nThe following skills are available for use:\n</system-reminder>',
    }],
  }),
].join('\n');

/** Non-blank: real operator turn with /implement inside user_query. */
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
      text: '<user_query>\n/implement .scratch/demo/issues/01-first.md\n</user_query>',
    }],
  }),
].join('\n');

// --- Stage A: Closed → never kill; without session end → no auto next ---

test('acceptance A: Closed never kills; natural exit without session end does not auto-next', async () => {
  const stage = STAGE.HANDOFF;
  const first = candidate('01-first.md');
  const second = candidate('02-second.md');
  const { tracker, launcher, chain } = makeChain({
    candidates: [first, second],
    autoAdvance: true,
  });

  await chain.step();
  const oldPid = chain.slot?.pid;
  assertStage(
    oldPid != null,
    stage,
    FAIL.NO_EXIT,
    { slot: chain.slot, launches: launcher.launches.length },
    'first spawn must occupy the slot',
  );

  // Before Closed: must not look like handoff succeeded.
  assertStage(
    (await tracker.getCompletion('01-first.md')).closed === false,
    stage,
    FAIL.NOT_CLOSED,
    { closed: false },
    'fixture setup: first ticket must start open',
  );

  tracker.setCompletion('01-first.md', true);
  const closed = (await tracker.getCompletion('01-first.md')).closed;
  assertStage(
    closed === true,
    stage,
    FAIL.NOT_CLOSED,
    { closed, issueId: '01-first.md' },
    '没关票: Closed gate must be true before handoff',
  );

  assertStage(
    launcher.isAlive(oldPid) === true,
    stage,
    FAIL.NO_EXIT,
    { oldPid, alive: launcher.isAlive(oldPid) },
    'vibe hang case: worker still alive after Closed',
  );

  // Closed alone must NOT kill or open next.
  const waiting = await chain.step();
  assertStage(
    waiting.spawned === false
      && waiting.reason === 'awaiting-worker-exit'
      && launcher.isAlive(oldPid) === true
      && launcher.kills.length === 0,
    stage,
    FAIL.WRONG_KILL,
    {
      spawned: waiting.spawned,
      reason: waiting.reason,
      kills: [...launcher.kills],
      oldAlive: launcher.isAlive(oldPid),
    },
    'Closed alone must never kill a live worker or open next',
  );

  // Natural exit without session end signal: still no auto next (honest degradation).
  launcher.markExited(oldPid);
  const result = await chain.step();

  assertStage(
    result.spawned === false
      && result.reason === 'awaiting-session-end'
      && launcher.launches.length === 1
      && chain.slot?.issue?.id === '01-first.md',
    stage,
    FAIL.NO_NEXT,
    {
      spawned: result.spawned,
      reason: result.reason,
      status: chain.status,
      launches: launcher.launches.map((l) => l.issue?.id),
      kills: [...launcher.kills],
      oldAlive: launcher.isAlive(oldPid),
      slotIssue: chain.slot?.issue?.id,
    },
    'Closed ∧ natural exit without session end must NOT auto-spawn next',
  );

  assertStage(
    launcher.kills.length === 0,
    stage,
    FAIL.WRONG_KILL,
    { kills: [...launcher.kills], oldPid },
    'auto path must never kill; natural exit only',
  );
});

// --- Stage B: needs-resume r → non-blank history, no reinject ---

test('acceptance B: needs-resume r restores non-blank history (not next ticket)', async () => {
  const stage = STAGE.RESUME;
  const only = candidate('01-first.md');
  const tracker = createFakeTracker({ candidates: [only] });
  const base = createFakeLauncher({ sessionId: 'sess-accept-b', pid: 9000 });
  const launcher = {
    ...base,
    async launch(request) {
      const result = await base.launch(request);
      if (request?.kind === 'resume') {
        // Simulate real-launcher history probe attached on resume.
        result.history = classifyGrokChatHistory(NONBLANK_GROK_HISTORY);
      }
      return result;
    },
  };
  const chain = createChainRun({
    tracker,
    launcher,
    feature: 'demo',
    cwd: '/tmp/project',
    runtime: 'grok',
  });

  await chain.step();
  assertStage(
    chain.slot?.sessionId === 'sess-accept-b',
    stage,
    FAIL.BAD_STATUS,
    { sessionId: chain.slot?.sessionId },
    'session id must be recorded for needs-resume',
  );

  // Force-close unfinished worker (not Closed).
  launcher.markExited(chain.slot.pid);
  await chain.step();
  assertStage(
    chain.status === 'needs-resume',
    stage,
    FAIL.BAD_STATUS,
    {
      status: chain.status,
      closed: (await tracker.getCompletion('01-first.md')).closed,
      alive: launcher.isAlive(chain.slot?.pid),
    },
    'unfinished dead worker must enter needs-resume (not handoff-next)',
  );

  const closed = (await tracker.getCompletion('01-first.md')).closed;
  assertStage(
    closed === false,
    stage,
    FAIL.NOT_CLOSED,
    { closed },
    'resume path is for unfinished tickets; must still be not Closed',
  );

  const resumed = await chain.resume();
  assertStage(
    resumed.ok === true,
    stage,
    FAIL.BAD_STATUS,
    { resumed, launches: launcher.launches.length },
    'r must succeed when session id is present',
  );

  const resumeLaunch = launcher.launches[1];
  assertStage(
    resumeLaunch?.kind === 'resume',
    stage,
    FAIL.BAD_STATUS,
    { kind: resumeLaunch?.kind, launch: resumeLaunch },
    'second launch must be kind=resume',
  );

  assertStage(
    resumeLaunch?.sessionId === 'sess-accept-b',
    stage,
    FAIL.BAD_STATUS,
    { sessionId: resumeLaunch?.sessionId },
    'resume must hang the same session id',
  );

  // Not open-next: still same issue, empty skill entry.
  assertStage(
    resumeLaunch?.issue?.id === '01-first.md',
    stage,
    FAIL.NO_NEXT,
    { issueId: resumeLaunch?.issue?.id },
    'r is not open-next; must stay on the same unfinished ticket',
  );

  assertStage(
    resumeLaunch?.initialPrompt === ''
      && !/\/implement\b/.test(String(resumeLaunch?.initialPrompt || ''))
      && !/\/wayfinder\b/.test(String(resumeLaunch?.initialPrompt || '')),
    stage,
    FAIL.REINJECT,
    { initialPrompt: resumeLaunch?.initialPrompt },
    'resume must not reinject /implement or /wayfinder',
  );

  // chain.resume forwards launcher result.history when present.
  const attached = resumed.history;
  assertStage(
    attached != null
      && attached.blank === false
      && attached.hasUserQuery === true,
    stage,
    FAIL.RESUME_BLANK,
    { history: attached, resumedOk: resumed.ok },
    'resume 空白: history probe must be non-blank with real user_query',
  );

  // Classifier: blank bootstrap must classify blank (probe can go red).
  const blankVerdict = classifyGrokChatHistory(BLANK_GROK_HISTORY);
  assertStage(
    blankVerdict.blank === true && blankVerdict.hasUserQuery !== true,
    stage,
    FAIL.RESUME_BLANK,
    { blankVerdict },
    'blank bootstrap transcript must classify as blank (probe can go red)',
  );

  // Real launcher: non-blank probe attached; spawn alone is not success proof.
  const probeCalls = [];
  const real = createRealLauncher({
    spawnWorker() {
      return { pid: 9101 };
    },
    readHistory: async (args) => {
      probeCalls.push(args);
      return {
        exists: true,
        blank: false,
        hasUserQuery: true,
        hasSkillEntry: true,
        userCount: 2,
        reason: null,
      };
    },
  });
  const realResume = await real.launch(
    buildResumeContract({
      runtime: 'grok',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: {
        id: '01-first.md',
        number: '01',
        title: 'first',
        path: '.scratch/demo/issues/01-first.md',
      },
      sessionId: 'sess-accept-b',
    }),
  );
  assertStage(
    realResume.history?.blank === false,
    stage,
    FAIL.RESUME_BLANK,
    { history: realResume.history, probeCalls },
    'real launcher resume must attach non-blank history probe (not spawn alone)',
  );
  assertStage(
    probeCalls.length === 1 && probeCalls[0].sessionId === 'sess-accept-b',
    stage,
    FAIL.BAD_STATUS,
    { probeCalls },
    'history probe must run against the resumed session id',
  );

  // Red path: spawn may succeed while history is blank — acceptance must flag it.
  const blankReal = createRealLauncher({
    spawnWorker() {
      return { pid: 9102 };
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
  const blankResume = await blankReal.launch(
    buildResumeContract({
      runtime: 'grok',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: {
        id: '01-first.md',
        number: '01',
        title: 'first',
        path: '.scratch/demo/issues/01-first.md',
      },
      sessionId: 'sess-accept-blank',
    }),
  );
  assertStage(
    blankResume.pid === 9102,
    stage,
    FAIL.NO_EXIT,
    { pid: blankResume.pid },
    'blank history path may still spawn a worker process',
  );
  assertStage(
    blankResume.history?.blank === true,
    stage,
    FAIL.RESUME_BLANK,
    { history: blankResume.history, pid: blankResume.pid },
    'resume 空白: spawn success must not hide blank history (acceptance red signal)',
  );
});

// --- Stage C: not Closed → never kill ---

test('acceptance C: not Closed never kills (autoAdvance on or off)', async () => {
  const stage = STAGE.NO_MISKILL;

  // C1: soft-stuck + auto on
  {
    const first = candidate('01-first.md');
    const second = candidate('02-second.md');
    const { tracker, launcher, chain } = makeChain({
      candidates: [first, second],
      autoAdvance: true,
    });

    await chain.step();
    const pid = chain.slot.pid;
    const closed = (await tracker.getCompletion('01-first.md')).closed;
    assertStage(
      closed === false,
      stage,
      FAIL.NOT_CLOSED,
      { closed },
      'fixture: ticket must be open for mis-kill sampling',
    );

    const result = await chain.step();
    assertStage(
      result.spawned === false && result.reason === 'soft-stuck',
      stage,
      FAIL.BAD_STATUS,
      { result, status: chain.status },
      'open live worker must stay soft-stuck',
    );
    assertStage(
      launcher.isAlive(pid) === true && launcher.kills.length === 0,
      stage,
      FAIL.WRONG_KILL,
      {
        pid,
        alive: launcher.isAlive(pid),
        kills: [...launcher.kills],
        closed,
        autoAdvance: chain.autoAdvance,
      },
      '误关: not Closed must never kill the worker (auto on)',
    );
    assertStage(
      launcher.launches.length === 1,
      stage,
      FAIL.NO_NEXT,
      { launches: launcher.launches.length },
      'not Closed must not open next',
    );
  }

  // C2: forceAdvance while not Closed
  {
    const first = candidate('01-first.md');
    const second = candidate('02-second.md');
    const { launcher, chain } = makeChain({
      candidates: [first, second],
      autoAdvance: true,
    });

    await chain.step();
    const pid = chain.slot.pid;
    const forced = await chain.forceAdvance();
    assertStage(
      forced.ok === false,
      stage,
      FAIL.NOT_CLOSED,
      { forced, kills: [...launcher.kills] },
      '没关票: force-advance must refuse when not Closed',
    );
    assertStage(
      launcher.isAlive(pid) === true && launcher.kills.length === 0,
      stage,
      FAIL.WRONG_KILL,
      { pid, kills: [...launcher.kills] },
      '误关: refused force-advance must not kill',
    );
  }

  // C3: auto off + still not Closed — must not invent a kill either.
  {
    const first = candidate('01-open.md');
    const { launcher, chain } = makeChain({
      candidates: [first],
      autoAdvance: false,
    });
    await chain.startIssue('01-open.md');
    if (chain.autoAdvance) chain.toggleAutoAdvance();
    const pid = chain.slot.pid;
    const result = await chain.step();
    assertStage(
      launcher.isAlive(pid) === true && launcher.kills.length === 0,
      stage,
      FAIL.WRONG_KILL,
      {
        pid,
        kills: [...launcher.kills],
        autoAdvance: chain.autoAdvance,
        reason: result.reason,
      },
      '误关: auto off + not Closed must not kill',
    );
  }
});

// --- Bundle marker: stable failure codes used in stage evidence ---

test('acceptance bundle: stages A+B+C failure codes are documented', () => {
  assert.deepEqual(Object.values(STAGE).sort(), [
    'A-closed-no-kill-no-auto-without-end',
    'B-resume-nonblank',
    'C-not-closed-no-kill',
  ].sort());
  for (const code of ['not-closed', 'no-exit', 'resume-blank', 'wrong-kill']) {
    assert.ok(Object.values(FAIL).includes(code), `missing failure code ${code}`);
  }
});
