---
name: yjx-grill
description: Stress-test a plan, architecture, or complex decision with dynamic decision-tree exploration, autonomous fact-finding, balanced trade-off cards, and clear separation of human commitments from agent inferences. Use when the user runs /yjx-grill to align deeply and efficiently across any domain without questionnaire fatigue.
---

Stress-test requirements, system architectures, and plans thoroughly by exploring and pruning a decision tree. Maximize alignment depth and clarity while minimizing human cognitive fatigue: inquire only about high-impact architectural and business forks, present balanced options with explicit inherent costs, bundle transparent agent inferences with discarded alternatives, and deliver a scenario-driven, visually grounded alignment specification that pairs human guarantees with inlined companion mechanisms and minimal expressive viewports rather than a disjointed bookkeeping ledger.

## Maintenance

When reviewing, modifying, or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It contains the skill's design metadata and anti-drift rules; it is not needed for ordinary `/yjx-grill` execution.

## 1. Fact Autonomy (Investigate Facts, Inquire Intent)

Fact autonomy is hypothesis-driven across all rounds, not a one-off prelude or routine chore before every question:
- **Zero Tools for Intent & Trade-offs**: High-level trade-offs (e.g., consistency vs. availability, sync vs. async, retention policies) and business goals depend on human judgment, not code. Do NOT invoke tools for pure intent decisions—ask them directly.
- **Probe Only on Concrete Asset Dependencies**: Invoke search/read tools only when an option or prerequisite depends on an unverified existing asset (e.g., confirming whether a specific queue, client, schema field, or interface already exists to avoid proposing imaginary solutions).
- **Problem & Reality Gap Investigation (Adaptive Fact Closure)**: When the prompt involves a defect, unexpected behavior, or discrepancy, use tools to investigate the objective causal chain (logs, state mutations, code paths) as a fact baseline. Feed the discovered facts into a concise Fact Primer.
  - **Facts Are Non-Negotiable**: Root causes, causal attribution, and verification blockers are objective facts. Strictly FORBID turning investigation uncertainties or diagnostic steps into synthetic multiple-choice voting cards. If verification is physically blocked (e.g., unreachable DB), state confidence and provide an executable check command directly.
  - **Zero-Fork Direct Closure**: If facts are established and no genuine, high-reversal-cost architectural remediation trade-offs exist, deliver the definitive diagnostic conclusion and evidence chain, then STOP immediately. Do NOT manufacture artificial questions or force specification templates.
  - **Escalate to Grilling Only on Real Forks**: Formulate question cards ONLY if the verified root cause opens genuine strategic engineering forks (e.g., tactical bypass vs. breaking schema refactoring).
- **Clarify Real Ambiguities**: If investigation reveals missing context or conflicting implementations (e.g., legacy v1 vs. v2), ask the user a targeted clarification referencing the findings rather than guessing.
- **Prune Before Asking**: Use verified facts to eliminate impossible or already-implemented options before presenting questions.

## 2. Scope Slicing & Decision Taxonomy

### Scope Slicing (For Large Endeavors)
When an initiative spans multiple distinct subsystems, phases, or lifecycle boundaries (e.g., Auth vs. Billing vs. Reporting; or Transport vs. Lodging vs. Activities):
- Do NOT mix all subsystems into one monolithic grilling session.
- Decompose into naturally cohesive **Capability Slices** based on independent domain or lifecycle boundaries, and process them sequentially: complete and confirm the artifact for Slice N before starting Slice N+1.
- Do not merge contracts across slices.

### Two-Tier Decision Taxonomy (Strict Weight Separation)
Classify every element in the design silently into one of two tiers:
- **User Decisions (P0 / Highest Weight -> User-Confirmed Commitments)**:
  - Scope: True source of truth / authority ownership, foundational architecture/strategy trade-offs, boundary contracts, irreversible state transitions, hard constraints, and **remediation/resolution strategy (e.g., tactical quick-fix vs. structural/architectural overhaul; fail-safe degradation vs. strict rejection)**.
  - **Redline Test (Strict Anti-Downgrade Rule)**: If reversing or altering this decision later would require fundamental structural redesign, core entity/data model migration, irreversible resource consumption, or breaking externally visible guarantees/contracts, it MUST be classified as P0 and explicitly asked across rounds. Never bundle it silently into P1 companion inferences.
  - Action: **The ONLY tier presented as direct questions to the user.** These form the active nodes of the decision tree. When an option is chosen, any downstream forks it unlocks must continue to be explored across rounds until all high-impact forks on the chosen path are resolved. Once agreed, these form the core scenario guarantees in the alignment specification.
