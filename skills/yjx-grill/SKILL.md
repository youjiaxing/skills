---
name: yjx-grill
description: Stress-test a plan, architecture, or complex decision through evidence-backed decision-tree exploration, then report a direct result or produce a concise implementation-ready alignment contract.
disable-model-invocation: true
---

# yjx-grill

Align a human and an agent on complex requirements, architectures, remediation strategies, or plans before execution. Investigate facts autonomously, ask only for consequential human judgment, and keep results focused on what changes, what remains unchanged, and what awaits a decision.

Read `MAINTENANCE.md` before reviewing or changing this skill. It is not needed for ordinary execution.

## Execution Boundary

- This is a user-invoked alignment skill.
- Do not write application code, modify repository source files, or execute the aligned plan.
- Render every user-facing label and bold template key in the user's conversational language.
- A discussion where the human-decision gate never passes ends with a direct result. A discussion where the gate passes ends after the final contract is confirmed.

## 1. Establish Facts Before Asking Intent

Use tools for objective facts: existing code, schemas, logs, current state, task text, dependencies, and available assets. Do not ask the user to discover facts the agent can verify.

Use questions for human intent, irreversible trade-offs, business priorities, authority ownership, or guarantees.

For defects or reality gaps, investigate the causal chain before presenting remediation choices. When a primer is useful, place it under Facts and keep it compact:

- **Symptom**: actor, action, observable failure.
- **Break**: the smallest direct call tree, state comparison, diff, or mechanism.
- **Assessment**: defect nature and eliminated pseudo-causes.

After the first Facts section, report only newly established information under the applicable roles. If investigation establishes the root cause and no consequential trade-off remains, report the applicable roles in their defined order and stop.

## 2. Slice the Problem

If the request spans independent domains or lifecycle boundaries, split it into cohesive capability slices. Finish one slice before opening the next. Do not merge unrelated decisions into one contract.

## 3. Prove a Human Decision Exists

Before writing a question, identify the unresolved choice and why the agent cannot infer it safely. It is a human decision only when reversal would require structural redesign, data migration, irreversible resource use, broken external guarantees, authority changes, or a materially different remediation strategy.

Use this gate:

```text
The user must decide <choice> because either answer materially changes <cost, guarantee, ownership, or strategy>.
```

If that sentence cannot be completed with verified consequences, ask zero questions. Infer low-reversal-cost mechanics, routine parameters, and local technical defaults, then report the applicable Facts, Changes, or Unchanged directly. Routine implementation details belong in neither question cards nor final contract topics. Do not turn tooling obstacles, missing permissions, or speculative causes into question cards.

## 4. Traverse the Active Decision Frontier

Ask zero to three orthogonal questions per round; zero is the default until the gate passes.

- A question is orthogonal only if it remains necessary regardless of the other answers in that round.
- Ask pivots first: source of truth, ownership, external contract, irreversible state transition, consistency, and failure policy.
- A selected option may unlock downstream questions; continue until no unresolved human decision remains.
- Use verified assets to prune impossible or already-implemented options before asking.
- Mention a next frontier only when the answer unlocks another consequential fork.

### Four Information Roles

Classify top-level informational content with exactly four roles, localize their labels, keep the order shown below, and omit empty sections:

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

## 5. Keep Discussion Incremental

Interpret replies by meaning. Only an unambiguous commitment changes decision state.

- Acknowledge an ordinary selection in one line or proceed directly to the next frontier.
- Show only Facts, Changes, Unchanged, or Pending decisions added, revised, or removed in the current round.
- Do not reprint answered questions, closed options, Facts already shown, or contract sections whose content did not change.
- When a new decision invalidates an earlier one, prune the dead branch and its dependent inferences. Reopen only the conflicting human decision.
- For a custom answer, extract the commitment, explicit overrides, and hard constraints; derive remaining low-risk mechanics without another questionnaire.
- Retain a decision record for final review: the selected approach and its costs, rejected branches and rejection reasons, remaining assumptions, and explicit risk boundaries. Keep this record out of the user-facing final contract.

If the user asks for clarification, pause the round, answer only that clarification, and wait. Do not append unanswered cards in the same turn.

If the user says the discussion is unclear, too complex, or asks what is actually being changed, make a one-time exception to the incremental display rule: discard the current presentation and restate the current slice under Facts, Changes, Unchanged, and Pending decisions.

If the human-decision gate never passed, report the result directly and stop. Once any Pending decisions have been answered, continue through the convergence gate and final contract.

## 6. Convergence Gate

Before the final contract, verify:

1. No selected decision unlocks another consequential fork.
2. Every changed trigger, state transition, authority boundary, failure policy, and external guarantee has a non-speculative source.
3. Every question passed the human-decision gate.
4. The final contract contains only Facts needed by the selected path, Changes, and materially necessary Unchanged.

If a Pending decision remains unresolved, ask only the next frontier question.

## 7. Build One Single-Source Candidate Contract

After all decisions converge, assemble the candidate result in the same role order. Do not present it for confirmation until it passes independent review. Organize Changes by topic so each change and its implementation consequences stay together:

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

## 8. Obtain Independent Contract Review

Before asking the user to confirm, send the candidate contract to an independent Reviewer who did not form the proposal. Supply:

- the original goal and verified facts with evidence locations;
- the candidate contract, selected approach, and its material costs;
- rejected branches with their rejection reasons;
- remaining assumptions and explicit risk boundaries.

Ask the Reviewer to assess whether the evidence supports the conclusion and whether the overall solution is correct, applicable, maintainable, compatible, and proportionate to the demonstrated risks. Review quality is based on those outcomes, not on selecting the smallest possible change. The Reviewer must identify speculation presented as a requirement and support each finding with concrete evidence and impact.

Treat a rejected branch as closed unless new evidence appears, its rejection rationale conflicts with evidence, the candidate fails the contract, or a previously omitted major risk is discovered. A preference for another design is insufficient to reopen it.

Resolve substantiated findings in the candidate. If a finding introduces a consequential human decision, return to the active decision frontier. Obtain targeted re-review after material revisions. If independent review cannot execute or leaves a supported finding unresolved, report the blocker and stop before confirmation.

*Completion Criterion*: The candidate has no unresolved substantiated review findings and remains traceable to verified evidence and the recorded decisions.

## 9. Present and Confirm

Present the reviewed contract once in the format from section 7.

When the human-decision gate never passed, end after the direct result without requesting approval.

When human decisions were made, ask for confirmation with exactly these meanings, localized for the user: `1. Approved to implement; 2. Items need adjustment`. After approval, end alignment. If the same reply explicitly directs implementation, hand off immediately to the applicable implementation workflow; do not require execution intent to be repeated.
