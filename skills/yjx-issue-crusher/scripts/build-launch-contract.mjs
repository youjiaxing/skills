/**
 * Build the Worker launch contract for a ready ordinary implementation issue.
 * Fake or real launchers consume this DTO; no real agent is started here.
 */

const REVIEW_CONSTRAINT =
  'Hard constraints: completion requires Closed: true in the issue header. '
  + 'Mode: review — do not auto-commit or auto-close the issue; wait for human authorization.';

const VIBE_CONSTRAINT =
  'Hard constraints: completion requires Closed: true in the issue header. '
  + 'Mode: vibe — after finishing, commit, set Closed: true, then quit when possible.';

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
 * @param {object} input
 * @param {'grok'|'claude'} input.runtime
 * @param {string} input.feature
 * @param {string} input.cwd
 * @param {{ id: string, path: string, number?: string, title?: string }} input.issue
 * @param {'review'|'vibe'} [input.mode]
 */
export function buildLaunchContract({
  runtime,
  feature,
  cwd,
  issue,
  mode,
} = {}) {
  if (!runtime) throw new Error('runtime is required');
  if (!feature) throw new Error('feature is required');
  if (!cwd) throw new Error('cwd is required');
  if (!issue?.id && !issue?.path) throw new Error('issue identity is required');

  const effectiveMode = resolveMode(mode);
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
  lines.push(`/implement ${issuePath}`);
  lines.push(effectiveMode === 'vibe' ? VIBE_CONSTRAINT : REVIEW_CONSTRAINT);

  return {
    kind: 'initial',
    runtime,
    feature,
    cwd,
    issue,
    title,
    mode: effectiveMode,
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
