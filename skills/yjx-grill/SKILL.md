---
name: yjx-grill
description: Stress-test a plan, architecture, or complex decision through evidence-backed decision-tree exploration and implementation-decision coverage, then report a direct result or produce a concise implementation-ready alignment contract.
disable-model-invocation: true
---

# yjx-grill

Align a human and an agent on complex requirements, architectures, remediation strategies, or plans before execution. Investigate facts autonomously, ask only for consequential human judgment, and make the user-facing result proportional to the decisions the case actually contains.

Read `MAINTENANCE.md` before reviewing or changing this skill. It is not needed for ordinary execution.

## Execution Boundary

- This is a user-invoked alignment skill.
- Do not write application code, modify repository source files, or execute the aligned plan.
- Render every user-facing label and bold template key in the user's conversational language.
- Select the output mode independently for each capability slice. A slice where the human-decision gate never passes produces a direct result. A decision-bearing slice ends after its final contract is confirmed. Apply the collaborative-discussion rule below before concluding either mode.

When the user explicitly requests collaborative discussion, the absence of consequential questions is not a completion signal. Present an adjustable proposal and wait for feedback. This changes automatic stopping only: select the slice's mode through the existing human-decision gate, without a third mode or new contract or confirmation obligations. Interpret readiness to conclude by meaning, not a fixed phrase; clarify only when ambiguous. Agreement with a discussion proposal alone is neither discussion completion nor authorization to execute. A decision-bearing slice still requires the reviewed contract and confirmation in sections 6 through 9.

## Presentation Density

This rule governs discussion rounds, direct results, review handoffs, and final contracts. Compose by topic first, then separate sources within that topic. When presenting two or more independently discussable changes or results, give each a short heading naming its actual object or goal. A contract title covering distinct outcomes is not a substitute for those topic headings. Routine details stay with the behavior or boundary they support. A short, single-topic reply needs no heading; internal capability-slice terminology is not required display vocabulary.

Draft each material claim once, in the topic and source identified by its ledger entry. Write user requirements or choices as natural prose with brief contextual attribution. Put necessary verified context in its own prose paragraph. Render material agent proposals as Markdown blockquotes, starting with a short attribution before stating their behavior for the first time. Keep proposal-origin behavior and its implementation consequences inside those quotes, separate from user commitments and facts. A later disclaimer or unquoted summary does not repair a proposal first presented as a fact or commitment. Routine implementation mechanics remain unlabelled.

Use prose for a single commitment or proposal, and lists for several actionable or comparable claims of the same source. Keep necessary context, behavior, implementation consequences, and acceptance local to their topic and source. Omit absent sources and redundant facts. Reduce repeated content and stock introductions, not the visible boundaries; the ledger's categories are not fields to render in every topic. Approval status belongs to the contract's confirmation and cannot replace source attribution.

For illustration, given a user choice to keep CSV, an agent proposal of UTF-8, and a separate requested text change:

```markdown
**Download format**
As requested, downloads remain CSV.

> I suggest UTF-8 encoding so names with accents survive export.

**Completion message**
Change "Finished" to "Complete"; everything else stays the same.
```

The example is not a required wording, field sequence, domain, or combined approval scope. Its quoted proposal illustrates the source boundary; topics without material agent proposals add no quote.

Before sending, inspect the actual draft: each independent outcome has a content-named group, each material agent proposal first appears attributed inside its quote, and no role-field rows or mixed-source paragraphs replace those distinctions. Rewrite any failing part. Give each semantic claim one primary home; repeat it only when the second occurrence adds a distinct boundary or independently observable consequence. Keep the internal record and implementation-critical content complete.

## 1. Establish Facts Before Asking Intent

Use tools for objective facts: existing code, schemas, logs, current state, task text, dependencies, and available assets. Do not ask the user to discover facts the agent can verify.

Use questions for human intent, irreversible trade-offs, business priorities, authority ownership, or guarantees.

For defects or reality gaps, investigate the causal chain before presenting remediation choices. When a primer is useful, keep it compact:

- **Symptom**: actor, action, observable failure.
- **Break**: the smallest direct call tree, state comparison, diff, or mechanism.
- **Assessment**: defect nature and eliminated pseudo-causes.

If investigation establishes the root cause and no consequential trade-off remains, prepare a Direct Result that leads with the conclusion, explains the causal fact and selected remedy in natural prose, and includes only material boundaries or risks. Use Presentation Density for its organization. Apply any review required by section 8 before reporting it, then follow the completion rule in Execution Boundary.

## 2. Slice the Problem

If the request spans independent domains or lifecycle boundaries, split it into cohesive capability slices. Finish one slice before opening the next. Do not merge unrelated decisions into one contract.

