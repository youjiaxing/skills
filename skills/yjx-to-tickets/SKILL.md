---
name: yjx-to-tickets
description: Break a plan, spec, or conversation into context-sized, causality-complete tracer-bullet tickets with explicit blocking edges, domain-adaptive verification criteria, and invariant traceability.
disable-model-invocation: true
---

# yjx-to-tickets

Break a plan, specification, or conversation consensus into a set of **tracer-bullet tickets**: self-contained, vertically-sliced units of execution, each declaring the tickets that **block** it.

Each ticket is designed to converge cleanly within a **single fresh context window** without triggering lossy context compression, maintain complete **causal cohesion**, and remain **self-explanatory for human review**.

The issue tracker configuration and triage label vocabulary are read from the environment (`docs/agents/issue-tracker.md`, `docs/agents/local-tracker.json`, or `docs/agents/triage-labels.md`). If not configured, tell the user to run the repo's tracker setup.

## Maintenance

When reviewing, modifying, or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It records the skill's design intent, community evolution history, and anti-drift rules; it is not needed for ordinary runtime execution.

## 1. Slicing Principles & Semantics

Evaluate every slice against three semantic invariants rather than rigid line counts or artificial file limits:

1. **Causal Cohesion (因果自洽)**:
   - Every ticket must deliver a complete, observable evidence chain (Intent $\to$ Action $\to$ Verification).
   - A completed slice is independently runnable and verifiable on its own.
   - **Anti-Fragmentation**: Never split a single business action into isolated definitions without callers (e.g. DTO without consumers, UI stub without events). If Ticket A cannot be verified without Ticket B, merge them.
2. **Cognitive Focus & Single-Session Convergence (认知聚焦与单会话收敛)**:
   - Target a single concern with a self-contained scope, enabling an agent or human to complete the task within one fresh session from understanding to test passage without derailment.
   - Slices derive naturally from topological milestones and state transitions in the source material.
3. **Review Self-Containedness (审查自解释性)**:
   - A reviewer can understand the rationale, changes, and proof of correctness solely from the ticket's code and tests, without consulting unmerged downstream tickets.