- **Agent Inferences (P1 / Default Companion Rules -> Agent-Inferred Defaults)**:
  - Scope: Low-reversibility-cost technical/operational defaults, routine parameters, local interval configurations, standard fallback paths, or non-breaking local rules.
  - Action: **Never asked as standalone questions.** Instead, bundle them visibly into Option 1 (or the matching companion package for a custom user decision) as adopted defaults accompanied by **explicitly discarded alternative approaches and their discard rationale**. Once accepted or inferred, they attach directly to their corresponding scenario as inlined companion mechanisms (or into the cross-cutting section if system-wide) for immediate causal review and override.
- **Implementation Details (Sub-P1)**: Localized helper functions, routine defensive checks, standard logging/formatting, internal variable names — decided autonomously per domain conventions, strictly never asked and never highlighted in the artifact.

## 3. Dynamic Frontier Exploration & Balanced Question Cards

### Strict Orthogonality & Frontier Traversal
- **Dynamic Frontier Exploration**: The grilling session is a decision-tree traversal along the active path. Settling a decision unblocks downstream forks (the new frontier) on the chosen branch.
- **Strict Orthogonality Gate**: In any round, batch ONLY questions (1 to 3 questions) that must still be answered regardless of how other open questions in that round resolve. If question B depends on an option in question A, defer B to a later round.
- **Pivots First**: Prioritize questions that could fundamentally reshape the tree or architecture over detail questions.
- **Frontier Visibility (Lookahead)**: At the end of each round's questions, compute and append a concise lookahead line indicating the downstream forks that will unlock next:
  `🔮 Expected Downstream Forks: <Brief mention of 1-2 major architectural or boundary forks that will open depending on the user's choice>`. This maintains cognitive tree depth and prevents premature tree collapse.
- **No Arbitrary Depth Limit**: Continue iterating across rounds until the active frontier contains no more unresolved forks and is reduced entirely to deterministic agent inferences.

### Fact Primer for Problem & Reality-Gap Contexts
When the prompt involves diagnosing a bug, an operational incident, or an unexpected discrepancy:
- Before presenting question cards, output a glanceable **Fact Primer** (`💡 事实速览`).
- **Anti-Prose Wall Rule**: Strictly FORBID dense, unbroken narrative prose blocks. Structure the facts into a clean 3-part skeleton:
  1. **Symptom (`异常现象`)**: Actor, action, and external failure manifestation.
  2. **Conflict / Causal Mechanism (`链路与断点` / `核心原因`)**: Present the core breaking mechanism using the smallest, most direct visual form (strictly ≤6 lines; do NOT overfit to any single format):
     - *Multi-hop calls / exception swallowing*: Micro call tree (`text`, using indentation).
     - *Expected vs. actual / config or state drift*: Micro `diff` block (`- expected` vs `+ actual`).
     - *Data conflict / cache-DB inconsistency*: Compact key-value list or state comparison.
     - *Linear flow*: Single-line arrow chain (`Step ➔ Step ➔ Breakpoint`).
     - *Isolated single-point defect*: 1-2 concise bullet lines (strictly FORBID unnecessary diagrams or trees).
  3. **Assessment & Exclusions (`定性与排除`)**: Technical nature of the defect and explicitly eliminated pseudo-causes (e.g., excluding network jitters, generic protocol faults, or unrelated systems).
- **Fact Foundation & Exit Gate**: Ground findings in this primer. If genuine strategic remediation trade-offs exist, use it to anchor subsequent question cards; if the issue is a resolved fact/attribution with zero architectural forks, stop here cleanly with definitive conclusions and verification steps.

### Visual Viewports & Structural Contrast
To minimize cognitive translation fatigue, embed concise visual viewports using standard Markdown code blocks. Never generate or open external files (e.g., `.html`).

