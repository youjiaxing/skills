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
- **Trade-off Symmetry & Costs**: Every recommended option must explicitly state its unavoidable friction, complexity, or risks (`⚠️ Costs`) and its critical vulnerabilities (`❗️ Key assumptions`). Alternative options must define conditions where they become strictly superior (`Applicable scenarios`).
- **Transparent Inferences with Causality**: Low-risk companion rules are bundled into Option 1 (and custom decisions) with explicitly unadopted alternatives and reasons. They remain strictly causal to the current decision node.
- **Bidirectional Cascade Impact (DAG Traversal)**: A decision unblocks downstream frontier questions (forward) and may invalidate, prune, or re-open historical nodes (backward).

## Semantic Boundaries

### Complete and Concise
A complete alignment artifact accounts for every material behavior, rule, condition, state, boundary, and decision source needed to review the active slice before execution.

Concision means removing repetition, filler, and non-value-adding prose. It does NOT mean flattening the decision tree, omitting a section, merging distinct decision sources, or hiding a material inference.

### Universal Four-Part Artifact
The four parts are distinct verification views, not interchangeable summaries:

1. **User Commitments & Core Model (用户决策与核心模型)**: Verifies what the human explicitly committed to (P0 / highest weight). State transitions, lifecycle milestones, or phase matrices. No agent-inferred rules belong here.
2. **Agent Inferences (AI推断 / 配套推断 - Transparent & Individually Adjustable)**: Exposes the concrete companion rules the agent adopted along with explicitly unadopted alternatives and reasons (P1 / default baseline).
3. **Execution Specification / Concrete Contract (落地执行规格 / 契约)**: Shows how aligned behavior and inferences map to concrete, domain-adaptive boundaries (e.g., Protobuf/APIs/schemas for code; booking/timeline/budget matrices for operations/planning) without speculative placeholders.
4. **Forbidden Paths (禁止事项 - Anti-Goals & Exclusions)**: Identifies plausible paths or actions that would violate the aligned intent.

### Decision Provenance & Weight Separation
- **User Decisions (P0)** cannot be modified without explicit human instruction.
- **Agent Inferences (P1)** take effect by default to prevent question storms, but remain independently adjustable without reopening the entire slice.
- Selecting a recommended option adopts its attached inferences as default rules; it does not turn them into user-originated decisions. Order inferences by review priority (`❗️`, `⚠️`).

### Stable Identifiers
Identifiers such as `I-1`, `I-2` are deliberate handles for precise human corrections. Keep them stable within the active alignment artifact and assign them at the smallest useful rule unit. Do not remove them merely for stylistic brevity.

## Anti-Drift Checks

Before changing this skill, verify that the change:

- preserves alignment-before-action as the primary outcome;
- maintains domain neutrality (works for software, planning, strategy without hardcoding language-specific assumptions);
- keeps decision depth unconstrained and driven by actual decision-tree frontier traversal;
- requires symmetric exposure of costs, trade-offs, and falsifiable assumptions;
- enforces transparent companion inferences with unadopted alternatives and reasons;
- strictly maintains the distinction and provenance between User Decisions (P0) and Agent Inferences (P1);
- accounts for bidirectional cascade impact (pruning invalid historical branches upon premise changes);
- preserves the distinct verification purpose of all four artifact parts;
- treats concision as removal of non-value-adding expression, not loss of coverage or shallow questioning;
- retains stable identifiers (`I-1`, `I-2`) for precise correction;
- keeps the execution spec concrete, domain-grounded, and non-speculative;
- keeps the skill file itself authored strictly in English, using explicit runtime localization mapping for user-facing multilingual interactions;
- preserves the active-slice boundary and execution stop condition;
- generalizes a problem instead of encoding a single example as a rule.

If a proposed optimization conflicts with one of these checks, resolve that conflict before editing the skill.


