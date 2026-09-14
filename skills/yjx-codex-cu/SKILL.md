---
name: yjx-codex-cu
description: Grant this task permission to delegate necessary real-GUI verification to Codex CLI Computer Use while keeping implementation and fixes in the current agent.
argument-hint: "[--model <id>] [--reasoning <effort>] [--fast on|off]"
disable-model-invocation: true
---

# Codex Computer Use Delegation

## Maintenance

Before reviewing, modifying, or redesigning this skill, read [MAINTENANCE.md](MAINTENANCE.md). It is not needed during normal execution.

## Permission boundary

Invocation grants permission for the current task to use Codex Computer Use if real-GUI verification becomes necessary. It does not trigger an immediate test, and the permission expires with the task.

Keep implementation and fixes in the current agent. Codex is the GUI tester: it may prepare, build, and launch the application, then operate the interface and report evidence, but it does not modify product code.

## Workflow

1. Complete the implementation and every meaningful verification available without delegating GUI control.
2. Decide whether the remaining claim requires interaction with a real GUI. If the current agent can perform equivalent real-GUI verification directly, use that capability. If no GUI gap remains, finish without starting Codex.
3. Build one outcome-oriented test brief containing:
   - the user-visible behavior to verify;
   - only the implementation context needed to understand that behavior;
   - any required application, device, account, or platform boundary;
   - the expected result and useful failure evidence.
4. Keep the brief flexible. Codex chooses how to prepare, build, launch, navigate, and recover from ordinary UI mistakes. Do not turn the brief into a click-by-click script.
5. Resolve `scripts/run-codex-cu.mjs` relative to this `SKILL.md`; never assume a particular global skill directory. Pass the brief on standard input and run the script from the project being tested. Use invocation arguments only for explicit model, reasoning, or Fast overrides.
6. Treat the runner as one long-lived task. Wait for its terminal result instead of splitting one GUI test across multiple Codex sessions.
7. Read the runner's JSON summary. A GUI claim is verified only when the summary reports `PASS` and contains Computer Use evidence. Continue implementation or bug fixing in the current agent after `FAIL`; explain the environmental blocker after `BLOCKED`.
8. If a fix requires another GUI check, launch a new complete test brief after the fix rather than resuming the tester step by step.

## Runner interface

```text
Usage: node run-codex-cu.mjs [options]

The complete GUI test brief is read from standard input.
```

Use `node <skill-dir>/scripts/run-codex-cu.mjs --help` for the current options and defaults. The runner owns model/Fast policy, Codex CLI arguments, temporary event storage, and evidence parsing.

## Final report

Report all of the following in the current agent's reply:

- `PASS`, `FAIL`, or `BLOCKED`;
- the Codex session ID and a copyable `codex resume <session-id>` command;
- requested and recorded model/reasoning values;
- whether Fast was requested, disabled, or independently confirmed;
- the GUI path Codex actually exercised;
- relevant result details, failures, or blockers;
- the implementation or fix that remains with the current agent.

State missing evidence literally. A requested Fast setting is not proof that the service applied Fast.
