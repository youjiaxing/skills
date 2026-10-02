---
name: yjx-to-spec
description: Check readiness, then compile and publish aligned discussions or decision artifacts into a domain-native specification with explicit contracts, change boundaries, and verifiable acceptance.
disable-model-invocation: true
---

# yjx-to-spec

Compile the agreed destination into a specification and create or update it at the project's configured storage target. Invoking this skill requests creation and publication together, without a separate draft-approval step. Invocation, or an upstream agent declaring discussion complete, is not evidence that the input is ready.

A specification describes the promised outcome, contracts, change boundaries, and verification basis. It is not an interview, an implementation schedule, or a collection of execution tickets. Remain independent of particular upstream alignment tools and downstream implementation workflows. Do not modify application code or create, update, or execute implementation tickets.

## Maintenance

Before reviewing or changing this skill, read [MAINTENANCE.md](MAINTENANCE.md). Ordinary execution does not require it.

## 1. Ground the Request

- Read the available conversation, decisions, and referenced artifacts. Establish the intended outcome, agreed scope, and whether this is a new requirement or a revision.
- Inspect the relevant environment to check current contracts and constraints. For software, consult applicable project instructions, domain vocabulary, ADRs, and relevant existing tests; use equivalent evidence in other domains.
- Establish the formal storage target and triage conventions from project instructions or `docs/agents/issue-tracker.md`. Do not invent a tracker, destination, or label vocabulary when these are missing.
- For a revision, locate and read the original specification using an explicit path, Issue reference, or reliable project association. Title similarity alone is insufficient. Apply the revision rules in section 5 before replacing content.

Separate **confirmed choices**, **verified facts**, and **inferences** while reasoning. Give important decisions, derived constraints, and remaining implementation choices enough attribution to understand their basis; do not force a provenance field on every sentence or output a large classification ledger. Approval of a proposal does not turn its agent-derived reasoning into a user-originated requirement or a verified fact.

Preserve known decision rationale and actually discussed rejected alternatives. If that history is absent, leave it absent or say it was not recorded; do not invent a decision process to fill a template.

## 2. Check Readiness Before Generating

The goal, scope, externally observable behavior, key constraints, and acceptance basis must be sufficiently clear, supported, and mutually consistent. Check the requested deliverable as a whole, including shared commitments when it contains multiple specifications.

A remaining choice may be left to implementation only when it neither changes those commitments nor depends on an unsettled key commitment. Its size or the label "parameter" does not establish safety. Investigate unclear effects using available evidence; do not substitute an agent-selected key design for missing alignment.

Use bounds only when evidence supports them. An invented interval is no safer than an invented number. Valid implementation freedom need not have a concrete value or numeric range, and readiness does not require eliminating all such freedom.

**If a material gap, conflict, or missing evidence prevents establishing readiness, stop before generating or mutating specifications.** Return a concise, localized statement that no specification was generated, with the blocker, its basis, and the decision or evidence needed. Do not produce a formal or placeholder spec, alter an existing one, publish, or assign ready labels. Do not automatically start another interview or workflow.

This gate takes precedence over all generation and publication instructions. Missing publication prerequisites likewise stop publication; report them rather than guessing a target. When the gate passes, proceed directly. Any readiness statement must describe the actual result of the check, not prefilled completion percentages or claims that every open choice is settled.

## 3. Compile for the Actual Domain

Use the user's conversational language for headings, labels, and prose. Keep literal protocol identifiers and the document marker unchanged. Choose headings, order, and representations to fit the subject; merge or omit inapplicable sections without omitting necessary commitments.

Cover the following content where it affects the outcome:

- **Problem and outcome:** what needs to change, the promised result, in-scope capabilities, and explicit exclusions.
- **Contracts and behavior:** the public entities, interfaces, interactions, lifecycle transitions, failure behavior, or physical/process constraints needed to remove material ambiguity. Be exact where collaboration or acceptance depends on it, not merely because a template contains a field.
- **Change boundaries:** the capabilities, behavior, and contracts allowed to change. Treat expected modules or files as non-exhaustive impact locations, distinguishing inspected locations from predicted ones, not as an automatically authorized physical whitelist.
- **Invariants and prohibitions:** keep protection requirements in one place. Honor explicit physical restrictions from the user, applicable project governance, or confirmed design, and state their basis. A new file location is not by itself scope expansion; a listed location is not permission to change any behavior. Crossing a confirmed boundary requires renewed alignment.
- **Decisions and implementation freedom:** preserve confirmed decisions and their available rationale. State meaningful remaining freedom and its supported constraints without disguising unresolved key decisions as tunable parameters.
- **Acceptance and verification:** specify essential behaviors, important failure cases, and invariant checks, together with the observation points, prerequisites, and reusable tests or inspection methods that can establish the result.

Possible representations include typed interfaces, schema changes, error contracts, and state tables for software; drawings, material specifications, or inspection criteria for physical design; and responsibility or escalation rules for operations. Select only what the requirement needs. Do not fabricate schemas, dimensions, tolerances, or timing values to make the document look complete.

