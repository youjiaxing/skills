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

/** Soft upper bound on session title length (Unicode scalar values / JS code points). */
export const SESSION_TITLE_MAX = 120;

/**
 * Truncate a session title without cutting `feature/` or `NN-` prefixes.
 * Only the title-slug tail is trimmed; trailing `-` after cut is stripped.
 * If the protected prefix alone fills the budget, allow `feature/NN` with empty slug.
 */
export function truncateSessionTitle(title, max = SESSION_TITLE_MAX) {
  const text = String(title ?? '');
  const chars = Array.from(text);
  if (chars.length <= max) return text;

  const slash = text.indexOf('/');
  if (slash < 0) {
    return chars.slice(0, max).join('').replace(/-+$/u, '');
  }

  const featurePrefix = text.slice(0, slash + 1); // includes trailing '/'
  const after = text.slice(slash + 1);
  const match = after.match(/^(\d+)(?:-(.*))?$/u);
  if (!match) {
    const room = max - Array.from(featurePrefix).length;
    if (room <= 0) return Array.from(featurePrefix).slice(0, max).join('');
    return featurePrefix + Array.from(after).slice(0, room).join('').replace(/-+$/u, '');
  }

  const nn = match[1];
  const slug = match[2] ?? '';
  const protectedPrefix = `${featurePrefix}${nn}-`;
  const protectedChars = Array.from(protectedPrefix);
  if (protectedChars.length >= max) {
    const bare = `${featurePrefix}${nn}`;
    const bareChars = Array.from(bare);
    if (bareChars.length <= max) return bare;
    return bareChars.slice(0, max).join('');
  }

  const room = max - protectedChars.length;
  const cutSlug = Array.from(slug).slice(0, room).join('').replace(/-+$/u, '');
  return protectedPrefix + cutSlug;
}

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
  return truncateSessionTitle(`${feature}/${stem}`);
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
 * Normalize optional model/effort: empty string → null (omit flag; runtime product default).
 */
export function normalizeOptionalFlag(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalize worker morph: interactive (default) | observable (AFK end-events).
 * @param {unknown} morph
 * @returns {'interactive'|'observable'}
 */
export function resolveMorph(morph) {
  return morph === 'observable' ? 'observable' : 'interactive';
}

/**
 * @param {object} input
 * @param {'grok'|'claude'} input.runtime
 * @param {string} input.feature
 * @param {string} input.cwd
 * @param {{ id: string, path: string, number?: string, title?: string, entryClass?: string, type?: string, workflow?: string, statusRole?: string }} input.issue
 * @param {'review'|'vibe'} [input.mode]
 * @param {'impl'|'wayfinder'|'human'|'unknown'} [input.entryClass]
 * @param {'interactive'|'observable'} [input.morph] default interactive
 * @param {string|null} [input.model] omitted → runtime product default (no CLI flag)
 * @param {string|null} [input.effort] omitted → runtime product default (no CLI flag)
 */
export function buildLaunchContract({
  runtime,
  feature,
  cwd,
  issue,
  mode,
  entryClass,
  morph,
  model = null,
  effort = null,
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

  // Lead with the skill slash (or neutral open path). Do NOT:
  // - put `/rename` in the prompt (Grok treats leading /rename as a dead
  //   bootstrap; embedded /rename is plain text and does not set the title);
  // - inject "Scope is limited..." style guardrails (operator preference /
  //   they also become the auto-generated session title noise).
  // Grok session title is applied out-of-band by the real launcher (summary.json).
  // Claude title is the -n flag on argv.
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
    morph: resolveMorph(morph),
    model: normalizeOptionalFlag(model),
    effort: normalizeOptionalFlag(effort),
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
  model = null,
  effort = null,
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
    // Resume is always human-intervenable foreground (never AFK morph).
    morph: 'interactive',
    model: normalizeOptionalFlag(model),
    effort: normalizeOptionalFlag(effort),
    // Empty / neutral prompt: continue the existing session, no fresh skill entry.
    initialPrompt: '',
  };
}
