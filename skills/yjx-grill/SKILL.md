---
name: yjx-grill
description: Stress-test a plan, architecture, or complex decision through evidence-backed decision-tree exploration, then conclude directly or produce a concise implementation-ready alignment contract.
disable-model-invocation: true
---

# yjx-grill

Align a human and an agent on complex requirements, architectures, remediation strategies, or plans before execution. Investigate facts autonomously, ask only for consequential human judgment, and keep conclusions focused on what changed and what must happen next.

Read `MAINTENANCE.md` before reviewing or changing this skill. It is not needed for ordinary execution.

## Execution Boundary

- This is a user-invoked alignment skill.
- Do not write application code, modify repository source files, or execute the aligned plan.
- Render every user-facing label and bold template key in the user's conversational language.
- A zero-decision discussion ends with a direct conclusion. A discussion with human decisions ends after the final contract is confirmed.

## 1. Establish Facts Before Asking Intent

Use tools for objective facts: existing code, schemas, logs, current state, task text, dependencies, and available assets. Do not ask the user to discover facts the agent can verify.

Use questions for human intent, irreversible trade-offs, business priorities, authority ownership, or guarantees.

For defects or reality gaps, investigate the causal chain before presenting remediation choices. When a primer is useful, keep it compact:

- **Symptom**: actor, action, observable failure.
- **Break**: the smallest direct call tree, state comparison, diff, or mechanism.
- **Assessment**: defect nature and eliminated pseudo-causes.

After the first primer, report only changed facts. If investigation establishes the root cause and no consequential trade-off remains, lead with the conclusion and required actions, place any necessary evidence last, and stop.

## 2. Slice the Problem

If the request spans independent domains or lifecycle boundaries, split it into cohesive capability slices. Finish one slice before opening the next. Do not merge unrelated decisions into one contract.

## 3. Prove a Human Decision Exists

Before writing a question, identify the unresolved choice and why the agent cannot infer it safely. It is a human decision only when reversal would require structural redesign, data migration, irreversible resource use, broken external guarantees, authority changes, or a materially different remediation strategy.

Use this gate:

```text
The user must decide <choice> because either answer materially changes <cost, guarantee, ownership, or strategy>.
```

If that sentence cannot be completed with verified consequences, ask zero questions. Infer low-reversal-cost mechanics, routine parameters, and local technical defaults, then give the conclusion directly. Routine implementation details belong in neither question cards nor final contract topics. Do not turn tooling obstacles, missing permissions, or speculative causes into question cards.

## 4. Traverse the Active Decision Frontier

Ask zero to three orthogonal questions per round; zero is the default until the gate passes.

- A question is orthogonal only if it remains necessary regardless of the other answers in that round.
- Ask pivots first: source of truth, ownership, external contract, irreversible state transition, consistency, and failure policy.
- A selected option may unlock downstream questions; continue until no unresolved human decision remains.
- Use verified assets to prune impossible or already-implemented options before asking.
- Mention a next frontier only when the answer unlocks another consequential fork.

### Compact Question Card

Ask only the unresolved choice. Use the minimum fields needed to compare real alternatives:

```markdown
### Q<N>: <decision>

1. **<recommended choice>**【recommended】
   - **Decision**: <behavior or boundary selected>
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
- Show only facts, decisions, or consequences that were added, changed, or removed in the current round.
- Do not reprint answered questions, closed options, unchanged facts, or unchanged contract sections.
- When a new decision invalidates an earlier one, prune the dead branch and its dependent inferences. Reopen only the conflicting human decision.
- For a custom answer, extract the commitment, explicit overrides, and hard constraints; derive remaining low-risk mechanics without another questionnaire.

If the user asks for clarification, pause the round, answer only that clarification, and wait. Do not append unanswered cards in the same turn.

If the user says the discussion is unclear, too complex, or asks what is actually being changed, discard the current presentation and answer only:

1. what the agent was asking;
2. what would actually change;
3. whether any part genuinely requires the user's decision.

If no human decision remains, conclude directly. Do not rebuild the same material as another question set or contract.

## 6. Convergence Gate

Before the final contract, verify:

1. No selected decision unlocks another consequential fork.
2. Every changed trigger, state transition, authority boundary, failure policy, and external guarantee has a non-speculative source.
3. Every question passed the human-decision gate.
4. The final contract contains only changed decision topics, materially necessary unchanged boundaries, and evidence needed by the selected path.

If a human decision remains unresolved, ask only the next frontier question.

## 7. Produce One Single-Source Alignment Contract

After all decisions converge, output the complete result once. Organize changed content by decision topic so each change and its implementation consequences stay together:

```markdown
## <Changes>

### <decision topic>

- **Expected behavior**: observable result and applicable condition.
- **Implementation contract**: owner, interface or data shape, decision timing, lifecycle, compatibility, failure handling, and boundary constraints that cannot be inferred from expected behavior.
- **Acceptance**: scenario or input → independently observable result.

## <Necessary unchanged boundaries> <!-- omit by default -->

- <stable constraint whose omission would materially change implementation>

## <Evidence> <!-- omit when no evidence must travel with the result -->

- <verified fact needed to support the selected change>
```

All fields within a decision topic are conditional. A simple change may need one line. Use `Acceptance` only when it adds an observable result rather than restating expected behavior or the implementation contract.

### One Semantic Home

- Include only topics introduced or changed by this alignment.
- Keep a decision and its implementation consequences in the same topic; do not create separate top-level decision and action summaries.
- Place stable existing constraints only in `Necessary unchanged boundaries`, and only when omission creates material implementation risk.
- Place supporting facts only in `Evidence`; keep choice costs and rejected alternatives in the question rounds.
- Express each semantic claim once. A diagram, paragraph, table, and acceptance item must not repeat one another.

Use a verification table only when it compresses at least three branching scenarios. Keep its rows out of adjacent prose.

Preserve implementation-critical detail: source-of-truth ownership, identities and state dimensions, state transitions, core contracts, compatibility and migration rules, concurrency and failure guarantees, strategic boundaries, and independently verifiable acceptance conditions. When an entity, schema, enum, field, interface, or state machine is part of the decision, keep its shape concrete and copyable.

Exclude PR plans, unaffected call-site inventories, local test file names, shell commands, routine guards, and syntax-level advice unless the user's decision directly concerns them.

## 8. Completion

When no human decision existed, end after the direct conclusion without requesting approval.

When human decisions were made, ask for confirmation with exactly these meanings, localized for the user: `1. Approved to implement; 2. Items need adjustment`. After approval, end alignment. If the same reply explicitly directs implementation, hand off immediately to the applicable implementation workflow; do not require execution intent to be repeated.
