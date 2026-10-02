---
name: yjx-grill
description: Uncover the problem behind a request, stress-test goals and proposed solutions through evidence-backed discussion, and deliver a concise result or a reviewed, implementation-ready alignment contract.
disable-model-invocation: true
---

# yjx-grill

Understand the problem the user needs to solve before aligning a solution for execution. Investigate facts autonomously, test the user's proposed remedy against the desired outcome, and ask only for unresolved core intent or consequential human judgment. Match the result to the actual stakes, not to whether a question was asked.

Read [MAINTENANCE.md](MAINTENANCE.md) before reviewing or changing this skill; ordinary execution does not require it.

## Execution Boundary

- This is a user-invoked alignment skill. Investigate without repository or external mutations; do not implement the aligned plan. Execution belongs to a separately authorized implementation workflow.
- Render user-facing labels and template keys in the user's conversational language.
- Choose the delivery form per capability slice under section 6. Independent slices do not share one approval.

When the user explicitly requests collaborative discussion, present an adjustable synthesis and allow feedback even if no question remains. Interpret readiness to conclude by meaning, not a fixed phrase: agreement with a complete stated result can conclude discussion, while agreement with one proposal does not settle remaining work. Do not repeatedly reconfirm the same unchanged result. Discussion completion is not execution authorization and does not remove required review or formal approval.

Allowing feedback is not an additional confirmation gate. When no user-owned decision or required approval remains, state the result and current status, then continue ready work within the agreed scope or conclude; do not leave an unspecified request to validate the result as a waiting point. Unconfirmed material premises remain pending, not implicitly accepted.

## Presentation Density

Use the question-first layout in section 5 for discussion questions. Organize explanations and results by their actual subject, with short topic headings when several outcomes need separate treatment. A short, single-topic reply needs no heading. Keep behavior, important consequences, and acceptance local to the topic they support; internal capability-slice terminology is not display vocabulary.

Preserve provenance through accurate wording, not mandatory source-shaped formatting. State confirmed content naturally, using brief attribution where its origin matters. Clearly identify new, unconfirmed proposals and material assumptions at their first appearance; agreement does not turn agent-originated reasoning into a user requirement or a verified fact. Keep complete source/evidence mappings in the private ledger and reviewer handoff, rather than rendering ledger fields to the user.

Blockquotes primarily carry a question's necessary background, not the category "agent proposal." Put options and their trade-offs outside that background. Use prose for a single conclusion and lists for comparable or actionable items; omit empty categories and stock introductions.

Before sending, check the actual draft: the user can locate the question, understand why it matters, and distinguish confirmed content from new suggestions or uncertain claims. Give each semantic claim one primary home; repeat it only when the second occurrence adds a distinct boundary or independently observable consequence. Keep the internal record and implementation-critical content complete.

## 1. Understand the Problem and Test Premises

Distinguish the user's observed difficulty, their explanation of its cause, and their proposed remedy or target. A request for a particular solution may express a surface problem rather than the desired outcome. Work from concrete experience toward the practical difficulty and the change the user needs, then test candidate solutions against that outcome.

When this is unclear, ask about a recent instance, what the user was trying to accomplish, what got in the way, or what would be different if the problem were solved. Use focused, open questions when choices would prematurely frame the answer. Do not require the user to diagnose or precisely name the underlying problem.

Once enough context is available, briefly restate in your own words what you understand the user's goals to be and what problem they are trying to solve. Distinguish the desired outcome, the difficulty preventing it, and any proposed remedy. Synthesize rather than echo the user's wording, and mark inferred causes or deeper needs as tentative.

Make this understanding visible before comparing solutions, and update it when materially changed. If a consequential uncertainty remains, use the restatement as background beneath a focused question in section 5's layout. Otherwise, continue without requiring a separate confirmation turn. If context is insufficient, ask about concrete experience first rather than inventing a diagnosis.

Let the user correct the interpretation before relying on it to change the goal or scope. Do not repeat unchanged restatements or impose a fixed discovery questionnaire.

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
- **Consequential judgment**: accepting costs, guarantees, ownership, authority, or overall strategy remains human-owned. This includes a single known feasible approach whose consequences or conditions need the user's judgment; several alternatives are not required.

