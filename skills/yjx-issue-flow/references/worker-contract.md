# Worker Contract

Use this contract for every issue worker. The worker is a new Codex task, not an implementation subagent of the coordinator.

## Handoff

Pass only the context needed to act, and require the worker to reread authoritative sources:

- issue identity in the project's native tracker syntax;
- the issue title, requirements, and acceptance criteria;
- the issue's explicit blockers, parents, and relevant completed dependencies;
- the selected mode, workspace policy, and concurrency context;
- project instructions and tracker instructions to reread;
- selected handler skill, if one is available;
- known worker results, verification, commits, merges, and risks from upstream issues;
- the instruction to own implementation, verification, review, merge, and issue closeout under project rules.

Do not pass the entire coordinator conversation as a substitute for the issue and project sources.

## Worker autonomy

The worker makes ordinary engineering decisions within the issue, project rules, and selected skill. It investigates missing file scope, resolves routine code conflicts, and retries normal integration races without asking the user.

Escalate only a real human gate:

- a product or domain choice with multiple plausible meanings;
- an approval, credential, external action, or other HIL step;
- an irreversible or high-risk operation;
- a project rule conflict;
- repeated failure after bounded recovery.

An HIL request blocks the issue and its downstream. It does not stop independent workers.

## Completion report

Return a concise structured report with these fields:

```text
Issue: <native tracker identity and title>
Result: completed | blocked | needs-human | failed | skipped
Handler: <skill or generic worker>
Scope: <what changed>
Acceptance:
  - <criterion>: passed | not-run | blocked
Verification:
  - <check>: passed | failed | not-run
Review: <project-required review and result>
Integration: <commit, branch, merge, or local delivery state>
Tracker: <issue state and closeout result>
Risks: <remaining risks or none>
Next action: <only when the result is not completed>
```

`Result: completed` requires the issue's own requirements, applicable verification, project review gates, integration, and tracker closeout to be complete. A report alone does not close an issue.
