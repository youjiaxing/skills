---
name: yjx-implement
description: Implement production-grade code with surgical precision based on aligned designs or specs. Enforce layer-aware deep modules, legitimate architectural seams, direct-consumer closures, allocation-aware complexity, sociable verification, and zero laundering across any language or architecture.
disable-model-invocation: true
---

# yjx-implement

Transform aligned designs, specification blueprints, or review consensus into production-grade code with surgical precision. Maximize reuse of existing project assets, enforce layer-aware module depth and minimal data closures, distinguish architectural ports from forbidden synthetic test mocks, push algorithmic complexity to practical resource limits, and uphold strict project governance without vanity ceremony.

## Maintenance

When reviewing, evolving, or modifying this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. Not needed for runtime execution.

## 1. Core Creed

- **Asset Reuse Ladder**:  
  Priority order: `Project Unified Libraries/Wrappers (Highest)` > `Language Standard Library/Idiomatic Native` > `New External Dependencies (Strictly Forbidden without Approval)`. Search and reuse established internal utilities (time, logging, errors, context, serialization) before writing code.
- **Layer-Aware Depth (Small Surface, Deep Implementation)**:  
  Module depth depends strictly on architectural responsibility:
  - *Orchestration Layers* (Controllers, Application/Workflow services, Event dispatchers) are coordinators: keep them clean and thin (load data ➔ invoke core ➔ persist/dispatch). Never hoard domain business logic or bypass core encapsulation.
  - *Core Logic Layers* (Domain entities, calculation engines, state machines, pure pipelines) are the true **Deep Modules**: hide complexity behind minimal, intention-revealing APIs.
  - *Mechanism Downward, Policy Upward*: Subsume invariant validation, state machine transitions, concurrency control, and transient retries inside the core unit; keep cross-domain routing and orchestration policies at the boundary.
  - *The Deletion Test*: If deleting an intermediate layer or helper causes complexity to vanish, it was a useless pass-through—inline or remove it. If complexity reappears across $N$ callers, it earns its keep.
- **Seam Hierarchy (Architectural Ports vs. In-Layer Seams)**:  
  - *Architectural Decoupling Ports (Legitimate)*: Seams isolating cross-layer boundaries, persistent storage, external networks, hardware, or third-party APIs are legitimate dependency inversion ports, even if only a single production implementation currently exists.
  - *In-Layer Seams (The Two-Adapter Rule)*: Within the same architectural tier or domain boundary, creating interfaces, abstract classes, factories, or indirection is strictly forbidden unless at least two distinct implementations exist in **production business requirements**. A test mock or fake DOES NOT count as a second adapter.
- **Direct-Consumer Closure & Single-Hop Read**:  
  Shared types, DTOs, schemas, and queries must contain only fields directly consumed within the touched scope. Never hoist downstream-specific data to shared models or cross-boundary protocols for local convenience. Forbid same-tier wide queries that hydrate full entities only to trim them downstream—fetch final projections directly from the authoritative owner in a single hop.
- **Allocation-Aware Complexity**:  
  Enforce asymptotic limits (Big-O) while eliminating hidden allocation waste: count network round-trips, database full-object hydrations, serialization cycles, and redundant intermediate collections alongside loop iterations. Reject clever micro-optimizations that destroy readability.
- **Minimal Surgical Diff**:  
  Every line and file modified must have direct causal necessity to the aligned spec or task. Forbid opportunistic refactoring, unsolicited formatting of untouched code, and speculative changes beyond the task boundary.
- **Readability Over Mockability**:  
  Never compromise production clarity, introduce artificial indirection, or multiply constructor parameters solely to facilitate unit test mocking. Production code serves production reliability and human readability; tests must adapt to the natural shape of production code.
- **Why-Anchored Comments**:  
  Naming and structure self-explain WHAT and HOW. Comments strictly record WHY: non-obvious business invariants, critical tripwires, performance trade-offs, and discarded alternatives. Forbid parrot comments that merely rephrase syntax.

## 2. Universal Execution Pipeline

### Phase 1: Scope, Boundary & Seam Lock
1. **Submodule/Workspace Anchoring**: In monorepos, multi-repo setups, or container workspaces, anchor execution strictly to the immediate leaf submodule or package context (respecting workspace boundary configs, e.g. `go.work`, `pnpm-workspace.yaml`, Cargo workspaces).
2. **Contract & Consumer Verification**: For any touched shared schema, DTO, or cross-boundary contract, verify explicit active consumers in the target scope. Reject speculative or convenience-driven field additions.
3. **Seam Classification**: Validate every introduced or modified interface: verify that it either represents an architectural I/O boundary port or satisfies the production-only Two-Adapter Rule. Reject in-layer synthetic test interfaces.
4. **Lightweight Probing (Non-Blocking)**: Inspect local build/syntax check commands with non-interactive flags (`--watch=false`, `CI=true`). Never run long-running test suites during pre-flight.
5. **Review Baseline**: Record the starting commit and existing staged, unstaged, and untracked changes before editing. Preserve existing work and distinguish it from this task's changes, including when they share a file.
*Completion Criterion*: Target boundaries locked; zero unneeded fields introduced; all seams justified; review baseline recorded.

### Phase 2: Surgical Implementation
Choose test-writing order to suit the task; use `/tdd` at agreed test boundaries only when the user or project explicitly requires it. For bug fixes, prefer reproducing the failure before editing. For behavior-preserving refactors, assess existing coverage and add missing characterization tests before changing behavior-sensitive code. Keep these checks targeted, using Phase 3's verification rules.