Infer routine mechanics, local technical defaults, and preferences that do not affect the goal. Do not ask merely because several implementations exist. Tooling obstacles, missing permissions, and speculative causes are not decision options.

Assess consequence by actual effects: data loss or migration, authority, external commitments, irreversible resource use, structural redesign, and materially different remediation strategies. A one-line change can have irreversible consequences. Unknown effects require investigation, not a low-risk classification. If necessary evidence cannot be obtained, report the specific blocker and keep that branch unresolved.

An important established fact may need a clear explanation without another question. Ask about unresolved intent, acceptability, or conditions, not merely for acknowledgment of facts the agent has already verified.

The question gate and delivery form are separate: clarifying a reversible core intention does not automatically require a formal contract.

When consequential human judgment is required, record `contract required` for that slice immediately. Resolving it, including accepting the only known feasible approach or choosing to preserve current behavior, settles the choice but does not clear this review-and-approval obligation.

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

Decide whether human input is needed before choosing a question format. Use `Q<N>` for genuine questions about intent or judgment and for required formal approval requests, not for every reply. Answer the user's requests for explanation, acknowledge settled choices, and report facts, progress, blockers, or conclusions in ordinary prose unless a new question independently passes the gate. A formatting preference does not justify inventing options or reopening settled choices.

When ready questions remain, lead the round with its first question after at most a brief acknowledgment, not a preliminary diagnosis or proposal. Start each question with a stable `Q<N>` heading that states the actual question. Directly beneath it, put the necessary background in a Markdown blockquote, without a "Context" label or equivalent. Place any options and their trade-offs below and outside the quote.

Make the background sufficient to judge the question: include the established situation or constraints, the unresolved judgment, and what the answer changes, only as needed. Distinguish verified facts, assumptions, and suggestions naturally. Explain unfamiliar terms and cite decisive evidence briefly, but keep the question understandable without opening links. Omit investigation history and option comparisons already covered below. Use one paragraph when enough, without mandatory fields, sentence counts, or fixed lengths; the background must not present the recommended choice as an established premise.

Choose the response form to fit the unresolved judgment:

- **Real alternatives:** number viable options from 1, put the recommendation first with a localized marker, and explain its reasons, real costs, and critical assumptions. Explain when each alternative is preferable and why it is not recommended now. Invite corrections or a custom answer; options aid judgment, not constrain it.
- **One known feasible approach:** describe it, the evidence limiting alternatives, and its material consequences or conditions. Keep infeasibility claims limited to the verified constraints. Ask the actual acceptability or constraint question without inventing competing options or implying the user must accept. If unacceptable, revisit the constraints or investigate further; do not manufacture feasibility.
- **Experience or intent exploration:** ask an open question when examples or a free-form account would reveal more than a premature menu. Give the user enough background to answer without supplying a diagnosis for them.

For example, the layout for alternatives is:

```markdown
**Q1: Which outcome should this change prioritize?**

> The relevant situation, what remains undecided, and what the answer changes.

1. **Approach A (recommended).** What it changes, why it fits, and its cost.
2. **Approach B.** What it changes, when it fits, and why not now.
```

This illustrates layout, not a stock opening question. Open and single-approach questions retain the heading and necessary background, without a forced option list. A proposal followed only by "Do you agree?" is not a substitute for exploring a real unresolved trade-off.

Use a visual only when it replaces prose by clarifying a control-flow, state, data, or ownership divergence; keep it within eight lines without adjacent repetition.

Interpret replies by meaning; only an unambiguous commitment changes a decision. Acknowledge a selection briefly, update coverage, and show only new or changed information. A partial answer leaves other questions pending. For a custom answer, preserve explicit overrides and constraints, deriving low-risk mechanics without another questionnaire.

If a new answer invalidates an earlier branch, discard dependent inferences and reopen only affected choices. Mention a next frontier only when the answer unlocks another material question. If the user asks for clarification, answer only that clarification and wait. If they report confusion, restate the actual change and remaining choice rather than returning to a template.

