---
name: yjx-to-spec
description: 检查就绪度，然后把已对齐的讨论或决策产物编译并发布为领域原生 specification，包含明确 contract、变更边界和可验证验收。
disable-model-invocation: true
---

# yjx-to-spec

把已达成共识的 destination 编译为 specification，并在项目配置的存储目标创建或更新它。调用本 skill 同时请求创建和发布，不需要独立的草稿审批步骤。调用本身，或上游 Agent 宣布讨论完成，都不是输入已就绪的证据。

specification 描述承诺的结果、contracts、变更边界和验证依据。它不是访谈、实施日程或执行 ticket 集合。保持对特定上游对齐工具和下游实施工作流的独立性。不要修改应用代码，也不要创建、更新或执行 implementation tickets。

## 维护

评审或修改本 skill 前，先阅读 [MAINTENANCE.md](MAINTENANCE.md)。普通执行不需要读取它。

## 1. 固定请求基础

- 阅读可用对话、决策和被引用产物，确定预期结果、已同意范围，以及这是新需求还是修订。
- 检查相关环境中的现有 contracts 和约束。软件任务要阅读适用的项目说明、领域词汇、ADR 和相关现有测试；其它领域使用等价证据。
- 根据项目说明或 `docs/agents/issue-tracker.md` 确定正式存储目标和 triage 约定。缺少这些信息时，不要发明 tracker、destination 或 label 词汇。
- 修订时，通过明确路径、Issue 引用或可靠的项目关联定位并阅读原 specification。仅凭标题相似不足以确认身份；替换内容前先应用第 5 节的修订规则。

推理时区分 **confirmed choices**、**verified facts** 和 **inferences**。为重要决策、派生约束和剩余实施选择提供足够来源信息，使人能理解其依据；不要给每句话强加 provenance 字段，也不要输出庞大的分类台账。批准提案不会把 Agent 推导的理由变成用户提出的 requirement 或 verified fact。

保留已知的决策理由和实际讨论过的 rejected alternatives。没有这段历史时就保持缺失，或说明未记录；不要为了填充模板而虚构决策过程。

## 2. 生成前检查就绪度

目标、范围、外部可观察行为、关键约束和验收依据必须足够清晰、有支持且彼此一致。整体检查请求的交付物；其中包含多份 specification 时，也要检查共享承诺。

只有在剩余选择既不改变这些承诺，也不依赖未解决的关键承诺时，才可以留给实施阶段。选择的大小或被称为“parameter”都不能证明它安全。使用可用证据调查不明确的影响；不要用 Agent 选择的关键设计替代缺失的对齐。

只有证据支持时才使用边界。虚构区间并不比虚构数字更安全。有效的 implementation freedom 不一定需要具体值或数值范围，就绪也不要求消除所有这类自由度。

**如果重大缺口、冲突或缺失证据导致无法确认就绪，必须在生成或修改 specification 前停止。** 简洁、局部地说明没有生成 specification，并写明 blocker、依据以及所需的决策或证据。不要生成正式或占位 spec，不要修改现有 spec、发布或添加 ready labels，也不要自动开始另一轮访谈或 workflow。

此门禁优先于所有生成和发布指令。缺失发布前置条件同样必须停止发布；报告缺口，不要猜测目标。门禁通过后直接继续。任何就绪声明都必须描述实际检查结果，不要填入预设完成百分比，也不要声称所有开放选择都已解决。

## 3. 按实际领域编译

标题、label 和正文使用用户的沟通语言。保留字面 protocol identifier 和 document marker 不变。根据主题选择标题、顺序和表达；可以合并或省略不适用章节，但不能省略必要承诺。

Cover the following content where it affects the outcome:

- **问题与结果**：需要改变什么、承诺的结果、范围内能力和明确排除项。
- **Contracts 与行为**：为消除重大歧义所需的公开实体、接口、交互、生命周期转换、失败行为或物理/流程约束。协作或验收依赖的内容要精确，不要仅因为模板有字段就补全。
- **变更边界**：允许变化的能力、行为和 contracts。把预期模块或文件视为非穷尽的影响位置，区分已检查位置与预测位置，不要把它们当作自动授权的物理白名单。
- **不变量与禁止项**：把保护性要求集中在一处。遵守用户、项目治理或已确认设计提出的明确物理限制，并说明依据。新增文件位置本身不等于扩大范围；列出的文件位置也不授权改变其它行为。越过已确认边界需要重新对齐。
- **决策与 implementation freedom**：保留已确认决策及其已有理由。说明有依据的剩余自由度及其约束，不要把未解决的关键决策伪装成可调参数。
- **验收与验证**：说明必要行为、重要失败场景和不变量检查，以及能建立结果的观察点、前置条件和可复用测试或检查方法。

可选表达包括软件的 typed interfaces、schema 变更、错误 contracts 和状态表；实体设计的图纸、材料规格或检查标准；运营场景的责任或升级规则。只选择需求真正需要的表达。不要为了让文档看起来完整而虚构 schema、尺寸、公差或时间值。

