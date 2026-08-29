---
name: yjx-grill
description: Stress-test a design, architecture, or plan with fast-forward decision tree pruning, autonomous fact-finding, and explicit separation of user decisions from agent inferences. Use when the user runs /yjx-grill to align efficiently without questionnaire fatigue.
disable-model-invocation: true
---

Stress-test requirements and system designs rapidly by pruning the decision tree. Minimize human cognitive load: inquire only about root architectural decisions, bundle visible defaults, and turn the discussion into a compact alignment artifact that exposes confirmed behavior, inferred policies, and their exact technical projection rather than a narrative prose summary.

## Design Intent (Preserve When Revising This Skill)

This skill exists because a long requirements discussion can feel aligned while the agent and user still hold different implementation models; the mismatch is then discovered only after code is written, during review. Its primary outcome is verified shared intent before implementation, not fewer questions, faster completion, documentation, or an implementation plan.

Preserve these invariants in any revision:
- Optimize for the user's verification bandwidth and the visibility of agent inference together. Reducing questions by hiding assumptions recreates the original failure.
- Use fast-forward pruning only when every material attached policy remains visible as agent-inferred and individually adjustable.
- Keep user-confirmed behavior physically separate from agent-inferred baselines; acceptance never changes provenance or weight.
- Let the user verify behavior and state changes before reading their technical projection. The contract makes the agent's intended implementation model precise enough to challenge before code exists.
- Prefer the smallest artifact that accounts for every material behavior and policy. Concision may remove repetition and trivia, never unresolved meaning or decision provenance.
- End at explicit confirmation of the active slice. Writing code, producing downstream planning artifacts, or broadening the confirmed scope are separate work.

## 1. Fact Autonomy (Never Ask Knowable Facts)

Before formulating questions, independently investigate the codebase, schemas, configuration files, and existing protocols using available search/read tools and subagents.
- Never ask the user about existing code behavior, current data models, or system facts that can be discovered locally.
- Use discovered facts to prune impossible or irrelevant branches before presenting questions.

## 2. Scope Slicing & Decision Hierarchy

### Scope Slicing (For Large Features)
When a feature spans multiple distinct subsystems or lifecycle boundaries (e.g., Signup vs. Matchmaking vs. Settlement):
- Do NOT mix all subsystems into one monolithic grilling session.
- Decompose into naturally cohesive **Capability Slices** based on independent domain or lifecycle boundaries, and process them sequentially: complete and confirm the artifact for Slice N before starting Slice N+1.
- Do not merge contracts across slices.

### Three-Tier Decision Hierarchy & Artifact Mapping
Classify every element in the design silently into one of three tiers:
- **L1 (Root Architectural Decisions -> User-Confirmed Behavior)**:
  - Scope: True source of truth / authority ownership, cross-boundary data flows, irreversible state transitions, and concurrency/transaction boundaries.
  - Action: **The ONLY tier presented as questions to the user.** Once agreed, these become high-weight decisions in Part 1 of the artifact.
- **L2 (Business Branches -> Agent-Inferred Baselines)**:
  - Scope: Concrete edge cases, fallback strategies, retry limits, and threshold values.
  - Action: **Bundle these visibly into Option 1 as choices that will be applied together with the recommended approach.** Once pruned/accepted, they remain agent-inferred and appear in Part 2 for fast, individual review.
- **L3 (Implementation Minutiae)**:
  - Scope: Internal helper structures, localized field naming, internal error codes, and log formats.
  - Action: **Decided autonomously by the agent per codebase conventions and never asked.**

Part 3 is the exact technical projection of the aligned L1 behavior and visible L2 baselines. Part 4 excludes implementation paths that could appear compatible with that positive contract while violating its intent.

## 3. Question Round Discipline & Visible Defaults

- **Batch Discipline**: Keep question batches compact (typically 1 to 3 questions per round to avoid cognitive fatigue); wait for the user's reply before proceeding.
- **Format**: Every question must be multiple-choice with 1-based numbered options.
  - **Option 1 (Always Recommended)**: The best fit for current repository conventions and L1 decisions already confirmed in this slice. **MUST state the concrete retry, fallback, threshold, and failure-handling choices that will also apply if the user selects this option.**
  - **Options 2+**: Alternative approaches, accompanied by clear counter-reasons (why they are not preferred).
  - **Localization**: Keep this skill file in English. At runtime, render all user-facing questions, artifact headings, labels, column names, and explanatory text in the user's conversational language. Keep internal tier names such as L1/L2 out of user-facing output. Label attached policies in plain language, for example `Also applied with this option`.

