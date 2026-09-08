---
name: yjx-handoff
description: Hand the current conversation off to a fresh interactive Grok Build session via a handoff file and copyable launch texts.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff summary of the current conversation so a fresh agent can continue the work. Save it under `tmp/` in the current working directory, then print copyable launch texts for an **interactive** Grok Build TUI. Do not start Grok yourself.

This is `claude-handoff` with a Grok launch surface. Grok has no `claude --bg --name` equivalent, so the successor starts only when the user runs the printed command (or pastes the short prompt into a new TUI).

When reviewing or redesigning this skill, read [`MAINTENANCE.md`](MAINTENANCE.md) first. It is not needed for ordinary `/yjx-handoff` execution.

## Handoff file

Create `tmp/` if it is missing. Write:

`tmp/yjx-handoff-<YYYYMMDD-HHMMSS>-<slug>.md`

`<slug>` is a short filesystem-safe token from the user's arguments, or from a title inferred from the conversation if they passed none.

The file body follows the same rules as `claude-handoff` / `handoff`. Do not impose a section template, and do not put Grok launch instructions (`/rename`, cwd, how to start the TUI) in the file:

- Summarize so a fresh agent can continue the work.
- Include a "suggested skills" section, naming which skills the next agent should call the Skill tool for.
- Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.
- Redact secrets: API keys, passwords, personally identifiable information.
- If the user passed arguments, treat them as a description of what the next session will focus on and tailor the summary accordingly.

## Launch texts

After the file is written, print two copyable blocks in the user's conversational language. On Windows, also print a PowerShell-equivalent command when quoting would differ.

1. Launch command (positional prompt — never `-p`, `--single`, `--prompt-file`, or `--prompt-json`; never `--cwd`):

```bash
grok "Read tmp/<filename> and continue the work. Follow every instruction in that file. Then /rename <display name>."
```

2. Short prompt — the same quoted string, for pasting into an already-open new Grok TUI.

State once: run the command from the current project directory.

`<display name>` is a short descriptive title (from the user's arguments when present, otherwise inferred), the stand-in for Claude's `--name`.

## Done

Stop. Do not continue the handed-off work. Do not exec `grok`.