## 3. Prove a Human Decision Exists

Before writing a question, identify the unresolved choice and why the agent cannot infer it safely. It is a human decision only when reversal would require structural redesign, data migration, irreversible resource use, broken external guarantees, authority changes, or a materially different remediation strategy.

Use this gate:

```text
The user must decide <choice> because either answer materially changes <cost, guarantee, ownership, or strategy>.
```

If that sentence cannot be completed with verified consequences, ask zero questions. Infer low-reversal-cost mechanics, routine parameters, and local technical defaults, then use Direct Result Mode for that slice, subject to the collaborative-discussion rule in Execution Boundary. Routine implementation details belong in neither question cards nor final contract topics. Do not turn tooling obstacles, missing permissions, or speculative causes into question cards.

### Decision Node Coverage

Before the first question, after each user reply, after any material evidence update, and before concluding any slice, privately inventory every material implementation-affecting decision node in a mode-independent coverage ledger. A material node is a choice or assumption whose alternatives can change observable behavior, the implementation contract, or a material risk boundary. For each node, record two independent fields:

- **Provenance**: exactly one of `需求`, `事实`, `决策`, or `推断`, using the definitions in Claim Provenance;
- **Coverage**: settled by a requirement or fact, traversed through a user decision, resolved as a low-risk inference, constrained by acceptance or review, explicitly closed by a recorded decision, or pruned by verified evidence.

This audit applies in both Direct Result Mode and Decision Mode. Treat ownership, source of truth, identity, state transitions, consistency or concurrency, external contracts, failure or retry guarantees, compatibility or migration, security or authority, and overall remediation strategy as critical-boundary heuristics. When an inference touches one of them, rerun the human-decision gate with verified consequences; promote it to the active human frontier only if the gate sentence can be completed. If the gate does not pass, gather facts or establish acceptance/review coverage; if neither is possible, report a blocker instead of concluding with an unconfirmed critical-boundary inference. Do not collapse materially different branches into one inference merely because the implementation details are technically familiar.

The audit is complete only when every material node has both fields, every consequential branch is traversed, explicitly closed by a recorded decision, or pruned by verified evidence, and no critical boundary remains supported only by an unconfirmed inference. Keep the complete ledger internal; expose only the nodes needed for the current user judgment. If independent review is triggered, include the ledger or the relevant summary in the reviewer handoff. The coverage ledger is the mode-independent internal record; in Decision Mode, the decision record carries it forward with selected decisions, rejected branches, and their evidence.

### Per-Slice Output Modes

- **Direct Result Mode**: Use when investigation completes without any unresolved choice passing the human-decision gate. State the conclusion, causal facts, selected remedy, and only material risks or verification boundaries in natural prose, organized under Presentation Density. This mode needs no fixed role fields, contract, or user confirmation.
- **Decision Mode**: Enter as soon as the current slice contains a verified consequential choice that the user must decide. Keep that slice in Decision Mode through its question rounds, convergence, reviewed contract, and confirmation. Other slices choose their mode independently.

Output mode does not determine review depth. Apply independent review according to concrete risk, impact, reversibility, and governing project rules. A reviewed direct result remains a direct result unless review discovers a consequential fork.

## 4. Traverse the Active Decision Frontier

Decision-frontier traversal, Discussion Context, and Compact Question Card apply when the current slice contains a choice that passes the human-decision gate. Claim Provenance and Presentation Density apply in both output modes and throughout discussion; Confirmation and Authorization governs any contract approval.

Ask zero to three orthogonal questions per round; zero is the default until the gate passes.

- A question is orthogonal only if it remains necessary regardless of the other answers in that round.
- Ask pivots first: source of truth, ownership, external contract, irreversible state transition, consistency, and failure policy.
- A selected option may unlock downstream questions; continue until no unresolved human decision remains.
- Use verified assets to prune impossible or already-implemented options before asking.
- Mention a next frontier only when the answer unlocks another consequential fork.

### Discussion Context

Give only the background needed to understand the current question. Use natural prose or a compact visual, omit background the user already knows, and allow no preamble when the choice is already clear. Discussion rounds do not require fixed information roles, headings, or ordering. Keep verified current behavior, proposed changes, and preserved boundaries distinguishable when that distinction affects the choice. The contract-organization requirements in section 7 apply only to the final contract.

### Claim Provenance

Maintain the source and evidence location or corresponding user expression for each material claim that can change implementation. Use the coverage ledger in every mode and extend it into the Decision Mode record described in section 5; source tracking is separate from user-facing presentation. The source categories are localized; in Chinese use `需求`, `事实`, `决策`, and `推断`:

