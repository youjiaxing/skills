# yjx-grill Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-grill`. It records the skill's design intent, systemic trade-offs, and semantic boundaries. It is maintenance reference, not ordinary execution guidance.

## Identity

`yjx-grill` is a user-invoked tool for aligning a human and an agent on a complex design, architecture, or plan before execution. It uses targeted questions, autonomous fact-finding, dynamic decision-tree exploration, and an explicit projection of the agent's execution model.

Its primary outcome is verified, shared intent before action is taken. It applies across all complex decision domains (software engineering, system architecture, operational planning, travel/event coordination, organizational strategy). It is not primarily a summary generator, a questionnaire minimizer, a speed optimizer, or an execution-plan generator.

## Origin & Evolution

The skill was created to solve three complementary failure modes:

1. **Monolithic summaries**: Lengthy requirement summaries encourage passive skimming, creating the illusion of agreement without a shared, verifiable execution model.
2. **Questionnaire storms & Trivial inquiries**: Broad, flat questioning overloads the human and buries critical trade-offs under dozens of trivial parameter questions.
3. **Sycophantic compliance (The "Yes-Man" Trap)**: Asymmetric question presentation (over-decorating the recommended option while presenting alternatives as weak strawmen) suppresses critical thinking and tempts the human into passive approval without acknowledging inherent costs.

### Core Evolutionary Principles
- **Unconstrained Depth via Frontier Traversal**: Settling a decision prunes unchosen alternatives, but unblocks downstream forks on the active path. As long as unresolved high-impact forks remain, grilling continues across rounds.
- **Anti-Premature Convergence & P0 Redline**: High-reversal-cost decisions (structural refactoring, data migration, broken client contracts) must never be downgraded to P1 companion inferences. Grilling must actively traverse deep frontier boundaries (failure modes, race conditions, compensation) and pass a convergence pre-flight gate before generating the final artifact.
- **Trade-off Symmetry & Costs**: Every recommended option must explicitly state its unavoidable friction, complexity, or risks (`⚠️ Costs`) and its critical vulnerabilities (`❗️ Key assumptions`). Alternative options must define conditions where they become strictly superior (`Applicable scenarios`).
- **Transparent Inferences with Causality**: Low-risk companion rules are bundled into Option 1 (and custom decisions) with explicitly unadopted alternatives and reasons. They remain strictly causal to the current decision node.
- **Bidirectional Cascade Impact (DAG Traversal)**: A decision unblocks downstream frontier questions (forward) and may invalidate, prune, or re-open historical nodes (backward).

## Semantic Boundaries

### Complete and Concise
A complete alignment artifact accounts for every material behavior, rule, condition, state, boundary, and decision source needed to review the active slice before execution.

Concision means removing repetition, filler, and non-value-adding prose. It does NOT mean flattening the decision tree, omitting a section, merging distinct decision sources, or hiding a material inference.

### Universal Four-Part Artifact
The four parts are distinct verification views, not interchangeable summaries:

1. **User Commitments & Core Model (用户决策与核心模型)**: Verifies what the human explicitly committed to (P0 / highest weight) for the active decision delta. Expressed as a glanceable, progressive-disclosure list with stable identifiers (`C1`, `C2`...) and verdict-first headlines (`[Action ➔ Consequence]`) followed by clean two-line state/consequence decompositions. Strictly forbids rigid form labels (`Trigger:`, `Result:`, `Invariant:`, `Guarantee:`) and ASCII/Unicode box-drawing artifacts. Strictly excludes unchanged platform/host infrastructure boilerplate and agent-inferred rules.
2. **Key Inferences (关键设计推断 / 配套推断)**: Exposes the concrete companion rules the agent adopted along with explicitly unadopted alternatives, their "when to prefer" applicability, and unchosen reasons (P1 / default baseline). Filter out routine Sub-P1 defensive coding.
3. **Execution Specification / Concrete Contract (落地执行规格 / 契约)**: Shows how aligned behavior and inferences map to concrete, domain-adaptive boundaries (e.g., Protobuf/APIs/schemas for code; booking/timeline/budget matrices for operations/planning) without speculative placeholders.
4. **Forbidden Paths (禁止事项 - Anti-Goals & Exclusions)**: Identifies plausible paths or actions that would violate the aligned intent.

### Decision Provenance & Weight Separation
- **User Decisions (P0)** cannot be modified without explicit human instruction.
- **Agent Inferences (P1)** take effect by default to prevent question storms, but remain independently adjustable without reopening the entire slice.
- Selecting a recommended option adopts its attached inferences as default rules; it does not turn them into user-originated decisions.
- **Implementation Details (Sub-P1)**: Routine defensive coding (nil checks, standard error logging) belongs to Sub-P1 and must not bloat Part 2.

### Stable Identifiers
Identifiers such as `C1`, `C2` (User Commitments) and `D1`, `D2` (Design Inferences) are deliberate handles for precise human corrections without letter `I` font ambiguities. Keep them stable within the active alignment artifact and assign them at the smallest useful rule unit. Do not remove them merely for stylistic brevity.

## Anti-Drift Checks

Before changing this skill, verify that the change:

- preserves alignment-before-action as the primary outcome;
- maintains domain neutrality (works for software, planning, strategy without hardcoding language-specific assumptions);
- anchors core models to progressive structural causality (Action ➔ Consequence) and clean state/consequence decompositions rather than bureaucratic form labels (`Trigger`, `Invariant`);
- enforces **Delta-Relevance** in Part 1 to prevent boilerplate dumping of unaffected host platform or infrastructure mechanisms;
- keeps decision depth unconstrained and driven by actual decision-tree frontier traversal;
- requires symmetric exposure of costs, trade-offs, and falsifiable assumptions;
- enforces transparent companion inferences with unadopted alternatives, "when to prefer" conditions, and unchosen reasons;
- strictly maintains the distinction and provenance between User Decisions (P0) and Agent Inferences (P1);
- enforces the P0 Redline to prevent LLM laziness from silently downgrading high-cost architectural forks into P1 companion inferences;
- prevents premature convergence via the Convergence Pre-Flight Gate before emitting the 4-part alignment artifact;
- maintains Frontier Visibility across questioning rounds without creating artificial questionnaire storms;
- accounts for bidirectional cascade impact (pruning invalid historical branches upon premise changes);
- preserves the distinct verification purpose of all four artifact parts;
- treats concision as removal of non-value-adding expression, not loss of coverage or shallow questioning;
- retains stable identifiers (`C1`, `C2` for commitments, `D1`, `D2` for inferences) for precise correction;
- preserves progressive-disclosure glanceability in Part 1 (verdict-first headlines and clean two-line decomposition) to eliminate human cognitive fatigue;
- keeps the execution spec concrete, domain-grounded, and non-speculative;
- keeps the skill file itself authored strictly in English, using explicit runtime localization mapping for user-facing multilingual interactions;
- preserves the active-slice boundary and execution stop condition;
- generalizes a problem instead of encoding a single example as a rule.
If a proposed optimization conflicts with one of these checks, resolve that conflict before editing the skill.
