# Worker 交接与报告契约（Worker Contract）

每次创建、恢复或替换实施 worker 时使用本契约。默认情况下，worker 是宿主原生的**独立顶层会话/任务（Independent Session/Task）**；仅当运行宿主不支持跨会话编排时，才回退使用宿主的全新上下文隔离执行单元（`Start every subagent with a fresh context window (do not fork the current conversation).`）。

## 1. 指针优先交接（Pointer-First Handoff）

通信保持稀疏。只向 worker 传递定位权威真源所需的**上下文指针（Context Pointers）**与运行时边界，不要把协调器的完整对话历史或整篇 issue/spec 正文复制粘贴进交接消息，并要求 worker 启动后直接读取这些权威真源：

- **Issue 指针**：目标 issue 在项目 tracker 中的原生标识或本地文件路径（如 `#42` 或 `.scratch/<feature>/issues/02-xxx.md`）；
- **项目与 Tracker 合同指针**：`AGENTS.md`、`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`（及适用时的 `docs/agents/local-tracker.json`）路径；
- **执行与评审技能指针**：选定的 handler skill（如 `yjx-implement`）；
- **工作区与基线指针**：
  - 当前工作区模式：`local`（原地串行）或 `worktree`（独立 worktree 路径与专属 issue 分支名）；
  - 集成基线分支名与当前基准 commit SHA（`Baseline SHA`）；
- **上游依赖与共享探索指针**：
  - 已完成直接上游 blocker 的 issue 标识、交付 commit SHA 及需要留意的遗留风险摘要；
  - 若本次运行生成了前置共享探索笔记，传入 `./tmp/research/<run-slug>.md` 的绝对路径；
- **模式职责指针**：按 [flow-rules.md](flow-rules.md) 第 5、6 节执行对应工作区模式（`local` 或 `worktree`）及受限宿主代审边界。

## 2. Worker 自治与升级门禁

Worker 在 issue 边界、项目规则与所选 handler skill 内自主完成工程决策。遇到未预先列出的关联文件、常规代码冲突或本地基线更新时，自行调查并消解，不要为常规实现细节向用户提问。在 worker 内部启动任何调查或评审子代理时，均须遵守：`Start every subagent with a fresh context window (do not fork the current conversation).`

仅在遇到真正的**人工门禁（HIL Gate）**时才向上升级并暂停当前票据：

- 存在多种合理业务含义、且会影响外部行为或领域模型的产品/需求歧义；
- 需要人类审批、外部凭据、手工环境操作或显式 HITL 签字；
- 不可逆或高风险的破坏性变更；
- 项目规则之间存在无法调和的直接冲突；
- 在有限次恢复重试后仍无法解决的持久性构建/测试阻塞。

触发升级时，仅将当前 issue 标记为 `needs-human` 或 `blocked`，不影响其它互不依赖的并行 worker。

## 3. 结构化完成报告（Completion Report）

Worker 结束或暂停时，必须向协调器返回以下结构化报告：

```text
Issue: <原生 tracker 标识与标题>
Result: completed | ready-to-integrate | needs-coordinator-review | blocked | needs-human | failed | skipped
Handler: <使用的 skill 或 generic worker>
Workspace: local | worktree (<worktree 路径与分支名>)
Baseline SHA: <验证所基于的集成基线 commit SHA>
Delivery SHA: <本票已提交的 HEAD commit SHA>
Scope: <实际修改模块与行为摘要>
Acceptance:
  - <验收标准条目>: passed | not-run | blocked
Verification:
  - <实际执行的验证命令>: passed | failed | not-run
Review: <项目要求的独立评审结果，或受限宿主待协调器代审的证据包摘要>
Integration: integrated-in-local | branch-ready-for-coordinator | not-integrated
Tracker: closed | ready-to-close-after-integration | open-blocked | closeout-retry-needed
Risks: <剩余风险说明或 none>
Next action: <仅在 Result 非 completed 时填写具体后续动作>
```

### 完成状态判据

- **`Result: completed`（`local` 模式终态，或协调器完成主工作区合入与关票后的最终记账）**：要求本票需求、验收标准、相关验证、项目必需独立评审、集成基线合入以及 tracker 关票全部完成。仅凭文字报告不能关闭 issue。
- **`Result: ready-to-integrate`（`worktree` 并行模式 worker 终态）**：要求本票需求、基于 `Baseline SHA` 的分支同步与冲突消解、验证、必需独立评审和 worker 分支本地 commit（`Delivery SHA`）全部完成，等待协调器在主工作区合入集成基线并执行 tracker 关票。
- **`Result: needs-coordinator-review`（禁止嵌套子代理的受限宿主过渡态）**：要求本票需求、验证及评审输入材料（决策上下文、适用验证路径证据与 diff 基线）已就绪，等待协调器代为完成独立评审子代理核查；评审通过后方可转入 `completed` 或 `ready-to-integrate`。

