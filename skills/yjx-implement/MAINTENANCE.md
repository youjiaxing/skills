# Maintenance: yjx-implement

This document records the architectural rationale, lineage against the original `mattpocock/skills` `/implement` command, real-world failure analyses, and anti-drift rules for `yjx-implement`. Consult this file when reviewing, modifying, or refactoring this skill; it is not loaded during runtime execution.

---

## 1. Design Rationale & Lineage

`yjx-implement` completely replaces Matt Pocock's thin 5-line `/implement` command ("implement per spec", "use /tdd", "run full test suite at the end", "use /code-review", "commit if permitted"), transforming it into a surgical code execution engine balancing master-level software design aesthetics with strict industrial delivery discipline.

In real-world enterprise engineering, the original naive instructions trigger catastrophic failure modes: out-of-control scope wandering, green-laundering (tampering with assertions to pass tests), full-suite test timeouts hanging for tens of minutes, gratuitous mocking destroying domain readability, and unauthorized dirty commits on protected branches.

---

## 2. Core Engineering Pain Points & Mitigations

### 1. The Asset Bypass & NIH Trap
* **Pain Point**: When models pursue "first-principles implementation", they frequently bypass battle-tested internal utility libraries (e.g. Go projects with unified `pkg/time` handling timezones and mockable test clocks, `pkg/errors`, or centralized context logging), reinventing raw standard library or third-party wheels.
* **Mitigation**: The **Asset Reuse Ladder**: `Project Unified Libraries (Highest)` > `Language Standard Library` > `External Dependencies (Strictly Forbidden without Approval)`. Search and reuse established internal utilities before coding.

### 2. Green Laundering & Assertion Tampering
* **Pain Point**: When faced with failing tests during complex implementation, LLMs suffer moral hazards—relaxing thresholds, commenting out assertions, or deleting test cases to fake a green bar.
* **Mitigation**: The **Zero Assertion Tampering Redline**: Modifying existing assertions is strictly forbidden unless the upstream specification explicitly mandates a contract change.

### 3. Over-Testing & Readability Destruction
* **Pain Point**: Models frequently equate "testability" with extracting premature interfaces for every struct, forcing dependency injection everywhere, and mocking every collaborator. Simple domain code gets bloated into impenetrable lasagna architecture.
* **Mitigation**: **Readability Over Mockability**: Synthetic interfaces and polymorphic indirection created solely for mocks are explicitly forbidden. Production code must take the shortest, clearest causal path.

### 4. Full Suite Timeout & Scale-Adaptive Testing
* **Pain Point**: Matt Pocock's directive to "run full test suite at the end" hangs indefinitely or times out in medium-to-large mono-repos; conversely, locking out all tests prevents small scripts or micro-projects from leveraging fast automated verification.
* **Mitigation**: **Scale-Adaptive Verification**: Allow micro-projects (run time ≤ seconds) to run full suites; strictly prohibit unconstrained recursive suite execution (e.g. bare `go test ./...`) in large/multi-repo projects, confining verification to leaf files or specific test functions.

### 5. Workspace Container Trap & Lightweight Pre-flight
* **Pain Point**: The root directory is often just an empty container repo or workspace wrapper. Running tests or git commands from the root causes misdirected execution. Furthermore, forcing baseline tests during pre-flight derails implementation momentum.
* **Mitigation**: Anchor sub-packages and Git boundaries to the touched file's immediate leaf submodule. Phase 1 remains a lightweight, non-blocking lock.

### 6. Hanging Interactive Watchers
* **Pain Point**: Commands like `npm test` or `pytest` default to interactive watch modes, causing background agent execution to hang indefinitely waiting for stdin.
* **Mitigation**: Force non-interactive CI flags (`--watch=false`, `CI=true`) during command probing.

### 7. Why-Anchored Positive Prompting
* **Pain Point**: Telling an LLM "don't write useless comments" triggers negative framing (either writing zero comments or writing more meta-comments).
* **Mitigation**: **Why-Anchored Comments**: Code structure and naming explain WHAT and HOW; comments strictly explain WHY (subtle invariants, tripwires, discarded architectural alternatives).

