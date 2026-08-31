---
name: yjx-to-spec
description: Compile aligned discussions, decision artifacts, or completed planning maps into a cohesive, domain-adaptive, high-fidelity specification blueprint with explicit invariants, open parameter range limits, and brownfield safety boundaries.
disable-model-invocation: true
---

Compile the confirmed consensus from the conversation, structured alignment artifacts, or completed planning maps into a cohesive, high-density, authoritative **Specification Blueprint**.

A specification defines the **complete, invariant truth of the destination** (what the finished system/artifact looks like, its change boundaries, contracts, and what must NOT break). It is NOT an interview questionnaire, NOT a lossy narrative summary, and NOT a premature execution schedule.

## Maintenance

When reviewing, modifying, or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It records design rationale, community issue lineage, and anti-drift rules; it is not needed for ordinary runtime execution.

## 1. Core Principles & Philosophy

- **High-Cohesion Blueprint (No Premature Slicing)**:
  Describe the complete system, its holistic entities, and its unified state machine as an indivisible whole. **Do NOT prematurely slice the Spec into vertical execution schedules or task tickets inside the document.** Slicing is the exclusive responsibility of downstream planning or ticketing workflows.
- **Upstream & Downstream Decoupling**:
  Never assume or mandate specific preceding workflows (e.g. particular interview tools) or specific downstream execution tools (e.g. particular testing or review commands). Produce a standalone, self-contained specification that any human engineer, QA team, contractor, or automated agent can directly consume.
- **Brownfield Safety & Surgical Scope**:
  In existing codebases or physical spaces, explicitly declare **Touched Areas** (what files/schemas/zones are allowed to change) and **What MUST NOT Break** (inviolable contracts of untouched surrounding systems). Prevent hallucinated wide refactors in large legacy systems.
- **Epistemological Separation**:
  Strictly separate **Human Confirmed Choices (P0 Locked / Solid Lines)** from **AI Inferred Open Parameters (P1 Range Limits / Dashed Slots)**. Surface these via a top-level **Readiness Radar**.
- **Decisions & Discarded Alternatives (ADR-Lite)**:
  Every major architectural or structural decision must record its **Rationale** and **Discarded Alternatives & Reasons** to prevent downstream implementers from re-proposing rejected approaches.
- **Contract vs. Implementation Separation**:
  Mandate exact public data structures (Struct, Interface, Proto, SQL DDL diff, state transition tables, or BOMs). **Strictly forbid private helper logic, internal glue code, or hidden scripts** inside the Spec.
- **High-Density Verifiable Assertions (Anti-BDD Inflation)**:
  Avoid mechanical generation of dozens of trivial Given-When-Then scenarios. Focus strictly on 3–5 high-leverage causal scenarios, or compress multi-branch assertions into a compact **Scenario Outline Matrix**. For non-software domains, degrade naturally to inspection rubrics.
- **Domain-Adaptive Native Projection**:
  Reason internally using the universal 7-part meta-skeleton, but **render the final document 100% in the native terminology, schemas, and concrete artifacts of the target domain**. Never output abstract meta-jargon.
- **Zero-Modal Friction**:
  Synthesize the Spec in a single turn without interrupting popups. Surface open uncertainties as explicit parameter range limits in Section 4.

## 2. Upstream Context Ingestion

Autonomously ingest the upstream context without imposing rigid workflow assumptions:
1. Extract confirmed user intent, verified facts, and architectural choices from the conversation, uploaded notes, meeting memos, or previous artifacts.
2. Independently explore the existing environment (codebase, schemas, or project docs) to ground the design and identify brownfield safety boundaries.
3. Automatically derive safe boundary range limits for unaddressed micro-parameters without inventing concrete unvetted numbers.

## 3. Domain-Adaptive Native Projection & Localization

Identify the domain archetype and project the sections into concrete, hard-edged domain representations:

- **Software & Systems Engineering**:
  - Output exact Protobuf definitions, SQL DDL diffs, typed domain structs, and error code tables with complete field comments.
  - Render concrete API/RPC signatures, idempotency keys, and transaction boundary notes.
  - Detail exact invariant equations (e.g., financial balance conservation) and concrete automated test assertions.
- **Physical & Space Design (e.g., Interior Decoration)**:
  - Output Bill of Materials (BOM) with mm dimensions, Pantone color codes, material grades, and tolerances.
  - Render spatial clearance rules ($\ge 800\text{mm}$), MEP (mechanical, electrical, plumbing) coordinate specs, and environmental standards.
  - Detail physical inspection checklists and load-bearing constraints.
- **Processes, Operations & Business**:
  - Output RACI role responsibility matrices, phase gate transition tables, and escalation paths.
  - Detail SLA timeout parameters, audit logging invariants, and rehearsal checklists.

**Localization**: Keep this skill file in English. At runtime, render all user-facing Spec headings, labels, table headers, and explanatory prose into the user's conversational language.

## 4. Disambiguated Specification Template

Render the Specification using the disambiguated standard template below:

```markdown
# [<System / Feature / Target Name>] Specification

> **Metadata**:
> - **Origin**: <Link to upstream notes, session context, or initiative map>
> - **Domain**: <Software / Physical Design / Operations / etc.>
> - **Readiness Radar**: 
>   - [x] P0 Locked Decisions (Human Confirmed): 100%
>   - [x] P1 Open Parameters Converged: 100% (Total: N items, all bounded within safety limits)
>   - [x] Brownfield Safety Verified (Touched Areas Defined)
>   - [ ] Status: [ READY FOR IMPLEMENTATION & VERIFICATION ]

---

## 1. Scope & Brownfield Safety (目标、范围与存量安全边界)

### 1.1 Scope Boundaries
- **Core Goal**: The fundamental problem to solve and the promised outcome.
- **In-Scope**: Explicit capabilities, components, and boundaries delivered in this iteration.
- **Out-of-Scope**: Explicitly excluded items, future phases, or external system boundaries.

### 1.2 Brownfield Surgical Scope (Existing Environment Protection)
- **Touched Areas (Allowed Modifications)**:
  - Explicit list of modules, services, database tables, schemas, drawings, or files permitted to change.
- **What MUST NOT Break (Untouched Scope & Invariants)**:
  - Explicit list of surrounding systems, backward-compatible contracts, and legacy data flows that must remain strictly undisturbed.

---

## 2. Core Entities & Schemas (核心数据与实体契约)
<!-- Define public data contracts, schemas, DDLs, types, or BOMs. Strictly forbid private implementation logic. -->

---

## 3. Flows & State Model (业务流转与状态模型)
<!-- Global state machine transition table or lifecycle sequence matrix -->
| Current State (From) | Trigger / Action | Guard Condition | Next State (To) | Side Effects & Persistence |
| :--- | :--- | :--- | :--- | :--- |
| ... | ... | ... | ... | ... |

- **Failure, Timeout & Rollback Strategies**: Compensation mechanisms and terminal consistency guarantees during outages.

---

## 4. Decisions & Open Parameters (核心选型与待定参数)

### 4.1 P0 Locked Choices (Confirmed Decisions)
- **[Choice-01] <Decision Title>**:
  - **Rationale**: Why this option was chosen based on trade-offs.
  - **Discarded Alternatives & Reasons**: Why alternative options were rejected (prevents regression).

### 4.2 P1 Open Parameters (Inferred Safety Bounds)
- **[Param-01] <Parameter Title>**:
  - **Derivation Basis**: Why this parameter is needed.
  - **Range Limits**: Safe bounds for adjustment (e.g. `Timeout ∈ [3s, 5s] with exponential backoff`).
  - **Degree of Freedom**: Where and when this parameter should be finalized (e.g., config table or execution phase).

---

## 5. Interfaces & Protocols (接口与交互契约)
<!-- Public API/RPC signatures, network protocols, or spatial assembly clearance tolerances -->

---

## 6. System Invariants & Forbidden Paths (全局不变量与行为禁令)

### 6.1 System Invariants (Inviolable Laws)
1. **[INV-01] <Invariant Name>**: Positive conservation laws and consistency requirements that must hold under all conditions.

### 6.2 Forbidden Paths (Anti-Patterns & Prohibitions)
1. **[FORBIDDEN-01] <Prohibition Name>**: Explicitly disallowed implementation shortcuts, silent error swallowing, or architectural violations.

---

## 7. Acceptance Criteria & Verifications (验收标准与验证断言)
<!-- Max 3-5 high-leverage causal scenarios or compact scenario matrices. Strictly avoid BDD text inflation. -->

### 7.1 Core Scenarios
- **[Scene-01] <Critical Path / High-Risk Failure>**:
  - **Given** <Preconditions & Input State>
  - **When** <Triggering Action>
  - **Then** <Observable State Changes, Assertions & Persistence>

### 7.2 Scenario Assertion Matrix
| Case ID | Given (Preconditions) | When (Trigger) | Then (Verifiable Invariant Assertions) |
| :--- | :--- | :--- | :--- |
| ... | ... | ... | ... |

---

## 8. Implementation & Delivery Notes (实施与交付指引)
- Implementation prerequisites, key verification focus, and cross-team delivery notes.
```

