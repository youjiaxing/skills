# yjx-grill Maintenance Metadata

Read before reviewing, modifying, or redesigning this skill, not during ordinary execution. This file records why the boundaries exist; `SKILL.md` is the runtime authority.

## Purpose and Decisions

The skill replaces exhaustive interviewing with evidence-backed problem discovery and alignment, without replacing human intent with agent convenience. A stated solution can address a symptom rather than the actual difficulty; the agent helps uncover the desired outcome through concrete experience, while keeping its interpretation tentative and correctable. It is domain-neutral: requirements, technical designs, organizational plans, and other complex decisions can use the same loop.

The approved optimization deliberately changes two earlier principles:

- **Intent and consequence are separate reasons to ask.** Reversal cost does not determine who owns the desired outcome. A cheap change may express the user's core intention, while several technical alternatives may require no question. Existing requirements, evidence, and explicit delegation can already settle a choice.
- **Asking does not force formal approval.** Low-risk intent clarification can end with a concise Direct Result. Consequential human judgment requires a reviewed Formal Contract even after the user answers, including acceptance of a single known feasible approach. Risk-triggered review still applies to Direct Results; it must not manufacture a human fork or an unnecessary contract.

The third approved choice preserves the pressure-testing purpose: challenge a premise for concrete goal mismatch, unsupported material assumptions, infeasibility, or a better-supported reduction in scope. Do not add a universal preliminary questionnaire or reopen closed choices for preference alone.

These choices supersede the former high-reversal-cost-only question gate and the rule that every asked decision automatically required a contract. Do not restore either while editing neighboring wording.

Question layout and provenance serve different purposes. Genuine intent/judgment questions and required formal approval requests lead with `Q<N>`, followed directly by necessary background in a blockquote and then any real options. The quote has no context label; its relevant situation, unresolved judgment, and consequences are content needs, not mandatory fields. Open exploration and single-approach acceptability questions are valid; importance does not imply a menu. This supersedes mandatory proposal quotes: source distinctions remain in accurate prose and the private record, while conclusions synthesize the solution rather than replaying the interview.

The conversation retrospective exposed a routing failure, not a need to number every reply: an ordinary conclusion ended in an ambiguous feedback checkpoint, then a formatting correction prompted unnecessary alternatives. Keep the question gate ahead of formatting, and leave explanations, status reports, and completed conclusions unnumbered. Collaborative feedback remains welcome without manufacturing an extra approval gate; this does not waive required review, formal approval, or unresolved material premises.

Mid-discussion agreement on a proposal only settles that decision branch and never starts implementation. At the final reviewed Formal Contract confirmation step, however, forcing a two-option ('Approve conclusion only' vs. 'Adjust') menu created an artificial extra turn when the user wanted to approve and immediately execute by selecting 1. The confirmation step therefore offers three explicit choices ('Approve and start implementation', 'Approve conclusion only, do not implement yet', and 'Items need adjustment'), ordering the recommendation by session context so both direct implementation and planning-only workflows complete in one step without conflating mid-discussion agreement with execution authority. Likewise, when a Direct Result has finished all in-scope alignment and required review and can be implemented in the current session but still lacks an explicit execution instruction (and the user did not ask for planning-only), ending with two brief execution-intent options ('Implement now (recommended)' vs. 'Keep aligned conclusion only') avoids a separate 'start implementation' turn without turning the Direct Result into a Formal Contract.

Review uses a context-isolated Reviewer subagent via the host's native subagent mechanism when available (Start every subagent with a fresh context window (do not fork the current conversation).), without hardcoding host-specific parameter names in the skill requirement or faking subagents through external CLI processes. When the host has no subagent tool or subagent invocation fails, the current session performs the same standard review against the original goal, verified facts, candidate result, and coverage record and discloses that fallback when presenting the result or requesting approval. Targeted follow-up after material revisions can resume the same Reviewer subagent or re-run current-session review; only unresolved substantiated correctness findings block delivery.

