# Maintenance: yjx-to-spec

This document captures the design intent, architectural rationale, and anti-drift validation rules for `yjx-to-spec`. Consult this document when reviewing, updating, or refactoring this skill.

## Design Rationale & History

`yjx-to-spec` was created to overcome fundamental structural limitations discovered in traditional agile-centric specification skills (e.g. `to-spec` from `mattpocock/skills`) when applied to modern complex engineering, multi-agent pipelines, and domain-agnostic projects.

### Community Issues & Real-World Pain Points Addressed:
1. **User Story Inflation (Issue #777)**: Mechanical `As a... I want... so that...` templates dilute context in stateful, algorithmic, and backend systems. Replaced with public schemas, state transition matrices, and high-density verifiable assertions.
2. **Brownfield Destabilization (Issue #843)**: LLMs operating in large legacy codebases tend to hallucinate wide refactors. Solved by separating **Touched Areas (Physical Whitelist)** from **System Invariants (Inviolable Laws)** to eliminate semantic overlap while maintaining strict safety.
3. **Decision Amnesia & Regressions (Issue #689, #959)**: Without recording discarded alternatives, downstream agents frequently re-propose previously rejected flawed designs. Solved with **ADR-Lite Rationale & Discarded Alternatives**.
4. **Epistemological Ambiguity**: Traditional tools silently hallucinate unvetted numbers. Solved by cleanly projecting upstream user commitments to **P0 Locked Choices** and agent companion rules to **P1 Open Parameters with Range Limits**, crowned with a **Readiness Radar**. If all items are locked, P1 is cleanly omitted/marked as none without forced padding.
5. **Anti-Padding Verification**: Avoid replacing User Story inflation with 20 repetitive Given-When-Then paragraphs. Solved by focusing on essential behaviors and high-impact failure modes, leveraging **Scenario Assertion Matrices** when multi-case combinations expand.
6. **Scale-Adaptive Topology & SSOT**: Validated via massive real-world systems (e.g. `341-union-battle-optimize` across 3 repos and multiple heterogeneous lifecycles). Solved via **Master Topology Spec (Global Timeline, Key Arbitration, Static DAG)** down-linked to **Orthogonal Sub-Specs** using native Markdown anchor links or tracker-native references (`#issue_id`) without duplicate schema drift.
7. **Decoupled Architecture**: Strictly independent of specific upstream interview tools or downstream execution commands, ensuring pure composability.

## Anti-Drift Validation Checklist

When modifying this skill, ensure none of the following regressions occur:

- [ ] **No User Story Regression**: Does the skill still forbid `As a... I want...` templates in favor of structured domain schemas?
- [ ] **No Premature Slicing**: Does the skill refrain from breaking the Spec into execution task slices, leaving vertical slicing to downstream planning?
- [ ] **Structural Clarity & No Duplication**: Are `Touched Areas` (physical whitelist in Section 1.2) and `System Invariants` (logical rules in Section 6.1) kept cleanly separated without semantic redundancy?
- [ ] **Epistemology Preserved**: Is there a clear distinction between human-confirmed choices (P0) and AI-inferred safety limits (P1) without forcing artificial P1 padding?
- [ ] **Scale-Adaptive Topology Intact**: Does Master Spec contain only static DAG dependencies, global timelines, and key arbitration points, strictly avoiding dynamic project management status/checkboxes?
- [ ] **SSOT Cross-References**: Do Sub-Specs use standard relative Markdown anchor links or tracker issue numbers instead of duplicate copy-pasted schemas?
- [ ] **High-Signal Verification**: Are acceptance criteria focused on essential behaviors without rigid formatting paranoia or repetitive padding?
- [ ] **Tracker Compatibility**: Does the skill avoid polluting remote trackers with unregistered custom labels?
- [ ] **Decoupling Maintained**: Are hardcoded slash command references excluded from the Spec output?
