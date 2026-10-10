#!/usr/bin/env node

// Browser-only session classifier for Bilibili.
//
// The browser must pass observable page signals; this module never reads
// cookies, session storage, external profiles, or HTTP clients. It exists so
// every script and audit uses the same four outcomes:
//
//   browser_logged_in_without_capability
//   browser_logged_out
//   browser_session_unverified
//   anonymous_request (produced outside this module, for non-browser requests)
//
// A missing capability is NOT a logged-out signal. Anonymous requests are NOT
// session evidence. Only browser_logged_out may trigger a user login request.

export const SESSION_STATE = {
  LOGGED_IN: 'logged_in',
  LOGGED_OUT: 'logged_out',
  UNVERIFIED: 'unverified',
};

export const SESSION_OUTCOME = {
  LOGGED_IN_WITHOUT_CAPABILITY: 'browser_logged_in_without_capability',
  LOGGED_OUT: 'browser_logged_out',
  UNVERIFIED: 'browser_session_unverified',
  ANONYMOUS_REQUEST: 'anonymous_request',
};

export const QUALITY_UNAVAILABLE_STATUS = {
  [SESSION_OUTCOME.LOGGED_IN_WITHOUT_CAPABILITY]: 'quality_unavailable_for_logged_in_user',
  [SESSION_OUTCOME.LOGGED_OUT]: 'login_required_for_quality',
  [SESSION_OUTCOME.UNVERIFIED]: 'browser_session_quality_unavailable_unverified',
};

export function classifyBilibiliSession(signals) {
  const {
    initialStateUser = null,
    playinfoUser = null,
    playerUser = null,
    hasAvatar = false,
    hasLoginEntry = false,
  } = signals ?? {};

  const candidates = [initialStateUser, playinfoUser, playerUser];
  const authenticated = candidates.find((candidate) => (
    candidate && (candidate.isLogin === true || Number(candidate.mid) > 0)
  )) ?? null;

  if (authenticated) {
    const evidence = [];
    if (authenticated.isLogin === true) evidence.push('user.isLogin=true');
    if (Number(authenticated.mid) > 0) evidence.push(`user.mid=${Number(authenticated.mid)}`);
    if (hasAvatar) evidence.push('header-avatar');
    return { state: SESSION_STATE.LOGGED_IN, evidence };
  }

  if (hasAvatar) return { state: SESSION_STATE.LOGGED_IN, evidence: ['header-avatar'] };

  const sawAnonymousFlag = candidates.some((candidate) => candidate?.isLogin === false);
  if (sawAnonymousFlag && hasLoginEntry) {
    return { state: SESSION_STATE.LOGGED_OUT, evidence: ['user.isLogin=false', 'login-entry'] };
  }
  if (hasLoginEntry) return { state: SESSION_STATE.LOGGED_OUT, evidence: ['login-entry'] };
  return { state: SESSION_STATE.UNVERIFIED, evidence: [] };
}

export function sessionOutcomeForMissingQuality(session) {
  if (session?.state === SESSION_STATE.LOGGED_IN) return SESSION_OUTCOME.LOGGED_IN_WITHOUT_CAPABILITY;
  if (session?.state === SESSION_STATE.LOGGED_OUT) return SESSION_OUTCOME.LOGGED_OUT;
  return SESSION_OUTCOME.UNVERIFIED;
}

export function qualityUnavailableStatusForOutcome(outcome) {
  return QUALITY_UNAVAILABLE_STATUS[outcome] ?? QUALITY_UNAVAILABLE_STATUS[SESSION_OUTCOME.UNVERIFIED];
}

export function nextActionForSessionOutcome(outcome) {
  switch (outcome) {
    case SESSION_OUTCOME.LOGGED_IN_WITHOUT_CAPABILITY:
      return 'Do not ask the user to sign in again. Retry the next allowed quality or record the capability limit with evidence.';
    case SESSION_OUTCOME.LOGGED_OUT:
      return 'Ask the user to sign in to Bilibili in the current Codex Browser tab, then retry the same capability check.';
    case SESSION_OUTCOME.ANONYMOUS_REQUEST:
      return 'This result has no browser cookies and cannot decide login state. Run the check inside the bound Codex Browser tab before concluding anything.';
    default:
      return 'Browser session state is unverified. Inspect the page UI or retry inside the bound Codex Browser tab; do not claim the user is logged out.';
  }
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('bilibili-session-status.mjs')) {
  console.log(JSON.stringify({
    session_state: SESSION_STATE,
    session_outcome: SESSION_OUTCOME,
    rules: nextActionForSessionOutcome(SESSION_OUTCOME.ANONYMOUS_REQUEST),
  }, null, 2));
}
