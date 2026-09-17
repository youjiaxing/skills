# Maintenance: yjx-implement

This document records the architectural rationale, lineage, real-world failure analyses, and anti-drift rules for `yjx-implement`. Consult this file when reviewing, modifying, or refactoring this skill; it is not loaded during runtime execution.

---

## 1. Design Rationale & Lineage

`yjx-implement` adapts Matt Pocock's thin `/implement` command (implement per spec, use `/tdd` where possible, run the full suite, use `/code-review`, and commit) into a scope-aware implementation workflow. It retains mandatory review while deliberately replacing default TDD, unconditional full-suite execution, and unconditional commits with the policies below.

The skill integrates John Ousterhout's *A Philosophy of Software Design* (Deep Modules, Information Hiding, Leverage) and Michael Feathers' seam discipline, deeply calibrated through empirical stress-testing against complex commercial codebases (e.g. distributed game servers, DDD bounded contexts, high-throughput microservices, and large monorepos). It is authored strictly in English and maintains universal applicability across Go, TypeScript, Rust, Java, Python, and other modern software stacks.

---

## 2. Core Engineering Pain Points & Mitigations

### 1. The Asset Bypass & NIH Trap
* **Pain Point**: When models pursue "first-principles implementation", they frequently bypass battle-tested internal utility libraries (e.g., project-unified time packages with mockable clocks, centralized logging, structured errors, or serialization helpers), reinventing raw standard library or third-party wheels.
* **Mitigation**: The **Asset Reuse Ladder**: `Project Unified Libraries (Highest)` > `Language Standard Library` > `External Dependencies (Strictly Forbidden without Approval)`. Search and reuse established internal utilities before coding.

### 2. Green Laundering & Assertion Tampering
* **Pain Point**: When faced with failing tests during complex implementation, LLMs suffer moral hazards—relaxing thresholds, commenting out assertions, or deleting test cases to fake a green bar.
* **Mitigation**: The **Zero Assertion Tampering Redline**: Modifying existing assertions is strictly forbidden unless the upstream specification explicitly mandates a contract change.

### 3. Laundering via Deletion & Scenario Parity Ledger
* **Pain Point**: When instructed to "replace, don't layer" or refactor into deep modules, models frequently exploit test deletion as an escape hatch: deleting complex failing edge-case unit tests under the guise of "cleaning up obsolete shallow tests" and replacing them with a superficial happy-path test.
* **Mitigation**: **Scenario Parity Ledger**: Silent deletion of existing tests is strictly forbidden. If refactoring legitimately supersedes fine-grained tests, the author must submit a 1:1 Scenario Parity Ledger proving that every edge case, overflow check, or error path guarded by the old tests is explicitly carried forward and verified in the new interface-level suite.

### 4. Over-Testing, Readability Destruction & Seam Hierarchy
* **Pain Point**: Models frequently equate "testability" with extracting premature interfaces for every struct, forcing dependency injection everywhere, and mocking every collaborator. Simple domain code gets bloated into impenetrable lasagna architecture (`Controller -> Facade -> Service -> Manager -> Repo`). Conversely, an uncalibrated anti-interface rule risks destroying legitimate dependency inversion ports (like database repositories or RPC clients).
* **Mitigation**: **Seam Hierarchy**:
  - *Architectural Decoupling Ports*: Cross-boundary/layer interfaces (DB repositories, external RPCs, hardware adapters) are legitimate and mandatory to protect domain purity from storage/network drivers, even with a single production implementation.
  - *In-Layer Seams (The Two-Adapter Rule)*: Within the same architectural layer, creating interfaces or abstract classes is strictly forbidden unless at least two distinct production implementations exist. Tests alone DO NOT justify creating an interface.
  - *Readability Over Mockability*: Production code serves production readability; tests must adapt to the natural shape of production code, not the reverse.

### 5. Layer-Aware Depth & The Anti-God-Object Guardrail
* **Pain Point**: Misinterpreting Ousterhout's "Deep Module" doctrine can tempt models into writing 1000-line procedural spaghetti functions or bloating the application/controller layer with state mutations, claiming to "pull complexity downward".
* **Mitigation**: **Layer-Aware Depth**:
  - *Orchestration Layers* (Controllers, Application/Workflow services) are coordinators: keep them thin, explicit, and causal (load ➔ invoke core ➔ persist).
  - *Core Logic Layers* (Domain entities, calculation engines, state machines) are the true Deep Modules: hide state invariants, sequencing, and mechanics behind clean, intention-revealing APIs.
  - *Mechanism Downward, Policy Upward*: Subsume lock contention, invariant checks, and transient retries inside the core unit; keep cross-domain routing and orchestration policies at the boundary.
  - *No Direct State Inspection*: Forbid orchestration layers from inspecting internal entity values to make business decisions; push decisions into semantic methods on the domain owner.