- `需求`: explicit requirement or constraint.
- `事实`: verified code, specification, configuration, or runtime state.
- `决策`: user-confirmed choice.
- `推断`: agent-originated proposal or implementation default; its implementation authorization is separate from its source.

These categories apply to behavior, ownership, data source, state, failure policy, protocol, boundary, and abstraction claims. They are internal source classifications, not a set of fields to render for every topic. Routine implementation details remain unlabelled. Preserve the full claim-to-source mapping in the coverage ledger, Decision Mode record, and independent-review handoff; use Presentation Density to express the relevant distinctions to the user. Approval status cannot substitute for origin, and choosing or approving a recommendation never changes an attached `推断` into a `需求` or `决策`. Do not add provenance labels to production-code comments.

### Confirmation and Authorization

Provenance records who supplied a claim; authorization records whether its implementation is approved. Before final contract approval, agent proposals remain adjustable. Explicit approval of the reviewed contract authorizes only its listed implementation behaviors and boundaries, including the material agent inferences it presents. Record those inferences as approved for implementation while retaining their `推断` source. Agreement during discussion or selection of an option does not approve the whole contract or undisclosed defaults.

Before requesting approval, clearly name the current reviewed contract or state its concrete scope. Other independently aligned results shown as background retain their respective modes and any existing confirmation status and are explicitly outside this request. Display grouping neither creates extra approval units nor combines independent contracts into one authorization.

After approval, changing a material contracted behavior or boundary requires renewed alignment and approval. Routine mechanics left outside the contract remain subject to the existing human-decision gate. Approval does not turn an uncertain factual claim into a verified fact, replace consequential question traversal, or expand the execution boundary.

### Compact Question Card

Keep the question identifier `Q<N>`, number options from 1, and place the recommended option first with a localized recommendation marker. Ask only the unresolved choice; there is no required heading or field schema.

Before asking for a selection, make each question understandable without assuming the user knows its domain terminology. When the choice needs context, briefly explain the concrete situation, unfamiliar terms in plain language, and why the answer changes a consequential outcome that the agent cannot decide. Use a small hypothetical example if it clarifies the choice; distinguish it from verified facts. Put this explanation in the question card, reuse context already given in the current round, and omit what the user already knows.

Explain the real difference between options and why the first is recommended. For alternatives, state when they are preferable and why they are not recommended now. Let the explanation fit the choice rather than filling fixed Outcome, Cost, Assumption, or Companion rule fields. Present real costs and critical assumptions when they exist and affect judgment; do not hide material downsides or invent them to complete a template.

Use a visual only when it replaces several lines of prose by showing a control-flow divergence, state transition, data shape, or ownership boundary. Keep it within eight lines and do not repeat it in adjacent prose.

## 5. Keep Decision Discussion Incremental

In Decision Mode, interpret replies by meaning. Only an unambiguous commitment changes decision state.

- Acknowledge an ordinary selection in one line or proceed directly to the next frontier.
- Show only information added, revised, or removed in the current round, using the context guidance in section 4.
- Do not reprint answered questions, closed options, facts already shown, or contract sections whose content did not change.
- Compress repeated claims before presenting them: one scoped statement is preferable to several bullets carrying the same source label or baseline.
- When a new decision invalidates an earlier one, prune the dead branch and its dependent inferences. Reopen only the conflicting human decision.
- For a custom answer, extract the commitment, explicit overrides, and hard constraints; derive remaining low-risk mechanics without another questionnaire.
- Retain a decision record for final review: each material claim's source and evidence location or corresponding user expression, the selected approach and its costs, rejected branches and rejection reasons, remaining assumptions, and explicit risk boundaries. Keep this record out of the user-facing final contract.

If the user asks for clarification, pause the round, answer only that clarification, and wait. Do not append unanswered cards in the same turn.

If the user says the discussion is unclear, too complex, or asks what is actually being changed, discard the current presentation and restate only what resolves that confusion. Make the actual change and, if one remains, the unresolved choice and reason human judgment is required clear without returning to a fixed template.

Apply the collaborative-discussion rule in Execution Boundary at the completion point. If the human-decision gate never passed for the current slice, use Direct Result Mode without the convergence and contract steps. Once a slice enters Decision Mode and is ready to conclude, continue through its convergence gate and final contract.

## 6. Decision-Mode Convergence Gate

Before the final contract, verify:

1. The decision-node coverage audit is complete: every material implementation-affecting node has provenance and coverage, and every consequential branch is traversed, explicitly closed by a recorded decision, or pruned by verified evidence.
2. No selected decision or unresolved inference unlocks another consequential fork.
3. Every changed trigger, state transition, authority boundary, failure policy, and external guarantee has a non-speculative source.
4. Every question passed the human-decision gate.
5. The final contract organizes the selected changes by topic, separates their sources, and includes only necessary supporting facts and preserved boundaries.
6. Every material implementation-affecting claim has provenance, and no `推断` is presented as `需求` or `决策`.

