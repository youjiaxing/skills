---
name: yjx-grill
description: Stress-test a design, architecture, or plan with dynamic decision tree exploration, autonomous fact-finding, explicit discarded alternatives, and clear separation of user decisions from agent inferences. Use when the user runs /yjx-grill to align deeply and efficiently without questionnaire fatigue.
disable-model-invocation: true
---

Stress-test requirements and system designs thoroughly by exploring and pruning the decision tree. Maximize alignment depth and clarity while minimizing human cognitive fatigue: inquire only about high-impact architectural and business forks, bundle transparent agent inferences with explicit discarded alternatives and reasons, and turn the discussion into a compact alignment artifact that exposes confirmed behavior, inferred companion rules, and their exact technical contract rather than a narrative prose summary.

## Maintenance

When reviewing, modifying, or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It contains the skill's design metadata and anti-drift rules; it is not needed for ordinary `/yjx-grill` execution.

## 1. Fact Autonomy (Never Ask Knowable Facts)

Before formulating questions, independently investigate the codebase, schemas, configuration files, and existing protocols using available search/read tools and subagents.
- Never ask the user about existing code behavior, current data models, or system facts that can be discovered locally.
- Use discovered facts to prune impossible or irrelevant branches before presenting questions.

## 2. Scope Slicing & Decision Taxonomy

### Scope Slicing (For Large Features)
When a feature spans multiple distinct subsystems or lifecycle boundaries (e.g., Signup vs. Matchmaking vs. Settlement):
- Do NOT mix all subsystems into one monolithic grilling session.
- Decompose into naturally cohesive **Capability Slices** based on independent domain or lifecycle boundaries, and process them sequentially: complete and confirm the artifact for Slice N before starting Slice N+1.
- Do not merge contracts across slices.

### Two-Tier Decision Taxonomy (Strict Weight Separation)
Classify every element in the design silently into one of two tiers:
- **User Decisions (P0 / Highest Weight -> User-Confirmed Decisions)**:
  - Scope: True source of truth / authority ownership, core architectural trade-offs, cross-boundary data flows, irreversible state transitions, and concurrency/transaction boundaries.
  - Action: **The ONLY tier presented as direct questions to the user.** These form the active nodes of the decision tree. When an option is chosen, any downstream architectural or business forks it unlocks must continue to be explored across rounds until all high-impact forks on the chosen path are resolved. Once agreed, these become high-weight commitments in Part 1 of the artifact.
- **Agent Inferences (P1 / Default Companion Rules -> Agent-Inferred Defaults)**:
  - Scope: Concrete edge cases, fallback strategies, retry limits, backoff algorithms, timeouts, dead-letter alarms, and localized threshold values.
  - Action: **Never asked as standalone questions.** Instead, bundle them visibly into Option 1 (or the matching companion package for a custom user decision) as adopted defaults accompanied by **explicitly discarded alternative approaches and their discard rationale**. Once accepted or inferred, they appear in Part 2 for fast, individual review and override.
- **Implementation Details (Sub-P1)**: Localized helper functions, internal variable names, minor error strings — decided autonomously per codebase conventions and neither asked nor highlighted.

## 3. Dynamic Frontier Exploration & Question Round Discipline

- **Dynamic Frontier Exploration**:
  - The grilling session is a **decision tree traversal along the active path**.
  - Settling a decision prunes unchosen alternative branches, but **unblocks any downstream architectural forks (the new frontier)** on the chosen branch.
  - Evaluate the chosen path after each round. If it introduces new non-trivial architectural trade-offs, irreversible state paths, or boundary conflicts, **advance to the next round of questions (1 to 3 questions per round)**.
  - **No arbitrary depth/round limit**: Continue iterating across rounds until the active frontier contains no more unresolved architectural/business forks and is reduced entirely to deterministic agent inferences.
- **Batch Discipline**: Keep each round compact (typically 1 to 3 questions) to avoid cognitive overload; wait for the user's reply before proceeding.
- **Question & Option Format**: Every question must be multiple-choice with 1-based numbered options.
  - Present each option in up to three parts, in this order: **Core decision**, **Key assumptions**, and **Agent inferences**. Omit empty parts.
  - **Option 1**: Recommend the approach that best fits current repository conventions and confirmed decisions in this slice. Include:
    - `Core decision`: The specific behavioral/architectural path selected.
    - `❗️Key assumptions`: Material assumptions that deserve early review (marked with `❗️` for critical risks or `⚠️` for notable assumptions).
    - `Agent inferences`: Concrete companion rules adopted, formatted as: `[<Rule Name>]: <Adopted default> (Discarded: ❌ <Alternative A> [<reason>]; ❌ <Alternative B> [<reason>])`.
  - **Options 2+**: Alternative approaches, accompanied by clear **Discard reason** (why they are not preferred as the primary approach).
  - **Custom User Decisions**: When the user provides a custom answer or rejects all options, extract their core commitment, autonomously derive a matching set of Agent Inferences (with discarded alternatives and reasons), and evaluate whether new downstream frontier questions must be asked in the next round.
- **Localization**: Keep this skill file in English. At runtime, render all user-facing questions, artifact headings, labels, column names, and explanatory text into the user's conversational language. Translate the option-part labels (`Core decision` -> `核心决策`, `Key assumptions` -> `关键假设`, `Agent inferences` -> `AI推断`). Keep internal tier labels (P0/P1) out of user-facing output.

