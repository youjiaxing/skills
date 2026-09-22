# yjx-grill Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-grill`. It records design intent and anti-drift rules; ordinary execution does not require it.

## Identity

`yjx-grill` is a user-invoked alignment tool for complex requirements, architectures, remediation strategies, and plans. It combines autonomous fact-finding with decision-tree exploration when consequential human judgment exists.

Its primary outcome is verified shared intent before execution. A zero-decision case ends with a direct conclusion. A decision-bearing case ends with one topic-organized, human-confirmed, implementation-ready contract per capability slice. It is not a summary generator, generic questionnaire, or execution-plan generator.

## Problems It Must Prevent

1. **Synthetic decisions** that shift routine engineering judgment to the user.
2. **Questionnaire storms** that ask low-value implementation details.
3. **Fragmented summaries** that separate one change from its implementation consequences or mix changed content with unchanged context.
4. **Repeated baselines** that obscure what changed during discussion.
5. **Asymmetric options** that hide the recommended choice's real costs.
6. **Premature convergence** that skips downstream ownership, state, compatibility, or failure forks.
7. **Fact/intent confusion** that asks humans for discoverable facts or turns diagnostic facts into commitments.
8. **Thin conclusions** that gain brevity by removing implementation-critical contracts.

## Core Design Principles

### Cohesive Slices

A request spanning independent domains or lifecycle boundaries splits into cohesive capability slices. One slice completes before the next opens, and each slice carries its own fact primer, rounds, and final contract. Unrelated decisions stay out of the same contract.

### Human-Decision Gate

Questions require a verified, consequential fork. Human decisions cover irreversible or high-reversal-cost choices, authority, external guarantees, state transitions, consistency, and remediation strategy. Agent inferences cover low-risk mechanics and remain overrideable.

Zero questions is the default until this gate passes. Routine implementation details become neither decision cards nor final contract topics. Tooling obstacles, missing permissions, and speculative causes never become decision cards.

### Dynamic Frontier

Once the gate passes, selecting a branch prunes alternatives and may open the next dependent frontier. Depth is determined by remaining decisions, not by a fixed number of rounds. A round asks zero to three orthogonal questions.

### Incremental Rounds

After the first fact primer, each round contains only added, changed, or removed facts, decisions, and consequences. Closed questions, unchanged facts, and unchanged contract sections remain implicit.

When the user reports excessive complexity or cannot identify the proposed change, the skill abandons the current presentation and briefly states the intended question, actual change, and whether human judgment is still required.

### Symmetric Trade-offs

Recommended choices expose unavoidable costs and falsifiable assumptions. Alternatives state when they are superior. Symmetry is required while deciding; rejected options do not travel into the final contract.

### Topic-Based Single-Source Contract

The final result is emitted once after convergence and organizes changed content by decision topic. Expected behavior, implementation-critical consequences, and independently useful acceptance results stay with the change they describe, avoiding a top-level split between decisions and actions.

Stable existing constraints and supporting evidence remain separate, optional sections. Every semantic claim has one authoritative home: changed content stays in its topic, unchanged boundaries appear only when omission risks material drift, and evidence contains only verified facts needed by the selected path.

### Implementation-Ready Concision

Concision removes repeated expression, filler, ambient context, and template-completion prose. It preserves every owner, identity, data shape, state transition, interface, compatibility rule, failure policy, strategic boundary, and acceptance condition needed to implement the selected design without reopening the conversation.

Completeness is measured by executable semantics, not by the number of headings filled. Structural assets such as entities, fields, schemas, enums, interfaces, and state machines remain concrete and copyable when they are part of a decision. Verification tables are optional compression for branching scenarios, never a second expression of adjacent prose.

### Alignment Boundary

The skill may investigate and write an alignment result, but it does not modify application code, create implementation files, or execute the plan. A zero-decision result needs no approval prompt. A decision-bearing result requires final confirmation before implementation begins; explicit approval and execution intent may appear in the same reply.

## Information Placement

- Objective facts first appear in the fact primer; only evidence needed by the selected path is retained in the final `Evidence` section.
- Choice costs and rejected alternatives appear only in question rounds.
- Each changed decision and its implementation consequences share one decision topic.
- Acceptance stays in that topic only when it adds an independently observable result.
- Stable constraints appear only in `Necessary unchanged boundaries`, and only when omission risks material drift.
- Question and final-contract templates live in `SKILL.md` with the execution steps that use them.

## Anti-Drift Checks

Before changing the skill, verify that the change:

- preserves alignment-before-action;
- remains domain-neutral;
- keeps fact discovery autonomous and consequential intent decisions human-owned;
- allows zero questions and zero confirmation prompts when no human decision exists;
- preserves the verified, consequential-fork decision threshold and downstream frontier audit;
- keeps one contract per capability slice and completes a slice before opening the next;
- keeps discussion rounds incremental;
- keeps each changed decision with its implementation consequences while separating critical unchanged boundaries and evidence;
- omits unchanged content unless its absence creates material implementation risk;
- presents balanced costs and assumptions without carrying rejected options forward;
- preserves implementation-critical model shapes and lifecycle contracts in concrete, copyable form;
- keeps visuals and verification tables optional and non-duplicative, with visuals within eight lines;
- performs no repository or external side effects during alignment;
- keeps the skill authored in English while localizing runtime output;
- generalizes improvements instead of encoding one conversation as a special case.

Reject brevity that hides a consequential decision or implementation contract. Consolidate completeness that repeats one claim in multiple forms.
