# Flow Rules

## Tracker and target scope

The project owns issue-tracker behavior. Read its tracker documentation, configured skills, and scripts before querying or writing issues. Use the tracker-native issue identity supplied by the user. If a target cannot be resolved, report it and continue valid independent targets; do not guess a tracker or silently drop it.

Default scope is the full descendant tree of each target. The user may request exact targets or direct children. Overlapping targets are one work item, not duplicate workers.

Parent-child edges define scope. Explicit blocking edges define execution order. A parent worker is a special final stage: when a parent has its own requirements, wait for all in-scope child issues to complete before creating that worker.

## Classification

Project-provided type and `requiredSkill` information outrank generic labels. Common work labels describe content, not automatic execution permission. Do not add an implementation label merely to make a ticket eligible.

Default behavior:

- `ready-for-agent` is a useful automatic-entry signal when the project defines it.
- A direct user target may override ordinary triage state after a warning.
- `ready-for-human`, `needs-info`, `needs-triage`, and terminal states such as `wontfix`, `invalid`, or `duplicate` require a warning before forced execution.
- Conflicting labels are a local issue blocker. Do not guess which one wins.
- A user force applies only to the named issue, not its descendants.

## Wayfinder boundary

Issues managed by Wayfinder, including `wayfinder:map`, `wayfinder:research`, `wayfinder:grilling`, `wayfinder:prototype`, and `wayfinder:task`, are excluded by default. Tell the user which targets were excluded and that `yjx-wayfinder` or `wayfinder` owns them.

If the user explicitly forces a Wayfinder target into the run, hand it to the corresponding Wayfinder workflow. `yjx-issue-flow` does not implement or reinterpret the Wayfinder ticket. `grilling` and `prototype` remain HIL even when forced: the worker may reach the human gate, but it cannot invent the human response or close the ticket.

## Handler selection

Select a handler in this order:

1. Project or issue `requiredSkill`;
2. A skill explicitly named by the user;
3. An available project implementation skill such as `yjx-implement` or `implement`;
4. A generic implementation worker for an ordinary non-Wayfinder issue.

Missing optional skills are a fallback condition, not a reason to install one or block ordinary implementation.

## Scheduling and integration

`serial` uses one worker. `parallel` requires isolated workspaces unless the project provides another safe isolation mechanism. `auto` uses the dependency-ready frontier and worktrees when permitted. An unknown file list is not a reason to ask or serialize: workers discover scope in isolation and resolve conflicts during integration.

`max-workers` is a requested cap. Use the per-run value, then project configuration, then the default of three. There is no assumed fixed AI API concurrency value. If task creation or API calls are rate-limited, back off and lower the active count temporarily.

Workers self-integrate according to project rules. Local Git is sufficient for version consistency; a stale or competing update is a normal retry signal. Do not require a remote merge queue or a global issue lock.

## Recovery and reporting

Resume a failed worker before replacing it. Keep retry attempts bounded. A semantic conflict, HIL, or persistent failure blocks only the affected issue and its downstream; independent targets continue.

Refresh the tracker before each batch and before closeout. Do not write a run manifest into the project repository. Use event-driven waits or long intervals, and report only meaningful changes.

Separate implementation delivery from tracker closeout. A temporary tracker write failure should be retried without repeating implementation or rolling back integrated code.
