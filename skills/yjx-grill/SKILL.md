---
name: yjx-grill
description: 找出请求背后的问题，通过有证据的讨论压力测试目标与候选方案，并交付精简结果或经评审、可实施的对齐 contract。
disable-model-invocation: true
---

# yjx-grill

在为执行对齐方案前，先理解用户需要解决的问题。自主调查事实，将用户提出的补救方案与期望结果对照测试，只询问尚未解决的核心意图或有后果的人类判断。结果要匹配实际利害关系，而不是是否提出了问题。

评审或修改本 skill 前阅读 [MAINTENANCE.md](MAINTENANCE.md)；普通执行不需要读取它。

## 执行边界

- 这是一个由用户调用的对齐 skill。在不修改仓库或外部系统的前提下调查；不要实施已对齐计划。执行属于另行授权的 implementation workflow。
- 面向用户的 labels 和 template keys 使用用户的沟通语言。
- 按第 6 节为每个能力切片选择交付形式。独立切片不共享同一个批准。

当用户明确要求协作讨论时，即使没有剩余问题，也要呈现可调整的综合结果并允许反馈。按语义而不是固定短语判断是否可以结束：完整结果获得同意可以结束讨论，但同意一个方案不等于剩余工作已确定。不要反复确认未变化的结果。讨论完成不等于执行授权，也不会取消必要的评审或正式批准。

允许反馈不是额外确认门禁。当没有用户负责的决策或必要批准剩余时，说明结果和当前状态，然后推进剩余对齐工作，或按第 6 节结束；implementation handoff 属于第 8 节。不要把未明确的“请验证结果”留成等待点。未经确认的重大前提保持 pending，不能默认为已接受。

## 呈现密度

讨论问题使用第 5 节的 question-first 布局。按实际主题组织解释和结果；多个结果需要分别处理时使用简短主题标题。简短的单主题回复不需要标题。把行为、重要后果和验收放在它们支持的主题附近；内部能力切片术语不是展示用词。

通过准确措辞保留 provenance，不要强制使用按来源组织的格式。自然地陈述已确认内容，在来源重要时简短归因。新提出但未确认的方案和重大假设首次出现时要明确标识；获得同意不会把 Agent 推导变成用户 requirement 或 verified fact。完整的 source/evidence 映射保留在私有台账和 reviewer handoff 中，不要把台账字段直接展示给用户。

Blockquote 主要承载问题所需背景，不要把它当作“Agent proposal”分类。选项及其 trade-offs 放在背景之外。单个结论使用 prose，可比较或可行动的内容使用列表；省略空分类和套话式开场。

发送前检查实际草稿：用户能找到问题、理解它为何重要，并区分已确认内容、新建议和不确定主张。每个语义主张只保留一个主要归宿；只有第二次出现增加了不同边界或独立可观察后果时才重复。内部记录和实施关键内容都必须完整。

## 1. 理解问题并测试前提

区分用户观察到的困难、用户对原因的解释，以及用户提出的补救方案或目标。用户要求某个具体方案时，表达的可能是表面问题，而不是期望结果。从具体经历出发，逐步明确实际困难和用户需要的变化，再用该结果测试候选方案。

不清楚时，询问最近发生的实例、用户当时想完成什么、遇到了什么阻碍，或问题解决后会有什么不同。当选项会过早限定答案时，使用聚焦但开放的问题。不要要求用户诊断或准确命名底层问题。

上下文足够后，用自己的话简要复述对用户目标和待解决问题的理解。区分期望结果、阻碍结果的困难和提出的补救方案。要综合而不是复述用户原话，并把推断的原因或更深层需求标为暂定。

在比较方案前展示这份理解，发生重大变化时更新它。如果仍有有后果的不确定性，按第 5 节布局把复述放在聚焦问题的背景中。否则无需单独确认一轮即可继续。上下文不足时，先询问具体经历，不要凭空诊断。

在依据该理解改变目标或范围前，让用户有机会纠正它。不要重复未变化的复述，也不要强加固定的发现问卷。

使用工具获取客观事实：代码、schema、日志、任务文本、依赖、可用产物和当前状态。不要让用户查找 Agent 可以验证的事实，也不要仅从现有代码推断用户想要的结果。

对于 defect，在提出补救前调查其因果链。必要时简要说明参与者的动作、可观察失败、最小因果机制以及已排除的伪原因。区分已验证事实和仍需调查的假设。