### 8. Governance First & Universal Tracker
* **Pain Point**: Assuming direct commits on any branch and hardcoding GitHub `#123` assumptions breaks enterprise workflows (protected branches, mandatory CR, Jira/Teambition IDs).
* **Mitigation**: Forbid auto-commits on protected branches or CR-mandated repositories. When committing is allowed, enforce Conventional Commits and universally extract issue IDs in any format (`#123`, `PROJ-456`, `TASK-88`).

### 9. Data Boundary Hoisting & Pseudo-Reuse via Same-Tier Trimming
* **Pain Point**: Two frequent architectural regressions occur during feature assembly:
  1. *Unjustified Boundary Hoisting*: To make local assembly convenient, fields not required by direct consumers are hoisted into shared value objects, DTOs, or cross-boundary protocols (e.g., adding an unneeded `EnterTime` field into a cross-server member value object and proto, which pollutes the cross-server boundary when downstream real-time services could provide it locally).
  2. *Same-Tier Pseudo-Reuse*: Reusing wide query methods from the same layer and immediately discarding/trimming the wide projection into a narrower shape (e.g. calling `GetWarRoleValues` to hydrate full entities and maps, only to extract `UnionId`, instead of querying the repository/owner directly for `UnionId` in a single hop).
* **Mitigation**: **Direct-Consumer Closure & Single-Hop Read**: Require every added field in shared boundaries to have an explicit active consumer in the touched scope. Forbid same-tier wide query reuse when direct, single-hop queries to the domain owner are possible. Upgrade complexity analysis to **Allocation-Aware Complexity** (counting full-object hydrations and intermediate collections alongside Big-O).

### 10. The Whitelist Fallacy vs. Causal Scope
* **Pain Point**: Static "file whitelists" produce a false sense of security while creating bureaucratic friction:
  - Fatal bugs (like unneeded fields or bad queries) occur *inside* legitimate whitelisted files.
  - Pre-declaring a rigid whitelist before coding triggers cognitive failure modes: either the agent invents ugly architectural workarounds to avoid touching an unlisted companion file (like a caller signature update or unit test), or it pre-declares an overly broad whitelist that renders the guardrail meaningless.
* **Mitigation**: **Minimal Surgical Diff**: Eliminate the artificial bookkeeping ceremony of static whitelists. Anchor strictly to **causal necessity** (every line changed must be directly justified by the task/spec; zero opportunistic refactoring or formatting of untouched code) and use the environment's true source of truth (`git status` and `git diff`) for verification. Companion tests and local registrations are recognized as natural companion changes.

### 11. Architectural Decoupling: Sub-Agent Governance
* **Design Decision**: Multi-agent dispatch and parallel sub-agent launch gates (e.g., preventing overlapping planner sub-agents on the same codebase) belong exclusively to top-level orchestrators or user rules. Because `yjx-implement` is a leaf implementation execution engine (`disable-model-invocation: true`), it must never be contaminated with multi-agent orchestration policies, preserving its high cohesion and strict line budget.

---

## 3. Anti-Drift Validation Checklist

When modifying or maintaining this skill, verify that none of the following regressions occur:

- [ ] **Asset Reuse Ladder Preserved**: Does the skill still mandate prioritizing internal project libraries over raw standard libraries or new external dependencies?
- [ ] **Anti-Sprawl Line Budget Intact**: Is `SKILL.md` strictly constrained to under 100 lines (target ~70–80 lines) of high-density execution rules?
- [ ] **Direct-Consumer Closure Enforced**: Does the skill block adding speculative or convenience fields to shared schemas without explicit active consumers?
- [ ] **Single-Hop & Allocation-Aware Intact**: Are same-tier wide-then-narrow queries prohibited, and are memory allocations/object instantiations evaluated alongside Big-O?
- [ ] **Minimal Surgical Diff over Whitelist**: Does the skill enforce causal necessity via `git diff` without relapsing into bureaucratic static file whitelists?
- [ ] **Scale-Adaptive Testing Maintained**: Does it permit micro-project full suites while strictly forbidding unconstrained recursive suite execution in large repos?
- [ ] **Anti-Laundering Gate Intact**: Is unauthorized tampering or deletion of failing test assertions strictly forbidden?
- [ ] **Readability Redline Resilient**: Is the creation of synthetic interfaces solely for test mocking prohibited?
- [ ] **Governance & Ticket Tracker Intact**: Are protected branch commit restrictions and universal ticket ID attachments enforced?
