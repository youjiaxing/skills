# Repository Maintenance

## Skill Verification

Do not create, retain, or run simulated-conversation behavioral tests for skill
prompts. This includes synthetic user/assistant dialogues, scripted role-play,
and model- or mock-driven evaluations of how an agent responds to those dialogues.
Remove existing tests and requirements of this kind when encountered.

Use static document review, consistency checks, and packaging/link validation for
skill maintenance. Functional tests for executable scripts remain allowed, as do
retrospectives of actual user interactions. These checks do not establish that a
prompt reliably produces the intended agent behavior.

## Temporary Research

Treat exploratory reports, comparisons, and raw research notes as task-temporary
artifacts. Use `tmp/research/`, not `docs/research/`, for new material; do not build
a permanent research archive in this repository.

Promote durable, verified conclusions and necessary sources or applicability
limits into the relevant skill references or maintained documentation. Once the
owning task no longer needs its temporary research, clean up that task's files.
Preserve other tasks' artifacts; age alone is not authorization to delete them.
