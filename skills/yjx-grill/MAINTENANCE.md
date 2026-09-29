# yjx-grill Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-grill`. It records design intent and anti-drift rules; ordinary execution does not require it.

## Identity

`yjx-grill` is a user-invoked alignment tool for complex requirements, architectures, remediation strategies, and plans. It combines autonomous fact-finding with decision-node coverage auditing and decision-tree exploration when consequential human judgment exists.

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
9. **Hidden inference gaps** that leave material implementation decisions unclassified because they look like routine mechanics.
10. **Thin results** that gain brevity by removing implementation-critical contracts.
11. **Reviewer amplification** that revives rejected branches without new evidence or turns speculation into implementation scope.
12. **Opaque questions** that assume the user understands domain terms or the consequence of a choice before they can judge it.

## Core Design Principles

### Cohesive Slices

A request spanning independent domains or lifecycle boundaries splits into cohesive capability slices. One slice completes before the next opens, and each slice independently selects Direct Result Mode or Decision Mode. Only decision-bearing slices carry question rounds and a final contract. Unrelated decisions stay out of the same contract.

### Human-Decision Gate

Questions require a verified, consequential fork. Human decisions cover irreversible or high-reversal-cost choices, authority, external guarantees, state transitions, consistency, and remediation strategy. Agent inferences cover low-risk mechanics and remain overrideable.

Zero questions is the default until this gate passes. Routine implementation details become neither question cards nor final contract topics. Tooling obstacles, missing permissions, and speculative causes never become question cards.

### Decision Node Coverage

Before asking, after each answer, after any material evidence update, and before concluding a slice, inventory every material implementation-affecting decision node in a mode-independent coverage ledger. A material node is a choice or assumption whose alternatives can change observable behavior, the implementation contract, or a material risk boundary. Record two independent fields: provenance, exactly one of `需求`, `事实`, `决策`, or `推断`; and coverage, such as settled by requirement or fact, traversed through a user decision, resolved as a low-risk inference, constrained by acceptance or review, explicitly closed by a recorded decision, or pruned by verified evidence. Treat ownership, source of truth, identity, state, consistency or concurrency, external contracts, failure or retry guarantees, compatibility or migration, security or authority, and overall strategy as critical-boundary heuristics. A heuristic only triggers a fresh human-decision gate; promote the inference to the human frontier only when that gate has verified consequences. If the gate does not pass, gather facts or establish acceptance/review coverage; if neither is possible, report a blocker rather than conclude with an unconfirmed critical-boundary inference. The coverage ledger is mode-independent; Decision Mode carries it forward as the decision record with selected decisions, rejected branches, and evidence. Convergence requires every material node to have both fields and every consequential branch to be traversed, explicitly closed by a recorded decision, or pruned by verified evidence.

### Dynamic Frontier

Once the gate passes, selecting a branch prunes alternatives and may open the next dependent frontier. The user-facing frontier contains consequential human decisions; the coverage audit also tracks lower-risk nodes so they cannot disappear into an unexamined inference. Depth is determined by remaining decisions, not by a fixed number of rounds. A round asks zero to three orthogonal questions.

### Incremental Rounds

Discussion rounds use only the background needed for the current choice, without fixed information roles or headings. Each round contains only information added, revised, or removed. Closed questions, facts already shown, and contract sections whose content did not change remain implicit.

When the user reports excessive complexity or cannot identify the proposed change, abandon the current presentation and compactly explain only what resolves that confusion. Returning to a fixed template does not resolve a presentation failure.

### Symmetric Trade-offs

Questions retain their identifiers, numbered options, and a recommendation marker, not a fixed field schema. Explain real option differences and the recommendation's reason. Present real costs and critical assumptions when they exist and affect judgment, without hiding material downsides or inventing template filler. Alternatives state when they are preferable and why they are not recommended now. Rejected options stay out of the user-facing final contract and remain available to its independent Reviewer with their rejection reasons.

### Topic-Based Single-Source Contract

The final contract for a decision-bearing slice is emitted once after convergence and organizes `Changes` by topic. Expected behavior, implementation-critical consequences, and independently useful acceptance results stay with the change they describe, avoiding a top-level split between decisions and actions.

The final contract retains the `Facts`, `Changes`, and `Unchanged` order defined in `SKILL.md` section 7; discussion rounds are not bound to that structure. Each semantic claim has one primary authoritative home: `Changes` stays in its topics, `Unchanged` appears only when omission risks material drift, and `Facts` contains only verified state needed by the selected path. A claim may reappear when the second form adds a distinct decision, boundary, or independently observable consequence. Direct results are exempt from these headings.

