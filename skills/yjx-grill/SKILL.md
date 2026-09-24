---
name: yjx-grill
description: Stress-test a plan, architecture, or complex decision through evidence-backed decision-tree exploration, then report a direct result or produce a concise implementation-ready alignment contract.
disable-model-invocation: true
---

# yjx-grill

Align a human and an agent on complex requirements, architectures, remediation strategies, or plans before execution. Investigate facts autonomously, ask only for consequential human judgment, and make the user-facing result proportional to the decisions the case actually contains.

Read `MAINTENANCE.md` before reviewing or changing this skill. It is not needed for ordinary execution.

## Execution Boundary

- This is a user-invoked alignment skill.
- Do not write application code, modify repository source files, or execute the aligned plan.
- Render every user-facing label and bold template key in the user's conversational language.
- Select the output mode independently for each capability slice. A slice where the human-decision gate never passes ends with a direct result. A decision-bearing slice ends after its final contract is confirmed.

## 1. Establish Facts Before Asking Intent

Use tools for objective facts: existing code, schemas, logs, current state, task text, dependencies, and available assets. Do not ask the user to discover facts the agent can verify.

Use questions for human intent, irreversible trade-offs, business priorities, authority ownership, or guarantees.

For defects or reality gaps, investigate the causal chain before presenting remediation choices. When a primer is useful, keep it compact:

- **Symptom**: actor, action, observable failure.
- **Break**: the smallest direct call tree, state comparison, diff, or mechanism.
- **Assessment**: defect nature and eliminated pseudo-causes.

If investigation establishes the root cause and no consequential trade-off remains, prepare a Direct Result that leads with the conclusion, explains the causal fact and selected remedy in natural prose, and includes only material boundaries or risks. Apply any review required by section 8 before reporting it, then stop. Headings are optional; do not force the result into the decision-mode roles.

## 2. Slice the Problem

If the request spans independent domains or lifecycle boundaries, split it into cohesive capability slices. Finish one slice before opening the next. Do not merge unrelated decisions into one contract.

## 3. Prove a Human Decision Exists

Before writing a question, identify the unresolved choice and why the agent cannot infer it safely. It is a human decision only when reversal would require structural redesign, data migration, irreversible resource use, broken external guarantees, authority changes, or a materially different remediation strategy.

Use this gate:

```text
The user must decide <choice> because either answer materially changes <cost, guarantee, ownership, or strategy>.
```

If that sentence cannot be completed with verified consequences, ask zero questions. Infer low-reversal-cost mechanics, routine parameters, and local technical defaults, then use Direct Result Mode for that slice. Routine implementation details belong in neither question cards nor final contract topics. Do not turn tooling obstacles, missing permissions, or speculative causes into question cards.

### Per-Slice Output Modes

- **Direct Result Mode**: Use when investigation completes without any unresolved choice passing the human-decision gate. State the conclusion, causal facts, selected remedy, and only material risks or verification boundaries in natural prose. Do not require fixed headings, a contract, or user confirmation.
- **Decision Mode**: Enter as soon as the current slice contains a verified consequential choice that the user must decide. Keep that slice in Decision Mode through its question rounds, convergence, reviewed contract, and confirmation. Other slices choose their mode independently.

Output mode does not determine review depth. Apply independent review according to concrete risk, impact, reversibility, and governing project rules. A reviewed direct result remains a direct result unless review discovers a consequential fork.

## 4. Traverse the Active Decision Frontier

This section applies when the current slice contains a choice that passes the human-decision gate.

Ask zero to three orthogonal questions per round; zero is the default until the gate passes.

- A question is orthogonal only if it remains necessary regardless of the other answers in that round.
- Ask pivots first: source of truth, ownership, external contract, irreversible state transition, consistency, and failure policy.
- A selected option may unlock downstream questions; continue until no unresolved human decision remains.
- Use verified assets to prune impossible or already-implemented options before asking.
- Mention a next frontier only when the answer unlocks another consequential fork.

### Decision-Mode Information Roles

In Decision Mode, classify top-level informational content with exactly four roles, localize their labels, keep the order shown below, and omit empty sections:

```markdown
### <Facts>

- **<topic>**: <current observable state or behavior>.

### <Changes>

- **<topic>**: <future behavior that implementation will introduce>.

### <Unchanged>

- **<topic>**: <existing behavior or boundary the result preserves>.

### <Pending decisions>

<question cards>
```

Facts contain verified current state or diagnostic findings needed to understand the result. Changes contain future behavior already determined by verified evidence or a selected option, and state it as a future target; unselected behavior stays in its question card. Unchanged exclusively contains preserved current behavior or boundaries that materially constrain the result. Pending decisions contains only choices that pass the human-decision gate. Keep one semantic claim per item.

### Claim Provenance

For material claims that can change implementation, prefix the item with its source. Localize the labels; in Chinese use `需求`, `事实`, `决策`, and `推断`:

- `需求`: explicit requirement or constraint.
- `事实`: verified code, specification, configuration, or runtime state.
- `决策`: user-confirmed choice.
- `推断`: agent proposal or implementation default that remains adjustable.

Apply labels only to behavior, ownership, data source, state, failure policy, protocol, boundary, and abstraction claims. Routine implementation details remain unlabelled. Choosing a recommended option never changes an attached `推断` into a `需求` or `决策`. Carry these labels into the independent-review handoff; do not add them to production-code comments.

### Compact Question Card

Place active question cards under the localized `Pending decisions` heading. Ask only the unresolved choice and use the minimum fields needed to compare real alternatives:

```markdown
#### Q<N>: <pending decision>

1. **<recommended choice>**【recommended】
   - **Outcome**: <behavior or boundary this option selects>
   - **Cost**: <unavoidable downside>
   - **Critical assumption**: <falsifiable premise>
   - **Companion rule**: <only when non-obvious and implementation-relevant>
2. **<alternative>**
   - **Superior when**: <condition where it wins>
   - **Not selected now**: <current reason>

🔮 **Next frontier**: <only when this answer unlocks another consequential fork>
```

Omit fields that would paraphrase another field. Recommended choices must expose their real costs and assumptions; alternatives must state when they are superior.

Use a visual only when it replaces several lines of prose by showing a control-flow divergence, state transition, data shape, or ownership boundary. Keep it within eight lines and do not repeat it in adjacent prose.

## 5. Keep Decision Discussion Incremental

In Decision Mode, interpret replies by meaning. Only an unambiguous commitment changes decision state.

- Acknowledge an ordinary selection in one line or proceed directly to the next frontier.
- Show only Facts, Changes, Unchanged, or Pending decisions added, revised, or removed in the current round.
- Do not reprint answered questions, closed options, Facts already shown, or contract sections whose content did not change.
- When a new decision invalidates an earlier one, prune the dead branch and its dependent inferences. Reopen only the conflicting human decision.
- For a custom answer, extract the commitment, explicit overrides, and hard constraints; derive remaining low-risk mechanics without another questionnaire.
- Retain a decision record for final review: the selected approach and its costs, rejected branches and rejection reasons, remaining assumptions, and explicit risk boundaries. Keep this record out of the user-facing final contract.

If the user asks for clarification, pause the round, answer only that clarification, and wait. Do not append unanswered cards in the same turn.

If the user says the discussion is unclear, too complex, or asks what is actually being changed, discard the current presentation and restate only the relevant content under the information roles. Keep it compact, omit empty roles, and make the pending decision, actual change, and reason human judgment is required immediately clear.

If the human-decision gate never passed for the current slice, use Direct Result Mode and stop that slice before the convergence and contract steps. Once a slice enters Decision Mode, continue through its convergence gate and final contract.

## 6. Decision-Mode Convergence Gate

Before the final contract, verify:

1. No selected decision unlocks another consequential fork.
2. Every changed trigger, state transition, authority boundary, failure policy, and external guarantee has a non-speculative source.
3. Every question passed the human-decision gate.
4. The final contract contains only Facts needed by the selected path, Changes, and materially necessary Unchanged.
5. Every material implementation-affecting claim has provenance, and no `推断` is presented as `需求` or `决策`.