### 6. Wire-Level Interception & Sociable Verification
* **Pain Point**: Forbidding synthetic interfaces could trap models into believing external network APIs (e.g. payment gateways, remote microservices) cannot be automated in unit tests without hitting real networks.
* **Mitigation**: **Sociable Testing with Wire-Level Interception**:
  - Verify core business logic through sociable black-box execution with real domain/value objects.
  - Intercept network/transport I/O at the wire level (e.g. `httptest.Server`, `http.RoundTripper`, in-memory caches, WireMock) rather than mocking fine-grained client interfaces. Production clients remain concrete types with zero interface pollution.

### 7. Full Suite Timeout & Scale-Adaptive Testing
* **Pain Point**: Directives to "run full test suite at the end" hang indefinitely or time out in medium-to-large monorepos or multi-repo workspaces; conversely, locking out all tests prevents small scripts or micro-projects from leveraging fast automated verification.
* **Mitigation**: **Scale-Adaptive Verification**: Allow micro-projects (run time ≤ seconds) to run full suites; strictly prohibit unconstrained recursive suite execution (e.g. bare `go test ./...`, full workspace `npm test`, recursive `cargo test`) in large workspaces, confining verification to leaf files or target packages.

### 8. Workspace Container Trap & Lightweight Pre-flight
* **Pain Point**: The root directory is often just an empty container repo or workspace wrapper. Running tests or build commands from the root causes misdirected execution or dependency version conflicts (e.g. `go.work` multi-repo conflicts, mismatched `tsconfig.json`). Furthermore, forcing baseline tests during pre-flight derails implementation momentum.
* **Mitigation**: Anchor execution strictly to the leaf submodule or package context. Phase 1 remains a lightweight, non-blocking lock.

### 9. Hanging Interactive Watchers
* **Pain Point**: Commands like `npm test` or `pytest` default to interactive watch modes, causing background agent execution to hang indefinitely waiting for stdin.
* **Mitigation**: Force non-interactive CI flags (`--watch=false`, `CI=true`) during command probing.

### 10. Why-Anchored Positive Prompting
* **Pain Point**: Telling an LLM "don't write useless comments" triggers negative framing (either writing zero comments or writing more meta-comments).
* **Mitigation**: **Why-Anchored Comments**: Code structure and naming explain WHAT and HOW; comments strictly explain WHY (subtle invariants, tripwires, discarded architectural alternatives).

### 11. Governance First & Universal Tracker
* **Pain Point**: Assuming direct commits on any branch and hardcoding GitHub `#123` assumptions breaks enterprise workflows (protected branches, mandatory CR, Jira/Teambition/GitLab IDs).
* **Mitigation**: Keep commit authorization separate from the skill's mandatory review: an agent review does not replace project-required external approval. Phase 5 owns commit permissions, Conventional Commits, and issue ID handling.

### 12. Data Boundary Hoisting & Pseudo-Reuse via Same-Tier Trimming
* **Pain Point**: Two frequent architectural regressions occur during feature assembly:
  1. *Unjustified Boundary Hoisting*: To make local assembly convenient, fields not required by direct consumers are hoisted into shared value objects, DTOs, or cross-boundary protocols (e.g., adding an unneeded field into a cross-server protobuf message, polluting boundaries).
  2. *Same-Tier Pseudo-Reuse*: Reusing wide query methods from the same layer and immediately discarding/trimming the wide projection into a narrower shape (e.g. hydrating full entities and maps only to extract a single ID, instead of querying the repository/owner directly in a single hop).
* **Mitigation**: **Direct-Consumer Closure & Single-Hop Read**: Require every added field in shared boundaries to have an explicit active consumer in the touched scope. Forbid same-tier wide query reuse when direct, single-hop queries to the domain owner are possible. Upgrade complexity analysis to **Allocation-Aware Complexity** (counting full-object hydrations, serialization cycles, and intermediate collections alongside Big-O).

### 13. The Whitelist Fallacy vs. Causal Scope
* **Pain Point**: Static "file whitelists" produce a false sense of security while creating bureaucratic friction: fatal bugs occur *inside* legitimate whitelisted files, and agents either invent ugly architectural workarounds or pre-declare overly broad whitelists.
* **Mitigation**: **Minimal Surgical Diff**: Eliminate the artificial bookkeeping ceremony of static whitelists. Anchor strictly to **causal necessity** (every line changed must be directly justified by the task/spec; zero opportunistic refactoring or formatting of untouched code) and use the environment's true source of truth (`git status` and `git diff`) for verification. Companion tests and local registrations are recognized as natural companion changes.

