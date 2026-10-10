import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_OUTCOME,
  SESSION_STATE,
  classifyBilibiliSession,
  nextActionForSessionOutcome,
  qualityUnavailableStatusForOutcome,
  sessionOutcomeForMissingQuality,
} from '../scripts/bilibili-session-status.mjs';

test('classifies authenticated page evidence as logged in', () => {
  const session = classifyBilibiliSession({
    initialStateUser: { isLogin: true, mid: 42 },
  });

  assert.equal(session.state, SESSION_STATE.LOGGED_IN);
  assert.deepEqual(session.evidence, ['user.isLogin=true', 'user.mid=42']);
});

test('classifies an authenticated player user even when initial state is anonymous', () => {
  const session = classifyBilibiliSession({
    initialStateUser: { isLogin: false },
    playerUser: { isLogin: true, mid: 42 },
  });

  assert.equal(session.state, SESSION_STATE.LOGGED_IN);
});

test('classifies explicit anonymous page evidence as logged out', () => {
  const session = classifyBilibiliSession({
    initialStateUser: { isLogin: false },
    hasLoginEntry: true,
  });

  assert.equal(session.state, SESSION_STATE.LOGGED_OUT);
  assert.deepEqual(session.evidence, ['user.isLogin=false', 'login-entry']);
});

test('does not turn missing page evidence into a logged-out claim', () => {
  const session = classifyBilibiliSession({});

  assert.equal(session.state, SESSION_STATE.UNVERIFIED);
  assert.deepEqual(session.evidence, []);
});

test('maps a missing browser capability to the matching outcome and status', () => {
  const cases = [
    [SESSION_STATE.LOGGED_IN, 'browser_logged_in_without_capability', 'quality_unavailable_for_logged_in_user'],
    [SESSION_STATE.LOGGED_OUT, 'browser_logged_out', 'login_required_for_quality'],
    [SESSION_STATE.UNVERIFIED, 'browser_session_unverified', 'browser_session_quality_unavailable_unverified'],
  ];

  for (const [state, expectedOutcome, expectedStatus] of cases) {
    const outcome = sessionOutcomeForMissingQuality({ state });
    assert.equal(outcome, expectedOutcome);
    assert.equal(qualityUnavailableStatusForOutcome(outcome), expectedStatus);
    assert.ok(nextActionForSessionOutcome(outcome).length > 0);
  }
});

test('anonymous requests can never trigger a login request', () => {
  const action = nextActionForSessionOutcome(SESSION_OUTCOME.ANONYMOUS_REQUEST);

  assert.match(action, /cannot decide login state/i);
  assert.doesNotMatch(action, /^Ask the user/);
});
