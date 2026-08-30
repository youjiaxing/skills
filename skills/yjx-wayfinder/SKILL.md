---
name: yjx-wayfinder
description: Plan a large, ambiguous effort (spanning multiple agent sessions) as a shared map of decision tickets on your issue tracker, explore the active frontier with yjx-grill, and graduate fog into clear decisions until reaching the destination.
disable-model-invocation: true
---

A loose idea has arrived, too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging blindly at the destination. This skill charts the way as a **shared map** on the repo's issue tracker, then works its **decision tickets** (questions whose resolution is a decision or verified fact, not slices of a build to execute) one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting: it shapes every ticket. It might be a technical spec, an architecture decision, a course syllabus, an organizational plan, a book outline, or a physical project (like a garden design). The map is **domain-agnostic**: whatever fits the shape of multi-step cognitive exploration.

## Maintenance

When reviewing, modifying, or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It records the skill's design intent, evolution rationale, and anti-drift checks; it is not needed for ordinary runtime execution.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision or pre-condition, and the map is done when the way is clear, with nothing left to decide before someone goes and executes the build. An effort can override this in its **Notes**, carrying execution into the map itself, but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an issue, so it has a **name**: its title. In everything the human reads (narration, the map's Decisions-so-far), refer to it by that name, never by a bare id, number, or slug. Wrap the link inside the name (e.g. `[<title>](link)`), never let raw numbers stand in for it.

## The Map

The map is a single issue on this repo's issue tracker, labelled `wayfinder:map`, the canonical artifact. Its tickets are child issues of the map.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place, its ticket, so the map never restates it, only gists it and links.

Where the map, its child tickets, blocking, and frontier queries physically live is tracker-specific. Consult the tracker doc's "Wayfinding operations" section for how this repo expresses them. If no tracker has been configured, default to the local-markdown tracker.

### The Map body

The whole map at low resolution, loaded once per session:

```markdown
## Destination

<what reaching the end of this map looks like: the spec, architecture, outline, or plan this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain background; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link): <one-line gist of the decision>

## Not yet specified

<!-- the fog of war: all downstream, conditional, or blocked items waiting as plain text notes; graduates into physical issues as the frontier advances -->

- [ ] <unspecified or blocked question title> (Blocked by: <prerequisite>)

## Out of scope

<!-- work consciously ruled beyond the destination; closed, never graduates -->

- [<ticket title>](link): <why this is out of scope>
```

## Anti-Premature Ticketing & The Frontier

To avoid polluting the issue tracker with speculative tickets that become invalid when upstream decisions pivot, **physical tracker issues represent ONLY the active, unblocked, takeable frontier**.

- **Frontier (Physical Issues)**: Questions whose prerequisites are fully settled, open right now, and immediately takeable. These are created as child issues on the tracker.
- **Fog of War (Text Notes in `## Not yet specified`)**: All downstream, blocked, conditional, or coarsely-phrased questions remain as plain text checklist items in the map's `## Not yet specified` section. **Never pre-create physical issues for blocked downstream steps.**
- **Claiming**: A session claims a frontier ticket by assigning it to the dev/agent driving the map before starting work, ensuring concurrent sessions skip it.

### Ticket Body Format

Each physical ticket is a child issue of the map:

```markdown
## Question

<the specific decision, investigation, or prerequisite this ticket resolves>
```