If a Pending decision remains unresolved, ask only the next frontier question.

## 7. Build One Single-Source Candidate Contract

For a decision-bearing slice, after all decisions converge, assemble one candidate contract organized by change topic. Do not present it for confirmation until it passes independent review. Keep each change's observable behavior, implementation-critical consequences, and independently useful acceptance results together. Apply Claim Provenance within each topic so the user's commitments and agent-derived proposals have distinct source-scoped blocks.

Apply Presentation Density for layout, group naming, and concise source attribution. Facts, changes, and preserved constraints retain their semantic roles; they are not mandatory section names or a fixed display order. Supporting facts may provide concise context for a topic.

Include ownership, interfaces or data shapes, lifecycle, compatibility, failure handling, and boundary guarantees when they cannot be inferred safely from the observable behavior. Add an acceptance result only when it introduces an independently observable condition or consequence, rather than merely paraphrasing the proposal. Omit empty or redundant blocks.

### One Semantic Home

- Include only changes introduced by this alignment as proposed changes.
- Keep each change and its implementation consequences in the same topic, with sources separated locally; do not create separate top-level decision and action summaries.
- Include stable existing constraints only when omission creates material implementation risk, and distinguish them from proposed changes.
- Place supporting facts in clearly scoped context, distinct from commitments and proposals; keep choice costs and rejected alternatives in the question rounds.
- Give each semantic claim one primary home. A diagram, paragraph, table, and acceptance item may restate part of it only when the second form adds a distinct decision, boundary, or independently observable consequence; do not repeat it merely to fill a template or change the wording.

Use a verification table only when it compresses at least three branching scenarios. Keep its rows out of adjacent prose.

Preserve implementation-critical detail: source-of-truth ownership, identities and state dimensions, state transitions, core contracts, compatibility and migration rules, concurrency and failure guarantees, strategic boundaries, and independently verifiable acceptance conditions. When an entity, schema, enum, field, interface, or state machine is part of the decision, keep its shape concrete and copyable.

Exclude PR plans, unaffected call-site inventories, local test file names, shell commands, routine guards, and syntax-level advice unless the user's decision directly concerns them.

## 8. Apply Independent Review

Review depth is driven by risk rather than output mode. Review a Direct Result when concrete impact, reversibility, authority, material data effects, compatibility, security, or governing project rules warrant independent scrutiny. Review its evidence and proposed remedy without converting it into a contract. If review discovers a consequential fork, move that slice into Decision Mode.

Across both modes, resolve substantiated findings and obtain targeted re-review after material revisions. If a correctness blocker remains unresolved, report the blocker instead of the proposed result.

Every decision-bearing candidate contract must be sent to an independent Reviewer who did not form the proposal before asking the user to confirm. Supply:

- the original goal and verified facts, plus each material claim's source and evidence location or corresponding user expression from the coverage ledger or decision record;
- the candidate contract, selected approach, and its material costs;
- rejected branches with their rejection reasons;
- remaining assumptions and explicit risk boundaries.

When a Direct Result receives risk-triggered independent review, supply the coverage ledger or a concise summary of its material nodes, provenance, coverage, and any critical-boundary inference that was checked by the human-decision gate. When no review is triggered, retain the ledger as internal traceability rather than presenting it to the user.

Ask the Reviewer to assess whether the evidence supports the conclusion, whether provenance is preserved, and whether the overall solution is correct, applicable, maintainable, compatible, and proportionate to the demonstrated risks. Review quality is based on those outcomes, not on selecting the smallest possible change. The Reviewer must identify speculation presented as a requirement and support each finding with concrete evidence and impact.

Treat a rejected branch as closed unless new evidence appears, its rejection rationale conflicts with evidence, the candidate fails the contract, or a previously omitted major risk is discovered. A preference for another design is insufficient to reopen it.

Resolve substantiated findings in the candidate. If a finding introduces a consequential human decision, return to the active decision frontier. If independent review cannot execute or leaves a supported finding unresolved, report the blocker and stop before confirmation.

*Completion Criterion*: The reviewed direct result or candidate contract has no unresolved substantiated findings and remains traceable to verified evidence and, when applicable, the recorded decisions.

## 9. Present and Confirm Decision-Bearing Results

Present the reviewed contract once using the topic organization and source separation from section 7.

Ask for confirmation with exactly these meanings, localized for the user: `1. Approved to implement; 2. Items need adjustment`. Apply Confirmation and Authorization to the approved contract, then end alignment. If the same reply explicitly directs implementation, hand off immediately to the applicable implementation workflow; do not require execution intent to be repeated.
