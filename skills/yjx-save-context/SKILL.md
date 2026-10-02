---
name: yjx-save-context
description: Save the context needed to resume the current task after compaction or in a fresh session, preserving alignment, progress, and authorization without advancing the work.
argument-hint: "Optional focus for the next session"
disable-model-invocation: true
---

# Save Context

Write one standalone continuation file, then return its path and a copyable resume prompt. Saving preserves the current phase and existing authorization; it neither grants nor revokes permission.

When reviewing or redesigning this skill, read [MAINTENANCE.md](MAINTENANCE.md) first. It is not needed for ordinary execution.

## 1. Establish continuation control

Use the user's conversational language and the task's natural terminology. Use the available conversation and already-known artifacts. Arguments focus the continuation without dropping applicable constraints. Work from existing context; recover a critical gap only through a known, narrowly targeted source.

Place one localized control block at the start of the file:

```markdown
## <Continuation control>

- **<Current phase>**: <where the task stopped>
- **<Authorization>**: <permitted actions, applicable prohibitions, and prerequisites>
- **<Active item>**: <open question or unresolved work; omit when none>
- **<Next permitted action>**: <the first action allowed after resuming>
```

Distinguish proposals, user-confirmed decisions, and authorized actions. The control block is the single semantic home for phase, authorization, active work, and the next permitted action; later sections point to it instead of restating it. When carried source text contains old control information that could be mistaken for current state, mark it as historical or explicitly superseded by the control block. Normalize only the continuation's presentation, preserving the substantive agreement and original artifacts.

## 2. Preserve the minimum sufficient continuation

Check sufficiency before pruning. Cover the task's goal, scope, constraints, and critical acceptance conditions; distinguish decisions, completed work, verified results, and unknown outcomes, including gaps that affect continuation; preserve the action boundaries in the control block. These are internal coverage checks, satisfied by carried content or triggered references, not required output sections. Record only states supported by existing evidence: execution is not verification, and saving does not call for new task verification.

Select the current authoritative source before writing:

1. Use a current, user-confirmed stable artifact when one exists.
2. Otherwise use the latest consolidated conversation content that later messages have not superseded.
3. Otherwise reconstruct the active state from confirmed decisions and corrections, and disclose any gap.

Choose one representation: reference a stable independently accessible source without reproducing its contents, or carry conversation-only authoritative content into the file. Then add only later corrections, authorization, unresolved work, and continuation-critical facts absent from that source. Preserve exact wording when an interface, example, state transition, limit, or acceptance condition depends on it. Keep carried content's natural organization after the control block and omit empty sections.

For consequential human decisions, retain a compact decision ledger:

- the selected decision;
- the names of closed alternatives;
- the decisive reason they were closed;
- the condition that would justify reopening them, when one exists.

Leave full question cards, repeated comparisons, and superseded intermediate reasoning out of the file. A closed alternative remains closed until its reopening condition or material new evidence appears.

## 3. Carry only actionable context

Include evidence when it supports an active decision, constrains unresolved work, determines acceptance, avoids repeating costly investigation, or cannot be recovered from a stable artifact. Give quantitative conclusions the minimum source or counting rule needed for independent review. When a stable artifact owns the evidence, record the relevant conclusion and purpose with its reference.

Give each artifact or skill reference a purpose and a loading trigger, retaining established later-stage dependencies. Require immediate reading only for the current permitted action; listing a skill does not authorize its execution. Declare the workspace root once and use relative paths within it; use absolute paths for external artifacts.

For critical references, retain any already-known version cue as a lightweight change signal, not a prerequisite or separate verification workflow. On a mismatch, the agent uses known sources to resolve it and correct only continuation references or understanding, not project artifacts or confirmed decisions. Leave unsupported conclusions unknown rather than offloading routine checks to the user.

Record mutable state as a timestamped observation that must be rechecked before action. For live work, preserve its last known status and a usable inspection method. For cancelled or unreachable work with no result, preserve the outcome and its consequence without dead process handles, task IDs, or other unusable identifiers.

Include a short successor instruction to apply the destination workspace's current rules, recheck mutable state, and report material contradictions before revising user-confirmed decisions.

Conversation-only facts needed for continuation must travel in the file. State any inaccessible or unverified source as a limitation. Redact secrets and unnecessary personal data.

## 4. Save outside the workspace

Use the operating system's actual temporary directory. Do not create or select a workspace temporary directory. Write `yjx-context-<YYYYMMDD-HHMMSS>-<short-topic>.md`, using a filesystem-safe topic and a collision-safe suffix when needed. Never overwrite an existing file. If the operating system directory cannot be resolved or written, report the failure without returning a saved path or falling back to the workspace.

Identify the original working directory in the file. State that the continuation file is temporary, is not project documentation, and may be removed by the operating system or user. Return its resolved absolute path.

## 5. Read back, prune, and return

Read the saved file in full, using bounded chunks when needed. Repair coverage gaps before pruning repetition, and verify:

1. A fresh agent can identify what is settled, closed, open, authorized, and permitted next.
2. Stable sources are referenced rather than recopied; conversation-only authoritative content appears once, and the control block is the only complete statement of live phase and authorization.
3. Closed alternatives have enough closure context to prevent routine reopening.
4. The workspace root is absolute; every reference has a purpose and loading trigger, and every required local reference is independently accessible.
5. Every included fact or status can affect continuation; mutable observations are dated, quantitative facts are reviewable, and dead identifiers are absent.
6. The successor instruction covers current workspace rules, mutable-state rechecks, and material contradictions.
7. The saved file exists at the reported path and works without the old session or transcript.

Report any remaining gap. Return the saved path, material limitations, and a short copyable prompt naming the file and original working directory. The prompt asks the successor to read the file completely and continue from its control block within the recorded authorization.

Stop after saving and reporting. Leave compaction, session control, implementation, commits, and successor launch to the user or host.
