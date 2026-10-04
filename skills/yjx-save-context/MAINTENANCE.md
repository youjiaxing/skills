# yjx-save-context Maintenance Notes

## Purpose

The skill creates a temporary, independently usable continuation for unfinished work. It preserves enough semantics to resume safely while keeping phase and authorization unchanged.

Its optimization target is **minimum sufficient continuation**:

- **Minimum** keeps one semantic home, references stable sources, and excludes context that cannot affect resumption.
- **Sufficient** preserves implementation-critical decisions, closed branches, corrections, evidence, and authorization that a fresh agent cannot safely infer.

This differs from a general conversation summary. Sufficiency comes before pruning: a shorter file that loses a decision boundary or reopens settled alternatives has failed. Remove repetition and dead metadata without weakening a fresh agent's ability to continue correctly.

## Design decisions

- **Single control point:** phase, authorization, active work, and next permitted action appear together at the top. Saving neither grants nor revokes permission; potentially confusing old control information is explicitly historical or superseded, without changing the substantive agreement or original artifacts.
- **Evidence-backed sufficiency:** goal, scope, constraints, acceptance, progress, and action boundaries are coverage checks, not mandatory sections. Decisions, completed work, verified results, and unknown outcomes remain distinct; saving does not run task verification.
- **Authority plus delta:** use the current authoritative artifact or consolidated content once, then carry only subsequent changes and missing continuation facts.
- **Decision closure:** compact ledgers preserve the names and closure conditions of rejected branches without reproducing full question cards.
- **Source-agnostic continuation:** the skill recognizes useful contracts, plans, and issue records semantically. It has no fixed dependency on an upstream alignment skill or downstream implementation workflow.
- **Triggered references:** a path earns space by naming why and when it must be read. Established later-stage dependencies, including skills, remain available without immediate loading or implied execution permission. Existing version cues may signal changes; agents resolve routine discrepancies from known sources without a new verification workflow or delegating checks to the user.
- **Decision-bearing evidence:** evidence travels when it supports a decision, unresolved item, acceptance condition, or expensive-to-recover fact. Stable evidence stays at its authoritative location.
- **Ephemeral runtime state:** observations carry time and recheck expectations. Dead handles carry no continuation value.
- **Operating-system temporary storage:** continuation artifacts stay outside the workspace and identify their temporary lifetime.
- **Natural body structure:** only the control block is fixed. The preserved contract, diagram, table, or prose keeps the organization that carries its meaning.
- **Prompt-only operation:** semantic completeness is assessed by full readback and static document review; no transcript format, watcher, or fixed parsing harness is required.

## Static Review Examples

Use these examples to inspect the instructions and available continuation artifacts under the repository [Skill verification policy](../../AGENTS.md#skill-verification). They are not inputs for simulated saving/resumption runs, runtime headings, or a questionnaire.

| Situation | Expected result |
| --- | --- |
| A proposal is awaiting final approval | The control block says approval and implementation authorization are still pending; the successor resumes that confirmation. |
| Implementation was authorized with a prohibition on committing | The successor retains implementation permission and the prohibition, without asking for the same authorization again. |
| A design was selected, an edit was made, and its verification has not run | The continuation distinguishes the decision, completed edit, and unverified result; saving neither invents a pass nor runs task verification. |
| A user selected one option from several consequential alternatives | The selected decision remains complete; closed alternatives, decisive closure reason, and applicable reopening condition appear in compact form. |
| A full user-confirmed contract exists only in the conversation | The contract is carried once as the authoritative content, with later corrections added as deltas. |
| A current stable plan or issue already owns the full contract | The continuation references it with purpose and loading trigger, and carries only missing continuation state. |
| The latest assistant response conflicts with a later user correction | The correction is active and the superseded statement is excluded or identified only when needed to explain closure. |
| A carried contract contains old authorization or next-action text | Confusable old control information is explicitly historical or superseded by the control block; the substantive agreement and original artifact stay unchanged. |
| The current step is confirmation and a later implementation skill was already selected | The skill reference survives with its loading trigger; only confirmation inputs are immediate requirements, and listing the skill grants no execution permission. |
| A critical reference has a known version cue and a later change | The cue is a lightweight signal; the agent resolves the discrepancy from known sources and corrects only the continuation, without changing confirmed decisions or sending routine checks to the user. |
| A reference has no version cue, or a discrepancy cannot be resolved | No mandatory version field, fingerprinting, or snapshot workflow is introduced; unsupported conclusions stay unknown. |
| Quantitative evidence determines a decision or acceptance condition | The relevant result travels with enough source or counting detail to review it. |
| A cancelled subagent produced no result | The file states that no result is available and what remains undone; expired identifiers are omitted. |
| A live background task can still be inspected independently | The file preserves its observed status and usable inspection method. |
| Mutable repository or service state was checked | The file records the observation time and requires a fresh check before action. |
| The working directory already contains `tmp/` | The continuation still goes to the operating system temporary directory. |
| The operating system temporary directory cannot be resolved or written | The operation reports failure without claiming a saved file or using the workspace as fallback. |
| Current workspace rules or repository state contradict a recorded decision | The successor reports the conflict before changing settled choices and follows current workspace governance. |
| The host loses context before saving finishes | The file states the recovery gap and avoids claiming complete preservation. |

## Review method

During skill maintenance, review the runtime instructions and, when available, continuation artifacts from actual user interactions against their authoritative sources. Inspect whether decisions, corrections, authorization, references, evidence, and background work remain explicit and consistent. Do not generate simulated conversations or run saving/successor agents as behavioral tests.

Review sufficiency first, then economy:

1. The instructions and available artifact preserve the task, evidence-backed progress, remaining gaps, closed decisions, and action boundaries explicitly or through accessible references, without depending on the old session.
2. Repetition and irrelevant material are removed without losing continuation-critical meaning; sentence-by-sentence irreducibility is not an acceptance condition.

Repository discovery checks can verify skill placement and frontmatter. Static review can identify omissions and inconsistencies, but neither establishes reliable agent behavior.