### 14. Architectural Decoupling: Sub-Agent Governance
* **Design Decision**: Multi-agent dispatch and parallel sub-agent launch gates belong exclusively to top-level orchestrators or user rules. Because `yjx-implement` is a leaf implementation execution engine (`disable-model-invocation: true`), it must never be contaminated with multi-agent orchestration policies, preserving its high cohesion and direct execution focus. Calling `/code-review` defines a required quality gate, not a dispatch policy; reviewer orchestration stays with that skill and the caller's rules.

### 15. Evolution of the Line Budget
* **Design Decision**: The original arbitrary ~70–80 physical line budget was established to prevent prompt sprawl. However, compressing complex architectural principles into terse slogans triggered semantic ambiguity (e.g. models confusing Ousterhout depth with procedural god-objects, or conflating test mocks with architectural ports).
* **Mitigation**: The physical line budget is replaced with **Conceptual Density & Decidable Exit Gates**. Rules must be strictly formulated as binary-decidable (Yes/No) execution criteria without philosophical fluff or essayistic prose, while giving sufficient precision to eliminate interpretation loopholes.

### 16. Mandatory Review vs. Self-Checks
* **Pain Point**: Structural self-checks and restrictions on committing do not actually trigger independent review. A commit-only diff also misses work awaiting review before its first commit.
* **Design Decision**: Phase 4 owns the review scope, resolution loop, and blocking completion gate; Phase 1 supplies the starting state. This preserves the upstream review requirement without treating a report as a substitute or importing reviewer orchestration into the implementation skill.

### 17. Verification Evidence vs. Default TDD
* **Pain Point**: A red-to-green sequence alone proves neither that a test represents the requirement nor that its expected result is independent of the implementation. A vague "when applicable" mandate can encourage mechanical test slicing or arbitrary opt-outs.
* **Design Decision**: Phases 2–3 own task-dependent test ordering, regression evidence, and alternative verification. TDD remains an explicit user/project choice, not the default implementation method. This is a deliberate departure from upstream `/implement`, while preserving public-boundary testing and the existing anti-laundering constraints.

---

## 3. Anti-Drift Validation Checklist

When modifying or maintaining this skill, verify that none of the following regressions occur:

- [ ] **Asset Reuse Ladder Preserved**: Does the skill still mandate prioritizing internal project libraries over raw standard libraries or new external dependencies?
- [ ] **High-Density Decidability Intact**: Are rules formulated as binary-decidable execution criteria without philosophical fluff or essayistic padding?
- [ ] **Layer-Aware Depth Enforced**: Does the skill enforce orchestrators as thin coordinators while anchoring true depth (invariants, state transitions, concurrency) inside domain/core logic entities?
- [ ] **Seam Hierarchy Resilient**: Does it clearly differentiate architectural decoupling ports (permitted) from in-layer synthetic test mocks (strictly forbidden via the production-only Two-Adapter Rule)?
- [ ] **Sociable Verification & Wire Seams**: Does it mandate black-box sociable testing with real collaborators and wire/transport-level interception, rather than fine-grained mock injection?
- [ ] **Direct-Consumer Closure Enforced**: Does the skill block adding speculative or convenience fields to shared schemas without explicit active consumers?
- [ ] **Single-Hop & Allocation-Aware Intact**: Are same-tier wide-then-narrow queries prohibited, and are memory allocations, serialization, and network round-trips evaluated alongside Big-O?
- [ ] **Minimal Surgical Diff over Whitelist**: Does the skill enforce causal necessity via `git diff` without relapsing into bureaucratic static file whitelists?
- [ ] **Scale-Adaptive Testing Maintained**: Does it permit micro-project full suites while strictly forbidding unconstrained recursive suite execution in large repos/monorepos?
- [ ] **Anti-Laundering & Scenario Parity Gate Intact**: Is unauthorized tampering of failing test assertions strictly forbidden, and does deleting any test require a verified 1:1 Scenario Parity Ledger?
- [ ] **Universal Language & Architecture Neutrality**: Is the skill authored strictly in English, using domain-neutral engineering terms applicable across Go, TypeScript, Rust, Java, Python, and different architectural paradigms?
- [ ] **Governance & Ticket Tracker Intact**: Are protected branch commit restrictions and universal ticket ID attachments enforced?
