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

Questions require a verified, consequential fork. Human decisions cover irreversible or high-reversal-cost choices, authority, external guarantees, state transitions, consistency, and remediation strategy. Agent inferences cover low-risk mechanics; their implementation authorization is governed separately from their provenance.

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

The final contract for a decision-bearing slice is emitted once after convergence and organizes changes by topic. Expected behavior, implementation-critical consequences, and independently useful acceptance results stay with the change they describe, avoiding a top-level split between decisions and actions.

Facts, changes, and preserved constraints have distinct semantic roles, not mandatory visible headings or a fixed order. Each topic keeps source-scoped blocks for user commitments, agent proposals, and necessary factual context. Include preserved constraints only when omission risks material drift. Each semantic claim has one primary authoritative home; it may reappear when the second form adds a distinct decision, boundary, or independently observable consequence. Omit absent source blocks instead of filling a template.

### Claim Provenance

Material implementation-affecting claims retain one of four sources: explicit requirement, verified fact, user-confirmed decision, or agent-originated inference. The coverage ledger maps each material claim to its source and evidence location or corresponding user expression; in Decision Mode, the decision record carries that mapping forward with selected decisions and rejected branches. These are internal classifications, not user-facing role fields. Presentation Density owns the visible source separation and attribution rules. Attribution identifies the claim's origin independently of its approval status. When explicit labels are needed, they are localized; in Chinese they are `需求`, `事实`, `决策`, and `推断`. A selected recommendation does not change the source of its attached inferences. Routine implementation details stay unlabeled, and provenance never enters production-code comments.

### Implementation Authorization

Source and approval are independent. Before final approval, agent proposals remain adjustable. Explicit approval of the reviewed contract makes its listed material inferences implementation constraints while preserving their agent origin; undisclosed defaults receive no authorization from that approval. Approval requests clearly identify the current reviewed contract or its scope, excluding other independently aligned results shown as background. Display groups neither add approval units nor merge independent contracts' authorizations. Material changes to approved behaviors or boundaries require renewed alignment and approval. Routine mechanics outside the contract still follow the existing human-decision gate. Approval neither verifies uncertain facts nor replaces consequential decision coverage. Runtime confirmation rules live in `SKILL.md` Confirmation and Authorization.

### Presentation Density

Presentation Density is the shared runtime owner, placed before the execution steps so both output modes reach it. It covers discussion, direct results, review handoffs, and final contracts. Its design separates visual structure from wording: content-named topics make distinct outcomes scannable, while attributed blockquotes distinguish material agent contributions without a repeated role-field form. A combined contract title does not replace its topic groups. Short single-topic results and topics without agent proposals remain simple.

Runtime wording, quote boundaries, and the composition check live only in that section. Maintain complete internal provenance, local implementation consequences, and one semantic home per claim. The illustrative example explains separation rather than prescribing phrases, a domain, a field sequence, or an approval scope. Section 7 refers to this owner rather than maintaining parallel prescriptions.

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