用已声明目标和成功标准检查计划。只有存在具体目标不匹配、重大无依据假设、不可行性，或证据显示更小范围更能满足结果时，才挑战前提。解释证据和后果；少做或不做也可能是有效建议。没有这些信号时继续推进，不要额外安排强制性的“为什么”访谈。

只有出现新证据、拒绝理由自相矛盾、已选 contract 失败，或此前遗漏的重大风险时，才重新打开已关闭选择。另一种设计偏好不足以触发重开。

## 2. 划定范围并安排工作

把独立结果拆成连贯的能力切片，并完成一个切片后再打开下一个。把切片视为独立前先识别共享前置条件。在第 4 节 coverage record 中跟踪所有范围内建议、其决策和依赖；接受一项建议只关闭它实际解决的决策。

问题只有在事实和决策前置条件都确定后才 ready。进行中的调查属于未确定前置条件：继续处理 ready 分支，但等待依赖其结果的分支。即使无论答案如何都需要某问题，只要另一个答案会改变它的前提、可行选项或建议，该问题仍未 ready。

## 3. 按意图与后果设置问题门禁

提问前，明确未解决的选择、它为何重要，以及为什么 requirements、verified evidence、既定约束或用户的明确委托尚未解决它。使用以下任一入口：

  - **Core intent gap**：缺失的意图会改变成功结果的定义、预期用途或由人类负责的优先级。即使结果容易撤销，也要提问。
  - **Consequential judgment**：成本、保证、所有权、权限或整体策略的接受仍属于人类判断。这也包括只有一个已知可行方案，但其后果或条件需要用户判断的情况；不要求硬凑多个替代方案。

推断不影响目标的常规机制、本地技术默认值和偏好。不要仅因存在多个实现就提问。工具障碍、缺少权限和推测性原因不是决策选项。

按实际影响评估后果：数据丢失或迁移、权限、外部承诺、不可逆资源使用、结构重设计，以及实质不同的补救策略。一行改动也可能有不可逆后果。未知影响需要调查，不能直接归类为低风险。如果无法获得必要证据，报告具体 blocker，并保持该分支未解决。

重要的既定事实可能需要清晰解释，但不需要再次提问。询问未解决的意图、可接受性或条件，不要只为让用户确认 Agent 已验证的事实。

问题门禁和交付形式彼此独立：澄清一个可逆的核心意图，不会自动要求 formal contract。

需要有后果的人类判断时，立即为该切片记录 `contract required`。解决该判断（包括接受唯一已知可行方案，或选择保持当前行为）会确定选择，但不会消除评审和批准义务。

## 4. 维护覆盖与来源

在第一个问题前、每次回复或重大证据更新后，以及完成切片前，核对所有范围内建议和所有可能改变可观察行为、实施义务或风险边界的重大选择/假设。维护一份私有台账：

- **Provenance**: each material claim has exactly one source and its evidence location or corresponding user expression: `需求` (explicit requirement), `事实` (verified state), `决策` (user-confirmed choice), or `推断` (agent proposal or default).
- **Coverage**: `pending evidence`, `pending human`, `resolved`, or `pruned`, with prerequisites and a reason. Give each recommendation a disposition: established requirement/evidence, low-risk default, human decision needed, evidence needed, or excluded with a reason. A recommendation with unresolved material choices remains pending. For resolved nodes, record whether a requirement, fact, user choice, low-risk inference, or concrete acceptance/review constraint resolves them; for pruned nodes, record the verified evidence or explicit scoped decision that closes the branch. Apply section 3 before treating a choice as a low-risk default; this inventory does not create one question per recommendation.

未回答的问题和进行中的调查可以合法保持 pending。问题被提出、列出或分配测试，并不代表它已解决。评审或验收覆盖必须建立边界，不能把未知选择推迟了事。重要新证据会使相关 resolution 和依赖推断失效，并将它们退回 pending。

Use ownership, source of truth, identity, state transitions, consistency/concurrency, external contracts, failure/retry guarantees, compatibility/migration, security/authority, and overall strategy as critical-boundary heuristics. Inspect the actual consequences and rerun the question gate when an inference touches them. Promote unresolved human-owned choices to the ready frontier once their prerequisites are settled. If no human choice remains, gather evidence or establish concrete acceptance/review coverage; report a blocker only when neither can establish the boundary. Do not merge materially different branches into one familiar-looking default or close a critical boundary on an unconfirmed inference alone.

Source and approval are independent. Approving a proposal does not turn its attached agent inferences into requirements, user-originated decisions, or verified facts. Preserve the mapping in the ledger and reviewer handoff; use Presentation Density for the relevant visible distinctions, not role-field rows or production-code comments.

