# yjx-grill Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-grill`. It records the skill's design intent and semantic boundaries. It is maintenance reference, not ordinary execution guidance.

## Identity

`yjx-grill` is a user-invoked tool for aligning a human and an agent on a design before implementation. It uses targeted questions, autonomous fact-finding, dynamic decision-tree exploration, and an explicit projection of the agent's implementation model.

Its primary outcome is verified shared intent before code is written. It is not primarily a summary generator, a questionnaire minimizer, a speed optimizer, a design-document generator, or an implementation-plan generator.

## Origin & Evolution

The skill was created to solve two complementary failure modes:

1. **Monolithic summaries**: Lengthy requirement summaries encourage skipping, creating the illusion of agreement without a shared implementation model.
2. **Questionnaire storms**: Broad, flat questioning overloads the human and buries critical trade-offs under dozens of trivial parameter inquiries.

However, reducing questions must never be achieved by arbitrarily cutting off decision depth or hiding architectural forks:
- **Depth must not be prematurely capped**: Settling a decision prunes unchosen alternatives, but expands the active decision frontier. As long as the chosen path contains unresolved architectural, state, or boundary trade-offs, grilling must continue across rounds until the tree reaches leaf nodes.
- **Inferences must be transparent**: Agent inferences bundle low-risk defaults to prevent questionnaire fatigue, but they must explicitly expose discarded alternatives and discard rationale so the human can spot and override assumptions at a glance.

## Semantic Boundaries

### Complete and Concise

A complete alignment artifact accounts for every material behavior, rule, condition, state, boundary, and decision source needed to review the active slice before implementation.

A concise artifact removes repetition, filler, and explanations that add no new verification value. Concision does not mean flattening the decision tree, omitting a section, merging distinct decision sources, or hiding a material inference.

### Four-Part Artifact

The four parts are distinct verification views, not interchangeable summaries:

1. **User Decisions & State Model (用户决策与状态模型)**: Verifies what the human explicitly committed to (P0 / highest weight). No agent-inferred rules belong here.
2. **Agent Inferences (AI推断 - Transparent & Individually Adjustable)**: Exposes the concrete companion rules the agent adopted along with explicitly discarded alternatives and reasons (P1 / default baseline).
3. **Technical Contracts (技术契约)**: Shows how the aligned behavior and inferences map to the repository's actual technical boundaries (Protobuf, HTTP, schemas, structs). It exposes the agent's implementation model without speculative fields.
4. **Forbidden Paths (禁止事项 - Anti-Goals)**: Identifies plausible implementations that would violate the aligned intent.

### Decision Provenance & Weight Separation

User decisions and agent inferences are fundamentally separate kinds of information with different authority weights:
- **User Decisions (P0)** cannot be modified without explicit human instruction.
- **Agent Inferences (P1)** take effect by default to prevent question storms, but remain independently adjustable without reopening the entire slice.

Selecting a recommended option adopts its attached inferences as default rules; it does not turn them into user-originated decisions. When many inferences exist, order them by review priority (`❗️`, `⚠️`).

### Dynamic Frontier & Depth

- Decision depth is governed strictly by system complexity, not an arbitrary round counter.
- When an answer unblocks new architectural dilemmas, the agent must ask follow-up questions in the next round.
- Questioning stops only when the active frontier is empty of unresolved architectural forks.

### Stable Identifiers

Identifiers such as `I-1`, `I-2` are deliberate handles for precise human corrections. Keep them stable within the active alignment artifact and assign them at the smallest useful rule unit. Do not remove them merely for stylistic brevity.

## Anti-Drift Checks

Before changing this skill, verify that the change:

- preserves implementation-before-code alignment as the primary outcome;
- keeps decision depth unconstrained and driven by actual decision-tree frontier traversal;
- requires agent inferences to visibly expose discarded alternatives and discard reasons;
- strictly maintains the distinction and provenance between User Decisions (P0) and Agent Inferences (P1);
- preserves the distinct verification purpose of all four artifact parts;
- treats concision as removal of non-value-adding expression, not loss of coverage or shallow questioning;
- retains stable identifiers for precise correction;
- keeps the technical contract concrete, repository-grounded, and non-speculative;
- preserves the active-slice boundary and execution stop condition;
- generalizes a problem instead of encoding a single example as a rule.

If a proposed optimization conflicts with one of these checks, resolve that conflict before editing the skill.

