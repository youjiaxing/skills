# Tracker 协议、并行协同与交接模板

本文件承载 `yjx-wayfinder` 的 Map / Ticket 文档模板、轻量并行读写协议、对齐结果交接细则与决策取代协议，保持主入口聚焦核心心智模型与三种调用模式。

## 模板格式

### Map 正文格式

```markdown
## Destination

<目标、范围、承诺产物和可观察完成标准；保持简洁，并在 closeout 中保留>

## Notes

<领域背景；每个 session 都应查阅的 skills；本次工作的长期偏好>

## Decisions so far

<!-- 单行结论和链接；标记历史或 under-review 条目，避免被误认为当前前提 -->

- [<ticket title>](link): <one-line gist of the conclusion>

## Not yet specified

<!-- 范围内但尚未 ready 创建新 ticket 的问题；记录相关条件和前置链接，不要记录推测性 issue 树 -->

- [ ] <question or area to clarify; when it matters and what it waits on>

## Out of scope

<!-- 实际范围排除项及理由；只有已有 ticket 时才添加 ticket 链接 -->

- <excluded work>: <why it is beyond this destination>
```

### Ticket 正文格式

每个物理 ticket 是 map 的 child issue，按 tracker 约定附 `wayfinder:<type>` label，只附带独立工作必需的前提/证据链接与相邻边界：

```markdown
## Question

<the bounded question and what answering it sufficiently means>
```

### 决策取代索引格式

```markdown
- ~~[Storage selection](link): PostgreSQL~~ (under review; see the reopened ticket)
- ~~[Earlier storage decision](link): PostgreSQL~~ (superseded by [Embedded storage](link))
- [Embedded storage](link): SQLite for the confirmed local deployment
```

## Ticket 粒度与收窄/合并

ticket 应值得单独开一个会话而不使其不堪重负：**有用结果**（结论可供后续 session 复用；单个关键事实也可立项 `research`）、**连贯讨论**（紧耦合选择同窗权衡）、**完成空间**（留足调查与验证注意力，多条无关分支竞争注意力则拆分）。不以固定 token 数、轮数或“一 ticket 一决策”机械定粒度。

- **收窄/拆分**：保留原始问题与已确认部分结论；只将 ready 问题放入 ticket，未就绪部分留在 fog；关闭收窄后的 ticket 前确认每个下游依赖仍指向它真正需要的工作，否则保留原 ticket 未完成。
- **合并未领取重复项**：上下文高度重叠且尚未领取的 tickets 可合并，保留身份与历史，废弃重复项前先重定向受影响依赖；合并或取消不得误解除未完成工作的阻塞。

## 轻量并行更新

独立 session 并行推进时，claim 与 refresh 是 **best-effort coordination**，不引入中央协调器、锁、租约或新 tracker 协议：

1. **领取前读取**：即使由用户指定 ticket，仍核查当前状态、blockers、前提有效性与所有权；通过 tracker 领取后，记录足以区分同一账号不同 session 的上下文（`同一账号不等于所有权`），仅在确认本人所有权或明确 handoff 时恢复既有 claim。
2. **每次修改前刷新**：写入前拉取最新 ticket 与 map，复核 claims、状态与前提；仅合并当前 ticket 的增量变更并保留他人无关更新，禁止覆盖整篇旧版 map；遇冲突先重估。
3. **删除前持久化**：保存结论并确认新建/复用 ticket 的持久引用后，再清理或关闭来源 fog 备注；部分失败时保留已成功步骤并记录剩余项。
4. **回读核对**：写入后回读确认目标更新及保留内容完整；互相矛盾的结论保持未解决并显式标记，不静默择一。此步可发现冲突但不能消除并发窗口。

若受影响 ticket 归属其他 session，记录变更的前提由原 owner 在关闭前复核；会话中断后恢复时，先检查已有结果与未完成更新再重开工作。

## 对齐结果交接

适用于用户与宿主允许对齐之后，不改变调用权限；`HITL` 与 `AFK` 义务不可由输出格式改写——AFK 若遇人类偏好或重大无支撑推断，保持未解决或转 HITL 讨论。

- **来源区分**：Direct Result 混含已核实事实、用户确认意图与 Agent 推断，记录时分别保留来源；未获批准的 contract candidate 不是 Formal Contract。
- **HITL 闭环门禁**：关闭 `grilling` 等 HITL ticket 前，确认实时人类确认已完整覆盖**最终结论**以及解除下游阻塞所需的**全部重大前提（含 Agent 推断）**；部分确认不批准后续新增内容，未确认前提保持未解决。对同一完整范围已获明确确认的直接复用，不重复询问。
- **授权隔离**：确认 Direct Result 或批准 Formal Contract 仅用于结算规划 ticket，不自动要求转成契约，也不授予或扩大生产实施授权；任何既有的实施授权保持原范围，确认后的推断仍保留其推断归属进入交付产物。

## 决策再验证与取代

当新证据实质挑战已有前提时，沿 premise links 只核查真实受影响的开放 tickets、已完成结论与 fog，**不得**把受挑战或临时阻塞误归为 Out of scope，也不静默覆盖人类已确认选择：

- **尚无有效替代**：按现有 tracker 生命周期重开原 ticket，保留旧答案作历史，记录新证据、受影响部分与待复查问题；在 map 标记为 `under review`（不再作有效前提），恢复相应阻塞关系并在必要时重开下游受影响已完成票。
- **已有有效替代**：保留旧 ticket 作历史并链接新替代票；更新下游前提与阻塞关系指向新票后才可恢复就绪判断（旧票 `closed` 状态不能单独证明可用）。修正后的结论仍须走对应确认流程再更新 map。
