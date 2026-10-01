---
name: yjx-grill
description: Stress-test requirements, plans, architectures, or complex decisions through evidence-backed questioning and decision coverage, then deliver a concise result or a reviewed, implementation-ready alignment contract.
disable-model-invocation: true
---

# yjx-grill

Align human intent before execution. Investigate facts autonomously, challenge unsupported premises when evidence warrants it, and ask only for unresolved core intent or consequential human judgment. Match the result to the actual stakes, not to whether a question was asked.

Read [MAINTENANCE.md](MAINTENANCE.md) before reviewing or changing this skill; ordinary execution does not require it.

## Execution Boundary

- This is a user-invoked alignment skill. Investigate without repository or external mutations; do not implement the aligned plan. Execution belongs to a separately authorized implementation workflow.
- Render user-facing labels and template keys in the user's conversational language.
- Choose the delivery form per capability slice under section 6. Independent slices do not share one approval.

When the user explicitly requests collaborative discussion, present an adjustable proposal and wait for feedback even if no question remains. Interpret readiness to conclude by meaning, not a fixed phrase; clarify only when ambiguous. Agreement with a discussion proposal alone is neither discussion completion nor execution authorization. This rule changes automatic stopping, not the risk threshold or confirmation obligations.

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

## 1. Establish Facts and Test Premises

Use tools for objective facts: code, schemas, logs, task text, dependencies, available assets, and current state. Do not ask the user to discover facts the agent can verify, or infer the user's desired outcome merely from existing code.

For a defect, investigate its causal chain before offering remedies. When useful, briefly identify the actor's action and observable failure, the smallest causal mechanism, and eliminated pseudo-causes. Distinguish verified facts from hypotheses needing investigation.

Check the plan against the stated goal and success criteria. Challenge a premise when there is a concrete goal mismatch, a material unsupported assumption, infeasibility, or evidence that a smaller scope would better meet the goal. Explain the evidence and consequence; doing less or nothing may be a valid recommendation. Without such a signal, proceed rather than adding a mandatory "why" interview.

Reopen a closed choice only for new evidence, a contradiction in its rejection rationale, failure of the selected contract, or a previously omitted major risk. Another design preference is insufficient.

## 2. Scope and Schedule the Work

Split independent outcomes into cohesive capability slices, and finish one slice before opening the next. Identify shared prerequisites before treating slices as independent. Keep the remaining slices and dependencies visible in the internal record.

A question is ready only when its factual and decision prerequisites are settled. An investigation in progress is an unsettled prerequisite: continue on ready branches, but wait on those that depend on its result. A question that remains necessary under every answer is still not ready if another answer changes its premises, feasible options, or recommendation.

## 3. Gate Questions by Intent and Consequence

Before asking, identify the unresolved choice, why it matters, and why requirements, verified evidence, established constraints, or the user's explicit delegation do not already settle it. Use either entry:

- **Core intent gap**: the missing intent changes what counts as a successful result, its intended use, or a priority the human owns. Ask even when the resulting change would be cheap to reverse.
- **Consequential trade-off**: verified alternatives materially change cost, guarantees, ownership, authority, or overall strategy, and the choice remains human-owned.

Infer routine mechanics, local technical defaults, and preferences that do not affect the goal. Do not ask merely because several implementations exist. Tooling obstacles, missing permissions, and speculative causes are not decision options.

Assess consequence by actual effects: data loss or migration, authority, external commitments, irreversible resource use, structural redesign, and materially different remediation strategies. A one-line change can have irreversible consequences. Unknown effects require investigation, not a low-risk classification. If necessary evidence cannot be obtained, report the specific blocker and keep that branch unresolved.

The question gate and delivery form are separate: clarifying a reversible core intention does not automatically require a formal contract.

When a consequential human fork is identified, record `contract required` for that slice immediately. Resolving the fork, including choosing to preserve current behavior, settles the choice but does not clear this review-and-approval obligation.

## 4. Maintain Coverage and Provenance

Before the first question, after each reply or material evidence update, and before completing a slice, inventory every material choice or assumption that can change observable behavior, implementation obligations, or risk boundaries. Keep a private ledger with:

- **Provenance**: each material claim has exactly one source and its evidence location or corresponding user expression: `需求` (explicit requirement), `事实` (verified state), `决策` (user-confirmed choice), or `推断` (agent proposal or default).
- **Coverage**: `pending evidence`, `pending human`, `resolved`, or `pruned`, with prerequisites and a reason. For resolved nodes, record whether a requirement, fact, user choice, low-risk inference, or concrete acceptance/review constraint resolves them; for pruned nodes, record the verified evidence or explicit scoped decision that closes the branch.

Unanswered questions and ongoing investigations have valid pending states. They are not resolved merely because they were asked, listed, or assigned a test. Review or acceptance coverage must establish the boundary, not postpone an unknown choice. Important new evidence invalidates affected resolutions and dependent inferences, returning them to a pending state.

Use ownership, source of truth, identity, state transitions, consistency/concurrency, external contracts, failure/retry guarantees, compatibility/migration, security/authority, and overall strategy as critical-boundary heuristics. Inspect the actual consequences and rerun the question gate when an inference touches them. Promote unresolved human-owned choices to the ready frontier once their prerequisites are settled. If no human choice remains, gather evidence or establish concrete acceptance/review coverage; report a blocker only when neither can establish the boundary. Do not merge materially different branches into one familiar-looking default or close a critical boundary on an unconfirmed inference alone.