引用已有权威 contracts 并描述确切变更；不要复制完整定义，也不要只放链接来替代新承诺。包含与决策相关的公开 contracts，不要包含私有 helper 代码、胶水脚本或可运行实现。优先使用直接的领域描述，不要强制套用冗长的 Agile user stories。

验证时优先使用合适的现有观察点和相关先例。不要强制指定某个 framework、命令、最高测试层级或单一测试入口。测试承诺的行为，不要冻结私有实现结构。缺少现有测试本身不阻塞 spec，只要结果仍可判断；描述必要的新验证能力及其影响，不要静默添加产品接口或架构要求。

根据清晰度选择 scenarios 或紧凑矩阵，不要用两种形式重复同一组案例。验证计划不等于检查已通过。说明实际检查过哪些证据，以及实施或验收还剩什么。

对于候选 multi-spec initiative，在决定结构或发布其单元前阅读 [references/multi-spec.md](references/multi-spec.md)。拆分文档不等于授权拆分 implementation tickets。

## 4. 为每份 Specification 提供稳定身份

Every formal specification created or updated by this skill, including a master and each sub-specification, must begin with this exact, unindented marker as its first nonblank line:

```markdown
<!-- yjx:spec -->
```

The marker occupies the entire line, with no trailing text or spaces. An initial UTF-8 BOM, leading blank lines, and LF or CRLF line endings are allowed. A marker quoted in prose, a blockquote, or a code example is not a document declaration.

The marker declares a document type, not readiness, approval, or implementation progress. The rest of the document can use native-language headings and an appropriate structure without fixed numbering or a "Readiness Radar".

For a project using `yjx-gh-kanban`, ensure its marker-aware reader is available before dropping the old identifying headings. The updated reader retains the legacy `to-spec` and `yjx-to-spec` heading paths; old readers are not guaranteed to understand a new flexible layout. Do not bulk-migrate historical specifications. Add the marker when an existing specification is legitimately revised, without gratuitously reformatting its unrelated content.

## 5. 在正式目标创建或修订

### 修订

Create a new specification for a new requirement. For an explicitly continuing requirement, update the existing file or Issue in place rather than creating a competing version.

- Read the original and establish the exact update target. If its identity is ambiguous, multiple candidates remain, or the original cannot be read, report the blocker; do not guess an overwrite or create a replacement to bypass it.
- If implementation has not started, apply the aligned revision without an extra publication approval.
- If implementation has started and a change affects the goal, scope, external behavior, key constraints, or acceptance basis, establish its impact on existing commitments and completed or ongoing work. Update only with confirmation covering those effects. Reuse sufficient existing authorization rather than asking again.
- Do not treat unknown implementation status as "not started" to bypass impact checks. Corrections that do not change meaning do not need this material-change gate.
- Preserve unrelated content and published reference entry points. If compatibility cannot be maintained, leave the affected entry point unchanged and report the limitation rather than silently editing other documents.
- Record material commitment changes and their basis, not a dynamic execution-progress ledger. Recheck the source before replacement; if it has changed, reconcile against the current version instead of overwriting from a stale copy. Do not claim atomic concurrency protection that the storage tool does not provide.

### Local Tracker

Follow the configured local convention. For a new specification in the `.scratch/` convention, use `.scratch/<YYYYMMDD-HHmm>-<descriptive-slug>/spec.md`, with the user's or project's local timezone. Place optional sub-specifications under that feature's `specs/` directory. Preserve an existing specification's location on revision, and do not overwrite an unrelated file on a naming collision.

These files are the formal specification, not temporary upload material. Do not add execution `Status:` fields or other task-progress metadata that would enroll a specification in the implementation kanban.

### Remote Tracker

The remote specification is the formal source. Create or update it directly through the available authorized tracker interface. Use a concise title in the user's language, adding prefixes only where the project requires them. Follow canonical triage labels; do not invent labels.

The presence of local project documentation does not request a second maintained copy or a Git commit. Use direct content input when supported. If upload tooling requires a local file:

- Create it in a task-owned system temporary directory outside the repository, not in business directories, versioned docs, or the local tracker.
- Never stage or commit upload material, or modify `.gitignore` to accommodate it.
- After verified publication success, remove only this task's temporary material.
- On failure or an unknown result, preserve the material for recovery and report its temporary path and actual publication state. Do not promise permanent retention or blindly retry a create that may already have succeeded.

There is no default Git commit step in either storage mode. Honor a separate explicit user or project requirement where applicable; it does not turn upload temporaries into versioned artifacts or implicitly request dual-source maintenance.

### 完成

Before mutation, check the final content against the agreed scope, readiness gate, marker protocol, and reference targets. After writing or publishing, verify the stored content and references and apply only the project's required triage labels for a completed specification. Do not declare success from a local upload file alone.

If publication fails, is partial, or cannot be verified, report completed targets and outstanding work accurately and preserve recoverable temporary material. Do not silently reduce the requested scope, claim the entire specification is published, or launch an implementation workflow.
