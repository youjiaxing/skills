---
name: yjx-to-tickets
description: Break a plan, spec, or conversation into context-sized, causality-complete tracer-bullet tickets with explicit blocking edges, domain-adaptive verification criteria, and invariant traceability.
disable-model-invocation: true
---

# yjx-to-tickets

Break a plan, specification, or conversation consensus into a set of **tracer-bullet tickets**: self-contained, vertically-sliced units of execution, each declaring the tickets that **block** it.

Target **single-session completion**, **causal cohesion**, and **review self-containedness**. This skill turns sufficiently clear intent into executable tickets; it does not execute their work or maintain an ongoing task schedule.

## Maintenance

When reviewing, modifying, or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It records the skill's design intent, community evolution history, and anti-drift rules; it is not needed for ordinary runtime execution.

## 1. Slicing Principles & Semantics

1. **Causal Cohesion (因果自洽)**: Deliver an observable chain from intent through action to verification. A normal ticket must be independently deliverable and verifiable **on the baseline of its completed blockers**. Depending on upstream results is not a reason to merge tickets. If a ticket needs unfinished downstream work to become useful or verifiable, redraw its boundaries instead of automatically merging the dependency chain. Avoid definitions without consumers or UI stubs without working interactions.
2. **Single-Session Focus (单会话聚焦)**: Use natural behavioral milestones and state transitions, keeping the necessary context, unresolved decisions, and verification work manageable together. Single-session completion is a sizing goal, not a guarantee against context compression. Do not impose line-count or file-count thresholds.
3. **Review Self-Containedness (审查自解释性)**: Reviewers may consult the ticket, its code and evidence, the upstream Spec/ADRs, and completed blockers. Correctness must not depend on unfinished downstream work, except for the explicit wide-refactor integration case below.
4. **Execution Subject (执行主体)**: Prefer AFK when the intended executor has the capability and permission to perform and verify the work. Use HITL for prerequisites requiring human access, approval, or judgment, with blockers only where their outcomes are needed. Cloud setup, migration, or naming a human owner does not by itself make execution HITL. Map these roles to the project's actual `ready-for-agent` / `ready-for-human` equivalents; classification grants no new permissions.

## 2. Process

### Step 1: Gather Context & Invariants
- Read the supplied conversation, Spec, PRD, or plan. For referenced issues or documents, read the full body and relevant comments/decisions. Preserve the canonical source link; without a document, summarize the confirmed intent in the tickets.
- Extract goals, requirements, system invariants, touched areas, and forbidden changes. Inspect relevant implementation, domain vocabulary, ADRs, and verification entrypoints only as needed to establish scope, dependencies, and acceptance. Consider necessary prefactoring, not a general codebase survey.
- Read the applicable tracker contract and label vocabulary together: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and, for a configured local tracker, `docs/agents/local-tracker.json`. Use project paths and role mappings. Resolve configuration conflicts before publication; if unconfigured, direct the user to the repo's tracker setup without prescribing a particular skill.

Handle unknowns by their effects:

- **Discoverable facts**: investigate them rather than asking the user to do the lookup. Report unavailable evidence instead of inventing facts.
- **Local implementation choices**: leave them to the executor when they do not change delivery goals, permission boundaries, external contracts, or dependencies.
- **Choices affecting task structure or major boundaries**: discuss them before finalizing affected implementation tickets. Unrelated drafts may continue.
- **Questions requiring an independent experiment**: propose an exploration ticket only when needed, with its question, evidence output, and completion condition, for user confirmation. Experimental results are not design approval: obtain confirmation of the design choices affecting the breakdown before finalizing downstream implementation tickets.

### Step 2: Draft Vertical Slices & Dependency DAG
Cut through the domain layers needed for each outcome, not every possible layer. Each ticket states:

- **Delivery & rationale**: the end-to-end behavior and necessary background.
- **Scope bounds**: agreed behavior and contract changes, relevant invariants, explicit non-goals, and existing user or project restrictions. Keep the Spec as the global source of truth; carry only the constraints relevant to this ticket.
- **Acceptance & verification**: pair an observable expected result with a way to check it. A command alone is not acceptance. Identify existing verification entrypoints versus verification the ticket must add; never invent an existing command. Use domain-appropriate evidence, such as tests, measurement tolerances, state changes, or explicit human sign-off criteria.
- **Blocked by**: only upstream outcomes genuinely needed before this work can begin. Retain necessary edges to completed tickets; their completion satisfies the dependency rather than erasing it. Schedule necessary prefactoring ahead of the work it enables.

Impact locations are optional, non-exhaustive navigation or impact evidence; distinguish inspected locations from predicted ones. Do not create file or module modification whitelists. A necessary change at an unlisted location does not by itself require renewed approval, and a listed location does not authorize unrelated behavior changes. Crossing an agreed behavioral or contract boundary requires renewed alignment. Preserve existing explicit user or project restrictions rather than deriving new permissions or prohibitions from location lists.

#### Wide Refactor Exception

For broad shared-contract changes that cannot sensibly land as ordinary vertical slices:

1. **Expand**: introduce the new form alongside the old while retaining compatibility.
2. **Migrate**: batch callers into context-sized tickets, each blocked by expand. Keep each batch green when possible.
3. **Contract**: remove the old form in a ticket blocked by all migration batches; verify that no old callers remain.

If batches cannot independently pass whole-system verification, propose an isolated integration branch and a final integrate-and-verify ticket blocked by all necessary migration and contract work. Each batch still needs a bounded, observable milestone and local acceptance, not a claim of complete end-to-end delivery. State the integration owner, isolation, local checks, whole-system success criteria, and failure handling in the breakdown for approval. Do not finalize affected tickets while these boundaries are unclear. Batch completion is not overall delivery; the combined result is not releasable before whole-system verification passes.

### Step 3: Traceability & Anti-Fragmentation Self-Audit
Keep a lightweight internal mapping from requirements/invariants to tickets and acceptance evidence. Check that:

- Requirements, critical edge cases, and safety boundaries have owners and meaningful verification.
- Cross-ticket invariants have an explicit final verification owner, which may be an existing ticket; do not mechanically add an aggregate ticket.
- Tickets satisfy the slicing principles, references resolve, and the dependency graph has no self-dependencies or cycles.
- Execution subjects match project status mappings, and no unresolved choice has been disguised as an executable implementation plan.

Correct gaps before presenting a final breakdown. Surface remaining omissions, unresolved decisions, and cross-ticket verification responsibilities; a large traceability matrix is not a required user-facing artifact.

### Step 4: Review Breakdown with User
Present the draft breakdown clearly:

```markdown
### Proposed Breakdown

1. **[01] <Ticket Title>**
   - **Execution**: <AFK or HITL; actual mapped project status>
   - **Blocked by**: <Necessary upstream tickets, including completed ones; None only if independent>
   - **What it delivers**: <Outcome and necessary rationale; bounded milestone for an approved exception>
   - **Acceptance & verification**: <Observable expected result; how it will be checked>
```

For wide refactors, include the exception's integration boundaries above. Ask about granularity, genuine dependencies, execution subjects, and any needed boundary adjustments. Iterate until the user approves the finalized breakdown; approval of an exploration ticket does not approve a speculative downstream plan.

### Step 5: Publish Tickets to Configured Tracker
Publish only approved, finalized tickets following the configured tracker protocol.

Establish the project's relationship source of truth and the ability to write and read it before affected publication; if that capability is unavailable, pause the affected publication and report the blocker. Body references can serve as relationship records only when the project protocol permits them and every consumer determining readiness or execution eligibility recognizes them. For GitHub with `yjx-gh-kanban`, native relationships are authoritative; body links are explanatory, not a fallback. Missing write capability does not change that protocol.