If a Pending decision remains unresolved, ask only the next frontier question.

## 7. Build One Single-Source Candidate Contract

For a decision-bearing slice, after all decisions converge, assemble the candidate result in the same role order. Do not present it for confirmation until it passes independent review. Organize Changes by topic so each change and its implementation consequences stay together:

```markdown
## <Facts> <!-- omit when no supporting facts must travel with the result -->

- <verified fact needed to support the selected change>

## <Changes> <!-- omit when the result requires no changes -->

### <change topic>

- **Expected behavior**: observable result and applicable condition.
- **Implementation contract**: owner, interface or data shape, decision timing, lifecycle, compatibility, failure handling, and boundary constraints that cannot be inferred from expected behavior.
- **Acceptance**: scenario or input → independently observable result.

## <Unchanged> <!-- omit by default -->

- <stable constraint whose omission would materially change implementation>
```

All fields within a change topic are conditional. A simple change may need one line. Use `Acceptance` only when it adds an observable result rather than restating expected behavior or the implementation contract.

### One Semantic Home

- Include only changes introduced by this alignment under `Changes`.
- Keep each change and its implementation consequences in the same topic; do not create separate top-level decision and action summaries.
- Place stable existing constraints only in `Unchanged`, and only when omission creates material implementation risk.
- Place supporting facts only in `Facts`; keep choice costs and rejected alternatives in the question rounds.
- Express each semantic claim once. A diagram, paragraph, table, and acceptance item must not repeat one another.

Use a verification table only when it compresses at least three branching scenarios. Keep its rows out of adjacent prose.

Preserve implementation-critical detail: source-of-truth ownership, identities and state dimensions, state transitions, core contracts, compatibility and migration rules, concurrency and failure guarantees, strategic boundaries, and independently verifiable acceptance conditions. When an entity, schema, enum, field, interface, or state machine is part of the decision, keep its shape concrete and copyable.

Exclude PR plans, unaffected call-site inventories, local test file names, shell commands, routine guards, and syntax-level advice unless the user's decision directly concerns them.

## 8. Apply Independent Review

Review depth is driven by risk rather than output mode. Review a Direct Result when concrete impact, reversibility, authority, material data effects, compatibility, security, or governing project rules warrant independent scrutiny. Review its evidence and proposed remedy without converting it into a contract. If review discovers a consequential fork, move that slice into Decision Mode.

Across both modes, resolve substantiated findings and obtain targeted re-review after material revisions. If a correctness blocker remains unresolved, report the blocker instead of the proposed result.

Every decision-bearing candidate contract must be sent to an independent Reviewer who did not form the proposal before asking the user to confirm. Supply:

- the original goal and verified facts with evidence locations;
- the candidate contract, selected approach, and its material costs;
- rejected branches with their rejection reasons;
- remaining assumptions and explicit risk boundaries.

Ask the Reviewer to assess whether the evidence supports the conclusion, whether provenance is preserved, and whether the overall solution is correct, applicable, maintainable, compatible, and proportionate to the demonstrated risks. Review quality is based on those outcomes, not on selecting the smallest possible change. The Reviewer must identify speculation presented as a requirement and support each finding with concrete evidence and impact.

Treat a rejected branch as closed unless new evidence appears, its rejection rationale conflicts with evidence, the candidate fails the contract, or a previously omitted major risk is discovered. A preference for another design is insufficient to reopen it.

Resolve substantiated findings in the candidate. If a finding introduces a consequential human decision, return to the active decision frontier. If independent review cannot execute or leaves a supported finding unresolved, report the blocker and stop before confirmation.

*Completion Criterion*: The reviewed direct result or candidate contract has no unresolved substantiated findings and remains traceable to verified evidence and, when applicable, the recorded decisions.

## 9. Present and Confirm Decision-Bearing Results

Present the reviewed contract once in the format from section 7.

Ask for confirmation with exactly these meanings, localized for the user: `1. Approved to implement; 2. Items need adjustment`. After approval, end alignment. If the same reply explicitly directs implementation, hand off immediately to the applicable implementation workflow; do not require execution intent to be repeated.