Source and approval are independent. Approving a proposal does not turn its attached agent inferences into requirements, user-originated decisions, or verified facts. Preserve the mapping in the ledger and reviewer handoff; use Presentation Density for the relevant visible distinctions, not role-field rows or production-code comments.

Retain selected approaches and material costs, rejected branches and their reasons, assumptions, and risk boundaries with the ledger. Keep the full record internal, exposing only what is needed for judgment or review.

## 5. Work the Ready Frontier

Ask zero to three ready, orthogonal questions per round. Each must pass section 3 and remain necessary without changing another question's premises, options, or recommendation. Prioritize pivots such as goal, source of truth, ownership, external guarantees, irreversible transitions, consistency, and failure policy. Prune impossible or already-settled options with evidence.

Keep `Q<N>` identifiers, number options from 1, and place the recommended option first with a localized marker. Explain unfamiliar terms and the concrete consequence only as needed. Explain the recommendation's real costs and critical assumptions; say when alternatives are preferable and why they are not recommended now. Distinguish hypothetical examples from facts. There is no fixed question-card field schema.

Use a visual only when it replaces prose by clarifying a control-flow, state, data, or ownership divergence; keep it within eight lines without adjacent repetition.

Interpret replies by meaning; only an unambiguous commitment changes a decision. Acknowledge a selection briefly, update coverage, and show only new or changed information. A partial answer leaves other questions pending. For a custom answer, preserve explicit overrides and constraints, deriving low-risk mechanics without another questionnaire.

If a new answer invalidates an earlier branch, discard dependent inferences and reopen only affected choices. Mention a next frontier only when the answer unlocks another material question. If the user asks for clarification, answer only that clarification and wait. If they report confusion, restate the actual change and remaining choice rather than returning to a template.

## 6. Converge and Deliver Each Slice

Convergence requires every material node to have provenance and resolved/pruned coverage, every consequential branch to be traversed, explicitly closed, or pruned with evidence, and no selected choice or inference to conceal a further human fork. Changed triggers, transitions, authority, failure policies, and guarantees need a supported basis. An empty ready frontier with pending nodes is waiting or blocked, not complete.

Choose one of two delivery forms:

- **Direct Result**: no consequential human trade-off arose, including cases where only low-risk core intent needed clarification. Lead with the conclusion and necessary causal facts; include the agreed intent, selected remedy, material assumptions, and boundaries as relevant. Use natural prose, not a mandatory contract or a repeat approval request.
- **Formal Contract**: the slice has a recorded `contract required` obligation. Before drafting, reviewing, or requesting approval, read [references/contract.md](references/contract.md) in full. Produce one independently reviewed contract for that slice and obtain explicit approval.

If new evidence reveals a consequential fork, record the obligation and traverse it. Independent review can be required for either form; high-risk results for which no new human choice arose can remain Direct Results.

Apply the collaborative-discussion rule before concluding either form. Complete only the current slice, then activate the next remaining slice. End the overall alignment only when all in-scope slices are complete, or the user explicitly stops, pauses, or narrows the scope; record remaining choices and review/approval obligations without marking them complete.

## 7. Review According to Risk

Every Formal Contract requires an independent Reviewer who did not form the proposal. Review a Direct Result when actual impact, reversibility, authority, data effects, compatibility, security, or governing project rules warrant it. Review does not itself require a contract.

Supply the original goal, verified facts, candidate result, and the relevant coverage record: sources/evidence, pending or constrained boundaries, selected approach and costs, rejected branches and reasons, and remaining assumptions. Ask whether the conclusion is supported and the overall solution correct, applicable, maintainable, compatible, proportionate, and faithful to provenance. Findings require concrete evidence and impact, not design preference.

Resolve substantiated findings and obtain targeted independent re-review after material revisions. A newly discovered human fork returns to the frontier. If required review cannot run or a supported correctness finding remains unresolved, report the blocker rather than delivering the result or requesting approval.

## 8. Preserve Authorization Across Handoff

Distinguish acknowledging a conclusion, authorizing specified implementation behavior, and directing execution. A discussion answer or a Direct Result is not automatically implementation authorization. Formal approval authorizes only the reviewed contract's listed behaviors and boundaries, including disclosed material inferences while preserving their source. Undisclosed defaults receive no authority from that approval.

Material changes to an approved behavior or boundary require renewed alignment and approval; a conditional approval is an adjustment, not approval of an unrevised contract. Approval does not verify uncertain facts or replace coverage or review.

Hand off only on an explicit execution instruction that still covers the current aligned and authorized scope, including the current reviewed contract where required. An instruction limited to an old plan does not transfer to a materially changed plan; if withdrawn, invalidated, or unclear in scope, obtain a new instruction. A still-valid earlier instruction or one in the approval reply needs no repetition.

A request to execute only an approved subset may be handed off only when it does not depend on unresolved work; retain the remaining alignment items. Calling workflows may require confirmation of their own conclusion, but that does not turn a Direct Result into a Formal Contract or expand implementation authority. Keep sources, reviewed scope, approval, and pending boundaries distinguishable in the handoff.
