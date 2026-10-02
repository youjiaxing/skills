# Multi-Spec Initiatives

Read this reference when considering more than one specification for a single initiative. The main skill's readiness, provenance, storage, revision, and marker rules apply to every unit.

## Decide Whether to Split

Split around coherent responsibilities with stable contract boundaries that can be explained and verified separately. Different deployment units, repositories, or lifecycle lengths are useful signals, not sufficient reasons by themselves. File length alone does not justify a split.

Keep a tightly coupled state model together. Multiple documents still describe one agreed destination; they are not an execution schedule or a set of implementation tickets.

## Assign Contract Ownership

Use a master specification as the assembly map. Include only genuinely shared definitions, cross-unit commitments, and necessary interactions. Identify which unit owns shared state or resolves a disputed value where that affects correctness.

Do not invent a universal clock, global lifecycle, or shared schema when the domains do not have one. Sub-specifications own their local contracts and reference shared definitions at their authoritative location, without competing copies.

Apply the adaptive content coverage from the main skill to each unit. Every newly created or revised master and sub-specification carries the document marker.

## Explain Relationships

Distinguish runtime interactions, contract references, and actual implementation prerequisites. These meanings can coexist; explain them through prose, a diagram legend, or edge labels rather than forcing a separate metadata table for every reference.

Use a DAG only for a relationship that is actually acyclic. Runtime interaction may contain cycles; a runtime requirement for upstream data does not by itself mean that its producer must be implemented first.

If stating a prerequisite, explain its basis. A reference to another unit's schema is not evidence of an implementation blocker. Neither a diagram edge nor a body link automatically creates a tracker's native `Blocked by` relation. Follow the project's established native-relation conventions where applicable, and distinguish a documented relationship from one actually established in the tracker.

Choose a diagram or matrix only when it clarifies the contract; do not require both to repeat the same information. Keep execution status, assignments, and progress checkboxes out of specifications.

## Publish Navigable References

For a new local `.scratch/` initiative, place the master at `<feature>/spec.md` and units at `<feature>/specs/<unit>.md`. Generate relative links from the file containing the link: a master links into `specs/`, while one unit links to a sibling from within that directory. Use the actual final headings or supported reference entry points, not copied example anchors.

For remote trackers, use references that identify both the target and its repository or project when necessary. A bare Issue number is insufficient across repositories. Keep links to authoritative remote artifacts, not to temporary upload paths.

Before publication, settle the units' content and intended reference targets. As actual tracker identities become available, resolve and verify the final links before reporting complete publication; do not leave unresolved placeholders as the final contract. Reuse established targets on revision, and report any partial publication rather than creating duplicate units.

Published reference entry points are compatibility boundaries. Preserve them during revision; if that cannot be established, retain the existing entry point and report the restriction. Do not assume every tracker supports explicit HTML anchors or silently rewrite other documents to compensate.
