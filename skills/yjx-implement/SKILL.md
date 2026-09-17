---
name: yjx-implement
description: Implement aligned designs or specs using established engineering principles, evidence-based verification, mandatory code review, and project governance.
disable-model-invocation: true
---

# yjx-implement

Turn an aligned design, specification, or review consensus into production code. Use the principles below to guide engineering judgment within the project's architecture; the execution pipeline defines the delivery gates.

## Maintenance

When reviewing, evolving, or modifying this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. Not needed for runtime execution.

## 1. Engineering Principles

- **Asset Reuse**: Search for and prefer established project libraries and wrappers, then idiomatic standard-library facilities. New external dependencies require approval.
- **YAGNI**: Implement confirmed needs rather than hypothetical flexibility. Justify additions by the behavior or responsibility they support.
- **Information Hiding**: Keep decisions and invariants with their authoritative owner; expose intent without leaking the internal knowledge callers would need to duplicate those decisions.
- **High Cohesion, Low Coupling**: Group related responsibilities and limit change propagation. Judge a boundary by what it isolates, not by its number of implementations or its architectural label.
- **Deep Modules**: Prefer small, intention-revealing interfaces that hide meaningful complexity. Evaluate indirection by the responsibility and complexity it removes from callers, rather than enforcing a particular layer structure.
- **Compatibility**: Preserve existing consumer guarantees unless the confirmed requirements authorize a change. Assess affected consumers beyond the edited scope before narrowing a shared contract.
- **Cost Model**: Evaluate computation, memory, and I/O along actual execution paths. Optimize material costs without sacrificing clarity; a narrower representation or fewer hops is not inherently cheaper.
- **Minimal Diff**: Keep every change causally tied to the task, including necessary tests and integration changes. Leave unrelated refactoring and formatting untouched.
- **Readability**: Make production behavior clear to maintainers. Choose verification seams that support reliable tests without obscuring responsibilities or adding unjustified complexity.
- **Intentional Comments**: Use names and structure to explain mechanics; reserve comments for non-obvious constraints, rationale, and trade-offs.

## 2. Execution Pipeline

### Phase 1: Scope & Baseline
1. **Project Context**: Load applicable project rules and locate the owning repository or package and its workspace configuration. Run commands in that context.
2. **Contract**: Establish the confirmed behavior, affected responsibilities, and compatibility obligations from the spec, ticket, or agreed conversation. Resolve consequential ambiguities before implementation.
3. **Lightweight Pre-flight**: Identify bounded, non-interactive build and verification commands; keep long-running suites out of pre-flight.
4. **Review Baseline**: Record the starting commit and existing staged, unstaged, and untracked changes before editing. Preserve existing work and distinguish it from this task's changes, including when they share a file.
*Completion Criterion*: Requirements and execution boundaries established; verification approach identified; review baseline recorded.

### Phase 2: Implementation
Choose test-writing order to suit the task; use `/tdd` only when the user or project explicitly requires it. For bug fixes, prefer reproducing the failure before editing. For behavior-preserving refactors, assess existing coverage and add missing characterization tests before changing behavior-sensitive code.

Apply the engineering principles to the task's actual dependencies and constraints. Reuse existing assets, implement the confirmed behavior, and examine the diff for unnecessary complexity and scope expansion.
*Completion Criterion*: Required behavior implemented; changes causally bounded; relevant compatibility and resource-cost implications assessed.

### Phase 3: Verification
1. **Bounded Verification**: Run applicable compile or syntax checks first, then targeted tests for the changed behavior and affected consumers. Bound execution to relevant packages or suites in medium/large workspaces; reserve full-suite runs for small projects with known short runtimes. Use non-interactive commands.
2. **Behavioral Evidence**: Test observable contracts with realistic collaborators where practical. Choose isolation based on reliability and the boundary under test, rather than prescribing a mocking mechanism. Cover critical normal, boundary, and error paths; derive expected results from requirements or independently established examples, not the implementation under test.
3. **Regression Protection**: For bug fixes, add regression coverage and, where reproducible, verify failure for the target defect on the old implementation and success after the fix. Report any inability to establish that comparison.
4. **Behavior Preservation**: Refactors retain existing behavior and effective coverage while allowing tests to be reorganized. Confirmed requirement changes may justify updating or removing obsolete assertions; explain that basis and verify the new contract and still-valid boundaries. No itemized scenario ledger is required.
5. **Evidence Integrity**: Weakening, deleting, or disabling checks merely to make failures pass is prohibited. For changes unsuitable for automated tests, perform relevant alternative checks and disclose their evidence and remaining verification limits; test order never waives verification.
*Completion Criterion*: Applicable checks pass; behavior and regression evidence or justified alternative checks recorded; test changes have a behavioral basis; verification limits disclosed.

### Phase 4: Mandatory Code Review
1. **Independent Review**: Use `/code-review` for an independent review of the complete task changes against the aligned requirements, project standards, and this skill, including correctness and regression risks. Supply the Phase 1 baseline and the requirements from the spec, ticket, or agreed conversation.
2. **Complete Review Scope**: Supply `git diff <baseline>` for tracked changes and `git status --porcelain -uall` to identify new files, whose contents must also be reviewed. Use this input instead of `/code-review`'s commit-only comparison and empty-diff check; confirm it covers every task-changed file, whether committed, staged, unstaged, or untracked. Distinguish pre-existing work from task changes without omitting surrounding context needed to assess correctness.
3. **Finding Classification**: Correctness defects, regressions, unmet requirements, and violations of explicit project rules or delivery gates are blocking. Architecture-based blockers must explain concrete correctness, compatibility, maintainability, or resource-cost consequences using the actual changes and constraints. Deviation from a preferred design form or style alone is not blocking.
4. **Resolution Loop**: Fix substantiated blockers, rerun affected verification, and obtain independent re-review of the fixes and any further changes before delivery. Record finding dispositions; disputed blockers remain open until independent re-review resolves them.
*Completion Criterion*: Final task changes independently reviewed; all blocking findings resolved; affected verification passes. If review fails to execute, report the concrete blocker and keep the task incomplete; self-checks or a delivery report cannot substitute for review.

### Phase 5: Governance & Delivery
1. **Governance Gate**: After review passes, recheck branch and project rules. On protected branches (`main`, `master`, release branches) or where project policy requires external review approval, strictly forbid automatic commits; output a delivery report with review results, verification evidence, suggested message, and ticket IDs. Automated review does not grant commit authorization. Stage only task changes when authorized.
2. **Atomic Commits & Ticket Tracking**: When auto-commits are explicitly permitted, make Conventional Commits (`feat(scope): <summary>`), staging only task changes, splitting per repository when applicable, and including detected issue/ticket IDs in the project's format.
*Completion Criterion*: Review gate passed; task-created temporary files removed without disturbing pre-existing work; compliant commit or comprehensive delivery report produced.
