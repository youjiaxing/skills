# Maintenance: yjx-to-tickets

This document records the architectural rationale, community issue lineage, and anti-drift rules for `yjx-to-tickets`. Consult this document when reviewing, modifying, or refactoring this skill.

## Design Rationale & History

`yjx-to-tickets` builds upon the foundational concept of tracer-bullet task decomposition (originating in `mattpocock/skills`) while resolving critical failure modes identified across community discussions and real-world agent workflows.

### Community Issues & Real-World Pain Points Addressed:

1. **The Over-Fragmentation Trap (过度微切片陷阱)**:
   - *Problem*: Naive slicing guidelines often cause agents to produce dozens of tiny tickets (e.g., separate tickets for model types, handler stubs, and UI buttons). This fractures causal chains, inflates session initialization overhead, and makes human code review exhausting because isolated PRs lack visible business value.
   - *Solution*: **Causal Cohesion (因果自洽)** is evaluated on the baseline of completed blockers, not in isolation from all other tickets. Downstream-dependent shells need new boundaries; ordinary upstream dependencies do not justify automatically merging a chain. Reviewers can consult the ticket, Spec/ADRs, and completed upstream evidence.
2. **The Magic Number Fallacy (魔数硬限的刻舟求剑)**:
   - *Problem*: Attempting to enforce fixed scalar limits (e.g. "$\le 300$ lines of code", "$\le 5$ files", "3–6 tickets") breaks down across different languages (Go/Java vs Python/TS) and problem domains.
   - *Solution*: Size by semantic focus, required context, unresolved decisions, and verification work. Single-session completion is a target, not a promise that context compression can never occur.
3. **Orphaned Invariants & Spec Dilution (需求孤儿化与约束丢失)**:
   - *Problem*: When decomposing a PRD or Spec, global invariants, security guardrails, and forbidden patterns frequently get dropped, leading downstream agents to produce code that passes ticket-level tests but breaks system-level contracts.
   - *Solution*: Keep a lightweight internal requirement/invariant-to-ticket-to-evidence mapping. Carry only relevant constraints in each ticket and link to the Spec as global SSOT. Assign cross-ticket verification to an explicit owner, reusing an existing ticket where suitable; neither a large displayed matrix nor a separate aggregate ticket is mandatory.
4. **Execution Subject Ambiguity (AFK vs. HITL)**:
   - *Problem*: Traditional tools assume all tickets are uniform code tasks, causing agents to get stuck when encountering third-party credentials, manual cloud setups, or subjective visual reviews.
   - *Solution*: Classify by the intended executor's actual capabilities, permissions, and need for human judgment. Cloud setup, migration, and human ownership are not automatic HITL categories. Apply the project's mapped execution-role statuses consistently in local and remote output; a role never grants new permissions.
5. **Decoupled Architecture & Domain Adaptability**:
   - *Problem*: Slicing skills often assume they must strictly consume a formal `spec.md` or only run within software engineering contexts.
   - *Solution*: Universal adaptability across Software, Operations, and Physical Design projects, ingesting from raw conversations, planning notes, or formal specs without hardcoded tool assumptions.
6. **Tracker Protocol Grounding**:
   - Read the applicable contract, machine configuration, and triage vocabulary together. Preserve compatibility with `yjx-local-kanban` / `yjx-gh-kanban`; do not introduce new lifecycle states or reinterpret canonical role names as unmapped project values.

## Aligned Refinements

These refinements preserve the original tracer-bullet purpose while making its boundaries executable:

- **Grounding without over-design**: inspect supplied sources, relevant decisions, and existing implementation only far enough to establish scope, dependencies, and evidence. Leave ordinary implementation choices to executors. Choices affecting task structure or major boundaries require discussion; genuine experiments may become explicitly confirmed exploration tickets, but their results do not approve a downstream design.
- **Controlled wide refactors**: retain the original expand/migrate/contract dependency structure. An isolated integration exception allows locally verifiable batches only with an owner, failure handling, and final whole-system verification. All templates must distinguish a batch milestone from releasable delivery.
- **Evidence, not commands alone**: every acceptance result needs a checking method. Distinguish existing entrypoints from verification to be added; support software tests, physical measurements, state evidence, and human sign-offs without inventing commands.
- **Bounded publication**: create approved tickets or restore clearly identified missing parts of that publication. Preserve identities and stop affected work on ambiguity, content conflict, or implementation progress. Historical-ticket changes need separate confirmation; parent issues remain untouched. Read back results and report incomplete work without claiming success.
- **Keep the skill small**: the runtime remains a five-step workflow. Do not grow it into task scheduling, staged activation, transactional publication, or ongoing plan synchronization. Runtime rules live in `SKILL.md`; this file records rationale and review cases, not a second execution protocol.

## Anti-Drift Validation Checklist

When modifying this skill, ensure none of the following regressions occur:

- [ ] **No Magic Number Regression**: Does the skill remain free of arbitrary line count or file count hard-limits?
- [ ] **Causal Cohesion Intact**: Are normal tickets verifiable on completed blockers without downstream-dependent stubs or automatic chain merging?
- [ ] **Controlled Integration**: Are wide-refactor milestones, dependencies, local evidence, and the final integration gate consistent across rules and templates?
- [ ] **SSOT & Open Inspection**: Does the skill maintain links to the parent Spec (if present) without forbidding full Spec inspection?
- [ ] **Traceability Enforced**: Do requirements and invariants have acceptance evidence, including an owner for cross-ticket checks?
- [ ] **Acceptance Is Observable**: Do the review example and both ticket templates require a result plus a verification method, not a command alone?
- [ ] **Unknowns Stay Honest**: Are local choices left open while task-shaping decisions and experiment-dependent designs remain unapproved until confirmed?
- [ ] **AFK/HITL Segregation**: Do actual capabilities, permissions, and human judgment determine the role, including in examples?
- [ ] **Native Tracker Alignment**: Does the output strictly adhere to the repo's configured tracker and triage label mappings?
- [ ] **Publication Scope**: Are retries distinguishable from historical-ticket edits, with existing identities protected and incomplete results reported?
- [ ] **Decoupled Framing**: Are hardcoded upstream/downstream slash command mandates avoided?

## Scenario Checks

Use these as semantic review or forward-testing cases, not wording snapshots. Passing a parser or frontmatter check does not prove slicing quality.

| Input situation | Expected observable behavior |
| --- | --- |
| Export uses an already completed report-generation ticket | Keep a valid upstream dependency; do not merge solely because export needs reports. |
| A DTO has no consumer until a later ticket | Redraw boundaries so a normal ticket delivers verifiable behavior. |
| A system invariant spans several slices | Assign final evidence to an explicit ticket; do not lose it among repeated scope statements. |
| A draft offers only `npm test` as acceptance | State the expected behavior and its checking method; verify the command exists or identify new verification work. |
| Cloud setup is authorized and automatable, but a later visual sign-off needs a person | Keep setup AFK and the actual human gate HITL, using mapped project statuses. |
| Shared-contract migration cannot keep every batch independently green | Use the approved isolated integration exception, preserving local evidence and a final gate before releasable delivery. |
| A local helper choice is open, but a migration strategy still needs a decision | Leave the helper to the executor; pause only implementation drafts affected by the strategy. |
| An experiment establishes feasibility | Obtain confirmation of the resulting task-shaping design before finalizing downstream implementation tickets. |
| Publication stops after some tickets exist | Reuse verified identities and fill only attributable gaps; pause on conflicts or progress rather than overwrite or duplicate. |