- Direct results lead with the conclusion and use natural prose for causal facts, the selected remedy, and only material boundaries or risks. Shared Presentation Density governs topic headings in both modes.
- Discussion rounds present only the context needed for the current question, without fixed headings. Only verified facts needed by the selected path remain as clearly scoped context in the final contract.
- Choice costs and rejected alternatives appear in question rounds and the independent review handoff, while the user-facing final contract stays on the selected path.
- Each proposed change and its implementation consequences share one topic, with user commitments and agent inferences in separate source-scoped blocks.
- Acceptance stays in that topic only when it adds an independently observable result.
- Stable constraints are distinguished from new proposals and included only when omission risks material drift.
- Question presentation and final-contract organization guidance live in `SKILL.md` with the execution steps that use them.

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
- preserves the final contract's topic cohesion, source separation, and implementation-critical content without requiring category headings, a fixed display order, or role fields;
- keeps grouping, attributed proposal quotes, and concise contextual wording in the shared presentation rule for both output modes and discussion rounds, without requiring internal workflow terminology as group names;
- applies the collaborative-discussion completion rule in `SKILL.md` Execution Boundary without adding a mode, a fixed closing phrase, or contract obligations to direct results;
- keeps each proposed change with its implementation consequences, gives each semantic claim one primary home, permits only functionally useful restatement, and includes preserved constraints only when omission risks material drift;
- preserves claim-to-source and evidence mappings, shows discussion provenance when ambiguity affects judgment, retains final-contract and review provenance, and prevents agent inferences from being promoted to requirements or decisions;
- keeps material agent inferences separate from user commitments and facts in each topic, scopes each source once, and rewrites form-like output as natural prose without hiding provenance;
- preserves agent origin after explicit contract approval, clearly scopes each approval request to its reviewed contract rather than background results or display groups, and requires renewed alignment for material changes;
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
- Low-risk agent inferences remain adjustable before final approval and need not become questions, but every material inference is classified; a critical-boundary inference reruns the human-decision gate and reaches the human frontier only when that gate passes.
- Direct Result Mode still completes the decision-node coverage audit even when no human question is required.
- The coverage ledger is mode-independent; a risk-triggered Direct Result review receives the ledger or a concise summary, while an unreviewed direct result keeps it internal.
- A topic containing a user decision, agent proposal, and supporting fact keeps commitments and facts in distinct prose paragraphs and material agent proposals in attributed quotes.
- An inference block identifies its agent origin even when an approval status is also shown; a status-only label does not establish provenance.
- A topic without agent inferences adds no empty inference block; complex topics still retain concrete shapes, compatibility guarantees, and independently useful acceptance conditions.
- Multiple independent topics in a direct result or decision-bearing contract are visibly grouped with content-specific names; their evidence, boundaries, and acceptance stay with the relevant topic, and source blocks remain separate.
- A single short result adds no artificial group structure; source attribution remains brief and contextual without stock personal introductions or mandatory replacement phrases.
- Two independently discussable defects use content-named headings even in Direct Result Mode; that grouping does not create contract or confirmation obligations.
- A compact reply still separates user commitments from material agent proposals through attributed quotes; an inline source prefix or connective is not sufficient.
- A proposal is attributed at its first mention and stays in its own block; a later source disclaimer cannot repair an earlier presentation as a user commitment or fact.
- A multi-topic contract uses natural prose rather than repeating the ledger's categories as field rows; its illustrative example does not become a required output skeleton.
- Repeated facts are grouped under one scoped statement instead of rendering `事实` on every adjacent bullet or beneath an already source-scoped heading; a second form is retained only when it adds a distinct boundary or independently observable check.
- After the user resolves the consequential choices, the slice produces an independently reviewed contract and requests confirmation.
- A high-risk slice with no consequential human decision receives independent review but remains a natural-language direct result.
- A reviewed result that changes materially receives targeted re-review before it is reported or presented for confirmation.
- When a recommendation carries an agent-derived fallback or failure policy, it retains its `推断` origin; discussion agreement alone does not approve the whole contract.
- Explicit final approval marks listed material inferences as authorized implementation constraints without changing their origin, authorizing undisclosed defaults, or verifying uncertain facts.
- An approval request explicitly identifies its reviewed contract or concrete scope; other independently aligned results shown as background retain their own modes and confirmation status and stay outside that request. Display grouping adds neither separate per-group approvals nor cross-contract authorization.
- A material change to an approved implementation boundary requires renewed alignment and approval; routine mechanics outside that boundary still use the existing human-decision gate.
- A low-risk implementation detail is recorded as an inference or coverage constraint, while an alternative affecting ownership, state, compatibility, guarantees, authority, or strategy reruns the human-decision gate and becomes a new human question only when verified consequences satisfy it.
- A direct result with no consequential human fork still reports only after all material implementation nodes are classified and consequential branches are traversed, explicitly closed by a recorded decision, or evidenced as pruned.
- New facts discovered during autonomous investigation trigger a fresh coverage audit before the next question or conclusion.
- A consequential question involving unfamiliar terms explains the concrete situation and why the user's choice matters before presenting options, without adding a fixed primer to familiar questions.
