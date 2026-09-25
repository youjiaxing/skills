---
name: yjx-issue-flow
description: Coordinate multiple implementation issues from a project's configured issue tracker, including dependency-aware serial or parallel execution, independent Codex workers, integration, and issue closeout. Use when the user explicitly names this skill or asks to coordinate a parent issue, child issues, or multiple implementation issues; do not use for an ordinary single-issue implementation.
---

# Yjx Issue Flow

Coordinate implementation work across one or more issue targets while leaving tracker semantics and project delivery rules with the project.

## Boundary

- This skill is the coordinator. It does not implement issue code in the coordinator session.
- Create one fresh Codex task for each issue that needs implementation. A worker may use bounded subagents for investigation or review, but it owns its issue.
- A single ordinary issue that can be completed directly is not an issue-flow case. Handle it with the project's normal implementation workflow in the current session unless the user explicitly requires a new worker.
- Do not hardcode GitHub, Local Markdown, or another tracker. Read the project's tracker instructions and use its configured capabilities.
- Do not create new issues to fill decomposition gaps. A parent worker handles its own remaining requirements.
- Wayfinder-managed issues are outside the default scope. Read [flow-rules.md](references/flow-rules.md) for the explicit-force handoff and HIL boundary.

## Start

1. Read the project instructions and the configured issue-tracker contract.
2. Resolve every user-supplied target in the project's native issue syntax. A call may contain multiple targets.
3. Expand each target recursively by default. Support an explicit exact-target or direct-children scope override. Deduplicate overlapping targets and descendants.
4. Classify each issue using project-provided type, `requiredSkill`, status, labels, and issue content. Do not invent an implementation label.
5. Separate executable implementation issues, Wayfinder-managed issues, HIL issues, terminal issues, invalid targets, and dependency blockers. Report excluded targets and continue independent targets.
6. If scope resolution leaves one directly completable ordinary issue, downgrade to the normal implementation workflow instead of creating orchestration workers.

## Dispatch

1. Respect explicit user settings for `mode: auto|serial|parallel`, `workspace: auto|local|worktree`, and `max-workers`.
2. Project rules are hard boundaries. `local` is serial-only; `parallel + local` is a parameter conflict. When workspace is `auto`, use worktrees for parallel execution only when the project permits them.
3. In `auto`, dispatch the ready frontier up to the effective worker limit. Use explicit dependency edges for ordering; do not serialize merely because files may overlap. Worktree isolation makes ordinary code conflicts an integration cost, not a preflight blocker.
4. Use the project or user worker limit when present; otherwise use a default maximum of three workers. Treat this as a requested concurrency limit, not a claim about any API quota. On observed rate limiting or task-creation failure, back off, reduce concurrency, and retry.
5. Give every worker the structured handoff in [worker-contract.md](references/worker-contract.md). Include the selected implementation skill when one is available, but fall back to a generic worker for ordinary implementation issues when it is not.

## Run

1. Workers own implementation, verification, review, commit, merge, and their issue's tracker closeout according to project rules. The coordinator owns scheduling, parent-level validation, and the final report.
2. Ordinary merge conflicts are expected. Workers update to the latest local integration baseline, resolve routine conflicts, rerun relevant checks, and retry. Do not pause the whole run for a normal conflict.
3. If a worker fails, first resume that worker. If it cannot continue, create a replacement worker with the same issue handoff. Limit retries and isolate the failed issue and its downstream; independent work continues.
4. Use event-driven or long-interval waiting for worker tasks. React to meaningful state changes; do not poll every worker on a short fixed interval.
5. Before each new batch and before parent or target closeout, reread the tracker and recompute the frontier. Tracker, Git, and worker task state are the sources of truth; do not write an orchestration manifest into the project repository.

## Finish

1. Require each issue's own requirements and acceptance criteria to be satisfied. Child completion is evidence for a parent, not a substitute for parent acceptance.
2. If a parent issue has independent requirements, create its parent worker only after all in-scope child issues complete. A pure aggregate parent needs parent-level validation, not a pointless worker.
3. Let the worker update its own issue. The coordinator manages parent and overall run state. Follow the project's lifecycle and closeout rules; never invent labels or closure semantics.
4. Treat a previously resolved issue as complete by default. Perform targeted verification only when the current run exposes a concrete problem, such as a failed dependent check or an unmet parent criterion.
5. A multi-target run may finish partially. Report completed, blocked, skipped, invalid, and user-action-required targets separately. On resume, process only incomplete or affected targets.
6. Report only meaningful state changes while running. At the end, return the structured per-issue results, commits or merges, verification, tracker state, blockers, and remaining risks.

Read [flow-rules.md](references/flow-rules.md) when classifying targets, resolving scope, choosing a mode, handling HIL or Wayfinder issues, or recovering a blocked run. Read [worker-contract.md](references/worker-contract.md) before creating or replacing a worker.
