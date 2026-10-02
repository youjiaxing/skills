# yjx-wayfinder Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-wayfinder`. It records the skill's design intent, evolution rationale, and anti-drift rules. It is maintenance reference, not ordinary runtime execution guidance.

## 1. Identity & Core Purpose

`yjx-wayfinder` breaks a requirements or planning effort too large for one session into coherent decision tickets. Independent sessions explore them in parallel, with a shared tracker map preserving context and a final synthesis reconnecting their conclusions.

Its primary outcome is **complete, consistent alignment across sessions without oversized tickets, fragmented micro-tickets, or speculative issue pollution**. The tracker supports the discussion; building a scheduling or coordination system is not the goal.

It is explicitly **domain-agnostic**: designed equally for software architecture, book writing, course syllabus design, organizational structuring, or physical planning (such as garden design).

---

## 2. Origin & Evolution Rationale

The runtime rules express the following design choices. Keep the mechanics in `SKILL.md`; this file explains their purpose and review boundaries.

### 1. Coherent Ticket Size
* **Problem**: Oversized tickets defeat cross-session exploration, while undersized tickets repeatedly reload the same context and fragment coupled choices.
* **Design**: A ticket has an independently useful outcome, tightly related decisions, and room for investigation, discussion, verification, and recording within one session. A pivotal fact may be a complete research ticket. Fixed token counts, turn counts, or one-choice-per-ticket rules are not sizing criteria.
* **Adjustment**: Splits and merges preserve history, references, and actual prerequisite obligations. Narrowing a question is not evidence that its omitted work is complete.

### 2. Anti-Premature Ticketing (Deferred Expansion)
* **Problem**: In exploratory planning, most dependencies are *directional/forking* (the answer to Ticket A determines whether Ticket B even exists). Pre-creating blocked issues in the tracker produces phantom/garbage issues when upstream decisions pivot.
* **Design**: Readiness restricts **creation**, not every later state of an issue. New blocked, conditional, or coarse questions remain in the fog; existing tickets may become blocked while retaining identity and history. An upstream answer triggers evaluation of branch applicability and premise validity, not mechanical creation on closure.
* **Disposition**: Graduation, retention, and pruning are normal outcomes. A pruned conditional branch is not necessarily outside the destination. Scope exclusions can be text without creating issues for them.

### 3. Loose-Coupling Delegation to `yjx-grill`
* **Problem**: Unbounded delegation can pull the whole effort into a single ticket; coupling to another skill's internal sections makes the integration fragile.
* **Design**: 
  - **Macro Charting**: `yjx-wayfinder` passes explicit prompt constraints into `yjx-grill` (*"Breadth-first exploration; focus on Destination and boundary scope; do not drill down into low-level implementation/parameter details"*).
  - **Micro Resolution**: Pass the ticket question, sufficient-answer criterion, valid premises, and neighboring boundaries. Resolve necessary prerequisites or report their block; hand later questions back to the map. `yjx-wayfinder` accepts either a Direct Result or an approved Formal Contract without hardcoding internal section names.
  - **Receipt & Confirmation**: Alignment Result Handoff preserves sources and requires confirmation of the complete HITL conclusion and material downstream premises. It does not treat a short result as pure fact, a partial answer as approval of attached assumptions, or an unapproved candidate as an approved contract. AFK work resolves verified facts, not human choices; result format cannot bypass a ticket's confirmation obligations.
  - **Authority Separation**: Ticket confirmation does not force a Direct Result into a contract or grant implementation authority. A reviewed and approved Formal Contract can settle a planning-only ticket; any separately established implementation authorization keeps its actual scope. Contract approval and ticket closure neither grant that authority nor start execution. Confirmed inferences retain their origin.
  - **Compatibility Boundary**: These changes concern results from alignments already permitted by the user and host. Invocation metadata and cross-host triggering remain unchanged and are not validated by this handoff contract.

### 4. Decision Revalidation & Superseding
* **Problem**: When exploring uncharted territory, later discoveries frequently invalidate or amend earlier premises. Without a revision protocol, subsequent sessions read contradictory or stale decisions from the map.
* **Design**: With no valid replacement, reopen the original question and preserve its old answer as history. With a valid replacement, retain the old ticket and point to the replacement. Check affected open tickets, completed conclusions, and fog; do not invalidate unrelated work. Changed premises do not themselves put a question out of scope.
* **Index & Dependencies**: The map visibly distinguishes current conclusions from under-review or superseded history. Dependent work must use effective premises, not infer validity from an old ticket's terminal state. Reuse the configured tracker lifecycle and blocking relationships rather than adding status enums.