4. **Execution Subject Segregation (执行主体分流)**:
   - **AFK-First (Default)**: Mark implementation, refactoring, and test tasks as `ready-for-agent` (or the repo's mapped equivalent) when verification is autonomous and self-contained.
   - **Explicit HITL Gates**: Extract external credential provisioning, cloud infrastructure setup, manual migrations, or subjective visual sign-offs into explicit human tickets (`ready-for-human`), declaring them as blockers for downstream AFK tickets.

## 2. Process

### Step 1: Gather Context & Invariants
- Ingest input from the conversation history, an upstream specification file, PRD, or plan notes passed as an argument.
- If an upstream Spec or design doc exists:
  - Record its path as the canonical reference link (SSOT).
  - Extract its core **System Invariants**, **Touched Areas**, and **Forbidden Paths** to ensure zero requirement leakage during slicing.
- If working from raw conversation, synthesize the confirmed goals, constraints, and boundaries directly.

### Step 2: Draft Vertical Slices & Dependency DAG
- Decompose the effort into tracer-bullet slices cutting vertically through the necessary domain layers.
- For each slice, formulate:
  - **What it delivers**: The end-to-end behavior or observable milestone made functional.
  - **Invariants & Scope**: The specific boundaries, constraints, and relevant invariants governing this slice.
  - **Falsifiable Acceptance Criteria**: Deterministic, observable checks (concrete automated test commands, physical measurement tolerances, or verifiable state changes).
  - **Blocking Edges (`Blocked by`)**: Explicit upstream tickets that must be resolved before this slice can begin. Independent tickets start unblocked.
- **Wide Refactor Exception**: For broad changes with massive blast radius across shared contracts, sequence as **expand–contract** (expand new form $\to$ batch-migrate callers $\to$ contract old form) rather than forcing into a single tracer bullet.

### Step 3: Traceability & Anti-Fragmentation Self-Audit
Before presenting to the user, conduct an internal audit:
- **Traceability Check**: Ensure every critical invariant, edge case, and touch boundary from the input is accounted for across the generated tickets.
- **Anti-Fragmentation Check**: Verify no ticket is an incomplete stub lacking verifiable utility. Merge tightly coupled micro-slices.

### Step 4: Review Breakdown with User
Present the draft breakdown clearly:

```markdown
### Proposed Breakdown

1. **[01] <Ticket Title>**
   - **Execution**: AFK (`ready-for-agent`) | HITL (`ready-for-human`)
   - **Blocked by**: None
   - **What it delivers**: <End-to-end outcome>
   - **Key Verification**: <Concrete test command or verifiable proof>

2. **[02] <Ticket Title>**
   - **Execution**: AFK (`ready-for-agent`)
   - **Blocked by**: 01
   - **What it delivers**: <End-to-end outcome>
   - **Key Verification**: <Concrete test command or verifiable proof>
```

Ask the user:
- Does the granularity feel balanced (neither too coarse nor over-fragmented)?
- Are the dependencies and execution subjects (AFK vs HITL) accurate?
- Should any slices be adjusted or merged?

Iterate until the user approves.

### Step 5: Publish Tickets to Configured Tracker
Publish approved tickets following the repo's configured tracker protocol:

- **Local Markdown Tracker (`.scratch/<feature-slug>/issues/<NN>-<slug>.md`)**:
  - Number sequentially from `01` in dependency order.
  - Apply the Local Ticket Template below.
- **Remote Issue Tracker (GitHub, Linear, Jira, etc.)**:
  - Publish issues via CLI/API in dependency order.
  - Establish native parent / blocking relationships and apply canonical triage labels (`ready-for-agent` / `ready-for-human`).

Do NOT modify or close parent spec/map issues during publication.

---

## 3. Ticket Templates

### Local Markdown Template (`.scratch/<feature>/issues/<NN>-<slug>.md`)

```markdown
# <NN>: <Ticket Title>

Status: ready-for-agent
Blocked by: None

<!-- If a parent spec or source document exists, link it here -->
Spec: <relative/path/to/spec.md>

## What to build

<Describe the end-to-end behavior this ticket delivers, from a functional perspective. Avoid stale code snippets unless encoding an exact state machine or mathematical formula.>

## Invariants & Scope Bounds

- **Touched Areas**: <Allowed modules, files, or physical scopes>
- **Relevant Invariants**: <Key rules and forbidden patterns governing this ticket>

## Acceptance criteria

- [ ] <Deterministic verification assertion or automated test command>
- [ ] <Observable behavior or error handling proof>
```

### Remote Issue Body Template

```markdown
## Parent
<Link to parent issue/spec if applicable, otherwise omit>

## What to build
<The end-to-end behavior this ticket delivers.>

## Invariants & Scope Bounds
- **Touched Areas**: <Allowed scopes>
- **Relevant Invariants**: <Key rules and constraints>

## Acceptance criteria
- [ ] <Deterministic verification assertion or automated test command>
- [ ] <Observable behavior or error handling proof>

## Blocked by
- <Reference to blocking issues, or "None">
```

---

## 4. Forbidden Paths

- **NEVER** use arbitrary magic numbers (e.g. rigid line count limits) as mechanical slicing rules.
- **NEVER** slice into incomplete, untestable stubs that break causal cohesion.
- **NEVER** forbid or discourage downstream executors from consulting the parent Spec when needed.
- **NEVER** mandate specific preceding or succeeding skill workflows.
- **NEVER** drop or dilute system invariants and safety boundaries during ticket creation.
- **NEVER** invent unmapped custom triage labels on remote issue trackers.
- **NEVER** modify production application source code within this skill.
