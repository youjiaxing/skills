---
name: yjx-issue-flow
description: 协调项目已配置 issue tracker 中的多个实施 issue，包括依赖感知的串行或并行执行、独立 Codex worker、集成和 issue 收尾。用户明确点名本 skill，或要求协调父 issue、子 issue 或多个实施 issue 时使用；普通单 issue 实施不要使用。
disable-model-invocation: true
---

# yjx-issue-flow

协调一个或多个 issue 目标的实施工作，同时把 tracker 语义和项目交付规则留给项目本身。

## 边界

- 本 skill 只负责协调，不在协调会话中实现 issue 代码。
- 每个需要实施的 issue 创建一个全新的 Codex task。worker 可以使用受限子代理调查或评审，但由它拥有并负责自己的 issue。
- 能在当前会话直接完成的普通单 issue 不属于 issue-flow；除非用户明确要求新 worker，否则使用项目正常实施流程。
- 不要写死 GitHub、Local Markdown 或其它 tracker。读取项目 tracker 说明，使用其已配置能力。
- 不要为了填补拆分缺口而创建新 issue；父 worker 负责其余要求。
- Wayfinder 管理的 issue 默认不在范围内。分类目标、处理 HIL 或 Wayfinder、选择模式或恢复阻塞运行时，读取 [flow-rules.md](references/flow-rules.md)。

## 开始

1. 读取项目说明和已配置的 issue-tracker contract。
2. 使用项目原生 issue 语法解析用户提供的每个目标；一次调用可以包含多个目标。
3. 默认递归展开每个目标；支持显式的 exact-target 或 direct-children 范围覆盖。去重重叠目标及其后代。
4. 根据项目提供的 type、`requiredSkill`、status、labels 和 issue 内容分类；不要发明 implementation label。
5. 分开可执行的 implementation issue、Wayfinder 管理的 issue、HIL issue、终态 issue、无效目标和依赖阻塞。报告排除目标，并继续处理独立目标。
6. 如果解析后只剩一个可以直接完成的普通 issue，降级为正常实施流程，不创建编排 worker。

## 调度

1. 遵守用户对 `mode: auto|serial|parallel`、`workspace: auto|local|worktree` 和 `max-workers` 的显式设置。
2. 项目规则是硬边界。`local` 只能串行；`parallel + local` 是参数冲突。`workspace` 为 `auto` 时，仅在项目允许的情况下用 worktree 并行。
3. `auto` 模式下，把 ready frontier 调度到有效 worker 上限。按显式依赖边排序，不要仅因文件可能重叠就串行化；worktree 隔离使普通代码冲突成为集成成本，而不是 preflight 阻塞。
4. 优先使用项目或用户给出的 worker 上限，否则默认最多三个 worker。把它视为请求的并发上限，不要当作 API 配额声明。观察到限流或创建 task 失败时，退避、降低并发后重试。
5. 给每个 worker 发送 [worker-contract.md](references/worker-contract.md) 中的结构化交接。存在选定的 implementation skill 时一并提供；没有时，普通实施 issue 使用通用 worker。

## 运行

1. worker 按项目规则负责实施、验证、评审、commit、merge 和自己 issue 的 tracker 收尾。协调器负责调度、父级验证和最终报告。
2. 普通 merge conflict 是预期情况。worker 更新到最新本地集成基线，解决常规冲突，重跑相关检查并重试；不要因普通冲突暂停整个运行。
3. worker 失败时先恢复该 worker；无法继续时，用相同 issue handoff 创建替代 worker。限制重试次数，隔离失败 issue 及其下游，独立工作继续。
4. 使用事件驱动或长间隔等待 worker task。只响应有意义的状态变化，不要按短固定间隔轮询每个 worker。
5. 每个新批次以及父级或目标收尾前，重新读取 tracker 并计算 frontier。tracker、Git 和 worker task 状态是真源；不要把编排清单写入项目仓库。

## 完成

1. 要求每个 issue 自身的 requirements 和 acceptance criteria 均满足。子 issue 完成只是父 issue 的证据，不能替代父 issue 验收。
2. 父 issue 有独立要求时，只有所有范围内子 issue 完成后才创建父 worker。纯聚合父 issue 需要父级验证，不需要无意义的 worker。
3. 让 worker 更新自己的 issue；协调器管理父级和整体运行状态。遵循项目生命周期和收尾规则，不发明 label 或关闭语义。
4. 默认把此前已 resolved 的 issue 视为完成。只有当前运行暴露具体问题（例如依赖检查失败或父级条件未满足）时才做针对性验证。
5. 多目标运行可以部分完成。分别报告已完成、阻塞、跳过、无效和需要用户操作的目标。恢复时只处理未完成或受影响的目标。
6. 运行中只报告有意义的状态变化。结束时返回逐 issue 的结构化结果、commit 或 merge、验证、tracker 状态、阻塞和剩余风险。

Read [flow-rules.md](references/flow-rules.md) when classifying targets, resolving scope, choosing a mode, handling HIL or Wayfinder issues, or recovering a blocked run. Read [worker-contract.md](references/worker-contract.md) before creating or replacing a worker.
