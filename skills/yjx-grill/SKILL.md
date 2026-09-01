---
name: yjx-grill
description: Stress-test a plan, architecture, or complex decision with dynamic decision-tree exploration, autonomous fact-finding, balanced trade-off cards, and clear separation of human commitments from agent inferences. Use when the user runs /yjx-grill to align deeply and efficiently across any domain without questionnaire fatigue.
disable-model-invocation: true
---

Stress-test requirements, system architectures, and plans thoroughly by exploring and pruning a decision tree. Maximize alignment depth and clarity while minimizing human cognitive fatigue: inquire only about high-impact architectural and business forks, present balanced options with explicit inherent costs, bundle transparent agent inferences with discarded alternatives, and deliver a compact 4-part alignment artifact that exposes confirmed behavior, inferred companion rules, and a domain-adaptive execution contract rather than a narrative prose summary.

## Maintenance

When reviewing, modifying, or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It contains the skill's design metadata and anti-drift rules; it is not needed for ordinary `/yjx-grill` execution.

## 1. Fact Autonomy (Never Ask Knowable Facts)

Before formulating questions, independently investigate the environment (codebase, schemas, configuration files, existing protocols, research notes, or domain materials) using available search/read tools and subagents.
- Never ask the user about discoverable facts, existing models, or verifiable context.
- Use discovered facts to prune impossible or irrelevant branches before presenting questions.

## 2. Scope Slicing & Decision Taxonomy

### Scope Slicing (For Large Endeavors)
When an initiative spans multiple distinct subsystems, phases, or lifecycle boundaries (e.g., Auth vs. Billing vs. Reporting; or Transport vs. Lodging vs. Activities):
- Do NOT mix all subsystems into one monolithic grilling session.
- Decompose into naturally cohesive **Capability Slices** based on independent domain or lifecycle boundaries, and process them sequentially: complete and confirm the artifact for Slice N before starting Slice N+1.
- Do not merge contracts across slices.

### Two-Tier Decision Taxonomy (Strict Weight Separation)
Classify every element in the design silently into one of two tiers:
- **User Decisions (P0 / Highest Weight -> User-Confirmed Commitments)**:
  - Scope: True source of truth / authority ownership, foundational architecture/strategy trade-offs, boundary contracts, irreversible state transitions, and hard constraints.
  - Action: **The ONLY tier presented as direct questions to the user.** These form the active nodes of the decision tree. When an option is chosen, any downstream forks it unlocks must continue to be explored across rounds until all high-impact forks on the chosen path are resolved. Once agreed, these become high-weight commitments in Part 1 of the artifact.
- **Agent Inferences (P1 / Default Companion Rules -> Agent-Inferred Defaults)**:
  - Scope: Concrete edge cases, fallback strategies, retry limits, backoff rules, timeouts, localized thresholds, validation rules, or default parameters.
  - Action: **Never asked as standalone questions.** Instead, bundle them visibly into Option 1 (or the matching companion package for a custom user decision) as adopted defaults accompanied by **explicitly discarded alternative approaches and their discard rationale**. Once accepted or inferred, they appear in Part 2 for fast, individual review and override.
- **Implementation Details (Sub-P1)**: Localized helper functions, internal variable names, minor phrasing — decided autonomously per domain conventions and neither asked nor highlighted.

## 3. Dynamic Frontier Exploration & Balanced Question Cards

### Strict Orthogonality & Frontier Traversal
- **Dynamic Frontier Exploration**: The grilling session is a decision-tree traversal along the active path. Settling a decision unblocks downstream forks (the new frontier) on the chosen branch.
- **Strict Orthogonality Gate**: In any round, batch ONLY questions (1 to 3 questions) that must still be answered regardless of how other open questions in that round resolve. If question B depends on an option in question A, defer B to a later round.
- **Pivots First**: Prioritize questions that could fundamentally reshape the tree or architecture over detail questions.
- **No Arbitrary Depth Limit**: Continue iterating across rounds until the active frontier contains no more unresolved forks and is reduced entirely to deterministic agent inferences.

### Balanced Question & Option Format
Never present biased, one-sided sales pitches. Force critical evaluation by exposing trade-offs, inherent costs, and falsifiable assumptions symmetrically across all choices:

- **Option 1 (Recommended)**:
  - `Core decision`: The primary structural/behavioral path selected.
  - `Recommendation rationale`: The decisive reasons and benefits for prioritizing this path.
  - `⚠️ Costs`: The unavoidable trade-offs, friction, or risks accepted by choosing this path.
  - `❗️ Key assumptions`: Critical falsifiable assumptions whose invalidity immediately breaks the recommendation (marked with `❗️` for critical risks or `⚠️` for notable assumptions).
  - `Companion inferences`: Concrete companion rules adopted, formatted as an indented sub-list:
    - `<Rule Name>: <Adopted default rule> (Rather than: <Alternative A> [<reason>]; <Alternative B> [<reason>])`
- **Options 2+ (Alternative Paths)**:
  - `Core decision`: The alternative path.
  - `Applicable scenarios`: Specific scenarios, priorities, or constraint shifts where this option becomes strictly superior to Option 1.
  - `Unchosen reason`: Why it was deprioritized under current baseline assumptions.
- **Localization**: At runtime, render all user-facing questions, artifact headings, labels, column names, and explanatory text into the user's conversational language. Translate option labels (`Core decision` -> `核心决策`, `Recommendation rationale` -> `推荐理由`, `Costs` -> `⚠️ 代价`, `Key assumptions` -> `❗️ 关键假设`, `Companion inferences` -> `配套推断`, `Applicable scenarios` -> `适用场景`, `Unchosen reason` -> `未选原因`, `Rather than` -> `而非`).

Example format:

```markdown
### ❓ Q1: <Decision Title>
<Brief context or situation description>

1. **<Recommended Approach>** [Recommended]
   * **Core decision**: <The primary behavior selected by this question>
   * **Recommendation rationale**: <The decisive benefits and contextual fit achieved>
   * **⚠️ Costs**: <The unavoidable trade-offs, friction, or risks accepted>
   * **❗️ Key assumptions**: <Material assumptions that must hold true for this option>
   * **Companion inferences**:
     - <Rule Name>: <Adopted default rule> (Rather than: <Alternative A> [<reason>]; <Alternative B> [<reason>])
2. **<Alternative Approach A>**
   * **Core decision**: <Alternative path>
   * **Applicable scenarios**: <Conditions or shifted priorities where this alternative is superior>
   * **Unchosen reason**: <Why this alternative is deprioritized under current baseline>
```

## 4. Special Interactions (Clarifications & Inquiries)

If the user asks for more context, background explanation, or clarification before answering (e.g., "What does this term mean?" or "Why did you choose this over alternative B?"):
- **Pause the round immediately.**
- Provide the explanation in plain conversational text and wait.
- Do NOT re-ask or re-dump the unanswered questions in the same turn.
- After the user understands the context, resume the unanswered questions.

## 5. Resolution, Custom Overrides & Cascade Impact Protocol

Interpret replies by meaning rather than rigid format. **Only an unambiguous commitment changes decision state; non-committal input informs analysis without settling a decision.**

### Modular Overrides & Custom Decisions
When the user provides a custom answer, a modular override (e.g., "Option 1 core, but replace inference I-1 with Alternative B"), or rejects all options:
1. **Semantic Disassembly**: Extract the user's P0 core commitment, explicit P1 companion overrides, and newly introduced hard constraints.
2. **Coherence Check**: Check for internal contradictions. If conflicting, do not force-merge; explain the tension in one sentence and ask a pinpoint alignment question.
3. **Companion Re-derivation**: Autonomously derive a matching set of Agent Inferences (with explicitly evaluated alternatives and reasons) tailored to the custom decision.

### Forward Expansion & Backward Cascade Impact
Every settled decision propagates both forward and backward across the dependency graph:
- **Forward Expansion**: Expand the active frontier along the selected path. If downstream trade-offs open, formulate the next round.
- **Backward Impact (Premise Change & Invalidation)**: If a new decision contradicts or invalidates previously settled nodes:
  - **Prune Dead Branches**: Immediately prune and invalidate all orphaned historical branches, old P1 inferences, and outdated contract drafts. Never allow dead assumptions to leak into the final artifact.
  - **Targeted Re-opening**: If a previously settled P0 node is in direct conflict, pause and re-open only that specific conflicting node for clarification.
  - **Silent Re-computation**: Silently update dependent historical P1 inferences without burdening the user.