Reference existing authoritative contracts and describe the exact change; do not duplicate whole definitions or replace the new commitments with a bare link. Include decision-relevant public contracts, not private helper code, glue scripts, or a working implementation. Prefer direct domain descriptions over a mandatory long list of Agile user stories.

For verification, prefer suitable existing observation points and relevant prior art. Do not impose a particular framework, command, highest test layer, or single test entry point. Test promised behavior rather than freezing private implementation structure. Missing existing tests do not alone block a spec if its result can be judged; describe necessary new verification capability and its impact without silently adding product interfaces or architectural requirements.

Use scenarios or a compact matrix according to clarity; do not repeat the same cases in both forms. A verification plan is not a passed check. State what evidence has actually been checked and what remains for implementation or acceptance.

For a candidate multi-spec initiative, read [references/multi-spec.md](references/multi-spec.md) before deciding its structure or publishing its units. Splitting documents does not authorize splitting implementation tickets.

## 4. Give Every Specification a Stable Identity

Every formal specification created or updated by this skill, including a master and each sub-specification, must begin with this exact, unindented marker as its first nonblank line:

```markdown
<!-- yjx:spec -->
```

The marker occupies the entire line, with no trailing text or spaces. An initial UTF-8 BOM, leading blank lines, and LF or CRLF line endings are allowed. A marker quoted in prose, a blockquote, or a code example is not a document declaration.

The marker declares a document type, not readiness, approval, or implementation progress. The rest of the document can use native-language headings and an appropriate structure without fixed numbering or a "Readiness Radar".

For a project using `yjx-gh-kanban`, ensure its marker-aware reader is available before dropping the old identifying headings. The updated reader retains the legacy `to-spec` and `yjx-to-spec` heading paths; old readers are not guaranteed to understand a new flexible layout. Do not bulk-migrate historical specifications. Add the marker when an existing specification is legitimately revised, without gratuitously reformatting its unrelated content.

## 5. Create or Revise at the Formal Target

### Revisions

Create a new specification for a new requirement. For an explicitly continuing requirement, update the existing file or Issue in place rather than creating a competing version.

- Read the original and establish the exact update target. If its identity is ambiguous, multiple candidates remain, or the original cannot be read, report the blocker; do not guess an overwrite or create a replacement to bypass it.
- If implementation has not started, apply the aligned revision without an extra publication approval.
- If implementation has started and a change affects the goal, scope, external behavior, key constraints, or acceptance basis, establish its impact on existing commitments and completed or ongoing work. Update only with confirmation covering those effects. Reuse sufficient existing authorization rather than asking again.
- Do not treat unknown implementation status as "not started" to bypass impact checks. Corrections that do not change meaning do not need this material-change gate.
- Preserve unrelated content and published reference entry points. If compatibility cannot be maintained, leave the affected entry point unchanged and report the limitation rather than silently editing other documents.
- Record material commitment changes and their basis, not a dynamic execution-progress ledger. Recheck the source before replacement; if it has changed, reconcile against the current version instead of overwriting from a stale copy. Do not claim atomic concurrency protection that the storage tool does not provide.

### Local Tracker

Follow the configured local convention. For a new specification in the `.scratch/` convention, use `.scratch/<YYYYMMDD-HHmm>-<descriptive-slug>/spec.md`, with the user's or project's local timezone. Place optional sub-specifications under that feature's `specs/` directory. Preserve an existing specification's location on revision, and do not overwrite an unrelated file on a naming collision.

These files are the formal specification, not temporary upload material. Do not add execution `Status:` fields or other task-progress metadata that would enroll a specification in the implementation kanban.

### Remote Tracker

The remote specification is the formal source. Create or update it directly through the available authorized tracker interface. Use a concise title in the user's language, adding prefixes only where the project requires them. Follow canonical triage labels; do not invent labels.

The presence of local project documentation does not request a second maintained copy or a Git commit. Use direct content input when supported. If upload tooling requires a local file:

- Create it in a task-owned system temporary directory outside the repository, not in business directories, versioned docs, or the local tracker.
- Never stage or commit upload material, or modify `.gitignore` to accommodate it.
- After verified publication success, remove only this task's temporary material.
- On failure or an unknown result, preserve the material for recovery and report its temporary path and actual publication state. Do not promise permanent retention or blindly retry a create that may already have succeeded.

There is no default Git commit step in either storage mode. Honor a separate explicit user or project requirement where applicable; it does not turn upload temporaries into versioned artifacts or implicitly request dual-source maintenance.

### Completion

Before mutation, check the final content against the agreed scope, readiness gate, marker protocol, and reference targets. After writing or publishing, verify the stored content and references and apply only the project's required triage labels for a completed specification. Do not declare success from a local upload file alone.

If publication fails, is partial, or cannot be verified, report completed targets and outstanding work accurately and preserve recoverable temporary material. Do not silently reduce the requested scope, claim the entire specification is published, or launch an implementation workflow.
