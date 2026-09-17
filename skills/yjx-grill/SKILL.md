---
name: yjx-grill
description: Stress-test a plan, architecture, or complex decision through evidence-backed decision-tree exploration, then produce a concise implementation-ready alignment contract.
disable-model-invocation: true
---

# yjx-grill

Align a human and an agent on complex requirements, architectures, remediation strategies, or plans before execution. Investigate facts autonomously, ask only high-impact intent questions, traverse every consequential fork on the selected path, and finish with a single-source implementation contract.

Read `MAINTENANCE.md` before reviewing or changing this skill. It is not needed for ordinary execution.

## Execution Boundary

- This is a user-invoked alignment skill.
- Do not write application code, modify repository source files, or execute the aligned plan.
- The active slice is complete only after the user confirms the final contract.
- Render every user-facing label and bold template key in the user's conversational language.

## 1. Establish Facts Before Asking Intent

Use tools for objective facts: existing code, schemas, logs, current state, task text, dependencies, and available assets. Do not ask the user to discover facts the agent can verify.

Do not use tools for human intent, irreversible trade-offs, business priorities, authority ownership, or guarantees. Ask those directly.

For defects or reality gaps, investigate the causal chain before presenting remediation choices. Output one compact fact primer per capability slice:

- **Symptom**: actor, action, observable failure.
- **Break**: the smallest direct call tree, state comparison, diff, or one-line mechanism; omit a diagram for an isolated defect.
- **Assessment**: defect nature and eliminated pseudo-causes.

After the first primer, report only changed facts. Never reproduce the whole primer in later rounds. If investigation establishes the root cause and no architectural or remediation trade-offs exist, deliver the diagnostic conclusion and verification steps directly, then stop. Do not manufacture synthetic question cards or force contract templates.

## 2. Slice the Problem

If the request spans independent domains or lifecycle boundaries, split it into cohesive capability slices. Finish and confirm one slice before opening the next. Do not merge contracts across slices.

## 3. Separate Decisions by Weight

Classify silently:

### Human Decisions

Ask the user only about choices whose reversal would require structural redesign, data migration, irreversible resource use, broken external guarantees, authority changes, or a materially different remediation strategy.

A decision meeting that redline must not be hidden as an agent default.

### Agent Inferences

Infer low-reversal-cost mechanics, routine parameters, and local technical defaults. Attach only non-obvious inferences to the recommended option. Do not ask standalone questions about implementation details.

Implementation details such as helper names, routine guards, logging, and local formatting never become question cards or final-contract entries.

## 4. Traverse the Active Decision Frontier

- Ask one to three orthogonal questions per round.
- A question is orthogonal only if it remains necessary regardless of the other answers in that round.
- Ask pivots first: source of truth, ownership, external contract, irreversible state transition, consistency, and failure policy.
- A selected option may unlock downstream questions; continue until no unresolved human decision remains.
- Use verified assets to prune impossible or already-implemented options before asking.
- Do not manufacture decision cards from missing permissions, diagnostic obstacles, or speculative causes.
- Include the optional `Next frontier` line only when the choice would unlock another high-impact downstream fork; omit it at leaf decisions.

### Compact Question Card

Use the minimum fields needed to compare real alternatives:

```markdown
### Q<N>: <decision>

1. **<recommended choice>**【recommended】
   - **Decision**: <behavior or boundary being selected>
   - **Cost**: <unavoidable downside>
   - **Critical assumption**: <falsifiable premise>
   - **Companion rule**: <only if non-obvious and implementation-relevant>
2. **<alternative>**
   - **Superior when**: <condition where it wins>
   - **Not selected now**: <current reason>

🔮 **Next frontier**: <only the dependent high-impact fork that this answer may unlock>
```

Do not split one idea across rationale, guarantee, mechanism, boundary, and preview fields. Omit any field that would merely paraphrase another.

Use one optional visual only when it replaces several lines of prose by showing control-flow divergence, a state transition, a data shape, or an ownership boundary. A visual must not repeat adjacent text and must be at most eight lines.

## 5. Handle Answers Without Repetition

Interpret replies by meaning. Only an unambiguous commitment changes decision state.

- Acknowledge an ordinary selection in one line or proceed directly to the next frontier.
- Echo a decision only when clarifying its interpretation, recording a custom override, or explaining a backward cascade that invalidates earlier assumptions.
- Never reprint answered questions, closed options, or unchanged fact primers.
- When a new decision invalidates an earlier one, prune the dead branch and its dependent inferences. Reopen only the conflicting human decision.
- For a custom answer, extract the human commitment, explicit overrides, and hard constraints; derive the remaining low-risk mechanics without another questionnaire.

If the user asks for clarification, pause the round, answer only that clarification, and wait. Do not append the unanswered cards again in the same turn.

## 6. Convergence Gate

Before writing the final contract, verify:

1. No selected decision unlocks another high-impact fork.
2. Every changed trigger, state transition, authority boundary, failure policy, and external guarantee has a non-speculative source.
3. When viable remediation or architecture alternatives exist, they received at least one interactive decision round unless the user explicitly requested zero-interaction output. (Omit grilling if facts are resolved with zero engineering forks).
4. The contract contains only decisions and implementation constraints introduced or changed by this alignment.

If any human decision remains unresolved, ask the next frontier question instead of producing a partial contract.

## 7. Single-Source Implementation Contract

The final output must be directly usable as implementation input while expressing each semantic claim once.

Organize by decision topic:

```markdown
### <decision topic>

- **Expected behavior**: observable result and applicable condition.
- **Implementation contract**: owner, interface or data shape, decision timing, lifecycle, compatibility, failure handling, and boundary constraints (prohibited anti-patterns or shortcuts) that cannot be inferred from expected behavior.
- **Acceptance**: scenario or input → expected result.
```

All three fields are conditional. A simple decision may need one line. A structural decision may include a focused code/schema shape instead of prose.

### One Semantic Home

- Facts belong in the fact primer, not the final contract unless they constrain implementation.
- Costs and rejected alternatives belong in question rounds, not the final contract unless the selected trade-off creates a lasting implementation constraint.
- Observable behavior belongs in `Expected behavior`.
- Structural and lifecycle constraints belong in `Implementation contract`.
- Conditional outcomes belong in `Acceptance`.
- A diagram, paragraph, and table must never express the same claim.

Use a verification table only when it compresses at least three branching scenarios. Do not restate its rows in prose.

### Preserve Implementation-Critical Detail

Concision must not remove:

- source-of-truth and authority ownership;
- identities and dimensions required by state;
- state transitions and terminal handling;
- core entity, schema, enum, field, or method contracts;
- boundary constraints, strategic anti-goals, and prohibited implementation shortcuts;
- compatibility, migration, concurrency, and failure guarantees;
- acceptance conditions needed to verify the change.

Do not include PR plans, unaffected call-site inventories, local test file names, shell commands, routine nil checks, or syntax-level advice.

### De-duplication Check

Before sending the contract, inspect every behavior, constraint, mechanism, and acceptance result. If the same semantic claim appears twice, keep it only in the location most useful to the implementer.

End with one confirmation prompt translated into the user's language. Its meaning must be: `1. Approved to implement; 2. Items need adjustment`. Do not reproduce the English wording when the user's conversational language is different.

## 8. Completion

After the user confirms the final contract, stop. Do not implement until the user gives a separate execution command.