- **Cascade Echo**: Before presenting the next round or the final artifact, echo the interpreted commitment and any backward adjustments in a single clear line:
  `🎯 Confirmed Decision [Q<N>]: <interpretation>; (Cascade note: <pruned/updated historical assumptions>)`.

## 6. Domain-Adaptive 4-Part Alignment Artifact

Once the active frontier is empty (all User Decisions on the active path are settled and only Agent Inferences remain), output ONLY a compact 4-part alignment artifact in the order below. Do NOT write a narrative prose summary. The artifact exists to expose any mismatch between human intent and the agent's execution model before work begins.

Translate all artifact headings, labels, and explanatory text into the user's conversational language. Keep internal tier labels (P0/P1) out of the artifact.

1. **User Commitments & Core Model (用户决策与核心模型 - 场景化行为流)**:
   Present only explicit human commitments as a self-contained **Scenario-Driven Behavior Flow (场景化行为流)**. Avoid wide multi-column matrices or abstract state tables that force the reader to mentally piece together fragmented cells. Format as a numbered list of exhaustive, mutually exclusive business scenarios:
   - **Scenario Formula**: `N. **[<Scenario Name>]** When <Trigger Event / Condition> ➔ <Core Action / State Transition>, ensuring <Observable Invariant / Result>`
   - **Exhaustive Coverage**: Systematically cover normal execution (happy path), failure & degradation, timeouts, idempotency (late responses & anti-reversal), and defensive error handling.
   - Preserve every confirmed condition, scope, unchanged outcome, failure path, and forbidden transition. Place no agent-inferred parameters or implementation choices here.

2. **Agent Inferences (AI推断 / 配套推断 - Transparent & Individually Adjustable)**:
   Group the concrete inferred companion rules in the same domain order as the core model. Give each rule a stable local identifier (e.g., `I-1`, `I-2`) so the user can revise or override one item without reopening the entire slice.
   - Present as a compact, structured list (or concise table without multiline wrapping clutter):
     `* **<ID>** [❗️/⚠️] **<Rule Name>**: <Adopted default rule> (Rather than: <Alternative A> [<reason>]; <Alternative B> [<reason>]) ➔ <Observable Consequence>`
   - Classify material items by review priority: Mark items whose mistake could change authority, ownership, safety, irreversible effects, or core protocol shape with `❗️`. Mark other material items with `⚠️`. Keep remaining baseline items without a marker.
   - Expose concrete edge cases, limits, ordering, retries, fallbacks, concurrency, and default policies.

3. **Execution Specification / Concrete Contract (落地执行规格 / 契约)**:
   Project the first two sections into exact, domain-adaptive, actionable definitions matching the target problem space without speculative placeholders:
   - **Software Engineering**: Exact repository-grounded definitions (Protobuf messages/RPCs, HTTP routes/schemas, database tables, domain types, or structs) with standard business comments.
   - **Planning & Operations (e.g., Travel, Projects, Events)**: Exact execution tables (booking/itinerary matrices, daily timetables, budget allocation tables, checklist specifications, or deliverable standards).
   - Strictly NO unconfirmed or speculative fields, states, routes, or behaviors.

4. **Forbidden Paths (禁止事项 - Anti-Goals & Exclusions)**:
   List only concrete implementation or execution paths that could appear compatible with the positive contract but would violate the aligned intent (e.g., unauthorized state mutation, silent fallback, unvetted intermediate steps, disallowed shortcuts). Omit generic platitudes.

## 7. Completion & Execution Boundary

- **Stop Condition**: The active slice is complete only after the user explicitly confirms all four parts of the alignment artifact defined in Section 6. If multiple slices exist, confirm each slice before advancing and stop after the final confirmed slice.
- **Execution Boundary**: Do NOT write application code, modify repository source files, or execute implementation actions within this skill. Stop immediately after delivering the confirmed artifact and wait for the user's next command.
