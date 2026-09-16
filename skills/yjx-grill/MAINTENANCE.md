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
4. **Format mimicry & Premature artifact dumping**: In troubleshooting, bug diagnosis, or reality-gap contexts, agents bypass interactive alignment and cram raw investigation findings, stack traces, and routine defensive coding into the 4-part artifact, distorting objective facts into fake "commitments" and "inferences".

### Core Evolutionary Principles
- **Unconstrained Depth via Frontier Traversal**: Settling a decision prunes unchosen alternatives, but unblocks downstream forks on the active path. As long as unresolved high-impact forks remain, grilling continues across rounds.
- **Anti-Premature Convergence & P0 Redline**: High-reversal-cost decisions (structural refactoring, data migration, broken client contracts) must never be downgraded to P1 companion inferences. Grilling must actively traverse deep frontier boundaries (failure modes, race conditions, compensation) and pass a convergence pre-flight gate before generating the final artifact.
- **Trade-off Symmetry & Costs**: Every recommended option must explicitly state its unavoidable friction, complexity, or risks (`⚠️ Costs`) and its critical vulnerabilities (`❗️ Key assumptions`). Alternative options must define conditions where they become strictly superior (`Applicable scenarios`).
- **Transparent Inferences with Causality**: Low-risk companion rules are bundled into Option 1 (and custom decisions) with explicitly unadopted alternatives and reasons. They remain strictly causal to the current decision node.
- **Scenario-Driven Cohesiveness & Minimal Expressive Viewports**: Eliminates the cognitive chasm of disjointed C-series (commitments) and D-series (inferences) bookkeeping ledgers. Ties business guarantees directly to their inlined companion mechanisms and ≤8-line micro-viewports (diff, call-chain, mapping tree) so handoff successors grasp state evolutions in seconds without context hopping.
- **Bidirectional Cascade Impact (DAG Traversal)**: A decision unblocks downstream frontier questions (forward) and may invalidate, prune, or re-open historical nodes (backward).

## Semantic Boundaries

### Complete and Concise
A complete alignment artifact accounts for every material behavior, rule, condition, state, boundary, and decision source needed to review the active slice before execution.

Concision means removing repetition, filler, and non-value-adding prose. It does NOT mean flattening the decision tree, omitting a section, merging distinct decision sources, or hiding a material inference.

### Universal Verification Views & Integrated Alignment Units
The specification unifies the four distinct verification dimensions—observable guarantees, companion mechanisms, concrete visual anchors, and prohibited anti-patterns—into self-contained, integrated alignment units (`Integrated Alignment Units`) rather than splitting them into disjointed, redundant chapters.

1. **Integrated Alignment Units (图文一体决策对齐单元)**: Each unit pairs a minimal expressive viewport (code/model shape sketch, evolution diff, or call-tree ≤8 lines) directly with its locked business invariants, adopted mechanisms (with discarded alternatives), and strategic anti-patterns. This prevents four-fold redundancy (the "four-times rewritten" syndrome) where the same decision is echoed across disparate sections.
2. **Preservation of Essential Model Assets**: Domain neutrality does NOT mean code-aversion or abstract hand-waving. In software engineering (including DDD, microservices, protocols, and APIs), structural definitions—such as Aggregate Roots, Entities, Value Objects, state machine enums, schema fields, or core method contracts—ARE essential design decisions. They must be visibly grounded as focused code/schema shape sketches or diffs without stripping their core structural essence.
3. **Cross-Cutting Technical Inferences (全局跨切面技术规则, Optional)**: Confined to system-wide companion rules and architectural trade-offs that span across all scenarios (e.g., global transaction retries, centralized cache consistency). Omitted if all rules are scenario-local.
4. **Core Verification Matrix (核心验证预期矩阵, Optional)**: Compact GFM table (≤4 rows) mapping multi-scenario conditions to observable guarantees.
5. **Anti-Implementation-Leak Guard**: Strictly separates design-level alignment from PR implementation tasks. Alignment specifications must never dump unaffected calling-point whitelists, local automated test script filenames (`.yaml`, `.py`), or routine language-level parameter hygiene (e.g., nil checks, slice length guards).

### Decision Provenance & Weight Separation
- **User Decisions (P0)** cannot be modified without explicit human instruction.
- **Agent Inferences (P1)** take effect by default to prevent question storms, but remain independently adjustable without reopening the entire slice.
- Selecting a recommended option adopts its attached inferences as default rules; it does not turn them into user-originated decisions.
- **Implementation Details (Sub-P1)**: Routine defensive coding (nil checks, standard error logging) belongs to Sub-P1 and must not bloat Part 2.

### Semantic Addressing & Cognitive Grips
The specification replaces rigid, bureaucratic alphanumeric handles (`C1`, `D1`) with self-contained, human-readable scenario headings and structured sub-elements. This eliminates questionnaire/meeting-minutes mimicry while keeping functional units individually addressable and intuitive for handoff successors.

## Anti-Drift Checks

Before changing this skill, verify that the change:

- preserves alignment-before-action as the primary outcome;
- maintains domain neutrality (works for software, planning, strategy without hardcoding framework-specific assumptions);
- incorporates the minimal expressive viewport philosophy (pick the smallest view, skip preambles, place text next to visual);
- eliminates four-fold template redundancy by consolidating guarantees, mechanisms, viewports, and boundaries into integrated alignment units;
- enforces the **Anti-Implementation-Leak Guard**: strictly forbids PR task bloat (unaffected call lists, test script filenames, routine parameter hygiene) while preserving essential model assets (structs, state enums, schemas, method contracts);
- keeps fact autonomy hypothesis-driven and continuous across rounds without ritualistic tool grinding;
- enforces **Delta-Relevance** in scenario contracts to prevent boilerplate dumping of unaffected host platform or infrastructure mechanisms;
- keeps decision depth unconstrained and driven by actual decision-tree frontier traversal;
- requires symmetric exposure of costs, trade-offs, and falsifiable assumptions;
- enforces transparent companion inferences with unadopted alternatives, "when to prefer" conditions, and unchosen reasons;
- strictly maintains the distinction and provenance between User Decisions (P0) and Agent Inferences (P1);
- enforces the P0 Redline to prevent LLM laziness from silently downgrading high-cost architectural forks into P1 companion inferences;
- enforces remediation and resolution strategy as P0 User Decisions, preventing agents from unilaterally deciding tactical vs. structural fixes;
- enforces the structured, adaptive Fact Primer in problem/incident contexts to ground human cognition without narrative dumping or overfitted visual viewports;
- prevents single-turn premature convergence via the Convergence Pre-Flight Gate when viable alternative solution forks exist;
- prevents semantics distortion in the alignment specification (never converting diagnostic facts into trade-offs, nor baseline requirements into newly aligned guarantees);
- maintains Frontier Visibility across questioning rounds without creating artificial questionnaire storms;
- accounts for bidirectional cascade impact (pruning invalid historical branches upon premise changes);
- treats concision as removal of non-value-adding expression, not loss of coverage or shallow questioning;
- keeps the skill file itself authored strictly in English, using explicit runtime localization mapping for user-facing multilingual interactions;
- preserves the active-slice boundary and execution stop condition;
- maintains zero file-system side-effects (forbidding standalone HTML generation or external openers during grilling);
- respects vertical height budgets for visual viewports (≤8 lines in cards, ≤8 lines in alignment units);
- applies visual viewports domain-neutrally, forbidding language-specific or framework-specific locks;
- generalizes a problem instead of encoding a single example as a rule.
If a proposed optimization conflicts with one of these checks, resolve that conflict before editing the skill.