Example format:

```markdown
### ❓ Q1: <Decision Title>
1. **<Recommended Approach>** (Recommended)
   * **Reason**: <Best fit for current repo conventions>
   * **Also applied with this option**: <Explicit retry/fallback/threshold/failure policies that come with choosing 1>
2. **<Alternative Approach A>**
   * **Counter-reason**: <Why this is not preferred>
```

## 4. Decision Resolution & Fast-Forward Pruning

Interpret replies by meaning rather than format. **Only an unambiguous commitment changes decision state; everything else informs the analysis without settling a decision.**

- Extract every explicit commitment from the reply, whether expressed as an option number, natural language, or a custom decision. Preserve its scope and conditions, and resolve multiple commitments independently.
- For each settled decision, echo the concrete interpretation in one line, prune its downstream branches, and carry along only the concrete strategies attached to the accepted choice.
- If meaning is ambiguous or conflicts with a settled decision, keep only that point unsettled and ask the minimum root-level question needed to resolve it. Reopen no other decisions.

## 5. Alignment Artifact & Verification Order

Once all L1 decisions for the active slice are settled, output ONLY a compact 4-part alignment artifact in the order below. Do NOT write a narrative prose summary. The artifact exists to expose a mismatch between the user's intent and the agent's implementation model before code is written.

Every behavior or policy that can materially change the implementation must appear in exactly one of the first two sections. Keep them physically separate: a user-confirmed decision always takes precedence over an agent-inferred baseline, and accepting a recommended option never changes the inferred origin of its attached policies.

Translate all artifact headings, labels, and explanatory text into the user's conversational language. Keep the skill's internal L1/L2/P0/P1 vocabulary out of the artifact.

1. **User-Confirmed Behavior & State Model**:
   Present only explicit user commitments. Start with the business states and their meanings, then show the lifecycle in the form that makes change easiest to verify: a state/sequence diagram when order or transition matters, otherwise a compact transition table using `Before State | Trigger / Condition | After State | Observable Result`. Place no agent-inferred limits, retries, fallbacks, performance targets, or implementation choices here.
   - Preserve every confirmed condition, scope, unchanged outcome, failure path, and forbidden transition.
   - State cross-cutting invariants beside the model rather than duplicating them across transitions.
   - This section is high weight: later work may change it only after an explicit user revision.

2. **Agent-Inferred Baselines (Individually Adjustable)**:
   Group the concrete policies inferred by the agent in the same business order as the behavior model. Give each policy a stable local identifier so the user can revise one item without reopening the slice.
   - For each item, state the concrete baseline and the resulting observable or verifiable consequence. Include implementation impact only when it adds distinct information.
   - Expose material limits, ordering, retries, fallbacks, concurrency, lifecycle, failure handling, and performance policies. Do not hide them inside the technical projection.
   - These remain agent-inferred even when accepted with a recommended option; they are the default implementation baseline, not user-originated decisions.

3. **Commented Technical Contract Projection**:
   Project the first two sections into exact definitions matching the target repository stack, such as Protobuf messages and RPCs, HTTP method/path/request/response/errors, domain types, or language-native state models. No abstract pseudocode.
   - The projection must make the implementation model precise enough for the user to catch incorrect fields, states, ownership, write authority, protocol shape, and collaboration boundaries before implementation.
   - Use repository-standard business comments to explain each definition's role, owner, lifecycle, field semantics, and non-obvious invariants. Comments serve alignment by making the agent's interpretation explicit; they are not a tutorial.
   - Keep decision provenance out of code comments: do not add communication meta-tags such as `[Human Confirmed]` or `[Agent Inferred]`.
   - Do not present inferred constants or policies as confirmed requirements. Keep their origin visible in Section 2 even when the technical projection includes them.
   - Strictly NO unconfirmed or speculative fields, states, RPCs, routes, errors, or behaviors.

4. **Slice-Specific Forbidden Paths (Anti-Goals)**:
   List only concrete implementation paths that could appear compatible with the positive contract but would violate the aligned intent, such as unauthorized state mutation, silent fallback, local recomputation of authoritative state, or a disallowed intermediary layer. Omit generic engineering platitudes.

## 6. Completion & Boundary

- **Stop Condition**: The active slice is complete only after the user explicitly confirms all four parts of the alignment artifact defined in Section 5. If multiple slices exist, confirm each slice before advancing and stop after the final confirmed slice.
- **Execution Boundary**: Do NOT write application code or modify codebase source files within this skill. Stop immediately after delivering the confirmed artifact and wait for the user's next command.
