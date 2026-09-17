# Maintenance: yjx-implement

Read this document when reviewing or changing the skill, not during ordinary execution. `SKILL.md` owns runtime instructions; this file records their rationale and supplies review scenarios, not a second set of execution rules.

## 1. Lineage & Abstraction Level

`yjx-implement` adapts Matt Pocock's thin `/implement` command into a scope-aware implementation workflow. It retains mandatory `/code-review` while replacing default TDD, unconditional full-suite execution, and unconditional commits with task-dependent verification and project governance.

Ousterhout's deep modules and information hiding, cohesion and coupling, YAGNI, compatibility, and cost models provide the engineering vocabulary. Each leading term carries a short operational meaning in the runtime document. These principles support judgment across languages and architectures; they do not prescribe a universal code shape.

Earlier versions encoded incident-specific remedies as hard rules: two production adapters before adding an in-layer interface, single-hop projected reads, fields consumed only within the touched scope, and itemized scenario-parity ledgers. Those rules mistook a useful remedy for a universal constraint. The current design preserves their intent through principles and evidence requirements instead.

Binary completion criteria belong to delivery gates. Architectural findings need a concrete consequence and supporting evidence, rather than a mechanical count or an architectural label. Concision means one authoritative home per rule, not a physical line budget or unexplained slogans.

## 2. Failure Cases & Design Rationale

The examples below explain why the principles exist. They are neither an exhaustive checklist for implementations nor mandatory remedies.

### Asset Bypass

An agent can bypass a project's clock or logging wrapper with a raw library call, losing behavior supplied by the project. Asset Reuse addresses that loss before new code is written; it does not justify unrelated library consolidation.

### Speculative Generality & Artificial Seams

Adding a factory and interface solely to mock a small calculation can obscure otherwise direct code. Conversely, a single-implementation repository boundary can isolate storage details usefully. YAGNI, cohesion, and information hiding evaluate those responsibilities without counting implementations or treating every seam as waste.

A pass-through may protect a stable public contract even when it performs little computation. Removing it requires checking the responsibility it carries; the old deletion test is a diagnostic question, not an automatic removal instruction.

### Responsibility Leakage

Duplicating an entity's transition rules in several controllers spreads knowledge of its internals. Information Hiding puts that decision with its owner. Reading a public value is not itself leakage, and Deep Modules does not imply a mandatory controller/domain layering scheme or a large procedural function.

### Local Convenience vs. Shared Compatibility

A consumer needing only an ID does not make the name and status fields of an existing shared protocol obsolete; other consumers may rely on them. Compatibility protects those obligations, while YAGNI challenges additions made for hypothetical consumers. Narrowing a contract needs evidence about the affected consumers, not just the edited files.

### Projection vs. Actual Cost

Hydrating full database records only to extract IDs can waste I/O and memory. But reusing an already-populated cache can be cheaper than issuing a new projected query. A Cost Model weighs actual access paths, allocations, serialization, and round-trips instead of treating narrower data or a single hop as proof of efficiency.

### Test Shape vs. Behavioral Evidence

Replacing many detailed tests with one happy-path test can lose meaningful coverage. A behavior-preserving refactor therefore needs evidence that the effective coverage remains, not preservation of test names or a mandatory one-to-one ledger.

When a confirmed requirement removes a restriction, a test expecting its old rejection should change. The relevant distinction is the basis for the change: the new contract justifies a new expectation; a failing result alone does not. Real collaborators, boundary fakes, and transport interception are possible verification techniques rather than universal architectural requirements.

### Verification Scope & Workspace Context

A workspace root may only aggregate repositories; commands run there can use incompatible dependency configurations. An unconstrained suite or interactive watcher can also stall a local task. Phase 1 identifies the owning context and bounded commands; Phase 3 owns execution and evidence. Small projects can still use fast full suites.

TDD is an explicit user/project choice, not the definition of verification. Regression comparisons and characterization coverage address bug fixes and behavior-sensitive refactors without forcing every task into one test-writing order. Changes unsuitable for automated tests still need alternative evidence and disclosed limits.

### Causal Scope

Static file whitelists can exclude necessary companion tests or encourage workarounds inside approved files. Minimal Diff ties changes to the task's cause and uses the actual diff to assess scope, rather than imposing an extra file-list ceremony. Existing project scope restrictions still apply.

### Review & Authorization

A structural self-check cannot replace independent review, and a comparison ending at `HEAD` misses work awaiting its first commit. Phase 1 owns the starting state; Phase 4 owns complete review input, finding classification, and the resolution loop. Preserve the distinction between pre-existing work and task changes even inside the same file.

Dispatch policy belongs to the caller and `/code-review`, not this implementation skill. Phase 5 separately owns commit authorization and ticket handling: successful automated review is not project-required human approval.

## 3. Maintenance Validation

Check the changed runtime text against these questions; use the scenarios to expose ambiguity rather than to prescribe exact wording.

- Do leading terms have enough meaning to guide decisions without recreating incident-specific bans elsewhere in the pipeline?
- Do descriptions, completion criteria, and maintenance examples agree on which statements are principles and which are delivery gates?
- Are concrete techniques confined to explanatory examples unless needed to make a gate executable?
- Are existing project assets, causal scope, workspace context, and authorization boundaries preserved?
- Does the review gate retain the complete final change set, blocker disposition, independent re-review, and incomplete status when review cannot execute?
- Is the skill still English, manually invoked, and independent of a particular language or application architecture?

| Scenario | Expected assessment |
| --- | --- |
| One implementation behind an interface that isolates storage changes | Evaluate the isolation benefit; implementation count alone is not a defect. |
| Tests are reorganized during a behavior-preserving refactor | Check behavior and effective coverage, not one-to-one test correspondence. |
| Confirmed requirements remove an old rejection condition | Verify the replacement behavior and still-valid boundaries; the old assertion may be retired. |
| An assertion is weakened only because it fails | Treat as an evidence-integrity blocker. |
| A style preference or architectural label is the only finding | Do not turn it into a blocking defect. |
| An architectural change duplicates an invariant across independently changing callers | A blocker needs concrete evidence of the maintenance or correctness consequence. |
| Task changes are uncommitted, new, or mixed with pre-existing work | Review the full task changes with context, not just committed history. |
| Independent review cannot execute, or a blocker remains disputed | Keep the task incomplete until the review gate is satisfied. |
| Automated review passes on a branch requiring human approval | Report readiness without treating it as commit permission. |