The video-course retrospective exposed incomplete coverage and a premature activity switch: one answer settled the default parsing route, but other recommendations were treated as settled and a later continuation was interpreted as permission to edit. The repair accounts for every recommendation without asking about each one, checks coverage at reply/completion/handoff transitions, and interprets continuation in its current activity. It adds no fixed interview length, magic authorization phrase, or repeated approval gate. Recovery discloses the already changed state before further alignment; later agreement does not rewrite earlier authority.

The follow-up retrospective exposed interrupted next-step guidance: a decision acknowledgment ended without advancing or explaining the wait. The user chose clear next steps at key transitions, not a full remaining-topic inventory. Keep the action and its owner visible at convergence, activity changes, waits, and overall closure, including evidence gathering and review rather than only newly unlocked questions. This does not require per-reply status summaries or alter approval and execution authority.

The travel-guide session exposed a second routing failure after alignment: the user asked for a real, usable guide and explicitly directed continued delivery, but repeated clarification checkpoints replaced handoff to completed work. Section 8 now requires a directed implementation request to move into the execution workflow, where the deliverable and its verification are completed. This preserves the alignment-only boundary while preventing clarification from substituting for authorized execution; new intent, consequential judgment, review, and permissions still use their existing gates.

## Project Participation and Optional GRILL.md

Different projects reserve different design decisions for the human. A project may delegate ordinary implementation details while another reserves detailed protocol or domain decisions. Requiring the user to restate these boundaries on every invocation creates avoidable work; calling a decision an internal or reversible detail must not erase an explicit participation requirement. This is a locally aligned extension, not a claim that the upstream `grilling` already supports this file or that the cause of an unavailable historical session has been proven.

`SKILL.md` section 1 owns discovery, loading and reminders. One optional `GRILL.md` belongs at the actual project root; starting in a subdirectory still reaches that file. Non-repository work uses its established project directory. No directory-layer merge, new configuration system or cross-project policy inheritance is introduced. Missing and unreadable are different outcomes: absence permits normal alignment, while an existing unreadable file requires an honest limitation and no inferred increase in agent discretion.

The file contains durable participation boundaries, areas explicitly delegated to the agent, and pointers to existing design references. It need not follow a fixed template and should not duplicate complete protocols or model definitions. It complements general project governance. Stable conventions can be suggested for persistence at natural milestones; absence alone is not a reminder trigger. One-task choices remain task-local, and creating or editing project files needs its own authorization rather than happening as a side effect of alignment.

Section 2 owns the brief, correctable overview and continuing discovery. It is navigation, not a scope-signoff gate. Section 3 adds explicit reserved decisions to the question gate without forcing every such question into a Formal Contract; the existing consequence/approval criteria still choose the delivery form. Sections 4 and 6 account for applicable reserved decisions using the existing coverage/provenance record. Confirmation and delegation retain real scope and source, so neither broad assent nor a shallow-participation default becomes permanent blanket authority. Section 8 owns handoff for both delivery forms; the contract reference adds its composition needs without redefining the shared protocol.

Static review should establish that:

- a root file is read when present even from a subdirectory; absence neither blocks work nor triggers repetitive setup prompts;
- an unreadable file, ambiguous project root or unresolved governance conflict is not silently converted into implementation discretion;
- actual task impact determines which participation categories apply; the user need not supply an exhaustive checklist or review every unrelated field;
- a brief overview goes straight into ready discussion, with later discoveries incorporated and no new scope-signoff checkpoint;
- reserved decisions have an evidenced disposition before closure, even on the Direct Result path, without automatically creating a Formal Contract;
- confirmed or delegated choices are reused only within their supported scope; remaining reserved decisions are visible before the affected implementation;
- reminders are conditional, brief and nonblocking; no project governance document (`GRILL.md`, `AGENTS.md`, etc.) is created, migrated or edited during alignment without separate authority, while user-designated persistent conclusion carriers (such as Yuque design/API docs or `.proto` contracts) are updated synchronously before slice switches when their conclusions change;
- the skill remains domain-neutral, and source maintenance, static verification and real-use observations are not confused with a guarantee of zero omissions.

