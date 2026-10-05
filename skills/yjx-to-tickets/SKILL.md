---
name: yjx-to-tickets
description: 将计划、spec 或对话拆分为适合上下文大小、因果完整的 tracer-bullet tickets，包含明确阻塞边、领域自适应验证标准和不变量可追溯性。
disable-model-invocation: true
---

# yjx-to-tickets

把计划、spec 或对话共识拆分为一组 **tracer-bullet tickets**：每个 ticket 都是自包含的垂直切片执行单元，并声明哪些 ticket **block** 它。

目标是 **single-session completion**、**causal cohesion** 和 **review self-containedness**。本 skill 把足够清晰的意图转成可执行 tickets；不执行 ticket 工作，也不维护持续的任务日程。

## 维护

评审、修改或重新设计本 skill 时，先阅读 [`MAINTENANCE.md`](MAINTENANCE.md)。其中记录 skill 的设计意图、演进历史和反漂移规则；普通运行不需要读取它。

## 1. 切片原则与语义

1. **Causal Cohesion（因果自洽）**：交付从意图、动作到验证的可观察链路。普通 ticket 必须能在其 blocker 完成后的基线上独立交付并验证。依赖上游结果不是合并 ticket 的理由。如果 ticket 需要未完成的下游工作才有用或可验证，重新划定边界，不要自动合并依赖链。避免只有定义没有消费者，或只有 UI 外壳没有可用交互。
2. **Single-Session Focus（单会话聚焦）**：使用自然的行为里程碑和状态转换，把必要上下文、未决策定和验证工作控制在可管理范围内。单会话完成是 sizing 目标，不保证不会发生上下文压缩。不要设置行数或文件数阈值。
3. **Review Self-Containedness（审查自解释性）**：评审者可以查看 ticket、代码和证据、上游 Spec/ADR 以及已完成 blocker。除下文明确的 wide-refactor integration case 外，正确性不能依赖未完成的下游工作。
4. **Execution Subject（执行主体）**：当预期执行者具备执行和验证能力与权限时，优先使用 AFK。需要人类访问、批准或判断的前置条件使用 HITL，只把确实需要其结果的事项设为 blocker。云端设置、迁移或指定人类负责人本身不会使执行变成 HITL。将这些角色映射到项目实际的 `ready-for-agent` / `ready-for-human` 等价状态；分类不会授予新权限。

## 2. 流程

### Step 1：收集上下文与不变量
- 阅读提供的对话、Spec、PRD 或计划。对于引用的 issue 或文档，阅读完整正文和相关评论/决策。保留 canonical source link；没有文档时，在 tickets 中总结已确认意图。
- 提取目标、requirements、系统不变量、涉及区域和禁止变更。只在建立范围、依赖和验收所需时检查实现、领域词汇、ADR 和验证入口；考虑必要的 prefactoring，不做泛化的代码库调查。
- 一起阅读适用的 tracker contract 和 label 词汇：`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`，以及使用 local tracker 时的 `docs/agents/local-tracker.json`。使用项目路径和角色映射。发布前解决配置冲突；未配置时，引导用户完成仓库 tracker 设置，不指定某个 skill。

按影响处理未知项：

- **可发现事实**：自行调查，不要让用户做本可由 Agent 完成的查找。无法获得证据时报告缺口，不要编造事实。
- **局部实施选择**：只要不改变交付目标、权限边界、外部 contracts 或依赖，就留给执行者。
- **影响任务结构或主要边界的选择**：在最终确定受影响的 implementation tickets 前先讨论。无关草稿可以继续。
- **需要独立实验的问题**：只有确有必要时才提出 exploration ticket，并写明问题、证据产物和完成条件，请用户确认。实验结果不是设计批准；在确定下游 implementation tickets 前，要确认影响拆分的设计选择。

### Step 2：起草垂直切片与依赖 DAG
按每个结果所需的领域层次切分，不要机械覆盖所有可能层次。每个 ticket 说明：