- **Before writing**: inspect existing tickets and previous publication results. Create new tickets or resume this approved publication, retaining existing identities. On retry, fill only missing parts clearly attributable to the approved work. If identity is uncertain, content conflicts, or implementation has started, pause the affected part and report it; do not overwrite or blindly create duplicates. Changes to historical tickets require a separate diff and user confirmation.
- **Local Markdown**: write one file per ticket under the configured path (default `.scratch/<feature-slug>/issues/<NN>-<slug>.md`). For a fresh feature, number from `01` in dependency order; when extending one, preserve existing numbers and use unused numbers for new tickets. Use the local template with resolved blocker references and mapped status values.
- **Remote tracker**: create issues in dependency order using real identifiers, then establish parent and blocking relationships separately through the project's authoritative mechanism. Apply the project's mapped labels, not unmapped canonical names.
- **After writing**: read back contents, execution statuses/labels, and relationships from their configured sources of truth against the approved breakdown, not just the body references. Missing or unverifiable required relationships mean publication is incomplete. Report actual identifiers and any unfinished parts; do not claim complete publication until the approved results are verified.

Do not modify or close parent spec/map issues. This step does not add task scheduling, staged activation, a publication state machine, or an atomic-publication guarantee.

---

## 3. Ticket Templates

Both templates express the behavioral scope and impact-location distinction from Step 2 rather than prescribing a file-by-file implementation. Include existing protected paths only with their user or project basis. Include code snippets only when a decision-rich state machine, schema, type shape, or formula is more precise than prose; retain its source.

For a wide-refactor batch, replace the normal delivery description with its bounded milestone and include the approved isolation, local acceptance, integration owner, final verification ticket, and failure handling. Do not present batch completion as releasable delivery. For a confirmed exploration ticket, describe its question, evidence output, and completion condition instead of inventing an implementation outcome. Omit optional source/parent fields when absent.

### Local Markdown Template (`.scratch/<feature>/issues/<NN>-<slug>.md`)

```markdown
# <NN>: <Ticket Title>

Status: <actual project status mapped from the execution role>
Blocked by: <necessary upstream references, including completed tickets, or None>

Spec: <canonical source reference, if present>

## What to build

<End-to-end behavior and necessary rationale, or the bounded outcome defined above.>

## Invariants & Scope Bounds

- **Scope**: <Agreed behavior and contract changes>
- **Impact Locations**: <Optional, non-exhaustive navigation evidence; distinguish inspected from predicted locations>
- **Relevant Invariants**: <Rules and safety boundaries relevant to this ticket>
- **Non-goals**: <Explicit exclusions>

## Acceptance criteria

- [ ] <Observable expected result>; verify by <existing check or verification this ticket adds>.
- [ ] <Relevant error/edge-case result>; verify by <test, measurement, state evidence, or human sign-off criterion>.
```

### Remote Issue Body Template

```markdown
## Parent
<Link to parent issue/spec if applicable, otherwise omit>

## What to build
<End-to-end behavior and necessary rationale, or the bounded outcome defined above.>

## Invariants & Scope Bounds
- **Scope**: <Agreed behavior and contract changes>
- **Impact Locations**: <Optional, non-exhaustive navigation evidence; distinguish inspected from predicted locations>
- **Relevant Invariants**: <Rules and safety boundaries relevant to this ticket>
- **Non-goals**: <Explicit exclusions>

## Acceptance criteria
- [ ] <Observable expected result>; verify by <existing check or verification this ticket adds>.
- [ ] <Relevant error/edge-case result>; verify by <test, measurement, state evidence, or human sign-off criterion>.

## Blocked by
- <Necessary upstream references, including completed tickets, or "None">
```

---

## 4. Execution Boundary

Create ticket artifacts, not production application changes or the work described by the tickets. Do not require specific preceding or succeeding skills. Existing project lifecycle and authorization rules continue to govern execution; this skill does not redefine them.
