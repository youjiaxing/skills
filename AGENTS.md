# Repository Maintenance

## Project-Local Skills

Repository-only maintenance skills live in `.agents/skills/`; `.claude/skills/`
may link to the same sources. They are separate from the public `skills/` tree.
For a manually requested upstream change review, use the installed
`yjx-upstream-review` entrypoint through the host's skill discovery mechanism.
This pointer does not schedule or automatically invoke the review.

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
When changes touch only Markdown, prompt, or maintenance documents without
modifying executable scripts or link/mount logic, run only static checks on the
changed documents (such as `git diff --check`, link/anchor, and frontmatter
checks) rather than the full `npm test` suite; when script changes require tests,
run `node --test <target-test-file>` for the affected module first.

## Subagent Context Isolation in Skills

When creating or maintaining any skill in this repository that launches or
delegates to a subagent, explicitly include the instruction:
`Start every subagent with a fresh context window (do not fork the current conversation).`
at the subagent dispatch site so subagents never inherit the primary session
context by default.

## Cross-Skill Invocation

Refer to another skill by its registered name and locate its installed entrypoint
through the host's skill discovery mechanism. Resolve that skill's scripts and
references from the returned installation location; do not assume sibling skill
directories or machine-specific paths. Relative references within the same skill
package remain valid. If a required skill is unavailable, report the missing
dependency rather than guessing its path or copying its workflow.

## Model Image Inputs

When adding or changing a skill that asks a model to inspect images, screenshots
or video frames, allow simple, one-off reading directly through the host's visual
capability. Choose isolation when expected visual-context accumulation and repeated
inspection justify a separate call's fixed overhead, or when isolation is explicitly
required. Judge the task as a whole, not a fixed image-count threshold. Direct reading
does not require loading the image skill or running its preparation/dispatch flow.
For the isolated branch, invoke the installed `yjx-image-reading` skill by name and
declare that dependency at the read site; reuse its input preparation and read-only
observation rather than duplicating compression or dispatch rules.

Keep source acquisition, action authority, necessary evidence coverage and
task-specific state checks with the calling skill on both paths. Reassess later
images if a one-off task becomes sustained visual work; images already received
by the primary remain in its context. Document host limitations and do not claim
isolation when tools automatically return images. Report a blocker when required
isolation is unavailable. Forwarding an image without model inspection does not
require a visual task. Static checks alone do not establish runtime isolation or
cost savings; retain actual-path verification requirements and unverified status.

## Temporary Research

Treat exploratory reports, comparisons, and raw research notes as task-temporary
artifacts. Use `tmp/research/`, not `docs/research/`, for new material; do not build
a permanent research archive in this repository.

Promote durable, verified conclusions and necessary sources or applicability
limits into the relevant skill references or maintained documentation. Once the
owning task no longer needs its temporary research, clean up that task's files.
Preserve other tasks' artifacts; age alone is not authorization to delete them.
