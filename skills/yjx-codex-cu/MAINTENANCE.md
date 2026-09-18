# yjx-codex-cu Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-codex-cu`. It records design intent and anti-drift checks; normal skill execution should stay in `SKILL.md` and the runner's `--help` output.

## 1. Identity and purpose

`yjx-codex-cu` is a user-invoked, host-agnostic delegation skill. It lets an agent that has terminal access delegate necessary real-GUI verification to Codex CLI Computer Use while retaining implementation and bug-fix ownership in the invoking agent.

It must work from Grok Build, Claude Code, and other Agent Skills hosts. Host-specific background-task or MCP APIs are outside its contract.

## 2. Design rationale

### Manual capability grant

Computer Use can take over the foreground desktop. The skill therefore remains user-invoked. Invocation grants permission for the current task but does not force immediate delegation; the host first uses its own adequate verification capabilities.

### Official CLI boundary

The runner uses `codex exec --json`. The former `codex mcp-server` command was removed from Codex CLI and is not a supported fallback. The runner consumes Codex's public non-interactive event stream and treats rollout files only as optional evidence for recorded model settings.

### One complete testing turn

The host sends an outcome-oriented brief once. Codex controls the internal preparation and GUI path. Implementation and fixes return to the host, preventing the tester from becoming a second development owner.

### Confined tester

Codex CLI advertises host skills (`~/.agents/skills`, `~/.codex/skills`) in the tester's context, and `disable-model-invocation: true` does not stop a direct file read. On 2026-09-18 a session read this skill and its runner source, then spent 19 of its 91 tool calls mapping the invoking agent's process tree, temp files, and event logs before starting the GUI work. It did not recurse, but it had learned how.

`buildPrompt` therefore states the delegated-tester role, its responsibility boundary, and only this skill and runner as off-limits, plus nested Codex and Computer Use sessions. It deliberately does not remove other skills, plugins, or rules files: a blanket capability ban would block legitimate work, and the observed failure is about this skill and off-task investigation. This is a prompt-level guard, not a sandbox.

### Build identity

A debug build and an installed release build of the same product share a display name. On 2026-09-18 a tester launched a dev-mode build, then resolved the window by the product's display name; the harness attached to the installed release copy instead — the build *without* the change under test — and the run reported a confident `FAIL` against the wrong artifact. The notice therefore requires attaching to the copy named in the task, forbids driving any other copy of the same product, and makes an unconfirmable identity a `BLOCKED` result. The brief must name the artifact and a signal that identifies it.

### Deterministic policy and evidence

The Node.js runner is the single source of truth for defaults, override behavior, Codex arguments, and result classification. `SKILL.md` tells the agent when and how to use it without duplicating those volatile details.

Computer Use tool names may evolve. Evidence detection recognizes semantic metadata and known tool surfaces, while failing closed when it cannot establish that GUI control actually occurred.

## 3. Anti-drift checks

Before changing this skill, verify that:

- [ ] `disable-model-invocation: true` remains present.
- [ ] The workflow is host-agnostic and names no required Grok, Claude, or MCP API.
- [ ] The host delegates only a remaining real-GUI gap, not routine terminal verification.
- [ ] One GUI acceptance task maps to one `codex exec` session.
- [ ] The test brief stays outcome-oriented rather than prescribing ordinary clicks.
- [ ] `buildPrompt` states what the delegated tester owns and does not own, names `yjx-codex-cu` and its runner as off-limits, and forbids nested Codex or Computer Use sessions, without banning other skills.
- [ ] `buildPrompt` requires attaching to the copy named in the task and returns `BLOCKED` when build identity cannot be confirmed.
- [ ] Product implementation and bug fixes remain with the invoking agent.
- [ ] Model overrides disable Fast unless the user explicitly re-enables it.
- [ ] Reasoning-only overrides preserve the default Fast policy.
- [ ] `PASS` requires both Codex completion and successful Computer Use evidence.
- [ ] Requested configuration and independently recorded configuration remain distinct in the report.
- [ ] The runner uses only Node.js standard-library modules and resolves `CODEX_HOME` portably.
- [ ] Temporary run artifacts stay outside the tested repository.
- [ ] Unit tests cover defaults, overrides, event evidence, classification, and rollout parsing.
- [ ] A non-destructive real-GUI smoke test passes before claiming compatibility with a new Codex CLI release.