Only this skill's runtime, rationale and contract reference change for this mechanism. Downstream workflows already consume project constraints and aligned contracts; their rules and invocation policies are not rewritten as a precaution. Existing project instructions stay in place, and unavailable projects are not claimed to have been configured.

## Failure Modes and Rationale

- **Over-questioning and silent intent substitution:** use the dual-entry gate, not "ask everything" or "guess anything reversible."
- **Polishing the wrong solution:** distinguish observations, causal explanations, and remedies; test the remedy against the user's practical difficulty. A deeper interpretation requires evidence and user correction, not agent certainty.
- **Proposal monologues and artificial choices:** make the unresolved question visible first, then supply the background needed to answer it. Compare real alternatives, expose a sole approach's consequences, or elicit experience as appropriate.
- **Cheap edits with irreversible effects:** judge data, authority, external commitments, resource use, and strategic consequences; unknown risk remains pending evidence.
- **Premature convergence:** ready questions need settled prerequisites; the necessity of two questions does not make them independent. Pending nodes are legitimate ledger states, not proof of completion.
- **Local completion mistaken for global completion:** a slice returns to the remaining-work loop. Partial execution needs independent, authorized scope and preserves the rest of the alignment.
- **Approval laundering:** conclusion acknowledgment, scoped implementation authorization, and execution intent have different effects. An old plan's execution instruction cannot authorize a materially different plan.
- **Provenance collapse:** neither conclusion confirmation nor implementation authorization changes claim origin. The private ledger retains sources and evidence; natural wording distinguishes confirmed content, new proposals, and material assumptions without imposing source-shaped layout.
- **Reviewer amplification:** scrutiny tests evidence and consequences. Rejected alternatives reopen only for the entrypoint's evidence-based reasons.
- **Thin or repetitive contracts:** preserve the actual problem, selected solution, key reasons, accepted costs, and implementation-critical semantics with their topic. Remove restatement and routine mechanics rather than correctness boundaries.

## Information Ownership

- `SKILL.md` owns shared runtime behavior, including all-path coverage, source separation, risk review, completion, and execution handoff.
- [references/contract.md](references/contract.md) owns only formal-contract composition and approval details. Its conditional read is mandatory on that path; Direct Result review must not depend on loading it.
- Wayfinder owns its ticket-closeout confirmation. Its receipt of a result does not alter this skill's delivery form. Confirmation must bind the conclusion and material premises used to unblock downstream work, including relevant agent inferences without relabeling their source.

Invocation metadata and cross-host triggering are unchanged. This work validates the behavior of an explicitly started skill and its permitted result handoff, not whether every host interprets invocation fields identically.

## Maintenance Checks

When changing the skill, verify that:

- autonomous fact discovery, dual-entry questioning, zero-question cases, ready-frontier dependency handling, and both delivery forms remain available;
- coverage and source/evidence mappings survive partial answers, new evidence, review, approval, and handoff;
- every in-scope recommendation has a supported disposition, and local acceptance does not close unrelated material choices;
- observed high stakes are not erased merely by answering a question, subagent unavailability falls back to disclosed same-standard current-session review rather than hard-blocking, and unresolved substantiated correctness findings cannot be presented as successful completion;
- collaborative discussion remains open to feedback, accepts clear closure without a fixed phrase or repeated unchanged confirmations, and preserves separate execution authorization;
- a request for Q-numbered questions does not manufacture a decision; explanation requests receive an explanation, while genuine questions and required approval requests use the question-first layout;
- background supplies enough context to decide without fixed fields or lengths, leading assumptions, duplicated option comparisons, or a required link detour; conclusions without pending decisions or approvals do not create an unspecified feedback checkpoint;
- each discussion question or batch is independently understandable when the user has not read earlier long Agent output, while carrying only the minimum context needed for the current judgment;
- key transitions identify the actual next action and its owner, or a specific blocker and how to clear it, without per-reply status templates or full remaining-topic inventories;
- decision acknowledgment advances available alignment work or makes the waiting input clear; clarification replies retain their explanation-only boundary;
- overall closure distinguishes alignment completion, implementation readiness, and existing execution authority without inventing questions or duplicate approvals;
- mid-discussion agreement never starts execution, while the final reviewed Formal Contract confirmation presents explicit options for both 'approve and start implementation' and 'approve conclusion only (do not implement yet)'—and a converged, reviewed Direct Result meeting section 6's execution-intent condition (non-planning-only, actionable in the current session, and still lacking an execution instruction) offers brief execution-intent options—so neither direct execution nor planning-only work requires a redundant follow-up turn;
- continuation stays within the current activity unless execution is clearly directed, while still-valid authorization supports resuming interrupted implementation;
- missed decisions or premature implementation are disclosed against the actual changed state, without retroactive authorization or unauthorized rollback;
- problem discovery permits open questions and user correction without requiring every discussion to restart from first principles;
- questions precede their unlabelled background quotes, real alternatives have recommendation-first numbered choices and honest costs, important single-approach questions do not manufacture options, and question IDs continue within current context while allowing a reset after context loss without history scans or a ledger;
- conclusions organize the understood problem and resulting solution by topic, lead converged rules with business conditions and observable behavior rather than raw internal function call chains, distinguish new proposals naturally, and scale down without empty sections or question-by-question replay;
- formal details are discoverable through a mandatory pointer, with shared safety rules still on all execution paths;
- full implementation-critical model shapes and guarantees survive compression, while empty fields and duplicate summaries do not return;
- user-facing text is localized; no business-code implementation or unauthorized governance mutation occurs during alignment, while user-designated persistent conclusion carriers are kept in sync before activating the next slice;
- unconfirmed conflicting branch changes whose keep/discard disposition affects downstream questions are resolved as upstream prerequisites without re-prompting when the session baseline is already established or `yjx-grill` is re-invoked mid-implementation; pending subagent/tool investigations block dependent questions; existing behavior is traced from live entrypoints/config without carrying over unmentioned legacy bypasses; and failure/consistency questions check host default transaction/rollback guarantees first.

Follow the repository [Skill verification policy](../../AGENTS.md#skill-verification). Use static checks for packaging, links, and document consistency; retrospect on actual user interactions when evidence exists. These checks do not prove reliable model behavior.


## 上游来源与更新记录

来源：[Matt Pocock / skills 的 `grilling`](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/grilling)，上游路径为 `skills/productivity/grilling/`。本 skill 为其概念与工作流的个人演进/替换版；此记录不声明存在 Git fork 或可直接文本合并的关系。

- **最初参考版本：未知，未钉版本。** 仓库演进映射及引入历史能支持来源关系，不能确定当时参考的上游提交；不使用当前版本倒填历史。
- **本次对照快照（2026-11-01）：** 上游提交 `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`，本路径目录 Git tree `f551b6e0d219fdda0b6abf277f8f915b3127d1e9`。通过 GitHub Git Tree API 核实；这只是今后的可复现对照点，不是最初派生基线。
- **最近行为增量评估：尚未建立。** 本次核对来源与路径/目录指纹，没有将当前上游全文与本地逐项比较，也没有据此吸收新行为。
- **本地演化依据：** 本文件原有设计理由、维护检查与本仓库 Git 历史；来源补齐不改写这些既有取舍。

后续维护时，固定待比较的上游提交，核查相关变化与本地取舍，再记录日期、版本、核查范围、采用内容和理由、暂缓/不采用原因及验证限制。分别维护已核查和已吸收的范围；未知历史保持未知，不直接覆盖本地工作流。

| 日期 | 核查范围与版本 | 实际吸收 |
| --- | --- | --- |
| 2026-11-01 | 来源、路径及上述对照快照的目录指纹；未做行为增量评估 | 仅补来源维护记录，未吸收上游行为变更 |
