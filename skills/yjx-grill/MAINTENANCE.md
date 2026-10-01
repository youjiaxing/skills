# yjx-grill Maintenance Metadata

Read before reviewing, modifying, or redesigning this skill, not during ordinary execution. This file records why the boundaries exist; `SKILL.md` is the runtime authority.

## Purpose and Decisions

The skill replaces exhaustive interviewing with evidence-backed alignment, without replacing human intent with agent convenience. It is domain-neutral: requirements, technical designs, organizational plans, and other complex decisions can use the same loop.

The approved optimization deliberately changes two earlier principles:

- **Intent and consequence are separate reasons to ask.** Reversal cost does not determine who owns the desired outcome. A cheap change may express the user's core intention, while several technical alternatives may require no question. Existing requirements, evidence, and explicit delegation can already settle a choice.
- **Asking does not force formal approval.** Low-risk intent clarification can end with a concise Direct Result. A consequential human trade-off requires a reviewed Formal Contract even after the user selects an option. Risk-triggered review still applies to Direct Results; it must not manufacture a human fork or an unnecessary contract.

The third approved choice preserves the pressure-testing purpose: challenge a premise for concrete goal mismatch, unsupported material assumptions, infeasibility, or a better-supported reduction in scope. Do not add a universal preliminary questionnaire or reopen closed choices for preference alone.

These choices supersede the former high-reversal-cost-only question gate and the rule that every asked decision automatically required a contract. Do not restore either while editing neighboring wording.

## Failure Modes and Rationale

- **Over-questioning and silent intent substitution:** use the dual-entry gate, not "ask everything" or "guess anything reversible."
- **Cheap edits with irreversible effects:** judge data, authority, external commitments, resource use, and strategic consequences; unknown risk remains pending evidence.
- **Premature convergence:** ready questions need settled prerequisites; the necessity of two questions does not make them independent. Pending nodes are legitimate ledger states, not proof of completion.
- **Local completion mistaken for global completion:** a slice returns to the remaining-work loop. Partial execution needs independent, authorized scope and preserves the rest of the alignment.
- **Approval laundering:** conclusion acknowledgment, scoped implementation authorization, and execution intent have different effects. An old plan's execution instruction cannot authorize a materially different plan.
- **Provenance collapse:** approval changes permission, not claim origin. The private ledger retains sources and evidence; shared presentation keeps material proposals in attributed quotes without rendering ledger fields.
- **Reviewer amplification:** scrutiny tests evidence and consequences. Rejected alternatives reopen only for the entrypoint's evidence-based reasons.
- **Thin or repetitive contracts:** keep implementation-critical semantics with their topic, while removing restatement and routine mechanics rather than correctness boundaries.

## Information Ownership

- `SKILL.md` owns shared runtime behavior, including all-path coverage, source separation, risk review, completion, and execution handoff.
- [references/contract.md](references/contract.md) owns only formal-contract composition and approval details. Its conditional read is mandatory on that path; Direct Result review must not depend on loading it.
- Wayfinder owns its ticket-closeout confirmation. Its receipt of a result does not alter this skill's delivery form. Confirmation must bind the conclusion and material premises used to unblock downstream work, including relevant agent inferences without relabeling their source.

Invocation metadata and cross-host triggering are unchanged. This work validates the behavior of an explicitly started skill and its permitted result handoff, not whether every host interprets invocation fields identically.

## Maintenance Checks

When changing the skill, verify that:

- autonomous fact discovery, dual-entry questioning, zero-question cases, ready-frontier dependency handling, and both delivery forms remain available;
- coverage and source/evidence mappings survive partial answers, new evidence, review, approval, and handoff;
- observed high stakes are not erased merely by answering a question, and reviewer unavailability or unresolved correctness findings cannot be presented as successful completion;
- collaborative discussion remains open to feedback without requiring a fixed closing phrase or adding a contract to low-risk clarification;
- topic organization, attributed proposal quotes, incremental rounds, numbered choices, and real option costs remain intact;
- formal details are discoverable through a mandatory pointer, with shared safety rules still on all execution paths;
- full implementation-critical model shapes and guarantees survive compression, while empty fields and duplicate summaries do not return;
- runtime text stays in English and user-facing text is localized; no repository or external mutation occurs during alignment.

Use static checks for packaging, links, and document consistency. Use actual model interactions for behavioral observations, reporting the cases, replies, outcomes, and limitations separately. Neither keyword matching nor a successful skill validator proves model behavior; unrun cases remain unrun.