### 5. Destination Closeout & Synthesis
* **Problem**: When all tickets close and fog clears, ending abruptly leaves a fragmented trail of individual tickets without a unified deliverable.
* **Design**: A formal closeout step checks all children and research ownership, then verifies destination coverage, valid-decision compatibility, and gaps between tickets. It synthesizes ticket details into the promised artifact and preserves the original destination. Empty queues and terminal states alone are insufficient evidence.
* **Authority**: The artifact is a derived synthesis, not an independent source of new decisions. Presentation work may proceed; important missing decisions or contradictions return to exploration.

### 6. Lightweight Parallelism
* **User Choice**: Multiple independent sessions may progress on one map. Heavy coordination, default single-writer scheduling, locks, and leases were rejected.
* **Design**: Advisory claims, fresh reads immediately before mutation, scoped merges, deduplication, and readback reduce accidental interference. Persist results before removing their source notes, and resume partial operations from existing evidence.
* **Accepted Limit**: This is best-effort coordination, not atomic updates, guaranteed exclusivity, or zero lost writes. Readback does not close every race window. Shared assignees do not establish session ownership.

### 7. Bounded Helpers
* **Research**: The initiating session owns collection, verification, and recording. Temporary workers are collected in-session; durable continuation requires actual host support. Without recoverability, keep an ordinary unclaimed research ticket rather than starting an orphaned worker.
* **Prototype & Tasks**: Use domain-appropriate exploratory artifacts and authorized prerequisite work. Helper instructions cannot expand the effort into production implementation. Keep evidence, artifacts, and human conclusions linked from the ticket.

---

## 3. Session Transition Heuristics

Use discussion coherence and context burden rather than a claimed exact token budget:

* **Default Baseline**: **One ticket, one fresh session**. Starting a clean session is the standard recommendation to ensure maximum reasoning fidelity.
* **Exception**: A tightly related follow-up with little context burden may continue in place. This is not a reason to make artificially small tickets or a fixed turn-count gate.
* **Recovery**: The next session should need the bounded question, relevant premises, conclusions, and pending work, not a reconstruction of the chat history. Use tracker-appropriate links or invocations for handoff.

---

## 4. Anti-Drift Checks

Before modifying or reviewing this skill, verify that the proposed changes satisfy all of the following:

- [ ] **Preserves Domain Agnosticism**: Does not assume codebases, compilers, PRs, or databases. The skill must work seamlessly for garden planning, book writing, and technical architecture alike.
- [ ] **Coherent Granularity**: Tickets are independently useful and feasible for a focused session, not fixed-size fragments. Resizing preserves real dependencies.
- [ ] **Strict Anti-Premature Ticketing**: Only ready questions become new issues; existing issues may become blocked without deletion or false completion.
- [ ] **Semantic Graduation**: Checks branch applicability and valid prerequisites; records pruning reasons without misclassifying them as scope exclusions.
- [ ] **Single Source of Truth**: The map is the index, tickets own detailed conclusions, and the destination artifact synthesizes effective conclusions without inventing decisions.
- [ ] **Loose-Coupling with `yjx-grill`**: Does not hardcode assumptions about `yjx-grill`'s internal sections or field names.
- [ ] **Scoped Result Confirmation**: Preserves claim sources and binds HITL closeout to the complete conclusion and material downstream premises; partial approval cannot unblock dependents or authorize execution.
- [ ] **Maintains Plan, Don't Do**: Preserves strict boundaries on ticket types (`task` and `prototype` are for fact-finding and disposable spikes, never for unaligned production implementation).
- [ ] **Preserves Decision Recovery**: Reopens challenged conclusions or links valid replacements, checks affected downstream work, and distinguishes history from current truth.
- [ ] **Lightweight Concurrency**: Preserves parallel independent sessions and explicit best-effort limits without a new coordinator or tracker protocol.
- [ ] **Owned Research**: Every launched task has a real collection path; persistent pointers are not mistaken for persistent execution.
- [ ] **Preserves Closeout Synthesis**: Checks all work, actual dispositions, coverage, and consistency before producing the cohesive destination artifact.
