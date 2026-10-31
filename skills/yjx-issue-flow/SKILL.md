---
name: yjx-issue-flow
description: 协调项目已配置 issue tracker 中的多个实施 issue，支持依赖感知的串行或并行执行、跨宿主独立会话/任务 worker、双轨工作区集成与 issue 收尾。
disable-model-invocation: true
---

# yjx-issue-flow

协调一个或多个 issue 目标的实施工作，同时把 tracker 语义和项目交付规则留给项目本身。

## 维护

评审、修改或重新设计本 skill 时，先阅读 [`MAINTENANCE.md`](MAINTENANCE.md)。普通运行不需要读取它。

## 边界与参考指针

- **只协调，不直接写业务代码**：协调器负责目标解析、前置共享探索、依赖调度、主工作区基线集成、父级验收与最终报告；不在协调器会话中直接实现 issue 代码或手动消解业务代码冲突。
- **跨宿主独立会话/任务 Worker**：默认把每个需要实施的 issue 派发到宿主原生的独立顶层会话/任务（Independent Session/Task）；仅当宿主不支持跨会话编排时，才回退使用宿主的全新上下文隔离执行单元。任何子代理调用（包括协调器的只读探索、代办评审，以及 worker 内部的调查或评审）均须遵守：`Start every subagent with a fresh context window (do not fork the current conversation).`
- **单票自动降级**：能在当前会话直接完成的单个普通实施 issue 不走编排；除非用户明确要求新启动独立 worker，否则直接转入项目正常实施流程（如 `yjx-implement`）。
- **尊重项目真源与范围**：不写死 GitHub、Local Markdown 或其它 tracker，也不把编排运行清单写入项目仓库；不为了填补拆分缺口而擅自新建子 issue（剩余要求由父级承接）。
- **参考文件触发指针**：
  - 分类目标、解析范围、处理 Wayfinder/HIL 边界、选择 handler skill、执行 `local` / `worktree` 双轨集成或恢复受阻运行时，读取 [flow-rules.md](references/flow-rules.md)。
  - 创建、恢复或替换 worker，以及组织指针交接和核对完成报告状态时，读取 [worker-contract.md](references/worker-contract.md)。

## 执行流水线

### Phase 1：解析与分流

1. 读取项目说明与已配置的 issue-tracker contract（如 `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md` 及本地 tracker 机器配置）。
2. 使用项目原生 issue 语法解析用户提供的全部目标，展开目标范围并去重重叠后代。
3. 执行目标资格分类，分离可执行 implementation issue、Wayfinder 规划票、HIL 人工门禁票、已完成/终态票、无效目标和被阻塞目标。报告被排除或阻塞的目标，继续推进互不依赖的有效目标。
4. 若过滤后仅剩一个可直接实施的普通 issue 且未要求独立 worker，立即降级为单票实施流程并结束编排模式。
5. 记录当前工作区所在的集成基线分支与起始 commit SHA（`run-baseline`）。
*Completion Criterion*: 项目 tracker 规则已加载；目标树已去重并完成分类分流；排除项已明确记录；非单票降级场景下已记录集成基线分支与 `run-baseline` SHA。

### Phase 2：前置探索与调度

1. 解析 `mode: auto|serial|parallel`、`workspace: auto|local|worktree` 与 `max-workers`（优先级：本次显式参数 > 项目配置 > 默认上限 3）。项目规则是硬边界：不支持或禁止 Worktree 的项目强制使用 `local + serial`，**绝不创建 Worktree**；`parallel + local` 视为参数冲突并拒绝。
2. 当多个待执行 issue 共享同一模块、契约或业务域时，可先派发一个只读探索子代理（`Start every subagent with a fresh context window (do not fork the current conversation).`），将公共模块定位、构建验证命令和关键约束写入当前工作目录的 `./tmp/research/<run-slug>.md`。写入前必须确认 `./tmp/` 已被版本控制忽略（`.gitignore` 或 `.git/info/exclude`）。
3. 按显式阻塞边计算当前 ready frontier，在有效并发上限内调度 worker。`worktree` 并行模式下不因预测文件可能重叠而预先串行化。
4. 为每张就绪票选定 handler skill，发送**指针优先（Context Pointers）**交接。遇到限流或创建任务失败时，退避并下调并发上限后重试。
*Completion Criterion*: 工作区与并发模式已校验无冲突；若启用 `./tmp/research` 探索，已确认 `./tmp/` 被版本控制忽略且探索文件已落盘；首批 ready frontier 已通过上下文指针交接派发。

### Phase 3：运行与分轨集成

1. 使用事件驱动或长间隔等待监控运行中的 worker，只响应有意义的状态变化，禁止短周期轮询。
2. Worker 异常中断或失败时，优先重连并恢复原独立会话/任务；仅在原会话确认无法继续时创建替代 worker。限制重试次数，失败或触发 HIL 的 issue 仅阻塞自身及其下游，独立分支继续。
3. 若回退到禁止嵌套子代理的受限宿主，当 worker 返回 `Result: needs-coordinator-review` 时，由协调器代为启动独立评审子代理（`Start every subagent with a fresh context window (do not fork the current conversation).`），通过后再推进集成，发现阻塞问题则交回该 worker 修复。
4. 按选定的工作区轨道（`local` 原地完成，或 `worktree` 分支预同步后由协调器主工作区合入与清理）执行集成与 tracker 关票。
5. 只有上游 issue **既合入集成基线、又完成 tracker 关票**后，才刷新 tracker 计算下一批 ready frontier 并解锁下游。
*Completion Criterion*: 所有范围内非阻塞子 issue 均已按对应工作区轨道完成集成与 tracker 更新（或明确定位在 `blocked` / `needs-human` / `failed` 终态）；已集成的并行 worktree 已安全清理。

### Phase 4：父级验收与收尾

1. 子 issue 全部完成只是父 issue 的前置证据，不能替代父级验收。此前已处于 `resolved` 的历史票默认视为完成，仅在当前运行暴露依赖破坏或父级条件不满足时做针对性核查。
2. 当父 issue 下所有范围内子 issue 均已集成后：
   - **纯聚合父 issue**：不创建空壳父 worker。协调器基于 `git diff <run-baseline>..HEAD` 核查跨票接口衔接，运行父 issue 验收标准要求的验证命令，通过后按项目规则更新并关闭父 issue。
   - **含独立未覆盖需求的父 issue**：在所有范围内子 issue 完成并合入基线后，派发父 worker 完成剩余要求、验证与收尾。
3. 若 Phase 2 创建了 `./tmp/research/<run-slug>.md`，在收尾时仅删除本次运行生成的临时探索文件，保留其他任务的产物。
4. 输出结构化最终报告：按已完成、阻塞、跳过、无效和需人工介入分类列出各 issue 的交付 SHA、验证与评审结果、tracker 状态及剩余风险。
*Completion Criterion*: 父级跨票集成验证或父 worker 已完成；父级与整体 tracker 状态已更新；本次创建的 `./tmp/research/<run-slug>.md` 已清理；已输出完整逐票结构化报告。
