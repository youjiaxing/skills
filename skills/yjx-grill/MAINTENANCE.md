# yjx-grill Maintenance Metadata

Read before reviewing, modifying, or redesigning this skill, not during ordinary execution. This file records why the boundaries exist; `SKILL.md` is the runtime authority.

## Purpose and Decisions

The skill replaces exhaustive interviewing with evidence-backed problem discovery and alignment, without replacing human intent with agent convenience. A stated solution can address a symptom rather than the actual difficulty; the agent helps uncover the desired outcome through concrete experience, while keeping its interpretation tentative and correctable. It is domain-neutral: requirements, technical designs, organizational plans, and other complex decisions can use the same loop.

The approved optimization deliberately changes two earlier principles:

- **Intent and consequence are separate reasons to ask.** Reversal cost does not determine who owns the desired outcome. A cheap change may express the user's core intention, while several technical alternatives may require no question. Existing requirements, evidence, and explicit delegation can already settle a choice.
- **Asking does not force formal approval.** Low-risk intent clarification can end with a concise Direct Result. Consequential human judgment requires a reviewed Formal Contract even after the user answers, including acceptance of a single known feasible approach. Risk-triggered review still applies to Direct Results; it must not manufacture a human fork or an unnecessary contract.

The third approved choice preserves the pressure-testing purpose: challenge a premise for concrete goal mismatch, unsupported material assumptions, infeasibility, or a better-supported reduction in scope. Do not add a universal preliminary questionnaire or reopen closed choices for preference alone.

These choices supersede the former high-reversal-cost-only question gate and the rule that every asked decision automatically required a contract. Do not restore either while editing neighboring wording.

Question layout and provenance serve different purposes. Genuine intent/judgment questions and required formal approval requests lead with `Q<N>`, followed directly by necessary background in a blockquote and then any real options. The quote has no context label; its relevant situation, unresolved judgment, and consequences are content needs, not mandatory fields. Open exploration and single-approach acceptability questions are valid; importance does not imply a menu. This supersedes mandatory proposal quotes: source distinctions remain in accurate prose and the private record, while conclusions synthesize the solution rather than replaying the interview.

The conversation retrospective exposed a routing failure, not a need to number every reply: an ordinary conclusion ended in an ambiguous feedback checkpoint, then a formatting correction prompted unnecessary alternatives. Keep the question gate ahead of formatting, and leave explanations, status reports, and completed conclusions unnumbered. Collaborative feedback remains welcome without manufacturing an extra approval gate; this does not waive required review, formal approval, or unresolved material premises.

Formal-contract approval confirms the reviewed conclusion, not permission to implement it. This replaces the former "Approved to implement" approval meaning, which left consequential planning decisions without a completion path when the user withheld implementation authority. Keep the existing consequence gate and independent review; confirmation, implementation authorization, and execution intent can share one explicit reply without becoming synonymous. Earlier explicit authorizations retain their actual scope.

The video-course retrospective exposed incomplete coverage and a premature activity switch: one answer settled the default parsing route, but other recommendations were treated as settled and a later continuation was interpreted as permission to edit. The repair accounts for every recommendation without asking about each one, checks coverage at reply/completion/handoff transitions, and interprets continuation in its current activity. It adds no fixed interview length, magic authorization phrase, or repeated approval gate. Recovery discloses the already changed state before further alignment; later agreement does not rewrite earlier authority.

The follow-up retrospective exposed interrupted next-step guidance: a decision acknowledgment ended without advancing or explaining the wait. The user chose clear next steps at key transitions, not a full remaining-topic inventory. Keep the action and its owner visible at convergence, activity changes, waits, and overall closure, including evidence gathering and review rather than only newly unlocked questions. This does not require per-reply status summaries or alter approval and execution authority.

## Failure Modes and Rationale

