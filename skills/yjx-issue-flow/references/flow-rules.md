# 协调分流与运行规则（Flow Rules）

本文档定义 `yjx-issue-flow` 的目标分类、Wayfinder/HIL 边界、Handler 选型、双轨工作区集成细则与故障恢复规则。阶段主干流程见 [`../SKILL.md`](../SKILL.md)。

## 1. 目标范围与依赖拓扑

- **项目拥有 Tracker 解释权**：查询或修改 issue 前，先读取项目的 tracker 文档、已配置看板技能（如 `yjx-local-kanban` 或 `yjx-gh-kanban`）及脚本。若某个用户输入的目标无法解析，报告该无效目标并继续处理其余独立的有效目标，禁止猜测 tracker 或静默丢弃。
- **范围展开语义**：
  - 默认展开每个目标的**完整后代树（full descendant tree）**；
  - 支持用户显式指定 `exact-target`（仅指定目标本身）或 `direct-children`（仅直接子项）；
  - 多个目标树存在重叠时合并为同一工作项，不重复派发 worker。
- **父子边与阻塞边分离**：父子边（parent-child）决定目标范围，显式阻塞边（`Blocked by` / `blockedBy`）决定执行顺序。含独立实施需求的父 issue 作为最终收敛节点，必须等待其范围内全部子 issue 集成并关票后才能启动。

## 2. 资格分类与强制覆盖（Classification）

项目定义的票据类型与 `requiredSkill` 优先级高于普通标签。普通领域标签仅描述内容，不代表自动执行许可；禁止为了使票据可执行而私自添加 implementation 标签。

默认准入与拦截规则：

- **`ready-for-agent`**：项目定义该角色时，作为默认的自动准入信号。
- **用户点名覆盖**：用户直接点名某个处于普通待分流状态的单个目标时，发出提示后可按用户指令执行，但**强制覆盖仅对被点名的那张 issue 生效，绝不自动传染给其子孙后代**。
- **需警告的拦截态**：`ready-for-human`、`needs-info`、`needs-triage` 以及终态（`resolved`、`wontfix`、`invalid`、`duplicate`）默认不进入自动执行队列；若用户强制要求执行，必须先发出明确警告。
- **标签冲突**：同一张 issue 同时携带相互矛盾的状态或分流标签时，视为该 issue 的局部阻塞（blocked），不得猜测哪一个优先。

## 3. Wayfinder 边界

带有 `wayfinder:map`、`wayfinder:research`、`wayfinder:grilling`、`wayfinder:prototype`、`wayfinder:task` 等由 Wayfinder 管理的规划票据，**默认排除在 `yjx-issue-flow` 之外**。发现此类目标时，在报告中明确列出并说明它们归属 `yjx-wayfinder`（或 `wayfinder`）。

若用户显式强制将某张 Wayfinder 票纳入运行：

- 必须按对应的 Wayfinder 工作流委托，不得将其篡改为普通代码实施票。
- `grilling` 与 `prototype` 即便被强制纳入，依然保持 HIL（Human-in-the-Loop）属性：worker 可以推进到人类决策或确认门禁，但绝不能替人类编造回答或擅自关闭票据。

## 4. Handler Skill 选择顺序

为每张可执行 implementation issue 选择 handler 时，严格按以下优先级匹配：

1. 项目或该 issue 元数据显式声明的 `requiredSkill`；
2. 用户在本次调用中显式指定的实施 skill；
3. 当前环境已安装的项目实施 skill（优先 `yjx-implement`，其次 `implement`）；
4. 通用实施 worker（当上述可选 skill 均未安装时直接回退，不得因缺少可选 skill 而阻塞运行或擅自安装）。

## 5. 双轨工作区与无锁集成细则

- **模式矩阵与硬约束**：
  - `local` 工作区：**只能配合 `serial`**（单 worker 串行）。当项目不支持 Git Worktree、项目规则禁止 Worktree 或用户指定 `workspace: local` 时，全程在主工作区原地串行推进，禁止创建任何 worktree。
  - `worktree` 工作区：支持 `parallel` 或 `auto` 并发。每个并行 worker 分配独立的 Git worktree 与独立 issue 分支。
- **前置共享探索与防泄漏**：
  - 启用 `./tmp/research/<run-slug>.md` 共享探索前，先用 `git check-ignore -q tmp/` 或检查 `.gitignore` / `.git/info/exclude` 核实 `./tmp/` 已被忽略；若未忽略，先在 `.git/info/exclude`（不污染受控文件）或按项目规范补齐忽略规则，再写入探索笔记。
- **`worktree` 并行模式的两阶段集成**：
  - Git 不允许两个 worktree 同时 `checkout` 同一个本地集成基线分支。因此并行 worker **不得尝试在自己的 worktree 中 checkout 主集成基线分支**。
  - **第一阶段（Worker 分支内同步与自验）**：worker 在自身 worktree 分支上完成开发后，先将主工作区当前的集成基线分支 merge/rebase 到自己的 issue 分支中，消解代码冲突，运行验证与必需的评审，随后提交并返回 `Result: ready-to-integrate`、验证所基于的 `Baseline SHA` 与分支 `Delivery SHA`。
  - **第二阶段（协调器主工作区合入与重验门禁）**：协调器在主工作区按完成顺序串行处理 `ready-to-integrate` 的分支：
    1. 若 worker 报告的 `Baseline SHA` 等于当前集成基线 `HEAD`，协调器直接将该分支合入（fast-forward 或 merge）集成基线。
    2. 若期间已有其它并行 worker 合入导致集成基线 `HEAD` 前进：
       - 协调器尝试在主工作区干净合入；若出现任何 Git 合并冲突，立即执行 `git merge --abort`（协调器绝不手动改代码解冲突），恢复原 worker 会话并传入新基线 SHA，要求其在自身 worktree 中同步新基线、解冲突、重跑验证与必要评审后再次交回。
       - 若无冲突合入，协调器必须在关闭票据前重跑该票据报告的定向验证命令（若两张票修改了同一模块或共享契约，也可唤醒原 worker 基于新基线重验），防止无文本冲突的语义回归。
    3. 集成验证通过后，完成 tracker 关票，并在确认 `Delivery SHA` 已是集成基线的祖先提交且该 worktree 内 `git status --porcelain` 为空后，安全移除该 worktree。

## 6. 故障恢复与状态分离

- **跨重启与中断恢复**：独立会话/任务（Session/Task）在 Agent 重启后依然存在。恢复中断的运行时，先读取 tracker 状态、Git 分支/worktree 状态以及已有的 worker 会话记录；优先重连并继续未完成的原 worker 会话，不要盲目重开重复会话。
- **受限宿主的评审兜底**：若运行宿主不支持独立顶层会话编排、且其子代理被禁止再次派生子代理（导致 worker 内部运行 `yjx-implement` 时无法启动 `/code-review` 子代理），worker 在完成实现与适用验证路径后上报评审材料，由协调器在一级上下文代为启动双轴独立评审子代理（`Start every subagent with a fresh context window (do not fork the current conversation).`）。
- **代码交付与 Tracker 写入分离**：若代码已合入集成基线且验证通过，但更新/关闭 tracker 时遇到网络或工具临时错误，将该票标记为 `closeout-retry-needed` 并仅重试 tracker 写入；绝不重复执行代码开发，也不回滚已合入的正确提交。


