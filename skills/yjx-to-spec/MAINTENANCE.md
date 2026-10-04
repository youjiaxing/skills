# Maintenance: yjx-to-spec

Read this document before reviewing or changing the skill, not during ordinary execution. It records why the runtime rules exist and how to check their behavior.

## Retained Intent

The specification is a high-fidelity description of the agreed destination, not a lossy summary, an interview, or a premature ticket plan. Preserve domain-native contracts, meaningful acceptance criteria, decision rationale, and protection for existing systems.

The original maintenance notes associated user-story inflation with Issue #777, brownfield destabilization with #843, and decision amnesia with #689 and #959. They also recorded `341-union-battle-optimize` as a multi-repository, multi-lifecycle example. These historical identifiers are background, not runtime proof of a project's requirements or safety bounds.

The useful lessons remain: avoid repetitive user-story padding, preserve important rejected alternatives when actually known, keep contracts at a single source, and retain multi-spec support without mandating particular upstream or downstream tools.

## Deliberate Corrections

- **Readiness is a gate, not a template claim.** Calling the skill means "check, then create and publish", not "assume the conversation is complete". Missing key commitments stop generation and publication; they do not produce a plausible-looking draft. Safe implementation freedom is allowed. Reject both automatic key-design completion and a requirement to settle every private implementation detail.
- **Source and readiness are different questions.** Replace the old P0/P1 binary with a distinction between confirmed choices, checked facts, and inferences, and separately assess whether unresolved content affects or depends on unsettled key commitments. A guessed range is not evidence of safety. Do not restore prefilled 100% readiness claims or fabricate discarded alternatives.
- **Behavioral scope is not a physical whitelist.** Retain allowed behavior changes, invariants, and explicit restrictions. Expected file or module locations are non-exhaustive impact evidence, not automatically the limits of authorization. Honor real physical restrictions without inferring them from exploration. Keep protection rules in one authoritative place.
- **Completeness is not fixed formatting.** Select the representations needed by the domain and requirement. A small feature need not have a schema, state machine, or every former template section. Preserve exactness where collaboration or acceptance depends on it, not incidental implementation decisions.
- **Acceptance needs a verification basis.** Restore relevant test or inspection prior art, observable entry points, project vocabulary, and ADR awareness. Prefer suitable existing entry points without imposing one framework, highest layer, or single test boundary. A plan to verify is not evidence that verification passed.
- **Invocation includes publication, not a default commit.** Keep the original direct creation/publication workflow after readiness succeeds. Do not insert another draft-approval step. Local and remote storage have distinct formal targets; a remote upload file is a repository-external temporary, not a maintained local copy. Separate explicit versioning requirements do not authorize committing upload temporaries.
- **Revisions preserve identity and implementation commitments.** Update a clearly identified continuing requirement in place. Major changes after implementation begins require impact coverage and sufficient authorization, not repeated confirmation of an unchanged approval. Do not guess targets, overwrite known concurrent changes, or modify execution tickets as a side effect.
- **Topology describes meaning, not task scheduling.** Preserve cohesive contracts, actual shared state ownership, and single-source references. Deployment count does not compel decomposition. Runtime interaction, contract reference, and implementation prerequisite are different, possibly overlapping relationships. No universal DAG, global clock, or automatic tracker blocker is required.

## Document Identity and Compatibility

The runtime marker is `<!-- yjx:spec -->`, as the exact unindented first nonblank line of every created or updated formal specification. It is a type declaration only. Presentation headings, language, and layout do not establish readiness or identity.

`yjx-gh-kanban` reads the marker before falling back to its existing `to-spec` and legacy `yjx-to-spec` heading paths. Install the reader change before enabling flexible templates in a project using that consumer. Backward compatibility means the new reader accepts old specifications; it does not mean an old reader recognizes every new layout.

Do not bulk-rewrite old artifacts. Add the marker during an authorized revision, preserve unrelated content and published reference entry points, and report actual limitations instead of breaking references. Do not create new tracker labels to carry this protocol.

The reader's behavioral checks live in:

- [Board classification tests](../yjx-gh-kanban/tests/board-engine.test.mjs): explicit and legacy identity, marker examples versus declarations, and exclusion from execution candidates.
- [CLI tests](../yjx-gh-kanban/tests/issue-board.test.mjs): relationship-loading compatibility and JSON, agent, and ready-only output.

## Static Review Examples

Use these examples to review the runtime instructions and available artifacts under the repository [Skill verification policy](../../AGENTS.md#skill-verification), not as inputs to model-driven or simulated-conversation tests. Inspect whether the rules preserve the listed boundaries; exact prose, headings, or template length do not establish quality. Static checks do not prove reliable agent behavior.

| Case | Required behavior |
| --- | --- |
| User or upstream agent says discussion is done, but a key permission or failure policy is unsettled | Report the gap without generating, changing, or publishing a specification or assigning ready labels. |
| Commitments are clear; internal organization or another harmless implementation choice remains open | Produce and publish the specification without inventing numeric limits or requiring every implementation choice to be settled. |
| A choice is called minor but depends on an unsettled key commitment | Investigate its dependency; do not use its label or a guessed range to bypass the gate. |
| A small feature has no relevant schema migration or complex state machine | Keep the document complete and precise without manufacturing those artifacts or forcing every old section. |
| Remote tooling needs a file; publication succeeds, fails, or returns an unknown result | Use a task-owned directory outside the repo, verify actual publication, clean only confirmed-success material, and retain/report temporary recovery material otherwise. Never commit it. |
| A continuing requirement has an original specification and ongoing implementation | Check identity, current content, affected commitments, and authorization before a material update; preserve stable references and do not change code or tickets. |
| A multi-unit system has cyclic runtime interaction and shared contracts | Explain the real relationships, preserve ownership and references, and do not manufacture implementation blockers or duplicate schemas. |
| A localized specification uses a different layout, or an ordinary ticket quotes the marker | Recognize the real declaration, not the example; preserve legacy recognition and keep specifications out of READY/next. |

## Anti-Drift Checks

- Can the skill stop without producing an artifact when readiness cannot be established?
- Are source, uncertainty, and implementation authority kept distinct without a mandatory metadata ledger?
- Are impact locations separated from real restrictions, with no default physical whitelist?
- Are necessary contracts and high-signal verification retained when irrelevant sections disappear?
- Are published references and specification identity preserved across authorized revisions?
- Does each storage mode have one clear formal target, with no default commit or accidental remote/local dual maintenance?
- Are temporary files isolated, scoped to the task, and handled honestly after failed or uncertain publication?
- Do main and sub-specifications remain static contracts rather than a dynamic execution graph?
- Do the runtime instructions, this maintenance rationale, conditional references, and companion reader agree?
