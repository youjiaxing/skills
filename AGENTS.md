# Repository Maintenance

## Skill Verification

Do not create, retain, or run simulated-conversation behavioral tests for skill
prompts. This includes synthetic user/assistant dialogues, scripted role-play,
and model- or mock-driven evaluations of how an agent responds to those dialogues.
Remove existing tests and requirements of this kind when encountered.

Write functional tests only for critical core code: code with irreversible or
externally visible effects, or logic whose failure is easy to miss by hand.
Credentials and secrets, external protocols, persistence and state migration,
deletion or overwrite, outbound sends, and concurrency or retry semantics qualify.
Do not add tests for prompts, copy, YAML/JSON field presence, path joining,
directory layout, one-glance helpers, or display-only output, and remove existing
tests that cover only those cases.

Use static document review, consistency checks, and packaging/link validation for
skill maintenance; retrospectives of actual user interactions remain allowed.
These checks do not establish that a prompt reliably produces the intended agent
behavior.

## Temporary Research

Treat exploratory reports, comparisons, and raw research notes as task-temporary
artifacts. Use `tmp/research/`, not `docs/research/`, for new material; do not build
a permanent research archive in this repository.

Promote durable, verified conclusions and necessary sources or applicability
limits into the relevant skill references or maintained documentation. Once the
owning task no longer needs its temporary research, clean up that task's files.
Preserve other tasks' artifacts; age alone is not authorization to delete them.
