---
name: yjx-wayfinder
description: Break a large requirements or planning effort into coherent decision tickets for parallel sessions, explore them with yjx-grill, and synthesize the valid conclusions into the agreed destination.
disable-model-invocation: true
---

Break a requirements or planning effort too large for one session into **decision tickets**: coherent questions whose answers are decisions or verified facts, not implementation slices. Independent sessions can advance different tickets in parallel; the **map** keeps their context connected until their conclusions form a complete, consistent **destination**.

The destination sets the scope and completion criteria. It might be a technical specification, architecture decision, course syllabus, organizational plan, book outline, or garden design. Keep the workflow **domain-agnostic**.

## Maintenance

When reviewing, modifying, or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It records the skill's design intent, evolution rationale, and anti-drift checks; it is not needed for ordinary runtime execution.

## Plan, don't do

Wayfinder is **planning** by default. Produce the decisions, evidence, and planning artifact promised by the Destination, not the implementation it describes. An explicit execution authorization recorded in **Notes** may extend an effort's scope; recording a decision, closing a ticket, or invoking a helper skill never grants that authorization by itself.

## Refer by name

Every map and ticket is an issue, so it has a **name**: its title. In everything the human reads (narration, the map's Decisions-so-far), refer to it by that name, never by a bare id, number, or slug. Wrap the link inside the name (e.g. `[<title>](link)`), never let raw numbers stand in for it.

## The Map

The map is a single issue on this repo's issue tracker, labelled `wayfinder:map`, the canonical artifact. Its tickets are child issues of the map.

The map is an **index**, not a store. Detailed conclusions live in their tickets; the map only gists and links them, visibly distinguishing valid conclusions from those under review or superseded. The final artifact synthesizes these sources rather than introducing a second set of decisions.

Where the map, its child tickets, blocking, and frontier queries physically live is tracker-specific. Consult the tracker doc's "Wayfinding operations" section for how this repo expresses them. If no tracker has been configured, default to the local-markdown tracker.

### The Map body

Load this low-resolution view to orient each session; refresh it before mutations under [Lightweight Parallel Updates](#lightweight-parallel-updates). Discover open children through the tracker rather than duplicating their status in the map.

```markdown
## Destination

<the goal, scope, promised artifact, and observable completion criteria; keep this concise and preserve it during closeout>

## Notes

<domain background; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- one-line conclusions and links; mark historical or under-review entries so they cannot be mistaken for current premises -->

- [<ticket title>](link): <one-line gist of the conclusion>

## Not yet specified

<!-- in-scope questions not yet ready for new tickets; record relevant conditions and prerequisite links, not speculative issue trees -->

- [ ] <question or area to clarify; when it matters and what it waits on>

## Out of scope

<!-- actual scope exclusions and reasons; add a ticket link only when one already exists -->

- <excluded work>: <why it is beyond this destination>
```

## Ticket Granularity

A ticket should be worth a separate session without overwhelming it:

- **Useful outcome**: Its answer is reusable by another session, not merely one conversational turn. A single pivotal fact can justify a research ticket.
- **Coherent discussion**: Keep tightly coupled choices sharing context and trade-offs together. If separate sessions would repeatedly negotiate the same choices, the split is probably too fine.
- **Room to finish**: Allow enough attention for investigation, discussion, verification, and recording the answer. Several independent contexts or unresolved branches competing for that attention suggest a split.

Do not size tickets by fixed token counts, turn counts, or one decision per ticket. Preserve the original question and confirmed partial conclusions when resizing. Move remaining questions to tickets only when ready; otherwise keep them in the fog. Before closing a narrowed ticket, verify that every downstream dependency still points to the work it actually needs. If this cannot be represented safely, leave the original ticket unfinished rather than declaring its omitted premises complete.

Unclaimed tickets with heavily overlapping context may be merged. Retain their identities/history and a pointer to the surviving question; redirect affected dependencies before retiring duplicates. A merge or cancellation must not falsely unblock unfinished work.

### Ticket Body Format

Each physical ticket is a child issue of the map:

```markdown
## Question

<the bounded question and what answering it sufficiently means>
```

Add only the context needed to work independently: relevant premise/evidence links and boundaries with neighboring questions. Each ticket carries a `wayfinder:<type>` label under the tracker convention.

## Frontier & Fog

**New tickets are created only for ready questions**: necessary within the destination, sharp enough to discuss, and supported by settled, still-valid prerequisites. Downstream, conditional, blocked, or coarse questions stay as text in **Not yet specified**. Existing tickets may later become blocked without losing their identity or history.

The **frontier** is the open, unblocked, unclaimed children whose substantive prerequisites still hold. Tracker closure alone does not prove a premise valid. Use the configured tracker states and dependency relationships; a review annotation is not a new status enum, and `claimed` is not a substitute for blocked.

After an answer or new evidence, revisit affected fog and newly discovered questions:

- **Graduate** when the question remains necessary and is now ready. Check for an existing equivalent ticket, create or reuse it, and confirm its durable identity before removing the corresponding fog text.
- **Retain** when the question is still needed but its conditions or discussion scope are not settled.
- **Prune** when the answer makes the branch unnecessary. Record the reason with the causative ticket's conclusion, or a map note when no such ticket exists, before removing the fog.

A false branch condition is not automatically **Out of scope**. Reserve that section for actual destination boundaries; close existing out-of-scope tickets with their reason, not a fabricated decision. Do not create tickets merely to give exclusions or pruned branches links.

## Lightweight Parallel Updates

Independent sessions may progress in parallel. Claims and refreshes are **best-effort coordination**, not locks or guarantees of atomicity, mutual exclusion, or zero lost updates. Do not add a central coordinator, leases, or a new tracker protocol.

1. **Read before claiming.** Even for a user-specified ticket, check current state, blockers, premise validity, and ownership. Claim a ready ticket through the tracker before work. Record enough ownership context to distinguish sessions sharing an assignee; the same account is not proof of ownership. Resume an existing claim only with established ownership or an explicit handoff.
2. **Refresh before each mutation.** Read the latest ticket and map at the time of writing. Recheck claims, states, and relevant premises. Merge only this ticket's changes into current content, preserving unrelated updates; do not submit the session's old map wholesale. A conflicting change requires reassessment, not an overwrite.
3. **Persist before removing.** Check for an existing resolution, child, or index entry before retrying. Save conclusions and confirm created/reused ticket references before closing or removing their source notes. Preserve successful steps and record what remains after a partial failure.
4. **Read back.** Verify the intended updates and retained neighboring content. If a conflict is detected, reread and reconcile non-conflicting changes; keep contradictory conclusions unresolved rather than choosing a winner silently. This check does not eliminate the remaining race window.

If another session owns an affected ticket, record the changed premise without taking over its claim. Its owner must revalidate the answer's premises before closing. After interruption, inspect existing results and unfinished updates before restarting work or delegation.

## Ticket Types & Skill Delegation

Every ticket is either **HITL** (worked with a human who speaks for themselves) or **AFK** (driven autonomously). Result format does not change that obligation: never reclassify a HITL ticket to bypass confirmation. If an AFK answer requires a human choice or an important unsupported inference, keep it unresolved and obtain evidence or route the decision through HITL discussion.

- **`grilling` (HITL)**: Align on core trade-offs, scope boundaries, and decision forks. Delegate to the `yjx-grill` skill. Treat it as a black-box alignment engine and accept either a Direct Result or an approved Formal Contract under [Alignment Result Handoff](#alignment-result-handoff). Always consult `domain-modeling` alongside if domain terminology or models are involved.
- **`research` (AFK)**: Use `research` to investigate facts against authoritative evidence, recording sources and limits. Resolve only what the evidence supports; do not turn an unresolved product choice into a factual answer.
- **`prototype` (HITL)**: Produce a disposable artifact suited to the domain, such as an outline, spatial sketch, or UI/logic spike. Use `prototype` when its capabilities fit. Bound its write scope and capture the artifact, observations, and human conclusion; helper instructions to fold a result into production do not authorize implementation.
- **`task` (HITL or AFK)**: Non-decision manual work that must happen before a decision can be made (e.g. provisioning access, running a data-sampling query, measuring physical dimensions). Output facts and environment status; do not implement production deliverables.

### Discussion Scope

Give the alignment skill the current question, sufficient-answer criterion, relevant confirmed premises, and boundaries with other questions. Macro charting concerns the destination and breadth of the question space; ticket work concerns that ticket's coherent problem. These are semantic inputs, not assumptions about `yjx-grill`'s internal sections.

A newly discovered prerequisite that can change the current answer's validity must be investigated, discussed, or left as an explicit blocker. A later question that consumes the answer belongs back on the map under [Frontier & Fog](#frontier--fog). Complete the ticket's scope without pretending the whole effort is complete or chasing every downstream fork.

### Research Ownership

The initiating session owns claiming, collecting, verifying, and recording its research results. Workers return evidence; they do not independently close tickets or mutate the shared map. Choose one delegation layer rather than recursively spawning workers through a helper.

Temporary workers must be collected in the same session. Cross-session research is permitted only when the host genuinely supports durable execution and result recovery; persist the owner, task/result pointer, and remaining steps. A pointer alone does not keep an agent alive. If collection cannot be guaranteed, leave the research ticket unclaimed for another session instead of launching it. Pending or failed research is not a resolution; on resume, check for an existing task or result before launching another.

### Alignment Result Handoff

These receipt rules apply after an alignment permitted by the user and host; they do not change invocation permissions.

A Direct Result may contain verified facts, answered user intent, and agent inferences. Preserve those sources instead of treating the whole result as fact or as an approved contract. An unapproved contract candidate is not an approved Formal Contract.

Before closing a HITL ticket, including `grilling`, ensure that live human confirmation explicitly covers its final conclusion and every material premise needed to unblock downstream work, including any such agent inference. A partial answer or acknowledgment does not approve subsequently added content. Keep unconfirmed necessary premises unresolved: do not close the ticket or graduate dependents on their basis. Reuse an existing explicit confirmation of the same complete scope rather than asking twice.

Confirmation of a Direct Result here is ticket-conclusion confirmation, not implementation authorization and not a request to turn it into a Formal Contract. A reviewed and approved Formal Contract can likewise settle a planning ticket without implementation authority, subject to the same premise and durable-resolution checks. Preserve any separately established implementation authorization at its actual scope; neither contract approval nor ticket closure grants or enlarges it or starts execution. Confirmed agent inferences retain their source; carry material boundaries and their confirmation scope into the resolution artifact and dependent decisions.

## Decision Revalidation & Superseding

When new evidence materially challenges a premise, inspect the affected open tickets, completed conclusions, and fog using their premise links. Recheck actual dependencies, not every unrelated decision.

- **No valid replacement yet**: Reopen the original ticket through the existing tracker lifecycle. Preserve its old answer as history; record the new evidence, affected parts, and question to re-examine. Mark the map entry as under review, not a current valid premise. Restore relevant blocking relationships and reopen affected completed tickets when their own answers need review.
- **A valid replacement exists**: Retain the original as history and link the replacing ticket. Check and update affected downstream premises and blocking relationships to the replacement before treating them as ready; the old ticket's closed state cannot justify readiness.

For example:

```markdown
- ~~[Storage selection](link): PostgreSQL~~ (under review; see the reopened ticket)
- ~~[Earlier storage decision](link): PostgreSQL~~ (superseded by [Embedded storage](link))
- [Embedded storage](link): SQLite for the confirmed local deployment
```

Neither a challenged premise nor a temporary block makes the question out of scope. Do not silently replace a human-confirmed choice. Apply the ticket's confirmation rules to the revised conclusion, then update its index entry and revisit affected questions.

## Invocation Modes

### Mode 1: Chart the Map (宏观建图)

User invokes with a loose, multi-session idea.

1. **Name the Destination**: Use `yjx-grill` under the macro discussion scope to establish the goal, scope boundaries, promised artifact, and completion criteria. Consult `domain-modeling` for key terminology. Survey the question space breadth-first without resolving every downstream detail.
2. **Check whether a map is useful**: Identify ready questions and fog. If the whole effort is clear and small enough for this session, explain that a map is optional and ask how the user wants to proceed.
3. **Create the Map** (label `wayfinder:map`): Preserve the agreed destination and standing constraints, record actual exclusions in **Out of scope**, and sketch deferred questions and their conditions in **Not yet specified**. Start the conclusion index empty.
4. **Create Ready Tickets**: Apply the granularity and readiness criteria, checking existing children first. Keep blocked or speculative future questions in the fog.
5. **Handle Research & Stop**: Dispatch ready research only under [Research Ownership](#research-ownership). Collect temporary workers and record verified results through Mode 2's resolution steps before ending; otherwise leave durable recovery context or undispatched tickets. Charting does not work through HITL decision tickets.

### Mode 2: Work Through the Map (单票推进与迷雾升级)

User invokes with a map or ticket (e.g. `/yjx-wayfinder <map>` or `/yjx-wayfinder #N`).

1. **Orient & Recover**: Load the map, including scope exclusions and Notes; consult named skills as applicable. For a supplied ticket, locate its parent map. Inspect any interrupted work or existing results before continuing.
2. **Choose & Claim**: Validate a specified ticket or select a frontier question, favoring useful bottlenecks. Follow the claim and refresh rules. If there is no ready ticket but unresolved work remains, report the actual blockers or refine the fog; an empty frontier is not completion.
3. **Work the Bounded Question**: Read related premise tickets as needed and use the matching discussion, research, prototype, or prerequisite-task method. Reassess granularity when new evidence changes the scope. Preserve partial results when blocked; do not close an unfinished question.
4. **Record the Resolution**: Revalidate current premises and apply [Alignment Result Handoff](#alignment-result-handoff) to HITL work, or verify the evidence for AFK work. Save the answer through the tracker with its key reasons, necessary evidence/premise links, important rejected alternatives, unresolved neighboring questions, source distinctions, and confirmation scope. Keep detail proportional; link assets rather than pasting them or the conversation. Close only after the answer is durable, then gist and link it in the map, repairing partial updates under the parallel-update rules.
5. **Revisit the Map**: Record newly discovered questions as well as revisiting existing fog. Apply graduation, retention, pruning, or decision revalidation as appropriate. Recording a follow-up does not require solving it in this session.
6. **Hand Off**: Prefer a fresh session for the next coherent ticket, with a name-wrapped link or tracker-appropriate invocation. In-place continuation is an exception for a tightly related follow-up with little context burden, not a fixed turn-count rule.

### Mode 3: Destination Closeout (终态收官)

An empty fog and apparently finished tickets invite a closeout check; they do not prove the destination reached.

1. **Check the whole effort**: Read the current map and **all** children, not just the frontier. Any open child (including claimed, blocked, or reopened tickets), unconfirmed conclusion, necessary fog question, or uncollected research result prevents closeout. For each terminal ticket, establish a valid conclusion or an evidenced disposition: scope exclusion, branch pruning, cancellation, or a merge/replacement linked to a ticket with a valid conclusion. `closed` or `wontfix` alone proves none of these. Repair missing result/index updates, and exclude challenged or superseded conclusions from the active decision set.
2. **Check coverage & synthesize**: Compare the effective conclusions with the original destination and completion criteria. Check compatibility, gaps between tickets, and whether the next stage can proceed without guessing important requirements. Synthesize the promised artifact from the ticket details, not only their gists. Ordinary presentation edits are allowed; a new consequential choice, contradiction, or missing prerequisite returns to exploration. Explicitly bound details legitimately deferred to the next stage instead of disguising important unresolved questions as minor parameters.
3. **Deliver & close**: Preserve the original Destination and add the verified artifact link or outcome. Write a promised project document at its agreed location. Refresh the map and children before publishing or closing; relevant changes require reconciliation and a renewed check. Post a closeout summary with the artifact, settled boundaries, and handoff, then close the map. These remain best-effort updates, not a locked snapshot.
