# Maintenance: yjx-to-tickets

This document records the architectural rationale, community issue lineage, and anti-drift rules for `yjx-to-tickets`. Consult this document when reviewing, modifying, or refactoring this skill.

## Design Rationale & History

`yjx-to-tickets` builds upon the foundational concept of tracer-bullet task decomposition (originating in `mattpocock/skills`) while resolving critical failure modes identified across community discussions and real-world agent workflows.

### Community Issues & Real-World Pain Points Addressed:

1. **The Over-Fragmentation Trap (过度微切片陷阱)**:
   - *Problem*: Naive slicing guidelines often cause agents to produce dozens of tiny tickets (e.g., separate tickets for model types, handler stubs, and UI buttons). This fractures causal chains, inflates session initialization overhead, and makes human code review exhausting because isolated PRs lack visible business value.
   - *Solution*: Replaced mechanical slicing with **Causal Cohesion (因果自洽)** and **Review Self-Containedness (审查自解释性)**. Tickets must represent independently runnable, verifiable units of value.
2. **The Magic Number Fallacy (魔数硬限的刻舟求剑)**:
   - *Problem*: Attempting to enforce fixed scalar limits (e.g. "$\le 300$ lines of code", "$\le 5$ files", "3–6 tickets") breaks down across different languages (Go/Java vs Python/TS) and problem domains.
   - *Solution*: Slicing criteria are grounded entirely in **semantic invariants, single-session cognitive closure, and natural topological derivation**.
3. **Orphaned Invariants & Spec Dilution (需求孤儿化与约束丢失)**:
   - *Problem*: When decomposing a PRD or Spec, global invariants, security guardrails, and forbidden patterns frequently get dropped, leading downstream agents to produce code that passes ticket-level tests but breaks system-level contracts.
   - *Solution*: Mandated a **Traceability & Invariant Extraction Check**, requiring relevant invariants to accompany each ticket while maintaining standard anchor links back to the parent Spec as SSOT.
4. **Execution Subject Ambiguity (AFK vs. HITL)**:
   - *Problem*: Traditional tools assume all tickets are uniform code tasks, causing agents to get stuck when encountering third-party credentials, manual cloud setups, or subjective visual reviews.
   - *Solution*: Explicit separation into **AFK-First implementation tickets (`ready-for-agent`)** and **explicit HITL gate tickets (`ready-for-human`)** with proper blocking edges.
5. **Decoupled Architecture & Domain Adaptability**:
   - *Problem*: Slicing skills often assume they must strictly consume a formal `spec.md` or only run within software engineering contexts.
   - *Solution*: Universal adaptability across Software, Operations, and Physical Design projects, ingesting from raw conversations, planning notes, or formal specs without hardcoded tool assumptions.
6. **Tracker Protocol Grounding**:
   - Strictly preserves compatibility with `docs/agents/issue-tracker.md`, `docs/agents/local-tracker.json`, `docs/agents/triage-labels.md`, and the `yjx-local-kanban` / `yjx-gh-kanban` engines.

## Anti-Drift Validation Checklist

When modifying this skill, ensure none of the following regressions occur:

- [ ] **No Magic Number Regression**: Does the skill remain free of arbitrary line count or file count hard-limits?
- [ ] **Causal Cohesion Intact**: Does the skill forbid incomplete, untestable stubs and enforce atomic value slices?
- [ ] **SSOT & Open Inspection**: Does the skill maintain links to the parent Spec (if present) without forbidding full Spec inspection?
- [ ] **Traceability Enforced**: Does the process include an internal audit ensuring no system invariants are orphaned?
- [ ] **AFK/HITL Segregation**: Are non-autonomous prerequisites (credentials, human sign-offs) cleanly extracted as HITL tickets?
- [ ] **Native Tracker Alignment**: Does the output strictly adhere to the repo's configured tracker and triage label mappings?
- [ ] **Decoupled Framing**: Are hardcoded upstream/downstream slash command mandates avoided?
