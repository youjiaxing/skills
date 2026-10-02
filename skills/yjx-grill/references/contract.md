# Formal Contract

Read this file in full when a slice requires a Formal Contract, before drafting, reviewing, or requesting approval. The entrypoint owns the question gate, coverage, shared presentation, risk review, completion, and authorization rules; this reference adds only formal-contract requirements.

## Assemble the Candidate

After convergence, assemble one candidate for the current slice using the entrypoint's result synthesis and Presentation Density. Connect the solution to the understood problem and intended outcome. Keep each change's observable behavior, implementation-critical consequences, and independently useful acceptance results together under a topic named for the actual change. State agreed content naturally and identify new unconfirmed proposals or material assumptions without requiring proposal blockquotes.

Give each semantic claim one primary home. Include only changes introduced by this alignment as proposed changes. Supporting facts are context, not commitments. Include preserved constraints only when omission creates material implementation risk. Keep key reasons and accepted costs with the decision they explain; retain the full alternative comparison in the discussion and reviewer record rather than repeating it as a second summary.

Preserve the owner, source of truth, identities, interfaces/data shapes, lifecycle and state transitions, compatibility/migration, concurrency and failure guarantees, and strategic boundaries when they cannot be safely derived from observable behavior. When an entity, schema, enum, field, interface, or state machine is part of the decision, keep its shape concrete and copyable.

Add acceptance conditions only when they introduce independently observable consequences, not paraphrases. Use a verification table only when it compresses at least three branching scenarios; do not repeat its rows in nearby prose. Diagrams or alternate forms earn their place only by adding a distinct boundary or observable consequence.

Exclude routine mechanics, unaffected call-site inventories, local test filenames, shell commands, PR plans, and syntax-level advice unless the user's decision directly concerns them. Brevity must not remove implementation-critical meaning.

## Review Before Approval

Apply the entrypoint's independent-review protocol to this candidate and the complete decision record. Check that every material implementation-affecting claim remains traceable, that each changed guarantee has a supported basis, and that no inference has been presented as the user's requirement or decision.

Keep the candidate out of the approval step until it has no unresolved substantiated findings. Review may identify another consequential question; return to that frontier, then update and re-review the material revision. A preference for a rejected design is insufficient to reopen it.

## Present and Confirm

Present the reviewed contract once, organized by the resulting solution rather than question order, with provenance clear in the wording. Name this contract or its concrete scope before asking for approval. Other aligned results shown as background retain their own approval status and stay outside this request; grouping creates neither new approval units nor cross-contract authorization.

Use the entrypoint's question-first layout for this required approval request. Ask for confirmation with exactly these meanings, localized:

1. Approve this conclusion.
2. Items need adjustment.

The first confirms this reviewed conclusion and its boundaries, including for planning-only work; it does not itself authorize implementation. Apply the entrypoint's authorization rules when the same reply also authorizes implementation or directs execution, without requiring separate turns. A reply with a material condition or change returns to alignment and required re-review before renewed approval; an old candidate's approval cannot approve new content.

After approval, return to the entrypoint's slice-completion loop rather than ending a multi-slice request prematurely. If a still-valid execution instruction covers this scope, hand off without asking the user to repeat it, subject to remaining dependencies and the execution boundary.
