---
name: yjx-save-context
description: Save the context needed to resume the current task after compaction or in a fresh session, preserving alignment, progress, and authorization without advancing the work.
argument-hint: "Optional focus for the next session"
disable-model-invocation: true
---

# Save Context

Write one standalone continuation file, then return its path and a copyable resume prompt. Support both unfinished alignment and completed alignment awaiting implementation. Saving does not confirm a proposal or authorize implementation.

When reviewing or redesigning this skill, read [MAINTENANCE.md](MAINTENANCE.md) first. It is not needed for ordinary execution.

## 1. Capture the current stopping point

Use the available conversation and already-known artifacts. If arguments are supplied, use them to focus the continuation without dropping applicable constraints. Work promptly from existing context; do not restart investigation, interview the user, compile a spec, or split tickets.

Distinguish what the agent proposed, what the user confirmed, and what the user authorized. Preserve unresolved questions as unresolved. If earlier context is missing or already summarized, identify the gap rather than claim full recovery. Recover critical missing details only through a known, narrowly targeted source; do not scan session archives or the codebase wholesale.

## 2. Choose the destination

Resolve the current working directory, not the skill installation directory or an assumed repository root.

- If `<cwd>/tmp/` already exists as a directory, use it.
- Otherwise use the operating system's actual temporary directory. Do not create `<cwd>/tmp/` for this operation or use `.scratch/`.
- If the preferred directory cannot be written, fall back to the system temporary directory and report the fallback. If neither destination is writable, report the failure without claiming a save.

Write `yjx-context-<YYYYMMDD-HHMMSS>-<short-topic>.md`, using a filesystem-safe topic and a collision-safe suffix when needed. Never overwrite an existing file. Resolve and return the absolute path, particularly for files outside the workspace.

## 3. Write sufficient continuation context

Use the user's conversational language and the task's natural terminology. Let the source material determine the organization: neither the alignment nor the continuation file has a required outline, section count, or schema. Do not add empty sections.

Preserve complete substantive alignment content and its existing structure, including exact wording where decisions, limits, interfaces, examples, or acceptance conditions depend on it. Do not assume the last assistant reply contains all agreements. Carry forward relevant earlier answers and later user corrections, making clear which decisions they supersede. Prefer direct extraction of available source text over regenerating it when feasible; claim verbatim preservation only if checked against that source.

Add whatever a fresh agent needs to understand and continue that content. The following are coverage checks, not document headings:

- The goal, scope, applicable constraints, and current phase.
- Confirmed decisions and their material rationale, rejected alternatives that must not be reopened without cause, verified facts, and separately identified assumptions or proposals.
- The exact stopping point: outstanding questions, answers already given, remaining evidence needs, and the next permitted action. In unfinished alignment, preserve the active question and live alternatives rather than inventing a final answer.
- Relevant working directory, repository or module locations, document and skill entry points, existing edits, verification outcomes, blockers, and external dependencies. Include these only when they affect continuation; record checks as observed results, not guarantees of current state.
- Any running work that affects continuation, its last known status, and how to inspect its outcome. A new session must not assume old process handles or background jobs survive, or repeat side effects merely because their outcome is unknown.

The file must not require the old session to remain open or its transcript to remain accessible. Put indispensable conversation-only facts, tool-result conclusions, and relevant attachment or screenshot content into the file, not merely attachment names. For bulky evidence, preserve the necessary excerpt or save a standalone supporting artifact beside the continuation file using the same collision protection; a session-only reference is not sufficient. Stable workspace artifacts may be referenced instead of duplicated: identify their purpose and give an absolute path or explicitly state the base for relative paths. Check required local references exist and are accessible independently of the old session; name inaccessible or unverified evidence as a limitation rather than expanding into new investigation. Redact secrets and unnecessary personal data; point to an approved credential source rather than copying credentials.

Tell the successor to read the entire continuation file and its required artifact references, apply the destination workspace's current rules, and recheck mutable state before acting. Preserve the recorded phase and authorization: continue open alignment where it stopped; implement a completed alignment only when implementation was explicitly authorized. Report material contradictions rather than silently redesigning agreed choices. Optional suggested skills are references, not new execution mandates.

## 4. Verify, return, and stop

Read back the written file in full, using bounded chunks if needed. Check that substantive alignment, corrections, pending questions, authorization, and necessary source context survived. Repair omissions before returning. Do not claim byte-for-byte fidelity from a semantic review alone.

The completion test is: can an agent that never saw this conversation use this file and its identified independent artifacts to know what is settled, what remains open, where work stopped, and what it may do next? Disclose any remaining gap that prevents this.

Return the actual saved path, any material limitations, and a short copyable prompt that names the file and original working directory. The prompt should request a complete read and continuation from the recorded stopping point within the existing authorization; it must not unconditionally say to implement. It should work after compaction or in a fresh session without referring to “the discussion above.”

Stop after saving and reporting. Do not compact, clear or close the session, launch a successor, commit files, or continue the task. A skill cannot prevent host auto-compaction; if context was lost during saving, report that limitation. Temporary files can be cleaned by the OS or user, so do not present this file as permanent project documentation.