## 6. Converge and Deliver Each Slice

Convergence requires every material node to have provenance and resolved/pruned coverage, every consequential branch to be traversed, explicitly closed, or pruned with evidence, and no selected choice or inference to conceal a further human fork. Changed triggers, transitions, authority, failure policies, and guarantees need a supported basis. An empty ready frontier with pending nodes is waiting or blocked, not complete.

Choose one of two delivery forms:

- **Direct Result**: no consequential human judgment required formal approval, including cases where only low-risk core intent needed clarification. Use natural prose, not a mandatory contract or a repeat approval request.
- **Formal Contract**: the slice has a recorded `contract required` obligation. Before drafting, reviewing, or requesting approval, read [references/contract.md](references/contract.md) in full. Produce one independently reviewed contract for that slice and obtain explicit approval.

For either form, synthesize the result around the actual problem and intended outcome, then the selected solution with key reasons and accepted costs. Keep related decisions together by topic rather than replaying Q numbers or the conversation. Include relevant boundaries, material assumptions, remaining uncertainties, and the confirmation status or next step. These are content needs, not four mandatory sections: omit empty categories, and let a simple result be one paragraph. New unconfirmed suggestions remain visibly distinct from agreed content; unresolved prerequisites prevent declaring completion.

If new evidence reveals consequential human judgment, record the obligation and address it. Independent review can be required for either form; high-risk results for which no new human choice arose can remain Direct Results.

Apply the collaborative-discussion rule before concluding either form. Complete only the current slice, then activate the next remaining slice. End the overall alignment only when all in-scope slices are complete, or the user explicitly stops, pauses, or narrows the scope; record remaining choices and review/approval obligations without marking them complete.

## 7. Review According to Risk

Every Formal Contract requires an independent Reviewer who did not form the proposal. Review a Direct Result when actual impact, reversibility, authority, data effects, compatibility, security, or governing project rules warrant it. Review does not itself require a contract.

Supply the original goal, verified facts, candidate result, and the relevant coverage record: sources/evidence, pending or constrained boundaries, selected approach and costs, rejected branches and reasons, and remaining assumptions. Ask whether the conclusion is supported and the overall solution correct, applicable, maintainable, compatible, proportionate, and faithful to provenance. Findings require concrete evidence and impact, not design preference.

Resolve substantiated findings and obtain targeted independent re-review after material revisions. A newly discovered human fork returns to the frontier. If required review cannot run or a supported correctness finding remains unresolved, report the blocker rather than delivering the result or requesting approval.

## 8. Preserve Authorization Across Handoff

Distinguish confirming a conclusion, authorizing specified implementation behavior, and directing execution. Approval of a Formal Contract confirms its reviewed conclusion and boundaries; like a discussion answer or Direct Result, it does not by itself grant implementation authority. Record explicit implementation authorization separately, limited to the stated behaviors and boundaries, including disclosed material inferences while preserving their source. Undisclosed defaults receive no authority from that authorization.

These distinctions do not require separate turns. An explicit instruction to implement the reviewed result can confirm it, authorize its implementation, and direct execution together. Permission to implement without a direction to start is not an execution instruction. Preserve earlier explicit authorizations according to their actual wording and scope; do not retroactively expand or revoke them, or infer authorization from ambiguous records.

Material changes to an approved behavior or boundary require renewed alignment, required review, and approval; a conditional approval is an adjustment, not approval of an unrevised contract. Approval does not verify uncertain facts or replace coverage or review.

Hand off only on an explicit execution instruction that still covers the current aligned and authorized scope, including the current reviewed contract where required. An instruction limited to an old plan does not transfer to a materially changed plan; if withdrawn, invalidated, or unclear in scope, obtain a new instruction. A still-valid earlier instruction or one in the approval reply needs no repetition.

A request to execute only an approved subset may be handed off only when it does not depend on unresolved work; retain the remaining alignment items. Calling workflows may require confirmation of their own conclusion, but that does not turn a Direct Result into a Formal Contract or expand implementation authority. Keep sources, reviewed scope, approval, and pending boundaries distinguishable in the handoff.
