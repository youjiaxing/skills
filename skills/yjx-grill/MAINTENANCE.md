# yjx-grill Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-grill`. It records design intent and anti-drift rules; ordinary execution does not require it.

## Identity

`yjx-grill` is a user-invoked alignment tool for complex requirements, architectures, remediation strategies, and plans. It combines autonomous fact-finding with decision-tree exploration when consequential human judgment exists.

Its primary outcome is verified shared intent before execution. Each capability slice independently chooses an output mode. A slice where the human-decision gate never passes produces a concise direct result in natural prose. A decision-bearing slice ends with one topic-organized, human-confirmed, implementation-ready contract. Completion follows the collaborative-discussion rule in `SKILL.md` Execution Boundary. It is not a summary generator, generic questionnaire, or execution-plan generator.

## Problems It Must Prevent

1. **Synthetic decisions** that shift routine engineering judgment to the user.
2. **Questionnaire storms** that ask low-value implementation details.
3. **Fragmented summaries** that separate one change from its implementation consequences or mix changed content with unchanged context.
4. **Repeated baselines** that obscure what changed during discussion.
5. **Asymmetric options** that hide the recommended choice's real costs.
6. **Premature convergence** that skips downstream ownership, state, compatibility, or failure forks.
7. **Fact/intent confusion** that asks humans for discoverable facts or turns diagnostic facts into commitments.
8. **Provenance collapse** that turns facts or agent inferences into requirements or decisions.
9. **Thin results** that gain brevity by removing implementation-critical contracts.
10. **Reviewer amplification** that revives rejected branches without new evidence or turns speculation into implementation scope.
11. **Opaque questions** that assume the user understands domain terms or the consequence of a choice before they can judge it.

## Core Design Principles

### Cohesive Slices

A request spanning independent domains or lifecycle boundaries splits into cohesive capability slices. One slice completes before the next opens, and each slice independently selects Direct Result Mode or Decision Mode. Only decision-bearing slices carry question rounds and a final contract. Unrelated decisions stay out of the same contract.

### Human-Decision Gate

Questions require a verified, consequential fork. Human decisions cover irreversible or high-reversal-cost choices, authority, external guarantees, state transitions, consistency, and remediation strategy. Agent inferences cover low-risk mechanics and remain overrideable.

Zero questions is the default until this gate passes. Routine implementation details become neither question cards nor final contract topics. Tooling obstacles, missing permissions, and speculative causes never become question cards.

### Dynamic Frontier

Once the gate passes, selecting a branch prunes alternatives and may open the next dependent frontier. Depth is determined by remaining decisions, not by a fixed number of rounds. A round asks zero to three orthogonal questions.

### Incremental Rounds

Discussion rounds use only the background needed for the current choice, without fixed information roles or headings. Each round contains only information added, revised, or removed. Closed questions, facts already shown, and contract sections whose content did not change remain implicit.

When the user reports excessive complexity or cannot identify the proposed change, abandon the current presentation and compactly explain only what resolves that confusion. Returning to a fixed template does not resolve a presentation failure.

### Symmetric Trade-offs

Questions retain their identifiers, numbered options, and a recommendation marker, not a fixed field schema. Explain real option differences and the recommendation's reason. Present real costs and critical assumptions when they exist and affect judgment, without hiding material downsides or inventing template filler. Alternatives state when they are preferable and why they are not recommended now. Rejected options stay out of the user-facing final contract and remain available to its independent Reviewer with their rejection reasons.

### Topic-Based Single-Source Contract

The final contract for a decision-bearing slice is emitted once after convergence and organizes `Changes` by topic. Expected behavior, implementation-critical consequences, and independently useful acceptance results stay with the change they describe, avoiding a top-level split between decisions and actions.

The final contract retains the `Facts`, `Changes`, and `Unchanged` order defined in `SKILL.md` section 7; discussion rounds are not bound to that structure. Every semantic claim in the contract has one authoritative home: `Changes` stays in its topics, `Unchanged` appears only when omission risks material drift, and `Facts` contains only verified state needed by the selected path. Direct results are exempt from these headings.

### Claim Provenance

Material implementation-affecting claims retain one of four sources: explicit requirement, verified fact, user-confirmed decision, or adjustable agent inference. The decision record maps each material claim to its source and evidence location or corresponding user expression. Discussion rounds display source distinctions only when ambiguity could affect judgment; the final contract and review handoff retain explicit source labels. The runtime labels are localized; in Chinese they are `需求`, `事实`, `决策`, and `推断`. A selected recommendation does not change the source of its attached inferences. Routine implementation details stay unlabeled, and provenance never enters production-code comments.

### Independent Review

Review depth is independent of output mode. Every candidate contract receives independent scrutiny before user confirmation. A direct result also receives independent review when concrete risk, impact, reversibility, authority, material data effects, compatibility, security, or governing project rules warrant it. Reviewing a direct result does not convert it into a contract unless the review discovers a consequential human decision. Supported findings must be resolved and materially revised results re-reviewed before reporting; unresolved correctness blockers replace the proposed result with a blocker report.

The Reviewer evaluates the evidence, whole solution, trade-offs, assumptions, compatibility, maintainability, and demonstrated risks. Patch size is one consideration only when it has a concrete consequence.

