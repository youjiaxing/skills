/**
 * Auto-relay candidate contract, aligned with yjx-local-ralph select-issue:
 * ordinary implementation ready-for-agent only (Wayfinder has no statusRole).
 *
 * HITL list: wayfinder / non-ready triage / unknown.
 * Wayfinder is Enter-startable (not auto); human/unknown still ask before spawn.
 */

function compareIssueNumbers(left, right) {
  const leftNumber = Number.parseInt(left.number, 10);
  const rightNumber = Number.parseInt(right.number, 10);
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left.id.localeCompare(right.id);
}

function isUnblocked(issue) {
  return Array.isArray(issue.blockedByOpen) && issue.blockedByOpen.length === 0
    && Array.isArray(issue.blockedByMissing) && issue.blockedByMissing.length === 0
    && Array.isArray(issue.blockedByInvalid) && issue.blockedByInvalid.length === 0
    && Array.isArray(issue.dependencyCycle) && issue.dependencyCycle.length === 0;
}

function isAutoEligible(issue) {
  return issue.closed === false
    && issue.statusRole === 'ready-for-agent'
    && issue.metadataValid === true
    && isUnblocked(issue)
    // Wayfinder tickets never auto-relay (Type / workflow), even if statusRole looks ready.
    && issue.workflow !== 'wayfinder'
    && !issue.type;
}

/**
 * Classify launch entry for a ticket.
 * @returns {'impl'|'wayfinder'|'human'|'unknown'}
 */
export function classifyEntryClass(issue) {
  if (!issue) return 'unknown';
  if (issue.entryClass === 'impl'
    || issue.entryClass === 'wayfinder'
    || issue.entryClass === 'human'
    || issue.entryClass === 'unknown') {
    return issue.entryClass;
  }
  if (issue.workflow === 'wayfinder' || (issue.type && String(issue.type).trim() !== '')) {
    return 'wayfinder';
  }
  if (issue.statusRole === 'ready-for-agent') return 'impl';
  if (
    issue.statusRole === 'ready-for-human'
    || issue.statusRole === 'needs-info'
    || issue.statusRole === 'needs-triage'
  ) {
    return 'human';
  }
  return 'unknown';
}

export function selectAutoCandidates(payload) {
  if (!payload || !Array.isArray(payload.issues)) {
    throw new Error('invalid tracker payload: issues must be an array');
  }
  return payload.issues
    .filter(isAutoEligible)
    .sort(compareIssueNumbers);
}

/**
 * HITL frontier: open + unblocked tickets that are NOT auto-ready impl.
 * Wayfinder, non-ready triage, and unclassifiable tickets only.
 * Blocked ready-for-agent stays out (waiting on blockers, not a human ask).
 */
export function selectHitlCandidates(payload) {
  if (!payload || !Array.isArray(payload.issues)) {
    throw new Error('invalid tracker payload: issues must be an array');
  }
  return payload.issues
    .filter((issue) => {
      if (issue.closed === true) return false;
      if (isAutoEligible(issue)) return false;
      if (!isUnblocked(issue)) return false;
      const entryClass = classifyEntryClass(issue);
      return entryClass === 'wayfinder'
        || entryClass === 'human'
        || entryClass === 'unknown';
    })
    .sort(compareIssueNumbers);
}

export function toCandidate(issue) {
  const entryClass = classifyEntryClass(issue);
  const candidate = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    path: issue.path,
    entryClass,
  };
  if (issue.type) candidate.type = issue.type;
  if (issue.statusRole) candidate.statusRole = issue.statusRole;
  if (issue.workflow) candidate.workflow = issue.workflow;
  return candidate;
}