- **Structural Divergence Gate**: Default to compact prose cards. Activate a visual viewport ONLY when options exhibit:
  1. **Control Flow Divergence**: Call-tree, concurrency, or async ordering differences (use micro `diff` or `call-tree`, ≤8 lines).
  2. **State Transitions**: Complex state flow involving ≥3 lifecycle states or recovery loops (use micro `mermaid stateDiagram` or state `diff`, ≤10 lines).
  3. **Boundary / Ownership Shifts**: Module responsibility, file layout, or authority boundary shifts (use micro `shallow-tree`, ≤8 lines).
- **Frugality & Anti-Inflation Rules**:
  - Strictly FORBID diagrams for linear, trivial paths (`A -> B -> C`).
  - Maximum 1 viewport per question card or option.
  - Domain Neutral: Use `diff` for both code modifications and non-code workflow additions (`+`) or removals (`-`).

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
- **Localization**: At runtime, render all user-facing questions, artifact headings, labels, column names, and explanatory text into the user's conversational language. Translate option labels (`Fact Primer` -> `💡 事实速览`, `Symptom` -> `异常现象`, `Causal Mechanism` -> `链路与断点`, `Assessment & Exclusions` -> `定性与排除`, `Core decision` -> `核心决策`, `Recommendation rationale` -> `推荐理由`, `Costs` -> `⚠️ 代价`, `Key assumptions` -> `❗️ 关键假设`, `Companion inferences` -> `配套推断`, `Applicable scenarios` -> `适用场景`, `Unchosen reason` -> `未选原因`, `Rather than` -> `而非`, `Expected Downstream Forks` -> `🔮 预期后续分叉`). Translate specification labels (`Integrated Alignment Units` -> `图文一体决策对齐单元`, `Minimal Expressive Viewport` -> `极简内联视口`, `Business Guarantees & Invariants` -> `业务规则与保证`, `Mechanism & Adopted Trade-off` -> `技术机制与取舍`, `Boundaries & Anti-Patterns` -> `边界与禁止反模式`, `Cross-Cutting Technical Inferences` -> `全局跨切面技术规则`, `Core Verification Matrix` -> `核心验证预期矩阵`, `Implementation Mechanism` -> `实现机制`, `Adopted` -> `采纳`, `Scenario` -> `场景`, `Expected State / Behavior` -> `预期状态 / 表现`, `Confirmation Prompt` -> `请确认：1. 以上方案确认，可进入实施； 2. 需要调整条目`).

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

🔮 **Expected Downstream Forks**: <Brief mention of 1-2 dependent architectural forks that will open in the next round>
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
When the user provides a custom answer, a modular override (e.g., "Option 1 core, but replace the companion rule with Alternative B"), or rejects all options:
1. **Semantic Disassembly**: Extract the user's P0 core commitment, explicit P1 companion overrides, and newly introduced hard constraints.
2. **Coherence Check**: Check for internal contradictions. If conflicting, do not force-merge; explain the tension in one sentence and ask a pinpoint alignment question.
3. **Companion Re-derivation**: Autonomously derive a matching set of Agent Inferences (with explicitly evaluated alternatives and reasons) tailored to the custom decision.

### Forward Expansion & Backward Cascade Impact
Every settled decision propagates both forward and backward across the dependency graph:
- **Forward Expansion**: Expand the active frontier along the selected path. If the chosen path depends on concrete existing interfaces or schema capabilities, verify them before formulating downstream options; otherwise, proceed directly with trade-off analysis. If downstream trade-offs open, formulate the next round.
- **Backward Impact (Premise Change & Invalidation)**: If a new decision contradicts or invalidates previously settled nodes:
  - **Prune Dead Branches**: Immediately prune and invalidate all orphaned historical branches, old P1 inferences, and outdated contract drafts. Never allow dead assumptions to leak into the final artifact.
  - **Targeted Re-opening**: If a previously settled P0 node is in direct conflict, pause and re-open only that specific conflicting node for clarification.
  - **Silent Re-computation**: Silently update dependent historical P1 inferences without burdening the user.
- **Cascade Echo**: Before presenting the next round or the final artifact, echo the interpreted commitment and any backward adjustments in a single clear line:
  `🎯 Confirmed Decision [Q<N>]: <interpretation>; (Cascade note: <pruned/updated historical assumptions>)`.

## 6. Scenario-Driven Alignment Specification (With Minimal Expressive Viewports)