在台账中保留已选方案及重大成本、被拒分支及理由、假设和风险边界。完整记录保持内部使用，只向用户暴露判断或评审所需内容。

## 5. 处理 Ready Frontier

每轮询问零到三个 ready 且相互正交的问题。每个问题都必须通过第 3 节门禁，并且在不改变其它问题前提、选项或建议的情况下仍然必要。优先处理目标、source of truth、ownership、外部保证、不可逆转换、一致性和失败策略等枢纽。用证据裁剪不可能或已经确定的选项。

选择问题格式前先判断是否需要人类输入。只有真正涉及意图、判断或正式批准请求时才使用 `Q<N>`，不要每次回复都使用。用户要求解释时直接回答；对已确定选择做简短确认；事实、进度、blocker 或结论用普通 prose 报告，除非新问题独立通过门禁。格式偏好不足以支持虚构选项或重开已确定选择。

When ready questions remain, lead the round with its first question after at most a brief acknowledgment, not a preliminary diagnosis or proposal. Start each question with a stable `Q<N>` heading that states the actual question. Directly beneath it, put the necessary background in a Markdown blockquote, without a "Context" label or equivalent. Place any options and their trade-offs below and outside the quote.

Make the background sufficient to judge the question: include the established situation or constraints, the unresolved judgment, and what the answer changes, only as needed. Distinguish verified facts, assumptions, and suggestions naturally. Explain unfamiliar terms and cite decisive evidence briefly, but keep the question understandable without opening links. Omit investigation history and option comparisons already covered below. Use one paragraph when enough, without mandatory fields, sentence counts, or fixed lengths; the background must not present the recommended choice as an established premise.

根据未解决判断选择回复形式：

- **Real alternatives:** number viable options from 1, put the recommendation first with a localized marker, and explain its reasons, real costs, and critical assumptions. Explain when each alternative is preferable and why it is not recommended now. Invite corrections or a custom answer; options aid judgment, not constrain it.
- **One known feasible approach:** describe it, the evidence limiting alternatives, and its material consequences or conditions. Keep infeasibility claims limited to the verified constraints. Ask the actual acceptability or constraint question without inventing competing options or implying the user must accept. If unacceptable, revisit the constraints or investigate further; do not manufacture feasibility.
- **Experience or intent exploration:** ask an open question when examples or a free-form account would reveal more than a premature menu. Give the user enough background to answer without supplying a diagnosis for them.

例如，多个替代方案可以使用以下布局：

```markdown
**Q1: Which outcome should this change prioritize?**

> The relevant situation, what remains undecided, and what the answer changes.

1. **Approach A (recommended).** What it changes, why it fits, and its cost.
2. **Approach B.** What it changes, when it fits, and why not now.
```

This illustrates layout, not a stock opening question. Open and single-approach questions retain the heading and necessary background, without a forced option list. A proposal followed only by "Do you agree?" is not a substitute for exploring a real unresolved trade-off.

只有在 visual 能替代 prose，并能澄清 control-flow、state、data 或 ownership 分歧时才使用；控制在八行以内，旁边不要重复同样内容。

收到决策回复后：

1. Identify the decisions the reply actually settles and update only that coverage. Preserve unanswered choices and any required review or approval. For a custom answer, retain explicit overrides and constraints, deriving low-risk mechanics under section 3.
2. Recompute the ready frontier across the remaining scope. Acknowledge the selection briefly, then ask the next ready question in the current slice or investigate missing evidence. Close the slice under section 6 before activating the next one; if neither investigation nor a user decision can advance the work, report the specific blocker. Use section 8 only when execution is actually directed.

Show only new or changed information and material unresolved boundaries, not the full ledger. Neither the number of questions answered nor accepting one recommendation establishes overall completion.

If a new answer invalidates an earlier branch, discard dependent inferences and reopen only affected choices. Mention a next frontier only when the answer unlocks another material question. If the user asks for clarification, answer only that clarification and wait. If they report confusion, restate the actual change and remaining choice rather than returning to a template.

## 6. 收敛并交付每个切片

声明切片完成前，检查 coverage record：每个范围内建议和重大选择都已解决或带有依据充分的 disposition 并被裁剪，没有把有后果的成本或行为隐藏在默认值中，所有必要评审或批准都已完成。变化的触发条件、转换、权限、失败策略和保证都必须有依据。ready frontier 为空但仍有 pending 节点时，表示等待或阻塞，不是完成。

选择两种交付形式之一：

