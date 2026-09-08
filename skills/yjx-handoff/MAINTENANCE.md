# yjx-handoff Maintenance Metadata

Read this file before reviewing, modifying, or redesigning `yjx-handoff`. It records the skill's design intent and anti-drift rules. It is not needed for ordinary `/yjx-handoff` execution.

## Identity

`yjx-handoff` is the Grok Build launch surface for the same handoff writing as `claude-handoff` / `handoff`. The summary content is unchanged. Only the way a successor is started differs.

`claude-handoff` launches `claude --bg --name "<name>" "<summary>"` and returns immediately. Grok Build (as of this writing) has no equivalent: no `--bg` live agent, no launch-time `--name`, no cross-process attach to a still-running TUI. Headless `grok -p` is a single user turn that cannot stop on permission or question cards.

The current skill therefore **degrades**: write the summary to `tmp/`, print copyable **interactive** launch texts, and let the user start the TUI. That degradation is a capability gap, not the desired end state.

## Upgrade when Grok catches up

Revisit this skill when Grok gains any first-class capability that restores `claude-handoff`'s launch shape:

- Start a still-living, interactive successor from the current session (equivalent to `claude --bg`), or attach across processes to that session
- A launch-time display name (equivalent to `--name`)
- Any other official start/manage surface that lets the successor begin at handoff time and still pause on permissions and questions

When that happens, prefer the official CLI/TUI over stacking window-spawn hacks, headless `-p`, or custom launch scripts. Until then, keep the degraded path in `SKILL.md`.

Do not freeze the degraded path as architecture.

## Anti-drift

Before changing this skill, verify that the change:

- keeps handoff **writing** identical to `claude-handoff` / `handoff` (suggested skills, reference existing artifacts, redact, tailor to arguments; no mandated outline)
- keeps Grok-specific launch protocol out of the handoff **file** (it belongs in the printed launch texts)
- starts the successor as an **interactive** TUI (`grok "<prompt>"`), never headless `-p` / `--prompt-file` / `--prompt-json`
- does not add `--cwd` to the launch command
- does not treat auto-spawning a Grok process, a new terminal, or a fake `--bg` as the current success criterion
- does not edit `.gitignore` or delete the handoff file before the user can launch
- stays user-invoked (`disable-model-invocation: true`)
- stays Grok-only for v1 (no provider switch)
- treats the `tmp/` + copyable-text path as reversible degradation, and upgrades it when the triggers above appear