### Claim Provenance

Material implementation-affecting claims retain one of four sources: explicit requirement, verified fact, user-confirmed decision, or adjustable agent inference. The coverage ledger maps each material claim to its source and evidence location or corresponding user expression; in Decision Mode, the decision record carries that mapping forward with selected decisions and rejected branches. Provenance is traceability metadata, not a mandatory visible prefix. Discussion rounds and direct results expose source distinctions only when ambiguity could affect judgment; the final contract and review handoff retain enough explicit provenance to prevent source confusion without mechanically labeling every bullet. The runtime labels are localized; in Chinese they are `需求`, `事实`, `决策`, and `推断`. A selected recommendation does not change the source of its attached inferences. Routine implementation details stay unlabeled, and provenance never enters production-code comments.

### Presentation Density

User-facing output should group claims with the same source and avoid repeating `事实`, `需求`, `决策`, or `推断` on adjacent items. Labels, headings, and qualifiers appear only when they resolve a real ambiguity or protect an implementation boundary. Give each semantic claim one primary home; repeat it only when the second occurrence adds a distinct decision, boundary, or independently observable consequence. The visible result may be natural prose or a compact list, while the private decision record and reviewer handoff remain complete. The final contract keeps its semantic order and implementation-critical detail, but does not create empty or repetitive source sections for visual symmetry.

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
- preserves decision-node coverage auditing, including separate provenance and coverage fields, evidence-update rechecks, branch coverage, and promotion of critical inferences only after the human-decision gate passes;
- selects output mode independently for each capability slice;
- allows zero questions and requires no fixed headings, contracts, or confirmation prompts when the human-decision gate never passes;
- preserves the verified, consequential-fork decision threshold and downstream frontier audit;
- keeps one contract per capability slice and completes a slice before opening the next;
- keeps discussion rounds incremental;
- keeps discussion context and question explanations flexible while retaining question identifiers, numbered options, and a recommendation marker;
- preserves the final contract's structure and order defined in `SKILL.md` section 7 without imposing them on discussion rounds;
- applies the collaborative-discussion completion rule in `SKILL.md` Execution Boundary without adding a mode, a fixed closing phrase, or contract obligations to direct results;
- keeps each item under `Changes` with its implementation consequences, gives each semantic claim one primary home, permits only functionally useful restatement, places preserved implementation constraints only in `Unchanged`, and includes `Unchanged` only when omission risks material drift;
- preserves claim-to-source and evidence mappings, shows discussion provenance when ambiguity affects judgment, retains final-contract and review provenance, and prevents agent inferences from being promoted to requirements or decisions;
- keeps provenance traceable without mechanically exposing a repeated source prefix; groups same-source claims and rewrites form-like output as natural prose;
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
- Discussion rounds omit routine source prefixes, but every material claim remains traceable in the coverage ledger and, when applicable, the decision record and review handoff.
- Low-risk agent inferences remain adjustable and need not become questions, but every material inference is classified; a critical-boundary inference reruns the human-decision gate and becomes a user decision only when that gate passes.
- Direct Result Mode still completes the decision-node coverage audit even when no human question is required.
- The coverage ledger is mode-independent; a risk-triggered Direct Result review receives the ledger or a concise summary, while an unreviewed direct result keeps it internal.
- Repeated facts are grouped under one scoped statement instead of rendering `事实` on every adjacent bullet; a second form is retained only when it adds a distinct boundary or independently observable check.
- After the user resolves the consequential choices, the slice produces an independently reviewed contract and requests confirmation.
- A high-risk slice with no consequential human decision receives independent review but remains a natural-language direct result.
- A reviewed result that changes materially receives targeted re-review before it is reported or presented for confirmation.
- When a recommendation carries a fallback or failure policy, the policy remains `推断` until explicitly confirmed and the Reviewer checks that it was not promoted.
- A low-risk implementation detail is recorded as an inference or coverage constraint, while an alternative affecting ownership, state, compatibility, guarantees, authority, or strategy reruns the human-decision gate and becomes a new human question only when verified consequences satisfy it.
- A direct result with no consequential human fork still reports only after all material implementation nodes are classified and consequential branches are traversed, explicitly closed by a recorded decision, or evidenced as pruned.
- New facts discovered during autonomous investigation trigger a fresh coverage audit before the next question or conclusion.
- A consequential question involving unfamiliar terms explains the concrete situation and why the user's choice matters before presenting options, without adding a fixed primer to familiar questions.
