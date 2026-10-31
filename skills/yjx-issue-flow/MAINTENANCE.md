# Maintenance: yjx-issue-flow

评审、修改或重新设计 `yjx-issue-flow` 前请先阅读本文档。`SKILL.md` 与 `references/` 承载运行时指令；本文档记录设计意图、演进权衡与静态反漂移检查，普通运行时无需读取。

## 1. 定位与演进背景（与 `implement-spec` 的对比）

`yjx-issue-flow` 面向项目级已配置 issue tracker 中的多目标实施编排。与轻量流水线技能 `implement-spec` 相比，两者的核心取舍如下：

- **复杂票据治理 vs. 纯平铺任务图**：`implement-spec` 假设输入已是平铺且全部可编码的 tickets；`yjx-issue-flow` 必须处理父子递归树、多目标去重、Wayfinder 规划票隔离、`ready-for-human` / `needs-info` 门禁、局部阻塞隔离以及单票自动降级。
- **吸收 `implement-spec` 的三项长处**：
  1. **前置共享探索（Shared Exploration）**：同域多票执行前允许通过只读探索子代理生成 `./tmp/research/<run-slug>.md`，避免多个并行 worker 重复扫描同一代码库；
  2. **指针优先交接（Context Pointers）**：交接仅传递 issue 标识、文档路径、基线 SHA、上游交付 SHA 与探索笔记路径，不复制粘贴 issue 正文；
  3. **Worktree 分支开发与主基线合入解耦**：避免多个并行 worktree 争抢检出同一集成基线分支。

---

## 2. 核心架构权衡与理由

### 1. 为什么默认使用“跨宿主独立会话/任务 Worker”，而不是普通子代理？

- **问题**：
  1. 若在文档中硬编码 `Codex task`，会破坏本仓库跨 Claude Code、Codex、Antigravity 等多平台的通用性；
  2. 若把 Worker 直接降级为协调器的普通内存态子代理（Subagent），会引入两个严重缺陷：一是部分 Agent 宿主禁止子代理再嵌套创建二级子代理，导致 Worker 在执行 `yjx-implement` 时无法启动 `/code-review` 的双轴独立评审子代理；二是普通子代理与当前回合强绑定，不如独立会话具备清晰的持久会话上下文。
- **设计**：
  - 使用宿主无关的**独立顶层会话/任务（Independent Session/Task）**作为默认 Worker 载体。在支持会话编排的宿主中，Agent 重启后协调器会话与各 Worker 会话依然持久存在，可直接重连恢复，且 Worker 内部拥有完整的一级子代理委派能力。
  - 仅在不支持跨会话编排的宿主中回退到全新上下文隔离单元；若该宿主同时禁止子代理嵌套，则由 Worker 返回实现与验证证据包，交由拥有一级权限的协调器代为触发独立评审子代理。

### 2. 为什么必须保留 `local` 与 `worktree` 双轨工作区，而不是强制 Worktree？

- **问题**：部分特殊项目（如包含固定绝对路径依赖、特殊硬件/容器挂载、或超大未忽略构建缓存的仓库）不支持或明确禁止使用 `git worktree`。若照搬 `implement-spec` 强制每张票创建 worktree，会导致这些项目无法使用本技能。
- **设计**：
  - 严格保留 `workspace: auto|local|worktree`。只要项目规则禁止 worktree 或用户指定 `local`，即锁定为 `local + serial`（单工作区串行模式），在当前目录原地按依赖顺序逐票闭环，绝不创建 worktree。
  - 当允许使用 `worktree` 并行时，采用**两阶段无锁集成**：Worker 在各自 worktree 分支内先合入最新集成基线消解冲突并自验，返回 `ready-to-integrate`；协调器在主工作区按序合入集成基线。因为 Git 不允许两个 worktree 同时 `checkout` 同一分支，这种拆分既避免了分支占用报错，又遵守了“协调器不直接写业务代码或手动解冲突”的边界（一旦基线前进引发冲突，立即 `git merge --abort` 并退回原 Worker 在其 worktree 中处理）。

### 3. 为什么共享探索必须落在 `./tmp/research` 并强制校验 Git 忽略？

- **问题**：将探索笔记写在仓库外随机临时目录不利于工作区路径管理，而写在 `docs/research/` 或未忽略目录则会污染工作区 Git 状态甚至被误提交。
- **设计**：遵循仓库 `AGENTS.md` 的临时研究规范，固定使用工作目录下的 `./tmp/research/<run-slug>.md`。写入前必须确认 `./tmp/` 已被 `.gitignore` 或 `.git/info/exclude` 忽略；运行收尾时仅清理本次运行生成的 `<run-slug>.md` 文件，不误删其它任务的临时文件。

### 4. 为什么主从文档必须严格按信息层级去重？

- **问题**：早期版本在中文 `SKILL.md` 与英文 `references/flow-rules.md` 中将相同规则用中英文各写了一遍。这不仅浪费上下文窗口，还导致 Agent 读完主文件后误以为已掌握全部规则，跳过参考文件中独有的 Handler 4 级优先级、Wayfinder 边界和恢复细则。
- **设计**：`SKILL.md` 只保留四阶段有序主干步骤、阶段 `*Completion Criterion*` 与单一触发指针；分流细则、双轨集成门禁与报告 Schema 统一用中文沉淀在 `references/flow-rules.md` 与 `references/worker-contract.md` 中，确保每条规则只有一个权威真源。

---

## 3. 静态反漂移检查清单（Anti-Drift Checks）

在评审或修改本 skill 时，使用以下静态检查清单核验（遵守仓库规范，不为 skill 提示词编写模拟对话行为测试）：

- [ ] **无单一平台硬编码**：`SKILL.md` 与 `references/` 正文中不再将 Worker 硬编码为 `Codex task/worker`，保持跨 Agent 宿主可移植表述。
- [ ] **子代理上下文隔离原语齐全**：所有触发子代理的站点均显式包含 `Start every subagent with a fresh context window (do not fork the current conversation).`。
- [ ] **保留 `local` 无 Worktree 轨道**：`local + serial` 模式畅通，绝不强制所有项目创建 Git worktree。
- [ ] **并行 `worktree` 无检出冲突与基线回归门禁**：`worktree` 模式下 Worker 不 checkout 主集成基线分支；包含 `ready-to-integrate` 状态、`Baseline SHA` / `Delivery SHA` 核对、基线前进后的冲突退回原 Worker 机制以及无冲突合入后的验证门禁。
- [ ] **`./tmp/research` 与版本控制忽略保护**：前置共享探索固定写入 `./tmp/research/<run-slug>.md`，包含写入前的 Git 忽略检查与收尾时的按文件精准清理。
- [ ] **指针优先交接**：`worker-contract.md` 通过上下文指针传递 issue 与文档位置，不要求复制粘贴整篇 issue 正文。
- [ ] **单一真源与阶段门禁**：`SKILL.md` 四个阶段均具备可核验的 `*Completion Criterion*`，且与 `references/` 之间无大段重复条文。
