# yjx-save-context Maintenance Notes

## Purpose

The skill creates a temporary, independently usable continuation for unfinished work. It preserves enough semantics to resume safely while keeping phase and authorization unchanged.

Its optimization target is **minimum sufficient continuation**:

- **Minimum** keeps one semantic home, references stable sources, and excludes context that cannot affect resumption.
- **Sufficient** preserves implementation-critical decisions, closed branches, corrections, evidence, and authorization that a fresh agent cannot safely infer.

This differs from a general conversation summary. A shorter file that loses a decision boundary or reopens settled alternatives has failed; a complete file that repeats live state or carries dead metadata has also failed.

## Design decisions

- **Single control point:** phase, authorization, active work, and next permitted action appear together at the top so a successor cannot mistake saving for approval.
- **Authority plus delta:** use the current authoritative artifact or consolidated content once, then carry only subsequent changes and missing continuation facts.
- **Decision closure:** compact ledgers preserve the names and closure conditions of rejected branches without reproducing full question cards.
- **Source-agnostic continuation:** the skill recognizes useful contracts, plans, and issue records semantically. It has no fixed dependency on an upstream alignment skill or downstream implementation workflow.
- **Triggered references:** a path earns space by naming why and when it must be read. Current work loads current requirements; later branches load their own constraints.
- **Decision-bearing evidence:** evidence travels when it supports a decision, unresolved item, acceptance condition, or expensive-to-recover fact. Stable evidence stays at its authoritative location.
- **Ephemeral runtime state:** observations carry time and recheck expectations. Dead handles carry no continuation value.
- **Operating-system temporary storage:** continuation artifacts stay outside the workspace and identify their temporary lifetime.
- **Natural body structure:** only the control block is fixed. The preserved contract, diagram, table, or prose keeps the organization that carries its meaning.
- **Prompt-only operation:** semantic completeness remains a model judgment verified by full readback and scenario review; no transcript format, watcher, or fixed parsing harness is required.

## Review scenarios

Use these cases to evaluate changes; they are not runtime headings or a questionnaire.

| Situation | Expected result |
| --- | --- |
| A proposal is awaiting final approval | The control block says approval and implementation authorization are still pending; the successor resumes that confirmation. |
| A user selected one option from several consequential alternatives | The selected decision remains complete; closed alternatives, decisive closure reason, and applicable reopening condition appear in compact form. |
| A full user-confirmed contract exists only in the conversation | The contract is carried once as the authoritative content, with later corrections added as deltas. |
| A current stable plan or issue already owns the full contract | The continuation references it with purpose and loading trigger, and carries only missing continuation state. |
| The latest assistant response conflicts with a later user correction | The correction is active and the superseded statement is excluded or identified only when needed to explain closure. |
| The current step is confirmation and implementation rules apply later | Only confirmation inputs are immediate requirements; implementation references are triggered by entering implementation. |
| Quantitative evidence determines a decision or acceptance condition | The relevant result travels with enough source or counting detail to review it. |
| A cancelled subagent produced no result | The file states that no result is available and what remains undone; expired identifiers are omitted. |
| A live background task can still be inspected independently | The file preserves its observed status and usable inspection method. |
| Mutable repository or service state was checked | The file records the observation time and requires a fresh check before action. |
| The working directory already contains `tmp/` | The continuation still goes to the operating system temporary directory. |
| The operating system temporary directory cannot be resolved or written | The operation reports failure without claiming a saved file or using the workspace as fallback. |
| Current workspace rules or repository state contradict a recorded decision | The successor reports the conflict before changing settled choices and follows current workspace governance. |
| The host loses context before saving finishes | The file states the recovery gap and avoids claiming complete preservation. |

## Review method

Exercise the skill against source material containing decisions, corrections, authorization changes, references, quantitative evidence, and background work. Compare the saved file with the source and verify both sides of the target:

1. Removing another sentence would lose a continuation-relevant semantic claim.
2. A fresh agent can continue without reopening closed decisions, inventing missing authority, or accessing the old session.

Repository discovery checks can verify skill placement and frontmatter. They cannot prove semantic completeness, closure fidelity, or correct authority selection; review those through the scenarios above.