- **Over-questioning and silent intent substitution:** use the dual-entry gate, not "ask everything" or "guess anything reversible."
- **Polishing the wrong solution:** distinguish observations, causal explanations, and remedies; test the remedy against the user's practical difficulty. A deeper interpretation requires evidence and user correction, not agent certainty.
- **Proposal monologues and artificial choices:** make the unresolved question visible first, then supply the background needed to answer it. Compare real alternatives, expose a sole approach's consequences, or elicit experience as appropriate.
- **Cheap edits with irreversible effects:** judge data, authority, external commitments, resource use, and strategic consequences; unknown risk remains pending evidence.
- **Premature convergence:** ready questions need settled prerequisites; the necessity of two questions does not make them independent. Pending nodes are legitimate ledger states, not proof of completion.
- **Local completion mistaken for global completion:** a slice returns to the remaining-work loop. Partial execution needs independent, authorized scope and preserves the rest of the alignment.
- **Approval laundering:** conclusion acknowledgment, scoped implementation authorization, and execution intent have different effects. An old plan's execution instruction cannot authorize a materially different plan.
- **Provenance collapse:** neither conclusion confirmation nor implementation authorization changes claim origin. The private ledger retains sources and evidence; natural wording distinguishes confirmed content, new proposals, and material assumptions without imposing source-shaped layout.
- **Reviewer amplification:** scrutiny tests evidence and consequences. Rejected alternatives reopen only for the entrypoint's evidence-based reasons.
- **Thin or repetitive contracts:** preserve the actual problem, selected solution, key reasons, accepted costs, and implementation-critical semantics with their topic. Remove restatement and routine mechanics rather than correctness boundaries.

## Information Ownership

- `SKILL.md` owns shared runtime behavior, including all-path coverage, source separation, risk review, completion, and execution handoff.
- [references/contract.md](references/contract.md) owns only formal-contract composition and approval details. Its conditional read is mandatory on that path; Direct Result review must not depend on loading it.
- Wayfinder owns its ticket-closeout confirmation. Its receipt of a result does not alter this skill's delivery form. Confirmation must bind the conclusion and material premises used to unblock downstream work, including relevant agent inferences without relabeling their source.

Invocation metadata and cross-host triggering are unchanged. This work validates the behavior of an explicitly started skill and its permitted result handoff, not whether every host interprets invocation fields identically.

## Maintenance Checks

When changing the skill, verify that:

- autonomous fact discovery, dual-entry questioning, zero-question cases, ready-frontier dependency handling, and both delivery forms remain available;
- coverage and source/evidence mappings survive partial answers, new evidence, review, approval, and handoff;
- every in-scope recommendation has a supported disposition, and local acceptance does not close unrelated material choices;
- observed high stakes are not erased merely by answering a question, and reviewer unavailability or unresolved correctness findings cannot be presented as successful completion;
- collaborative discussion remains open to feedback, accepts clear closure without a fixed phrase or repeated unchanged confirmations, and preserves separate execution authorization;
- a request for Q-numbered questions does not manufacture a decision; explanation requests receive an explanation, while genuine questions and required approval requests use the question-first layout;
- background supplies enough context to decide without fixed fields or lengths, leading assumptions, duplicated option comparisons, or a required link detour; conclusions without pending decisions or approvals do not create an unspecified feedback checkpoint;
- each discussion question or batch is independently understandable when the user has not read earlier long Agent output, while carrying only the minimum context needed for the current judgment;
- key transitions identify the actual next action and its owner, or a specific blocker and how to clear it, without per-reply status templates or full remaining-topic inventories;
- decision acknowledgment advances available alignment work or makes the waiting input clear; clarification replies retain their explanation-only boundary;
- overall closure distinguishes alignment completion, implementation readiness, and existing execution authority without inventing questions or duplicate approvals;
- a reviewed planning-only contract can be confirmed without implementation authority; bare agreement does not start execution, permission without a start instruction remains permission, and an explicit instruction to implement the reviewed result needs no duplicate confirmation;
- continuation stays within the current activity unless execution is clearly directed, while still-valid authorization supports resuming interrupted implementation;
- missed decisions or premature implementation are disclosed against the actual changed state, without retroactive authorization or unauthorized rollback;
- problem discovery permits open questions and user correction without requiring every discussion to restart from first principles;
- questions precede their unlabelled background quotes, real alternatives have recommendation-first numbered choices and honest costs, and important single-approach questions do not manufacture options;
- conclusions organize the understood problem and resulting solution by topic, distinguish new proposals naturally, and scale down without empty sections or question-by-question replay;
- formal details are discoverable through a mandatory pointer, with shared safety rules still on all execution paths;
- full implementation-critical model shapes and guarantees survive compression, while empty fields and duplicate summaries do not return;
- runtime text stays in English and user-facing text is localized; no repository or external mutation occurs during alignment.

Follow the repository [Skill verification policy](../../AGENTS.md#skill-verification). Use static checks for packaging, links, and document consistency; retrospect on actual user interactions when evidence exists. These checks do not prove reliable model behavior.
