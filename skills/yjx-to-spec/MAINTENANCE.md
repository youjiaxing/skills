# Maintenance: yjx-to-spec

This document captures the design intent, architectural rationale, and anti-drift validation rules for `yjx-to-spec`. Consult this document when reviewing, updating, or refactoring this skill.

## Design Rationale & History

`yjx-to-spec` was created to overcome fundamental structural limitations discovered in traditional agile-centric specification skills (e.g. `to-spec` from `mattpocock/skills`) when applied to modern complex engineering, multi-agent pipelines, and domain-agnostic projects.

### Community Issues & Real-World Pain Points Addressed:
1. **User Story Inflation (Issue #777)**: Mechanical `As a... I want... so that...` templates dilute context in stateful, algorithmic, and backend systems. Replaced with public schemas, state transition matrices, and high-density verifiable assertions.
2. **Brownfield Destabilization (Issue #843)**: LLMs operating in large legacy codebases tend to hallucinate wide refactors. Solved by mandating **Touched Areas** and **What MUST NOT Break (System Invariants)**.
3. **Decision Amnesia & Regressions (Issue #689, #959)**: Without recording discarded alternatives, downstream agents frequently re-propose previously rejected flawed designs. Solved with **ADR-Lite Rationale & Discarded Alternatives**.
4. **Epistemological Ambiguity**: Traditional tools silently hallucinate unvetted numbers. Solved by separating **P0 User Locked Choices** from **P1 Inferred Open Parameters with Range Limits**, crowned with a **Readiness Radar**.
5. **BDD Text Inflation**: Replacing User Story inflation with 20 repetitive Given-When-Then paragraphs is equally toxic. Solved by strictly capping scenarios to 3–5 high-leverage causal cases or compressing into **Scenario Assertion Matrices**.
6. **Decoupled Architecture**: Strictly independent of specific upstream interview tools or downstream execution commands, ensuring pure composability.

## Anti-Drift Validation Checklist

When modifying this skill, ensure none of the following regressions occur:

- [ ] **No User Story Regression**: Does the skill still forbid `As a... I want...` templates in favor of structured domain schemas?
- [ ] **No Premature Slicing**: Does the skill refrain from breaking the Spec into execution task slices, leaving vertical slicing to downstream planning?
- [ ] **Brownfield Safety Intact**: Are `Touched Areas` and `What MUST NOT Break` strictly required?
- [ ] **Epistemology Preserved**: Is there a clear distinction between human-confirmed choices (P0) and AI-inferred safety limits (P1)?
- [ ] **Anti-BDD Inflation Active**: Is BDD generation strictly constrained to high-leverage scenarios and tables?
- [ ] **Tracker Compatibility**: Does the skill avoid polluting remote trackers with unregistered custom labels?
- [ ] **Decoupling Maintained**: Are hardcoded slash command references excluded from the Spec output?
