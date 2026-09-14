---
name: yjx-implement
description: Implement production-grade code with surgical precision based on aligned designs or specs. Respect existing conventions, reject invented abstractions, minimize data closures, enforce allocation-aware complexity, and uphold scale-adaptive verification with zero laundering.
disable-model-invocation: true
---

# yjx-implement

Transform aligned designs, specification blueprints, or review consensus into production-grade code with surgical precision. Maximize reuse of existing project assets, enforce minimal data closures and direct-consumer reads, push algorithmic complexity to practical limits, and uphold strict project governance without vanity ceremony.

## Maintenance

When reviewing, evolving, or modifying this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. Not needed for runtime execution.

## 1. Core Creed

- **Asset Reuse Ladder**:  
  Priority order: `Project Unified Libraries/Wrappers (Highest)` > `Language Standard Library/Idiomatic Native` > `New External Dependencies (Strictly Forbidden without Approval)`. Search and reuse established internal utilities (time, logging, errors, context) before writing code.
- **Zero Invented Abstractions**:  
  Entities must not be multiplied beyond necessity. Forbid spurious factories, adapters, intermediate wrappers, or synthetic layers; implement core logic with the shortest causal path.
- **Direct-Consumer Closure & Single-Hop Read**:  
  Shared types, schemas, and queries must contain only fields directly consumed within the touched scope. Keep data in its domain owner; never hoist downstream-specific data to shared models or cross-boundary protocols for assembly convenience. Forbid same-tier wide queries that immediately trim results downstream—fetch final shapes directly from the authoritative owner in a single hop.
- **Allocation-Aware Complexity**:  
  Enforce asymptotic limits (Big-O) while eliminating hidden allocation waste: count round-trips, full-object hydrations, and redundant intermediate collections alongside loop iterations. Reject clever micro-optimizations that destroy readability.
- **Minimal Surgical Diff**:  
  Every line and file modified must have direct causal necessity to the aligned spec or task. Forbid opportunistic refactoring, unsolicited formatting of untouched code, and speculative changes beyond the task boundary.
- **Readability Over Mockability**:  
  Forbid synthetic interfaces, leaky abstractions, or gratuitous dependency injection invented solely to facilitate unit tests or mocking. Native readability and operational maintainability take precedence.
- **Why-Anchored Comments**:  
  Naming and structure self-explain WHAT and HOW. Comments strictly record WHY: non-obvious business invariants, critical tripwires, and discarded architectural trade-offs. Forbid parrot comments that merely rephrase syntax.

## 2. Execution Pipeline

### Phase 1: Context & Boundary Lock
1. **Submodule Anchoring**: In multi-repo or container workspaces, anchor execution strictly to the immediate sub-package/repository of the target change, ignoring outer wrapper containers.
2. **Contract & Consumer Verification**: For any touched shared schema, DTO, or cross-module boundary, confirm explicit active consumers in the target scope. Reject speculative or convenience-driven field additions.
3. **Lightweight Probing (Optional & Non-Blocking)**: Inspect local build/syntax check commands with non-interactive flags (`--watch=false`, `CI=true`). Never run blocking tests in this phase.
*Completion Criterion*: Target module boundaries identified; zero unneeded fields introduced to shared contracts.

### Phase 2: Surgical Implementation
1. Unroll core logic along direct causal paths, eliminating intermediate glue layers and same-tier query re-trimming.
2. Limit all edits strictly to causal necessities; accompany core logic with direct unit tests and local registrations as needed.
3. Adhere to Why-Anchored Comments.
*Completion Criterion*: Changes causally bounded; zero invented abstractions; zero speculative fields; single-hop data access.

### Phase 3: Gradient Verification & Anti-Laundering Gate
1. **Scale-Adaptive Verification**:
   - *Local Compile/Syntax First*: Verify touched packages rapidly (e.g. `go build <pkg>`, `tsc --noEmit`).
   - *Size-Tiered Testing*: Run fast suites in micro projects (≤ seconds); in large/multi-repo projects, strictly forbid unconstrained recursive suite runs (e.g. bare `go test ./...`), constraining test runs to touched files or target functions.
2. **Structural & Allocation Audit**:
   - Confirm all added fields in shared boundaries are actively read by target consumers.
   - Confirm no same-tier methods consume wide intermediate objects merely to narrow them.
   - Confirm allocations and intermediate collections are strictly necessary.
3. **Zero Laundering**: Strictly forbid weakening, deleting, or commenting out existing assertions due to test failures. Assertions may be updated only when the aligned spec explicitly mandates a contract change.
*Completion Criterion*: Local compilation clean; executed tests pass green; structural diff clean; zero unauthorized assertion laundering.

### Phase 4: Governance & Clean Wrap-up
1. **Governance Gate**: Check branch and project rules. On protected branches (`main`, `master`) or when Code Review is required, strictly forbid automatic commits; stage clean diffs and output a delivery report with suggested message and ticket IDs.
2. **Atomic Commits & Universal Ticket Tracking**: When auto-commits are explicitly permitted, make Conventional Commits (`feat(scope): <summary>`), staging only causally touched files (split per sub-repo if applicable). Append detected issue/ticket IDs of any format (e.g. `#123`, `PROJ-456`, `TASK-88`).
*Completion Criterion*: Zero temporary dirty files; compliant commit or comprehensive review delivery report produced.

## 3. Forbidden Paths

1. Bypassing existing project utility libraries in favor of raw standard libraries or ad-hoc implementations.
2. Adding speculative, unconsumed fields to shared models or cross-boundary protocols for assembly convenience.
3. Introducing same-tier wide queries that map intermediate full objects only to trim them down downstream.
4. Opportunistically refactoring or formatting untouched code outside the task's causal necessity.
5. Inventing dummy interfaces or wrapper layers solely to satisfy unit test mocking at the expense of readability.
6. Laundering broken tests by weakening, commenting out, or deleting existing assertions.
7. Running unconstrained recursive test suites in medium/large repos without assessing execution duration.
8. Writing syntax-repeating parrot comments.
9. Executing unauthorized `git commit` on protected branches or environments requiring Code Review.