- **Direct Result**: no consequential human judgment required formal approval, including cases where only low-risk core intent needed clarification. Use natural prose, not a mandatory contract or a repeat approval request.
- **Formal Contract**: the slice has a recorded `contract required` obligation. Before drafting, reviewing, or requesting approval, read [references/contract.md](references/contract.md) in full. Produce one independently reviewed contract for that slice and obtain explicit approval.

For either form, synthesize the result around the actual problem and intended outcome, then the selected solution with key reasons and accepted costs. Keep related decisions together by topic rather than replaying Q numbers or the conversation. Include relevant boundaries, material assumptions, remaining uncertainties, and the confirmation status or next step. These are content needs, not four mandatory sections: omit empty categories, and let a simple result be one paragraph. New unconfirmed suggestions remain visibly distinct from agreed content; unresolved prerequisites prevent declaring completion.

If new evidence reveals consequential human judgment, record the obligation and address it. Independent review can be required for either form; high-risk results for which no new human choice arose can remain Direct Results.

Apply the collaborative-discussion rule before concluding either form. Complete only the current slice, then activate the next remaining slice. Before ending overall alignment, run the completion check across all in-scope slices. If the user explicitly stops, pauses, or narrows the scope, preserve remaining choices and review/approval obligations without marking them complete. Distinguish alignment completion from implementation status; completing this workflow does not claim that any implementation occurred.

## 7. 按风险评审

每个 Formal Contract 都需要一名未参与形成提案的独立 Reviewer。当实际影响、可逆性、权限、数据影响、兼容性、安全性或项目治理规则要求时，也要评审 Direct Result。评审本身不自动要求 contract。

Supply the original goal, verified facts, candidate result, and the relevant coverage record: sources/evidence, pending or constrained boundaries, selected approach and costs, rejected branches and reasons, and remaining assumptions. Ask whether the conclusion is supported and the overall solution correct, applicable, maintainable, compatible, proportionate, and faithful to provenance. Findings require concrete evidence and impact, not design preference.

Resolve substantiated findings and obtain targeted independent re-review after material revisions. A newly discovered human fork returns to the frontier. If required review cannot run or a supported correctness finding remains unresolved, report the blocker rather than delivering the result or requesting approval.

## 8. 在交接中保留授权

区分确认结论、授权指定的实现行为和指示开始执行。批准 Formal Contract 只确认已评审的结论和边界；和讨论答案或 Direct Result 一样，它本身不授予 implementation authority。单独记录明确的 implementation authorization，并限制在指定行为和边界内，同时保留已披露重大推断的来源。未披露的默认值不会从该授权获得权限。

这些区分不要求分开多轮。明确要求实施已评审结果的指令，可以同时确认结果、授权实施并指示执行。允许实施但没有要求开始，不是执行指令。按原始措辞和范围保留早先的明确授权；不要事后扩大或撤销，也不要从含糊记录推断授权。

根据当前活动和用户实际意图解释 “continue” 或 “go ahead” 等简短回复，不要依赖关键词白名单。继续讨论会推进对齐，不会自动切换到实施。恢复中断的实施可以依赖仍然有效的授权和执行指令。上下文清楚的实施指令不要求固定措辞或重复确认；如果活动不明确，继续处理 ready 的对齐工作，或只询问未解决的执行意图。

已批准行为或边界发生重大变化时，需要重新对齐、必要评审和批准；有条件批准属于调整，不是对未修订 contract 的批准。批准不会验证不确定事实，也不能替代 coverage 或 review。

Before handoff, match the actual execution instruction to the current aligned and authorized behaviors, including the reviewed contract where required, and check that unresolved work does not block that scope. An instruction limited to an old plan does not transfer to a materially changed plan; if withdrawn, invalidated, or unclear in scope, obtain a new instruction. A still-valid earlier instruction or one in the approval reply needs no repetition.

A request to execute only an approved subset may be handed off only when it does not depend on unresolved work; retain the remaining alignment items. Calling workflows may require confirmation of their own conclusion, but that does not turn a Direct Result into a Formal Contract or expand implementation authority. Keep sources, reviewed scope, approval, and pending boundaries distinguishable in the handoff.

### 从边界违规中恢复

如果发现遗漏决策或过早实施，先报告实际变更：哪些由已确认决策和执行授权覆盖，哪些是 Agent 添加的，以及哪些仍未解决。暂停有效授权之外的进一步修改；讨论保留或修订当前状态，不要把后续工作伪装成实施前对齐。之后达成的共识可以授权未来处理，但不能证明早先已经存在授权。保留用户工作和依赖；撤销变更同样需要授权。