### Convergence Pre-Flight Gate (Anti-Premature-Convergence)
Before outputting the alignment specification, perform a mandatory frontier audit:
1. **Downstream Fork Audit**: Did the latest confirmed decision unlock any downstream forks meeting the P0 Redline (e.g., state consistency levels, exception/conflict resolution paths, irreversible commitments, or boundary contract guarantees)?
2. **Completeness Audit**: Are all material state transitions, trigger conditions, and domain guarantees introduced or altered by this decision grounded without speculative placeholders or unverified agent assumptions?
3. **Single-Turn Convergence Prohibition & Diagnostic Exception**: When an initiative or architecture prompt contains viable alternative engineering paths, FORBID outputting the final specification on round 1 without at least one round of balanced interactive questioning, unless the human explicitly requested immediate zero-interaction delivery. (Exception: pure troubleshooting/diagnostic prompts where facts are resolved with zero architectural forks may terminate immediately with fact conclusions).
4. **Anti-Semantics-Distortion Rules**:
   - **Guarantees & Mechanics**: Must record only genuine human guarantees and intentional engineering trade-offs made during alignment. FORBID framing pre-existing baseline behaviors, bug-fix goals, or standard domain common sense as newly established guarantees.
   - **Cross-Cutting Rules**: Must record only genuine system-wide trade-offs. FORBID converting diagnostic facts or eliminated bug hypotheses into design inferences.
   - **Boundaries & Anti-Patterns**: Must record strategic anti-goals and design-level boundary traps. FORBID lecturing routine language-level defensive coding rules, parameter sanity checks, or syntax-level platitudes.

- If any P0 fork or critical boundary ambiguity remains unresolved: **DO NOT output the final specification.** Formulate the next round of questions to explore the active frontier.
- Only when the active frontier is genuinely empty (all User Decisions on the active path are settled and only deterministic Agent Inferences remain), output ONLY a compact alignment specification in the structure below. Do NOT write a narrative prose summary. The specification exists to expose any mismatch between human intent and the agent's execution model before work begins.

Translate all specification headings, labels, and explanatory text into the user's conversational language. Keep internal tier labels (P0/P1) out of the specification.

### Universal Markdown Integrity & Anti-Garble Rules
Across ALL sections of the alignment specification, maintain clean, robust formatting:
- **No Pseudo-ASCII Tables**: Strictly FORBID drawing tabular borders using box-drawing characters (`┌ ─ ┬ ┐ │ ├ ┼ ┤ └ ┴ ┘`). All data matrices, comparisons, and verification tables MUST use standard GitHub-Flavored Markdown (GFM) tables (`|---|---|`).
- **No Unfenced Tree Characters or Bullets in Prose**: Outside fenced code blocks, strictly forbid loose Unicode bullets (`•`, `◆`) or tree branch characters (`├─`, `└─`). Use standard Markdown lists (`- `) for clean rendering and reliable indentation.
- **Fenced Micro-Trees Permitted**: Tree-drawing characters (`├──`, `└──`, `│`) are strictly confined to fenced `text` or `diff` code blocks for concise shallow file trees, call trees, or mapping DAGs (strictly ≤8 lines).

### Viewport Alignment Philosophy & Noise Elimination Guard

Apply expressively minimal visual viewports to deliver high-density, zero-bloat alignment:
1. **Pick the smallest view that makes the key point clear**:
   Choose the most direct visual representation (code/model shape sketch, evolution diff, or call tree) that anchors the decision.
2. **Skip the preamble and keep prose brief**:
   Eliminate conversational filler, throat-clearing, and verbose restatements.
3. **Place each visual next to the short text it supports**:
   Do NOT split a single decision across disjointed ledger chapters. Anchor the visual viewport directly beside its invariants and boundaries in an integrated, glanceable unit.
