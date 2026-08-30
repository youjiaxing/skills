# yjx-wayfinder Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-wayfinder`. It records the skill's design intent, evolution rationale, and anti-drift rules. It is maintenance reference, not ordinary runtime execution guidance.

## 1. Identity & Core Purpose

`yjx-wayfinder` is a multi-session cognitive navigation and decision cartography skill. It plans large, ambiguous efforts as a shared map of decision tickets on the repo's issue tracker, exploring the active frontier with `yjx-grill` and graduating fog into clear decisions until reaching the destination.

Its primary outcome is **structured, high-fidelity alignment across sessions without context budget exhaustion or speculative ticket pollution**.

It is explicitly **domain-agnostic**: designed equally for software architecture, book writing, course syllabus design, organizational structuring, or physical planning (such as garden design).

---

## 2. Origin & Evolution Rationale

`yjx-wayfinder` was redesigned to solve five critical failure modes observed in real-world use and community field reports:

### 1. Context-Budget Protection
* **Problem**: Large efforts cannot be solved in a single agent session without exceeding context limits, leading to hallucination, instruction drift, and severe quality degradation.
* **Design**: Wayfinder acts as a **cross-session context isolation scheduler**. Each decision ticket is sized for a single, focused session where deep alignment runs within a clean token budget.

### 2. Anti-Premature Ticketing (Deferred Expansion)
* **Problem**: In exploratory planning, most dependencies are *directional/forking* (the answer to Ticket A determines whether Ticket B even exists). Pre-creating blocked issues in the tracker produces phantom/garbage issues when upstream decisions pivot.
* **Design**: Physical issue tracker issues represent **ONLY the active, unblocked, takeable frontier**. All blocked, conditional, or future questions remain as structured plain text in the Map's `## Not yet specified` (Fog of War) section. They graduate into physical issues only after upstream dependencies close.

### 3. Loose-Coupling Delegation to `yjx-grill`
* **Problem**: Original Wayfinder hardcoded a 29-line unstructured `grilling` prompt that lost subtle invariants across sessions. Conversely, tightly coupling to the exact internal section layout of `yjx-grill` creates fragile abstractions.
* **Design**: 
  - **Macro Charting**: `yjx-wayfinder` passes explicit prompt constraints into `yjx-grill` (*"Breadth-first exploration; focus on Destination and boundary scope; do not drill down into low-level implementation/parameter details"*).
  - **Micro Resolution**: `yjx-wayfinder` treats `yjx-grill` as a black-box alignment engine, recording its final confirmed artifact as the ticket's resolution without hardcoding internal section names.

### 4. Lightweight Decision Superseding
* **Problem**: When exploring uncharted territory, later discoveries frequently invalidate or amend earlier premises. Without a revision protocol, subsequent sessions read contradictory or stale decisions from the map.
* **Design**: The map is an *index, not a store*. Superseded decisions are marked inline with strikethrough and a pointer to the overriding ticket (`~~[#1 Old Decision](link)~~ (superseded by [#3 New Decision](link))`).

### 5. Destination Closeout & Synthesis
* **Problem**: When all tickets close and fog clears, ending abruptly leaves a fragmented trail of individual tickets without a unified deliverable.
* **Design**: A formal closeout step synthesizes all resolved answers into the final promised `Destination` artifact, posts a Closeout Summary, and closes the Map issue.

---

## 3. Session Transition Heuristics (Zero-Guesswork)

AI agents cannot reliably inspect physical token counts. Therefore, session transitions follow simple, observable behavioral heuristics:

* **Default Baseline**: **One ticket, one fresh session**. Starting a clean session is the standard recommendation to ensure maximum reasoning fidelity.
* **Single Exception**: If and only if the current ticket was a **rapid micro-ticket** (resolved in 1–2 brief turns with minimal context cost) AND the next frontier ticket is a **direct, tight continuation**, the agent may suggest in-place continuation.
* **All Other Cases**: Recommend opening a fresh session (`yjx-wayfinder #N`).

---

## 4. Anti-Drift Checks

Before modifying or reviewing this skill, verify that the proposed changes satisfy all of the following:

- [ ] **Preserves Domain Agnosticism**: Does not assume codebases, compilers, PRs, or databases. The skill must work seamlessly for garden planning, book writing, and technical architecture alike.
- [ ] **Strict Anti-Premature Ticketing**: Never creates physical tracker issues for blocked or hypothetical downstream steps. Only unblocked frontier items become physical issues.
- [ ] **Single Source of Truth**: The Map issue is the canonical index. A decision lives in exactly one place (its ticket), and the Map only gists and links.
- [ ] **Loose-Coupling with `yjx-grill`**: Does not hardcode assumptions about `yjx-grill`'s internal sections or field names.
- [ ] **Maintains Plan, Don't Do**: Preserves strict boundaries on ticket types (`task` and `prototype` are for fact-finding and disposable spikes, never for unaligned production implementation).
- [ ] **Retains Decision Superseding**: Keeps the lightweight strikethrough/pointer protocol for overridden decisions.
- [ ] **Preserves Closeout Synthesis**: Ensures the map lifecycle terminates in a cohesive destination artifact synthesis.
