/**
 * Auto-relay candidate contract, aligned with yjx-local-ralph select-issue:
 * ordinary implementation ready-for-agent only (Wayfinder has no statusRole).
 */

function compareIssueNumbers(left, right) {
  const leftNumber = Number.parseInt(left.number, 10);
  const rightNumber = Number.parseInt(right.number, 10);
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left.id.localeCompare(right.id);
}

export function selectAutoCandidates(payload) {
  if (!payload || !Array.isArray(payload.issues)) {
    throw new Error('invalid tracker payload: issues must be an array');
  }
  return payload.issues
    .filter((issue) =>
      issue.closed === false
      && issue.statusRole === 'ready-for-agent'
      && issue.metadataValid === true
      && Array.isArray(issue.blockedByOpen) && issue.blockedByOpen.length === 0
      && Array.isArray(issue.blockedByMissing) && issue.blockedByMissing.length === 0
      && Array.isArray(issue.blockedByInvalid) && issue.blockedByInvalid.length === 0
      && Array.isArray(issue.dependencyCycle) && issue.dependencyCycle.length === 0)
    .sort(compareIssueNumbers);
}

export function toCandidate(issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    path: issue.path,
  };
}