4. **Domain-Neutral Noise Elimination Guard**:
   - **No Implementation Task Bloat**: Strictly FORBID dumping PR execution plans into the alignment contract. Do NOT list unaffected calling points ("keeping the following 4 calls unchanged"), do NOT dump internal helper method diffs, and do NOT list local automated test script paths (e.g., `test_xxx.yaml` or test commands).
   - **Strict Delta-Relevance**: Strictly FORBID dumping ambient baseline behaviors, unchanged domain mechanics, or pre-existing system contexts. Present ONLY the new commitments, state mutations, and boundary contracts established by this decision.
   - **No Sub-P1 Platitudes**: Strictly FORBID promoting routine coding hygiene (e.g., non-empty slice checks, nil guards, basic variable assignments) into forbidden anti-patterns.
   - **Preserve Essential Model Assets Across Domains**: Domain neutrality does NOT mean omitting concrete structural assets. In software/system engineering (including DDD, microservices, protocols, and APIs), core structural definitions—such as Aggregate Roots, Entities, Value Objects, state machine enums, schema fields, or core method contracts—ARE essential design decisions. Present them as focused shape sketches or diffs (isolate decisive fields; strip ambient boilerplate). In planning/operations, preserve core execution matrices (milestone schedules, resource/budget allocation, responsibility matrices).
   - **Strict Non-Linearity Ban**: For single variable adjustments, linear trivial sequences (`A ➔ B ➔ C`), or plain parameter tweaks, **strictly FORBID code blocks**—keep them as plain concise prose.

### Specification Structure

Organize the specification into cohesive, self-contained units by capability or decision topic (`### 1. <Scenario / Decision Topic>`):

1. **Integrated Alignment Units (图文一体决策对齐单元)**:
   Each unit encapsulates the decision's visual anchor, business guarantee, mechanism choice, and boundary rules together:
   - **🖼️ Minimal Expressive Viewport (strictly ≤8 lines, omit if no structural divergence)**:
     - *State/Data Shape Evolution (diff)*: For state mutations, schema/struct field additions or removals, or configuration shifts (`- old baseline` vs `+ new target`).
     - *Core Model/Shape Sketch (code/schema block)*: When introducing a new domain entity, value object, struct, state enum, or interface contract, present the concise, copyable shape without ambient boilerplate.
     - *Call-Tree & Control Flow Divergence (diff or text)*: For routing shifts, guard interceptions, or multi-hop execution flow (e.g., `- bypass cache` vs `+ read session cache`).
     - *Topology & Boundaries (text or mermaid)*: Shallow file tree or component tree (`├──`, `└──`) for module ownership shifts.
     - *Strict Context De-noising*: Never paste unchanged ambient code; show only the differential contrast or core skeleton.
   - **📌 Business Guarantees & Invariants (业务规则与保证)**:
     - 1~2 concise bullet lines stating the hard business invariants and state guarantees locked by this unit.
   - **⚙️ Mechanism & Adopted Trade-off (技术机制与取舍)**:
     - 1 concise bullet line stating the companion technical implementation choice alongside evaluated alternatives:
       `- *Implementation Mechanism*: Adopt <Adopted Choice> (Rather than: <Alternative A> [<reason>]; <Alternative B> [<reason>])`
   - **🚫 Boundaries & Anti-Patterns (边界与禁止反模式)**:
     - 1 concise bullet line stating strategic anti-goals, prohibited architectural shortcuts, or design-level traps (e.g., forbidden bypasses, unsafe async delays). Omit generic syntax/parameter checks.

2. **Cross-Cutting Technical Inferences (全局跨切面技术规则 - 系统级推断, Optional)**:
   Include ONLY if there are true system-wide companion rules spanning across all scenarios (e.g., centralized retry policies, global cache consistency guarantees, RPC timeout fallbacks). Omit this section entirely if all rules are scenario-local.
   Format:
   `- **<Focus / Mechanism Name>**: Adopt <Adopted Choice> (Rather than: <Alternative> [<reason>])`

3. **Core Verification Matrix (核心验证预期矩阵, Optional, GFM Table, ≤4 rows)**:
   Provide ONLY when the decision alters multi-scenario state mappings or complex branching conditions. Unify input conditions and expected observable state into a compact GFM table:
   | Scenario | Expected State / Behavior |
   | :--- | :--- |
   | <Condition A> | <Expected State / Guarantee> |
   | <Condition B> | <Expected State / Guarantee> |

### Stop Condition & Handoff
End the specification with a concise confirmation prompt:
`Please confirm: 1. Approved to proceed; 2. Items need adjustment`

## 7. Completion & Execution Boundary

- **Stop Condition**: The active slice is complete only after the user explicitly confirms the alignment specification defined in Section 6. If multiple slices exist, confirm each slice before advancing and stop after the final confirmed slice.
- **Execution Boundary**: Do NOT write application code, modify repository source files, or execute implementation actions within this skill. Stop immediately after delivering the confirmed artifact and wait for the user's next command.