The decision record prevents review from restarting settled discussion. A rejected branch reopens only for new evidence, a contradiction in its rejection rationale, failure of the selected contract, or a previously omitted major risk. This boundary preserves useful dissent while preventing preference-driven scope expansion. The primary remains responsible for resolving findings and returning newly consequential choices to the human.

### Implementation-Ready Concision

Concision removes repeated expression, filler, ambient context, and template-completion prose. It preserves every owner, identity, data shape, state transition, interface, compatibility rule, failure policy, strategic boundary, and acceptance condition needed to implement the selected design without reopening the conversation.

Completeness is measured by executable semantics, not by the number of headings filled. Structural assets such as entities, fields, schemas, enums, interfaces, and state machines remain concrete and copyable when they are part of a decision. Verification tables are optional compression for branching scenarios, never a second expression of adjacent prose.

### Alignment Boundary

The skill may investigate and write an alignment result, but it does not modify application code, create implementation files, or execute the plan. Apply the collaborative-discussion rule in `SKILL.md` Execution Boundary before concluding either mode; it changes automatic stopping, not the decision gate or contract obligations. A direct result needs no approval prompt. A decision-bearing result requires final confirmation before implementation begins; explicit approval and execution intent may appear in the same reply.

## Information Placement

- Direct results lead with the conclusion and use natural prose for causal facts, the selected remedy, and only material boundaries or risks. Headings are optional.
- Discussion rounds present only the context needed for the current question, without fixed headings. Only verified facts needed by the selected path remain in the final contract's `Facts` section.
- Choice costs and rejected alternatives appear in question rounds and the independent review handoff, while the user-facing final contract stays on the selected path.
- Each item under `Changes` and its implementation consequences share one change topic.
- Acceptance stays in that topic only when it adds an independently observable result.
- Stable constraints appear only in `Unchanged`, and only when omission risks material drift.
- Question presentation guidance and the final-contract template live in `SKILL.md` with the execution steps that use them.

## Anti-Drift Checks

Before changing the skill, verify that the change:

- preserves alignment-before-action;
- remains domain-neutral;
- keeps fact discovery autonomous and consequential intent decisions human-owned;
- selects output mode independently for each capability slice;
- allows zero questions and requires no fixed headings, contracts, or confirmation prompts when the human-decision gate never passes;
- preserves the verified, consequential-fork decision threshold and downstream frontier audit;
- keeps one contract per capability slice and completes a slice before opening the next;
- keeps discussion rounds incremental;
- keeps discussion context and question explanations flexible while retaining question identifiers, numbered options, and a recommendation marker;
- preserves the final contract's structure and order defined in `SKILL.md` section 7 without imposing them on discussion rounds;
- applies the collaborative-discussion completion rule in `SKILL.md` Execution Boundary without adding a mode, a fixed closing phrase, or contract obligations to direct results;
- keeps each item under `Changes` with its implementation consequences, places preserved implementation constraints only in `Unchanged`, and includes `Unchanged` only when omission risks material drift;
- preserves claim-to-source and evidence mappings, shows discussion provenance when ambiguity affects judgment, retains final-contract and review provenance, and prevents agent inferences from being promoted to requirements or decisions;
- presents real costs and assumptions when they affect judgment, without inventing fields or carrying rejected options forward;
- makes each question understandable with only the needed context, without repeating known facts or presenting examples as verified state;
- preserves implementation-critical model shapes and lifecycle contracts in concrete, copyable form;
- keeps review depth independent of output mode, requires independent review for candidate contracts, and preserves risk-triggered review for direct results;
- preserves the independent-review input, assessment, and reopening contract defined in `SKILL.md`;
- keeps visuals and verification tables optional and non-duplicative, with visuals within eight lines;
- performs no repository or external side effects during alignment;
- keeps the skill authored in English while localizing runtime output;
- generalizes improvements instead of encoding one conversation as a special case.

Reject brevity that hides a consequential decision or implementation contract. Consolidate completeness that repeats one claim in multiple forms.

## Validation Scenarios

- A verified defect with one proportionate remedy and no consequential fork ends in a short natural-language direct result without fixed role headings.
- A slice with materially different authority, guarantee, ownership, migration, state, or failure-policy choices enters Decision Mode and asks numbered questions with only the context needed to compare real options.
- A familiar consequential choice needs no repeated preamble or fixed Outcome, Cost, or Assumption fields; existing material downsides remain visible.
- A user explicitly requests collaborative discussion and no consequential question remains: present an adjustable proposal and wait for feedback under the Execution Boundary rule, without inventing questions or declaring completion.
- An ordinary agreement with a discussion proposal is not execution authorization. Readiness to conclude is interpreted by meaning, without a fixed closing phrase; clarify only when ambiguous.
- Discussion rounds omit routine source prefixes, but every material claim remains traceable in the decision record and review handoff.
- After the user resolves the consequential choices, the slice produces an independently reviewed contract and requests confirmation.
- A high-risk slice with no consequential human decision receives independent review but remains a natural-language direct result.
- A reviewed result that changes materially receives targeted re-review before it is reported or presented for confirmation.
- When a recommendation carries a fallback or failure policy, the policy remains `推断` until explicitly confirmed and the Reviewer checks that it was not promoted.
- A consequential question involving unfamiliar terms explains the concrete situation and why the user's choice matters before presenting options, without adding a fixed primer to familiar questions.