## 5. Scale-Adaptive Topology (For Mega-Initiatives)

When handling massive requirements spanning multiple orthogonal domains or loosely coupled components:
1. **Master Topology Spec (`spec.md` or `index.md`)**:
   - Outlines global objectives, system-wide invariants, and a **Units of Concern Dependency Matrix (DAG)**.
   - Categorizes units into **Interdependent Clusters** (tightly bound, unified state machine) and **Independent Islands** (orthogonal, parallelizable).
2. **Cluster / Island Sub-Specs (`specs/<unit-slug>.md`)**:
   - Generates dedicated sub-specifications adhering to the 7-part template for each cohesive cluster or independent island.

## 6. Issue Tracker & Storage Protocol

Consult `docs/agents/issue-tracker.md` (or repo conventions) to determine the storage target:
1. **Local Markdown Tracker (`.scratch/` ecosystem)**:
   - Write to `.scratch/<feature-slug>/spec.md` (and `specs/<unit>.md` if multi-unit).
   - As a contract specification, do NOT assign `Status:` fields that pollute the execution kanban graph.
2. **Remote Issue Tracker (GitHub / GitLab / etc.)**:
   - If local docs are maintained, commit the markdown spec and open/update the Spec Issue via CLI.
   - Strictly adhere to the repo's 5 canonical triage labels from `docs/agents/triage-labels.md` (e.g. apply `ready-for-agent` for completed specs). **Never invent custom labels** on remote trackers.
   - Express multi-unit hierarchy using issue titles (e.g., `[Spec] <Feature>: Master Architecture`) and native body links (`Parent: #...`, `Blocked by: #...`).

## 7. Forbidden Execution Paths

- **NEVER** use Agile User Stories (`As a... I want...`) as the primary specification vehicle.
- **NEVER** write private helper implementation logic or internal glue code inside the Spec (only public schemas/interfaces are allowed).
- **NEVER** invent unconfirmed micro-values without safety range limits. Always wrap unconfirmed items as explicit `[Param-XX]` entries in Section 4.2.
- **NEVER** mechanically generate dozens of trivial Given-When-Then scenarios (anti-BDD inflation). Focus strictly on 3–5 high-leverage scenarios or compact matrices.
- **NEVER** omit Touched Areas and System Invariants when operating in an existing codebase.
- **NEVER** prematurely slice the specification into vertical execution schedules or task tickets inside the document.
- **NEVER** modify production application source code or execute implementation commands within this skill.