Each ticket carries a `wayfinder:<type>` label: `research`, `prototype`, `grilling`, `task` (see [Ticket Types](#ticket-types)).

## Ticket Types & Skill Delegation

Every ticket is either **HITL** (human in the loop, worked with a human who speaks for themselves) or **AFK** (driven autonomously by the agent). A HITL ticket only resolves through live human exchange; the agent never stands in for the human's side.

- **`grilling` (HITL)**: Align on core trade-offs, scope boundaries, and decision forks. Delegate to the `yjx-grill` skill. `yjx-wayfinder` treats `yjx-grill` as a black-box alignment engine: when human confirmation is reached, record its confirmed output as the ticket's resolution. Always consult `domain-modeling` alongside if domain terminology or models are involved.
- **`research` (AFK)**: Reading documentation, investigating APIs, or surveying external facts that a decision waits on. Resolved by delegating to the `research` skill. Use when external knowledge is required.
- **`prototype` (HITL)**: Raise discussion fidelity by making a cheap, rough, concrete, disposable artifact to react to (an outline draft, UI wireframe stub, or code spike) by delegating to the `prototype` skill. The prototype is explicitly an exploratory spike, not production delivery.
- **`task` (HITL or AFK)**: Non-decision manual work that must happen before a decision can be made (e.g. provisioning access, running a data-sampling query, measuring physical dimensions). Output facts and environment status; do not implement production deliverables.

## Fog of War & Graduation

The map is *deliberately* incomplete: don't chart what you cannot yet see.

- **Fog or Ticket?**
  - **Create a physical ticket when**: The question is sharp AND all prerequisites are already resolved (the active frontier).
  - **Leave in `## Not yet specified` when**: The question depends on an open ticket OR is still too coarse to state sharply.
- **Graduation (迷雾升级)**: When an upstream ticket is resolved and closed, scan `## Not yet specified`. Any item whose prerequisites are now cleared is **graduated**: remove the text line from `## Not yet specified` and create a fresh physical Frontier issue for it.

## Decision Superseding

During exploration, new facts or downstream answers may prove an earlier closed decision invalid or obsolete.
Wayfinder uses a lightweight inline protocol to maintain truth on the map without complex revision trees:

- In `## Decisions so far`, apply strikethrough to the superseded decision and link to the overriding ticket:
  ```markdown
  - ~~[#1 Storage Selection](link): Use PostgreSQL cluster~~ (superseded by [#5 Embedded DB Adoption](link))
  - [#5 Embedded DB Adoption](link): Adopt SQLite for local single-binary deployment
  ```
- If downstream open tickets were based on the invalid premise, update or close them as `Out of scope`.

## Invocation Modes

### Mode 1: Chart the Map (宏观建图)

User invokes with a loose, multi-session idea.

1. **Name the Destination**: Invoke `yjx-grill` with an explicit macro constraint prompt:
   > *"We are in the macro charting phase of Wayfinder. The objective is to define the Destination and high-level decision branches across the entire system. Restrict grilling breadth-first to scope boundaries and high-level trade-offs; do not drill down into low-level implementation details or micro parameters."*
   Consult `domain-modeling` to lock key terminology.
2. **Map the Frontier & Fog Check**: Conduct a breadth-first scan across the problem space to identify the immediate open decisions and the downstream fog.
   - **Fog Check**: If this breadth-first scan reveals **zero fog** (the whole path is already clear, small, and solvable in the current session), **stop and report this fact to the user**. Ask if they prefer direct delivery in the current session or still want a persistent Map.
3. **Create the Map Issue** (label `wayfinder:map`): Populate `## Destination` and `## Notes`, leave `## Decisions so far` empty, and write all conditional/downstream items as text into `## Not yet specified`.
4. **Create Frontier Tickets**: Create physical child issues **ONLY** for the immediate, unblocked frontier questions.
5. **Fire Research Subagents**: If any AFK `research` tickets were created on the frontier, launch subagents to research them in the background.
6. **Stop**: Charting is one session's work; it does not hand-resolve decisions.

### Mode 2: Work Through the Map (单票推进与迷雾升级)

User invokes with a map or ticket (e.g. `/yjx-wayfinder <map>` or `/yjx-wayfinder #N`).

1. **Load the Map**: Load the low-resolution map view (`Destination`, `Notes`, `Decisions so far`, `Not yet specified`).
2. **Choose & Claim the Ticket**: If the user specified a ticket, use it. Otherwise, recommend an unblocked Frontier ticket (prioritizing high-leverage bottlenecks that unblock major fog). Claim it by assigning it to yourself.
3. **Resolve the Ticket**: Zoom into the ticket body and any related closed decisions. Delegate to the matching skill (`yjx-grill`, `research`, `prototype`, or `task`).
4. **Record the Resolution**:
   - Post the confirmed resolution artifact as a comment on the ticket.
   - Close the ticket issue.
   - Append a one-line gist and link to the map's `## Decisions so far` (or apply the [Decision Superseding](#decision-superseding) protocol if an earlier decision was overridden).
5. **Graduate Fog**: Scan `## Not yet specified`. For any text item whose blockers are now closed, remove it from `## Not yet specified` and create a new physical Frontier issue. Update the Map issue.
6. **Session Transition Guidance**:
   - **Default Baseline**: Recommend opening a fresh, clean session for the next ticket (e.g. `yjx-wayfinder #<next-id>`) to protect the context budget and maximize reasoning quality.
   - **Exception**: If and only if the current ticket was resolved rapidly in 1–2 turns with low context load AND the next ticket is a direct, tight logical continuation, in-place continuation is permitted.

### Mode 3: Destination Closeout (终态收官)

Triggered when **`## Not yet specified` is empty** and **all Frontier tickets are closed**.

1. **Synthesize Destination Artifact**: Aggregate the resolutions across all closed tickets in `## Decisions so far` and synthesize them into the final promised `Destination` artifact (e.g. a comprehensive architecture document, plan, outline, or proposal).
2. **Deliver Artifact**:
   - Update the Map's `## Destination` section with the final synthesized summary or link.
   - If the Destination specifies an output document in the project (e.g. `docs/design-spec.md`), write the synthesized content to that file.
3. **Closeout Map**:
   - Post a final **Closeout Summary comment** on the Map issue highlighting all settled core decisions, invariants, and next steps.
   - Mark the Map issue as **Closed**.
