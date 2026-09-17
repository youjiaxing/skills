# yjx-save-context Maintenance Notes

Read when reviewing or changing this skill, not during ordinary execution.

## Purpose and design decisions

The user needs room to continue work, not another specification workflow. A long alignment may be ready for implementation, or the conversation may still be resolving a decision when the context window runs low. Both need the same operation: persist enough context for an independent successor without changing the task's phase.

- **Continuation rather than last-reply export:** important answers, corrections, evidence, and permissions may precede or follow the latest consolidated response. Copying that response alone can lose them.
- **Natural document structure:** alignment can be prose, diagrams, tables, examples, or dialogue. Coverage requirements belong in the skill; a mandatory output template would distort the source and add ceremony.
- **Temporary storage:** prefer an existing working-directory `tmp/`, otherwise the OS temporary directory. Creating workspace directories, publishing specs, and updating trackers are outside this operation.
- **Independent of the old session:** stable project artifacts remain useful references, but conversation-only facts and essential session-local evidence must travel with the file. An archive path is not a substitute for necessary content.
- **No phase transition:** an agent's proposal, user confirmation, and implementation authorization are distinct. Saving or resuming grants none of them.
- **Prompt-only and manually invoked:** use existing file tools and available export capabilities. No fixed harness, transcript format, upstream alignment skill, downstream implementation skill, or plan mode is required. Do not add an automatic compaction watcher as part of this skill.

## Review scenarios

Use these cases to check changes; they are not a runtime questionnaire or output template.

| Situation | Expected result |
| --- | --- |
| Completed alignment contains tables and a diagram; the user authorized implementation | Preserve the substantive content and organization, include necessary earlier constraints, and allow the successor to implement under current workspace rules. |
| A full proposal exists, but the user has not confirmed it or authorized implementation | Preserve it as a proposal and record the pending confirmation; saving does not approve it. |
| Alignment stops at an unanswered question just before auto-compaction | Capture the active question, earlier answers, live alternatives, and evidence limits; resume alignment rather than implementation. |
| A later user correction contradicts an earlier consolidated answer | Keep the correction and identify the superseded decision; do not present both as active agreements. |
| Existing working-directory `tmp/`; no `tmp/`; `tmp` is a file; destination is unwritable; filename collides | Choose the destination by the runtime rules without creating workspace `tmp/` or overwriting previous saves, and disclose fallback or failure. |
| A critical fact exists only in a tool result, image, or old session log | Include the necessary fact or excerpt, or preserve an independent supporting artifact; disclose anything that cannot be recovered. |
| A background command has an uncertain outcome | Preserve that uncertainty and inspection information; do not claim completion or authorize a duplicate side effect. |
| The host compacts before saving finishes | Use available evidence and report gaps; never promise interception or lossless recovery. |

Repository unit tests can verify skill discovery and placement, but cannot prove semantic completeness or model behavior. Review saved outputs against the supplied source when exercising this skill.