- **交付与理由**：端到端行为和必要背景。
- **范围边界**：已同意的行为和 contract 变更、相关不变量、明确非目标，以及已有用户或项目限制。以 Spec 作为全局真源；只携带本 ticket 相关的约束。
- **验收与验证**：把可观察预期结果和检查方法配对。命令本身不是验收。区分已有验证入口和 ticket 必须新增的验证；绝不虚构已有命令。使用适合领域的证据，例如测试、测量公差、状态变化或明确的人类签字标准。
- **Blocked by**：只填写开始工作前确实需要的上游结果。保留指向已完成 ticket 的必要边；完成满足依赖，但不删除依赖。把必要 prefactoring 安排在它所支持的工作之前。

Impact locations 是可选的、非穷尽的导航或影响证据；区分已检查位置和预测位置。不要创建文件或模块修改白名单。未列出位置的必要变更本身不要求重新批准；列出位置也不授权无关行为变更。越过已同意的行为或 contract 边界需要重新对齐。保留已有明确的用户或项目限制，不要从位置列表推导新权限或禁止项。

#### Wide Refactor 例外

对于无法合理落地为普通垂直切片的广泛 shared-contract 变更：

1. **Expand**：在保留兼容性的同时，让新形式与旧形式并存。
2. **Migrate**：把调用方批量拆入适合上下文大小的 tickets，每批都 blocked by expand；尽可能让每批保持 green。
3. **Contract**：创建一个 blocked by 所有 migration 批次的 ticket，移除旧形式，并验证没有旧调用方残留。

如果各批次无法独立通过全系统验证，提出隔离的 integration branch，以及一个 blocked by 所有必要 migration 和 contract 工作的最终 integrate-and-verify ticket。每批仍需要有边界、可观察的里程碑和本地验收，不能声称完成端到端交付。在提交拆分供批准时，说明 integration owner、隔离方式、本地检查、全系统成功标准和失败处理。边界不清时不要最终确定受影响 tickets。批次完成不等于整体交付；组合结果在全系统验证通过前不可发布。

### Step 3：可追溯性与反碎片化自审
维护 requirements/invariants 到 tickets 和验收证据的轻量内部映射。检查：

- requirements、关键 edge cases 和安全边界都有负责人及有意义的验证。
- 跨 ticket 不变量有明确的最终验证负责人，该负责人可以是已有 ticket；不要机械添加 aggregate ticket。
- tickets 满足切片原则，引用可解析，依赖图没有自依赖或环。
- execution subjects 与项目状态映射一致，没有把未解决的选择伪装成可执行 implementation plan。

在呈现最终拆分前修正缺口。公开剩余遗漏、未解决决策和跨 ticket 验证责任；大型 traceability matrix 不是必须交给用户的产物。

### Step 4：与用户评审拆分结果
清晰呈现拆分草案：

```markdown
### 建议拆分

1. **[01] <Ticket Title>**
   - **Execution**：<AFK 或 HITL；实际映射的项目状态>
   - **Blocked by**：<必要的上游 tickets，包括已完成的；只有独立时才写 None>
   - **交付内容**：<结果和必要理由；已批准例外的有边界里程碑>
   - **验收与验证**：<可观察的预期结果；检查方式>
```

对于 Wide Refactor，在上方包含例外的 integration 边界。询问粒度、真实依赖、execution subjects 和所需的边界调整。迭代直到用户批准最终拆分；批准 exploration ticket 不等于批准推测性的下游计划。

### Step 5：发布到已配置 Tracker
只按已配置的 tracker protocol 发布已批准、已最终确定的 tickets。

在受影响的发布前，先确认项目关系真源以及读写能力；能力不可用时，暂停受影响发布并报告 blocker。只有项目 protocol 允许且所有判断就绪度或执行资格的消费者都能识别时，正文引用才能作为关系记录。对于使用 `yjx-gh-kanban` 的 GitHub，native relationships 是权威真源；正文链接只作解释，不是 fallback。缺少写能力不会改变该 protocol。

