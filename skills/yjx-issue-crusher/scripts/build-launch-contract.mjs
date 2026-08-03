/**
 * Build the Worker launch contract for an issue (impl / wayfinder / human / unknown).
 * Fake or real launchers consume this DTO; no real agent is started here.
 */

import { classifyEntryClass } from './select-candidates.mjs';

const REVIEW_CONSTRAINT =
  'Hard constraints: completion requires Closed: true in the issue header. '
  + 'Mode: review -- do not auto-commit or auto-close the issue; wait for human authorization.';

const VIBE_CONSTRAINT =
  'Hard constraints: completion requires Closed: true in the issue header. '
  + 'Mode: vibe -- after finishing, commit, set Closed: true, then quit when possible.';

const WAYFINDER_REVIEW_CONSTRAINT =
  'Hard constraints: Wayfinder completion is Status: resolved (not impl Closed alone). '
  + 'Mode: review -- do not auto-commit or auto-close the issue; wait for human authorization.';

const WAYFINDER_VIBE_CONSTRAINT =
  'Hard constraints: Wayfinder completion is Status: resolved (not impl Closed alone). '
  + 'Mode: vibe -- after finishing, commit when appropriate, set Status: resolved, then quit when possible.';

const NEUTRAL_REVIEW_CONSTRAINT =
  'Hard constraints: do not auto-commit or auto-close; confirm completion rules with the human. '
  + 'Mode: review -- wait for human authorization before commit or close.';

const NEUTRAL_VIBE_CONSTRAINT =
  'Hard constraints: confirm completion rules with the human before writing any close field. '
  + 'Mode: vibe -- after finishing, commit when appropriate only if the human already authorized close.';

/**
 * Session title: <feature>/<NN>-<slug> from the issue filename (not body H1).
 */
export function buildSessionTitle(feature, issue) {
  if (!feature) throw new Error('feature is required for session title');
  if (!issue) throw new Error('issue is required for session title');
  const raw = issue.id || issue.path || '';
  const base = String(raw).split(/[/\\]/).pop() || '';
  const stem = base.replace(/\.md$/i, '');
  if (!stem) throw new Error('cannot derive title slug from issue identity');
  return `${feature}/${stem}`;
}

/**
 * Normalize mode: hard default is review unless the chain resolved vibe.
 */
export function resolveMode(mode) {
  return mode === 'vibe' ? 'vibe' : 'review';
}

/**
 * Resolve launch entry class from explicit override and/or issue fields.
 * Single source of classification lives in select-candidates.classifyEntryClass.
 */
export function resolveEntryClass(entryClass, issue = {}) {
  if (
    entryClass === 'impl'
    || entryClass === 'wayfinder'
    || entryClass === 'human'
    || entryClass === 'unknown'
  ) {
    return entryClass;
  }
  const classified = classifyEntryClass(issue);
  // Bare auto-path candidates historically omit entryClass/type/workflow; treat as impl.
  if (
    classified === 'unknown'
    && !issue.entryClass
    && !issue.type
    && issue.workflow !== 'wayfinder'
    && (issue.statusRole == null || issue.statusRole === '' || issue.statusRole === 'ready-for-agent')
  ) {
    return 'impl';
  }
  return classified;
}

function modeConstraintLine(entryClass, effectiveMode) {
  if (entryClass === 'wayfinder') {
    return effectiveMode === 'vibe' ? WAYFINDER_VIBE_CONSTRAINT : WAYFINDER_REVIEW_CONSTRAINT;
  }
  if (entryClass === 'human' || entryClass === 'unknown') {
    return effectiveMode === 'vibe' ? NEUTRAL_VIBE_CONSTRAINT : NEUTRAL_REVIEW_CONSTRAINT;
  }
  return effectiveMode === 'vibe' ? VIBE_CONSTRAINT : REVIEW_CONSTRAINT;
}

function entryLines(entryClass, issuePath) {
  if (entryClass === 'wayfinder') {
    return [`/wayfinder ${issuePath}`];
  }
  if (entryClass === 'impl') {
    return [`/implement ${issuePath}`];
  }
  // human / unknown: neutral open-path convention — no concrete skill slash.
  return [
    `Open the issue at \`${issuePath}\` and confirm the next step with the human (no skill preselected).`,
  ];
}

/**
 * @param {object} input
 * @param {'grok'|'claude'} input.runtime
 * @param {string} input.feature
 * @param {string} input.cwd
 * @param {{ id: string, path: string, number?: string, title?: string, entryClass?: string, type?: string, workflow?: string, statusRole?: string }} input.issue
 * @param {'review'|'vibe'} [input.mode]
 * @param {'impl'|'wayfinder'|'human'|'unknown'} [input.entryClass]
 */
export function buildLaunchContract({
  runtime,
  feature,
  cwd,
  issue,
  mode,
  entryClass,
} = {}) {
  if (!runtime) throw new Error('runtime is required');
  if (!feature) throw new Error('feature is required');
  if (!cwd) throw new Error('cwd is required');
  if (!issue?.id && !issue?.path) throw new Error('issue identity is required');

  const effectiveMode = resolveMode(mode);
  const resolvedEntry = resolveEntryClass(entryClass, issue);
  const title = buildSessionTitle(feature, issue);
  const issuePath = issue.path || `.scratch/${feature}/issues/${issue.id}`;
  const lines = [];

  // Grok has no -n; first-line /rename is the title obligation.
  // Claude uses structured title for -n; prompt need not repeat /rename.
  if (runtime === 'grok') {
    lines.push(`/rename ${title}`);
  }

  lines.push(
    `Scope is limited to the issue at \`${issuePath}\` (path reference only; do not paste full issue text).`,
  );
  lines.push(...entryLines(resolvedEntry, issuePath));
  lines.push(modeConstraintLine(resolvedEntry, effectiveMode));

  return {
    kind: 'initial',
    runtime,
    feature,
    cwd,
    issue,
    title,
    mode: effectiveMode,
    entryClass: resolvedEntry,
    initialPrompt: lines.join('\n'),
  };
}

/**
 * Resume an existing worker session after needs-resume.
 * Carries recorded session id + original runtime/cwd; does NOT re-inject
 * /implement or /wayfinder ticket skill entries.
 */
export function buildResumeContract({
  runtime,
  feature,
  cwd,
  issue,
  title,
  sessionId,
  mode,
} = {}) {
  if (!runtime) throw new Error('runtime is required');
  if (!feature) throw new Error('feature is required');
  if (!cwd) throw new Error('cwd is required');
  if (!issue?.id && !issue?.path) throw new Error('issue identity is required');
  if (!sessionId) throw new Error('sessionId is required for resume');

  const effectiveMode = resolveMode(mode);
  const resolvedTitle = title || buildSessionTitle(feature, issue);

  return {
    kind: 'resume',
    runtime,
    feature,
    cwd,
    issue,
    title: resolvedTitle,
    sessionId,
    mode: effectiveMode,
    // Empty / neutral prompt: continue the existing session, no fresh skill entry.
    initialPrompt: '',
  };
}
