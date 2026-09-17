# yjx-grill Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-grill`. It records design intent and anti-drift rules; ordinary execution does not require it.

## Identity

`yjx-grill` is a user-invoked alignment tool for complex requirements, architectures, remediation strategies, and plans. It combines autonomous fact-finding with decision-tree exploration and ends in a human-confirmed, implementation-ready contract.

Its primary outcome is verified shared intent before execution. It is not a summary generator, a generic questionnaire, an execution-plan generator, or a substitute for implementation.

## Problems It Must Prevent

1. **Monolithic summaries** that encourage passive approval without exposing decisions.
2. **Questionnaire storms** that ask low-value implementation details.
3. **Asymmetric options** that hide the recommended choice's real costs.
4. **Premature convergence** that skips downstream ownership, state, compatibility, or failure forks.
5. **Fact/intent confusion** that asks humans for discoverable facts or converts diagnostic facts into fake commitments.
6. **Synthetic forks** created from missing permissions, tooling obstacles, or speculative causes.
7. **Semantic repetition** where one decision is restated as a viewport, guarantee, mechanism, boundary, and verification row.
8. **Thin summaries** that remove repetition by also removing implementation-critical contracts.

## Core Design Principles

### Dynamic Frontier

Only high-impact human decisions become questions. Selecting a branch prunes alternatives and opens the next dependent frontier. Depth is determined by remaining decisions, not by a fixed number of rounds.

### Decision Weight

- Human decisions cover irreversible or high-reversal-cost choices, authority, external guarantees, state transitions, consistency, and remediation strategy.
- Agent inferences cover low-risk mechanics and remain overrideable.
- Routine implementation details never become questions or contract entries.

### Symmetric Trade-offs

Recommended choices expose unavoidable costs and falsifiable assumptions. Alternatives state when they are superior. Symmetry is required during decision-making, not repeated in the final implementation contract.

### One Semantic Home

Every fact, decision, constraint, and acceptance result has one authoritative expression location:

- objective facts → fact primer;
- choice costs and rejected alternatives → question round;
- observable result → final `Expected behavior`;
- structural/lifecycle rule → final `Implementation contract`;
- branching verification → final `Acceptance`.

A visual may replace prose but never duplicate it. A verification table may compress branching scenarios but its rows must not be restated elsewhere.

### Implementation-Ready Concision

Concision removes repeated expression, filler, ambient context, and template-completion prose. It must preserve every owner, identity, data shape, state transition, interface, compatibility rule, failure policy, and acceptance condition needed to implement the selected design without reopening the conversation.
Negative boundary constraints and prohibited anti-patterns belong strictly in the implementation contract, not as a standalone repeated section.

Completeness is measured by executable semantics, not by whether every template heading is present.

### Alignment Boundary

The skill may investigate and write an alignment contract, but it does not modify application code, create implementation files, or execute the plan. Implementation begins only after a separate user command.

## Output Model

### During Rounds

- One fact primer per capability slice; later updates are delta-only.
- One to three orthogonal frontier questions per round.
- Compact option cards; omit fields that paraphrase another field.
- Closed questions and unchanged facts are never reprinted.
- Cascade echoes appear only when interpretation or earlier decisions change.

### Final Contract

Each topic uses only the fields needed from:

- `Expected behavior`
- `Implementation contract`
- `Acceptance`

Simple decisions may use one line. Structural assets such as entities, fields, schemas, enums, interfaces, and state machines remain concrete and copyable when they are part of the decision.

PR steps, unaffected call lists, test filenames, shell commands, and routine language hygiene are excluded.

## Anti-Drift Checks

Before changing the skill, verify that the change:

- preserves alignment-before-action and the user confirmation stop condition;
- remains domain-neutral;
- keeps fact discovery autonomous and intent decisions human-owned;
- strictly forbids manufacturing synthetic question cards out of diagnostic obstacles or symptom guessing when no genuine architectural trade-offs exist;
- preserves the high-impact decision redline and downstream frontier audit;
- presents balanced costs and assumptions without carrying rejected options into the final contract;
- prevents repeated fact primers, answered cards, cascade summaries, and final-contract paraphrases;
- uses visuals only when they replace prose and keeps them at most eight lines;
- preserves implementation-critical model shapes and lifecycle contracts;
- keeps verification matrices optional and non-duplicative;
- prevents implementation plans and routine code hygiene from entering the contract;
- keeps the skill authored in English while localizing runtime output;
- performs no repository or external side effects during alignment;
- generalizes improvements instead of encoding a single conversation as a special case.

If an optimization improves brevity by hiding a decision or implementation contract, reject it. If it improves completeness by repeating the same claim in multiple forms, consolidate it instead.