- **写入前**：检查现有 tickets 和之前的发布结果。创建新 tickets 或恢复本次已批准的发布，并保留已有身份。重试时只补充明确属于已批准工作的缺失部分。身份不确定、内容冲突或实施已开始时，暂停受影响部分并报告；不要覆盖或盲目创建重复项。修改历史 tickets 需要独立 diff 和用户确认。
- **Local Markdown**：在配置路径下每个 ticket 写一个文件（默认 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`）。新 feature 按依赖顺序从 `01` 编号；扩展现有 feature 时保留既有编号，新 tickets 使用未占用编号。使用包含已解析 blocker 引用和映射状态值的 local template。
- **Remote tracker**：按依赖顺序使用真实标识符创建 issues，然后通过项目权威机制分别建立 parent 和 blocking relationships。使用项目映射的 labels，不使用未映射的 canonical names。
- **写入后**：根据已批准拆分，从配置的真源回读正文、执行状态/labels 和关系，而不只是检查正文引用。必要关系缺失或无法验证，说明发布未完成。报告真实标识符和未完成部分；在已批准结果验证前，不要声称完整发布。

不要修改或关闭 parent spec/map issues。本步骤不增加 task scheduling、staged activation、publication state machine 或 atomic-publication guarantee。

---

## 3. Ticket Templates

Both templates express the behavioral scope and impact-location distinction from Step 2 rather than prescribing a file-by-file implementation. Include existing protected paths only with their user or project basis. Include code snippets only when a decision-rich state machine, schema, type shape, or formula is more precise than prose; retain its source.

For a wide-refactor batch, replace the normal delivery description with its bounded milestone and include the approved isolation, local acceptance, integration owner, final verification ticket, and failure handling. Do not present batch completion as releasable delivery. For a confirmed exploration ticket, describe its question, evidence output, and completion condition instead of inventing an implementation outcome. Omit optional source/parent fields when absent.

### Local Markdown 模板（`.scratch/<feature>/issues/<NN>-<slug>.md`）

```markdown
# <NN>: <Ticket Title>

Status: <actual project status mapped from the execution role>
Blocked by: <necessary upstream references, including completed tickets, or None>

Spec: <canonical source reference, if present>

## What to build

<End-to-end behavior and necessary rationale, or the bounded outcome defined above.>

## Invariants & Scope Bounds

- **Scope**: <Agreed behavior and contract changes>
- **Impact Locations**: <Optional, non-exhaustive navigation evidence; distinguish inspected from predicted locations>
- **Relevant Invariants**: <Rules and safety boundaries relevant to this ticket>
- **Non-goals**: <Explicit exclusions>

## Acceptance criteria

- [ ] <Observable expected result>; verify by <existing check or verification this ticket adds>.
- [ ] <Relevant error/edge-case result>; verify by <test, measurement, state evidence, or human sign-off criterion>.
```

### Remote Issue 正文模板

```markdown
## Parent
<Link to parent issue/spec if applicable, otherwise omit>

## What to build
<End-to-end behavior and necessary rationale, or the bounded outcome defined above.>

## Invariants & Scope Bounds
- **Scope**: <Agreed behavior and contract changes>
- **Impact Locations**: <Optional, non-exhaustive navigation evidence; distinguish inspected from predicted locations>
- **Relevant Invariants**: <Rules and safety boundaries relevant to this ticket>
- **Non-goals**: <Explicit exclusions>

## Acceptance criteria
- [ ] <Observable expected result>; verify by <existing check or verification this ticket adds>.
- [ ] <Relevant error/edge-case result>; verify by <test, measurement, state evidence, or human sign-off criterion>.

## Blocked by
- <Necessary upstream references, including completed tickets, or "None">
```

---

## 4. 执行边界

创建 ticket 产物，不要修改生产应用或执行 ticket 描述的工作。不要强制要求特定前置或后续 skill。执行仍由现有项目生命周期和授权规则约束；本 skill 不重新定义这些规则。
