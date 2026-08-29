# yjx-grill Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-grill`. It records the skill's design intent and semantic boundaries. It is maintenance reference, not ordinary execution guidance.

## Identity

`yjx-grill` is a user-invoked tool for aligning a human and an agent on a design before implementation. It uses targeted questions, fact-finding, decision-tree pruning, and an explicit projection of the agent's implementation model.

Its primary outcome is verified shared intent before code is written. It is not primarily a summary generator, a questionnaire minimizer, a speed optimizer, a design-document generator, or an implementation-plan generator.

## Origin

The skill was created to address two recurring failures:

- Long requirement summaries encourage skipping, creating the appearance of agreement without a shared implementation model.
- Broad, flat questioning overloads the human and makes important decisions harder to review.

Reducing questions or shortening output must not recreate the first failure by hiding assumptions. The skill deliberately trades some output and review effort for visibility of anything that can materially affect implementation.

## Semantic Boundaries

### Complete and concise

A complete alignment artifact accounts for every material behavior, policy, condition, state, boundary, and decision source needed to review the active slice before implementation.

A concise artifact removes repetition, filler, and explanations that add no new verification value. Concision does not mean showing only the latest changes, removing a section, merging distinct sources, or omitting a material policy.

### Four-part artifact

The four parts are different verification views, not four interchangeable summaries:

1. **User-confirmed behavior and state model** verifies what the human explicitly committed to.
2. **Agent-inferred baselines** exposes the concrete defaults the agent will use and keeps them individually adjustable.
3. **Commented technical contract projection** shows how the aligned behavior and baselines map to the repository's actual technical boundaries. It is for exposing the agent's implementation model, not for teaching the domain.
4. **Slice-specific forbidden paths** identifies plausible implementations that would violate the aligned intent.

The same business concept may appear in more than one part when each occurrence serves a different verification purpose. Remove only repetition that adds no distinct verification value.

### Decision provenance

User-confirmed decisions and agent-inferred baselines are separate kinds of information. A user selecting or accepting a recommended option does not change an inferred baseline into a user-originated requirement.

Material inference must remain visible in a form the user can identify and review. The skill may bundle compatible defaults to reduce questioning, but bundling must not make their meaning or origin unclear. Selecting an option settles the current question and adopts attached policies as agent-inferred baselines; it does not require a separate question for every attached policy.

When many inferred baselines exist, order them by review priority. Use `❗️` for items whose mistake could change authority, ownership, state meaning or transition, cross-boundary behavior, permission, an irreversible effect, or the protocol shape. Use `⚠️` for other material items that deserve early review. These markers prioritize attention only; they do not change provenance or create another question.

### Technical projection

The technical projection should use the repository's real stack and boundaries. Multiple representations are appropriate when they describe distinct boundaries or state models and each helps verify the implementation model. They are inappropriate only when speculative, unrelated, or duplicative without a distinct verification purpose.

### Stable identifiers

Identifiers such as `H-1`, `P-1`, or `R-1` are deliberate handles for precise user corrections. Keep them stable within the active alignment artifact and assign them at the smallest useful policy or decision unit. Do not remove them merely for stylistic brevity.

### Scope and stopping

Work is organized around the active capability slice. Do not broaden the confirmed scope without an explicit user decision. Do not write application code, downstream planning artifacts, or unrelated documentation as part of ordinary skill execution.

The skill stops only after the active slice's alignment artifact has been explicitly confirmed.

## Anti-Drift Checks

Before changing this skill, verify that the change:

- preserves implementation-before-code alignment as the primary outcome;
- keeps material agent inference visible and separate from user confirmation;
- preserves the distinct verification purpose of all four artifact parts;
- treats concision as removal of non-value-adding expression, not loss of coverage;
- retains useful identifiers for precise correction;
- keeps the technical projection concrete, repository-grounded, and non-tutorial;
- preserves the active-slice boundary and execution stop condition;
- generalizes a problem instead of encoding a single example as a rule.

If a proposed optimization conflicts with one of these checks, resolve that conflict before editing the skill.