Example format:

```markdown
### ❓ Q1: <Decision Title>
1. **<Recommended Approach>** (Recommended)
   * **Core decision**: <The primary behavior selected by this question>
   * **❗️Key assumptions**: <Material assumptions that deserve first review>
   * **Agent inferences**:
     - [<Rule Name>]: <Adopted default rule> (Discarded: ❌ <Alternative A> [<reason>]; ❌ <Alternative B> [<reason>])
2. **<Alternative Approach A>**
   * **Discard reason**: <Why this alternative is not preferred as the primary approach>
```

## 4. Decision Resolution & Branch Pruning

Interpret replies by meaning rather than format. **Only an unambiguous commitment changes decision state; everything else informs the analysis without settling a decision.**

- Extract every explicit commitment from the reply, whether expressed as an option number, natural language, or a custom decision. Preserve its scope and conditions, and resolve multiple commitments independently.
- For each settled decision, echo the concrete interpretation in one line and prune all unchosen alternative branches.
- Expand the active frontier along the selected branch. If downstream trade-offs remain open, formulate the next round of questions.
- If meaning is ambiguous or conflicts with a settled decision, keep only that point unsettled and ask the minimum question needed to resolve it before advancing.

## 5. 4-Part Alignment Artifact & Verification Order

Once the active frontier is empty (all User Decisions on the active path are settled and only Agent Inferences remain), output ONLY a compact 4-part alignment artifact in the order below. Do NOT write a narrative prose summary. The artifact exists to expose a mismatch between the user's intent and the agent's implementation model before code is written.

Every behavior or policy that can materially change the implementation must appear in exactly one of the first two sections. Keep them physically separate: a user-confirmed decision always takes precedence over an agent inference, and accepting a recommended option never turns an inferred companion rule into a user-confirmed requirement.

Translate all artifact headings, labels, and explanatory text into the user's conversational language. Keep the skill's internal P0/P1 vocabulary out of the artifact.

1. **User Decisions & State Model (用户决策与状态模型)**:
   Present only explicit user commitments. Start with the business states and their meanings, then show the lifecycle in the form that makes change easiest to verify: a state/sequence diagram when order or transition matters, otherwise a compact transition table using `Before State | Trigger / Condition | After State | Observable Result`. Place no agent-inferred limits, retries, fallbacks, performance targets, or implementation choices here.
   - Preserve every confirmed condition, scope, unchanged outcome, failure path, and forbidden transition.
   - State cross-cutting invariants beside the model rather than duplicating them across transitions.
   - This section is high weight: later work may change it only after an explicit user revision.

2. **Agent Inferences (AI推断 - Individually Adjustable & Transparent)**:
   Group the concrete inferred companion rules in the same business order as the behavior model. Give each rule a stable local identifier (e.g., `I-1`, `I-2`) so the user can revise or override one item without reopening the slice.
   - Present as a structured table with columns: `ID | Inferred Rule | Discarded Alternatives & Reasons | Observable Consequence`.
   - Classify material items by review priority. Put items whose mistake could change authority, ownership, state meaning or transition, cross-boundary behavior, permission, an irreversible effect, or the protocol shape first and mark them with `❗️`. Put other material items next and mark them with `⚠️`. Keep remaining material items after them without a marker.
   - For each item, state the concrete inference, the discarded alternatives with discard reasons, and the resulting observable consequence.
   - Expose material limits, ordering, retries, fallbacks, concurrency, lifecycle, failure handling, and performance policies. Do not hide them inside the technical contract.
   - These remain agent-inferred even when accepted with a recommended option; they are default implementation baselines, not user-originated decisions.

3. **Technical Contracts (技术契约)**:
   Project the first two sections into exact definitions matching the target repository stack, such as Protobuf messages and RPCs, HTTP method/path/request/response/errors, database schemas, domain types, or language-native state models. No abstract pseudocode.
   - The contract must make the implementation model precise enough for the user to catch incorrect fields, states, ownership, write authority, protocol shape, and collaboration boundaries before implementation.
   - Use repository-standard business comments to explain each definition's role, owner, lifecycle, field semantics, and non-obvious invariants. Comments serve alignment by making the agent's interpretation explicit; they are not a tutorial.
   - Keep decision provenance out of code comments: do not add communication meta-tags such as `[Human Confirmed]` or `[Agent Inferred]`.
   - Do not present inferred constants or policies as confirmed requirements. Keep their origin visible in Section 2 even when the technical contract includes them.
   - Strictly NO unconfirmed or speculative fields, states, RPCs, routes, errors, or behaviors.

4. **Forbidden Paths (禁止事项 - Anti-Goals)**:
   List only concrete implementation paths that could appear compatible with the positive contract but would violate the aligned intent, such as unauthorized state mutation, silent fallback, local recomputation of authoritative state, or a disallowed intermediary layer. Omit generic engineering platitudes.

## 6. Completion & Boundary

- **Stop Condition**: The active slice is complete only after the user explicitly confirms all four parts of the alignment artifact defined in Section 5. If multiple slices exist, confirm each slice before advancing and stop after the final confirmed slice.
- **Execution Boundary**: Do NOT write application code or modify codebase source files within this skill. Stop immediately after delivering the confirmed artifact and wait for the user's next command.
