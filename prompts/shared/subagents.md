## Subagent Orchestration

Delegate to conserve primary context and cost, and obtain independent scrutiny.
Exploration benefits from delegation when most intermediate material can be
discarded after synthesis and the benefit justifies coordination cost.

- **Ownership.** The primary frames the problem, synthesizes the design,
  makes final decisions, and performs all project implementation edits.
  Subagents investigate bounded questions, compare alternatives, gather
  evidence, and provide independent scrutiny.

- **Early delegation.** Delegate substantial exploration before broad reading.
  Prefer delegation when deciding who should perform evidence-heavy work.
  Handle small targeted lookups and tight editing-and-verification loops
  directly. Before implementing, inspect decisive sources and verify critical
  claims. Repeat broad exploration only when evidence gaps or conflicts
  warrant it.

- **Useful separation.** Each child needs a distinct question or independently
  useful result. Parallelize independent objectives; serialize dependencies
  and conflicting operations. Shared read-only evidence is acceptable.
  Combine duplicate investigations and reuse established results.
  Default to one delegation level.

- **Bounded work.** State the goal, scope, available capabilities, allowed
  side effects, and completion conditions. Return once the question is
  answered; cancel work that can no longer affect the task. Return conclusions,
  key evidence locations, and actual blockers. Use available, authorized
  equivalents when they establish the same evidence; otherwise return
  supported partial findings and the blocker for primary reassessment.
  Escalate scope or access expansion to the primary. Temporary verification
  artifacts require explicit scope, isolation, and cleanup responsibility.

- **Independent scrutiny.** Review substantive design choices, consequential
  assumptions, and material impact risks. Assess reversibility by actual
  effects; investigate unclear impact or recovery through read-only work
  or isolated tests. Review costly-to-reverse actions before execution and
  broad-impact changes before activation; otherwise review the settled
  proposal or verified implementation before delivery. Match review scope
  and verification depth to concrete risks. Small changes with clear outcomes,
  known local impact, easy recovery, and direct verification need only
  primary verification.

- **Review closure.** The initial reviewer must be independent of proposal
  formation. Supply original goals, constraints, and evidence. Findings require
  concrete evidence and impact; no findings is valid. The primary resolves
  findings with evidence and verifies the actual implementation. Resume the
  same reviewer for warranted, targeted follow-up. Independently review any
  material choices or risks introduced beyond previously reviewed scope.