1. Unroll core logic along direct causal paths: orchestrators coordinate flow, core entities/engines encapsulate invariants and state mutations.
2. Forbid direct inspection of entity internal state for external decision-making; expose semantic intention-revealing methods on the domain owner.
3. Apply the Deletion Test to eliminate intermediate glue layers, pass-through wrappers, and redundant same-tier re-trimming.
4. Adhere strictly to Why-Anchored Comments.
*Completion Criterion*: Changes causally bounded; zero invented abstractions; zero speculative fields; single-hop data access.

### Phase 3: Sociable Verification & Anti-Laundering Gate
1. **Scale-Adaptive Verification**:
   - *Local Compile/Syntax First*: Rapidly verify touched packages (e.g. `go build <pkg>`, `tsc --noEmit`, `cargo check`).
   - *Targeted Leaf Testing*: In medium/large projects or monorepos, strictly forbid unconstrained recursive suite execution (e.g. bare `go test ./...`, full workspace `npm test`), constraining test runs to touched files or target packages.
2. **Sociable Verification Over Brittle Mocking**:
   - Verify business logic through public facades using real domain/value collaborators.
   - Restrict mocking/stubbing strictly to true architectural I/O boundaries. Prefer wire/transport-level interception (e.g. `httptest.Server`, `http.RoundTripper`, in-memory databases/caches, wiremock) over synthetic interface mocks.
3. **Behavior & Regression Evidence**:
   - For new or changed behavior, add or update tests covering critical normal, boundary, and error paths. Derive expected results from requirements or independently established examples, not from the implementation under test.
   - For bug fixes, add regression coverage and, where reproducible, verify it fails for the target defect on the old implementation and passes after the fix; tests may be written before or after implementation. Report any inability to establish that comparison.
   - For changes unsuitable for automated tests, perform the relevant alternative checks and report the evidence and remaining verification limits; choosing not to use TDD never waives verification.
4. **Anti-Laundering & Scenario Parity Gate**:
   - *Zero Assertion Tampering*: Strictly forbid weakening, deleting, or commenting out existing assertions due to test failures.
   - *Scenario Parity Ledger*: If refactoring genuinely deprecates an obsolete fine-grained test, silent deletion is forbidden. The change must provide a 1:1 Scenario Parity Ledger proving that every edge case, overflow guard, and error path from the old tests is explicitly verified in the new interface-level test suite.
5. **Structural & Allocation Audit**:
   - Confirm all added fields in shared boundaries are actively consumed.
   - Confirm no methods consume wide intermediate objects merely to narrow them.
   - Confirm allocations, hydrations, and collections are strictly necessary.
*Completion Criterion*: Applicable compilation and targeted tests pass; behavior/regression evidence or justified alternative checks recorded; verification limits disclosed; structural diff clean; zero test laundering; 1:1 scenario parity audit passed if tests were superseded.

### Phase 4: Mandatory Code Review
1. **Independent Review**: Use `/code-review` for an independent review of the complete task changes against the aligned requirements, project standards, and this skill's constraints, including correctness and regression risks. Supply the Phase 1 baseline and the requirements from the spec, ticket, or agreed conversation.
2. **Complete Review Scope**: Include committed, staged, unstaged, and newly added untracked task changes. Adapt commit-only diff collection to include working-tree changes and read new files; a comparison ending at `HEAD` alone is insufficient for uncommitted work. Distinguish pre-existing work from task changes without omitting surrounding context needed to assess correctness.
3. **Resolution Loop**: Fix valid blocking findings, rerun affected verification, and obtain independent re-review of the fixes and any further changes before delivery. Record the disposition of findings, including reasons for rejecting suggestions; stylistic preferences alone do not mandate unrelated refactoring.
*Completion Criterion*: The final task changes have been independently reviewed, all blocking findings are resolved, and affected verification passes. If review is blocked by an execution failure, report the concrete blocker and keep the task incomplete; self-checks or a delivery report cannot substitute for review.

### Phase 5: Governance & Delivery
1. **Governance Gate**: Check branch and project rules after the review gate passes. On protected branches (`main`, `master`, release branches) or where project policy requires external review approval, strictly forbid automatic commits; output a delivery report with review results, verification evidence, suggested message, and ticket IDs. Stage only task changes when authorized.
2. **Atomic Commits & Universal Ticket Tracking**: When auto-commits are explicitly permitted, make Conventional Commits (`feat(scope): <summary>`), staging only causally touched files (split per sub-repo if applicable). Append detected issue/ticket IDs of any format (e.g. `#123`, `PROJ-456`, `TASK-88`).
*Completion Criterion*: Review gate passed; task-created temporary files removed without disturbing pre-existing work; compliant commit or comprehensive delivery report produced.

## 3. Forbidden Paths

1. Bypassing existing project utility libraries in favor of raw standard libraries or ad-hoc implementations.
2. Inventing in-layer dummy interfaces, wrapper classes, or dependency injection boilerplate solely to satisfy unit test mocking at the expense of readability.
3. Dismantling or bypassing legitimate architectural decoupling ports (e.g. database repositories, remote client boundaries) under the pretext of avoiding abstraction.
4. Orchestration layers bypassing domain encapsulation to read raw entity attributes and implement external business branching.
5. Adding speculative, unconsumed fields to shared models, DTOs, or cross-boundary protocols for assembly convenience.
6. Introducing wide queries that hydrate full objects only to trim them down downstream.
7. Opportunistically refactoring or formatting untouched code outside the task's causal necessity.
8. Laundering broken tests by weakening, commenting out, or silently deleting existing assertions without a 1:1 Scenario Parity Ledger.
9. Running unconstrained recursive test suites in medium/large repos or monorepos without assessing execution duration.
10. Writing syntax-repeating parrot comments.
11. Executing unauthorized `git commit` on protected branches or environments requiring external review approval.
