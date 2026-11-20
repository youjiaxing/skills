---
name: yjx-wayfinder
description: 将大型需求或规划拆分为适合并行会话的连贯 decision tickets，使用 yjx-grill 探索，并把有效结论合成为已达成共识的 destination。
disable-model-invocation: true
---

# yjx-wayfinder

把大到无法在一个会话完成的需求或规划拆成 **decision tickets**（每个 ticket 解决一个连贯问题，产出决策或已核实事实，而非 implementation slices）。独立会话并行推进 tickets，由一张 **map** 在达成完整 **destination** 前保持上下文连接。全流程保持 **domain-agnostic**（代码架构、课程、书籍或园艺规划通用）。

## 维护

评审、修改或重设计本 skill 时先阅读 [`MAINTENANCE.md`](MAINTENANCE.md)；运行时不读取。

## 核心规则

- **规划，不执行**：默认只交付 Destination 承诺的决策、证据与规划产物。仅 **Notes** 中明确写入的 execution authorization 可扩展为实施；记录决策、关闭 ticket 或调用 helper skill 均不授予实施授权。
- **按名称引用**：每个 map 和 ticket 在面向人类的叙述与 `Decisions so far` 中均以标题链接 `[<title>](link)` 引用，不使用裸数字、ID 或 slug 代替名称。
- **Map 即索引（Index, Not Store）**：map 是本仓库 tracker 上带 `wayfinder:map` label 的 canonical issue，只存 Destination、Notes、单行结论索引、fog 与 Out of scope；详细论证存各自 child tickets，不在 map 重复维护子项状态。物理定位见仓库 tracker 文档的 **“Wayfinding operations”** 节（未配置时默认 local-markdown tracker）。
- **Frontier 与 Fog**：只有属于 destination、明确可讨论且前提成立的 **ready questions** 才能建新 ticket（模板见 [Tracker 协议与模板](references/tracker-and-handoff.md)）。条件性、被阻塞或粗略问题留在 **Not yet specified**（fog）。**frontier** 是前提有效、开放、未阻塞且未领取的 ready child tickets；已有 ticket 可后续变阻塞（保持身份与历史），review 标注不是新 status enum，`claimed` 不替代 `blocked`。
  - 前提更新后重检受影响 fog：**Graduate**（仍必要且已 ready → 先查是否已有等价票并确认持久身份后再删 fog）、**Retain**（仍需但条件未定）、**Prune**（已不再需要 → 在致因 ticket 结论或 map Note 记录原因后删除 fog，不虚构为 Out of scope，也不为裁剪项单建票）。
- **粒度、并行与交接参考**：ticket 粒度调优、Map/Ticket/取代格式模板、轻量并行 4 步读写协议（`领取前读取 → 修改前刷新 → 删除前持久化 → 回读核对`）、`对齐结果交接` 与 `决策再验证与取代` 细节，按需读取 [Tracker 协议、并行协同与交接模板](references/tracker-and-handoff.md)。

## Ticket 类型与委托

每个 ticket 明确归为 **HITL**（人类共同参与）或 **AFK**（自主推进）；结果格式不改变义务，AFK 遇人类选择或无支撑重大推断时保持未解决或转 HITL。

- **`grilling` (HITL)**：对齐核心 trade-offs、范围边界与决策分叉。委托给 `yjx-grill`（黑盒对齐引擎，同时接受 Direct Result 与已批准 Formal Contract，不硬编码其内部章节）；涉及领域术语或模型时同步查阅 `domain-modeling`。只传入当前问题、充分回答标准、有效前提与相邻边界；新发现且影响当前答案的前提可在本票解决或保留为 blocker，后续衍生问题交回 map，不追逐所有下游分支。
- **`research` (AFK)**：使用 `research` 基于权威证据查证事实并记录来源与限制，不把未定产品选择编成事实。
- **`prototype` (HITL)**：产出适配领域的一次性探索原型（视觉/交互/逻辑状态优先调用 `yjx-prototype`，不可用且能力匹配时退回 `prototype`；非软件领域保留对应草图/大纲）。限定写范围并记录产物、观察与人类结论；helper 中“折入生产”的建议不授予实施权。
- **`task` (HITL / AFK)**：决策前必需的非决策准备工作（如开通权限、采样查询、物理测量）；只输出事实与环境状态。

**Research 所有权**：发起 session 负责领取、回收、验证并记录结果；worker 只交回证据，不独立关票或改共享 map，单层委托（Start every subagent with a fresh context window (do not fork the current conversation).）。临时 worker 须在同一 session 内回收；仅当宿主真正支持持久执行与结果恢复时才可跨 session 挂接（持久化 owner、pointer 与剩余步骤）；否则把 research 留作未领取 ticket 交下一会话。恢复前先查已有 pending/结果再启新任务。

## 工作模式

### Mode 1：绘制 Map（宏观建图）

以宽泛、跨会话需求触发时执行：

1. **定义 Destination**：在宏观广度下调用 `yjx-grill` 确立目标、范围边界、承诺产物与完成标准（术语关键时配合 `domain-modeling`），不提前钻入下游实现细节。
2. **判断 Map 必要性**：识别 ready 问题与 fog；若整体清晰且单会话即可完成，告知用户 Map 可选并确认推进方式。
3. **创建 Map**（label `wayfinder:map`）：按 [模板格式](references/tracker-and-handoff.md#模板格式) 建票，填入 Destination、Notes 与真实的 **Out of scope**，未就绪问题放 **Not yet specified**，`Decisions so far` 初始留空。
4. **实例化 Ready Tickets**：按粒度与就绪门槛建首批 frontier 票（先查已有子票），被阻塞或推测性问题留 fog。
5. **处理 Research 并收尾**：仅按 `Research 所有权` 派发 ready research 并回收记录；不通过宏观建图强推 HITL 决策票。

*完成条件*：Map 已创建且索引准确，首批无阻塞 frontier 或可恢复指针已就绪。

### Mode 2：推进 Map（单票推进与迷雾升级）

以 map 或具体 ticket（如 `/yjx-wayfinder <map>` 或 `/yjx-wayfinder #N`）触发时执行：

1. **定位与恢复**：加载 map（含 Out of scope 与 Notes，查阅指定 skills）；传入单票时定位父 map，先检查未完成更新或中断结果。
2. **选票与领取**：校验指定票或从 frontier 选择关键瓶颈票，按 [轻量并行更新](references/tracker-and-handoff.md#轻量并行更新) 领取并保留同一账号会话区分上下文；无 ready 票但仍有未决工作时如实报告 blockers 或细化 fog（frontier 为空不等于完成）。
3. **收敛边界问题**：读取相关前置票，按类型执行 `grilling`/`research`/`prototype`/`task`；遇新证据改变范围时重估粒度，受阻则保留部分结果不关票。
4. **持久化结论**：重检前提并执行 [对齐结果交接](references/tracker-and-handoff.md#对齐结果交接)（HITL 确认完整结论与重大下游前提；AFK 核验证据）。在 ticket 记录核心理由、证据/前提链、重要被拒方案、未解相邻问题、来源区分与确认范围（链接资产不粘贴原对话），持久落盘后关票并按名摘要入 map。
5. **回访 Map**：录入新问题并重检受影响 fog（Graduate / Retain / Prune）或触发 [决策再验证与取代](references/tracker-and-handoff.md#决策再验证与取代)。新衍生问题只记录不强求本会话解决。
6. **交接下一会话**：默认每完成一个连贯 ticket 后交接至新的干净会话（附标题链接与入口）；仅当紧耦合追问上下文极轻时才原位继续。

*完成条件*：目标票已持久收敛或明确记录阻塞，map 索引与 fog 同步刷新。

### Mode 3：Destination 收官（终态合成）

fog 清空与子票关闭仅是触发收官检查的信号，不直接证明达成：

1. **全量子票清点**：读取最新 map 与**全部**子票（不止 frontier）。存在任何开放子票（含已领取/阻塞/重开）、未确认结论、必要 fog 或未回收 research 即阻止收官。每张终态票必须具备有效结论或带依据处置（范围排除、分支裁剪、取消，或链接到有效替代票的合并/替代——仅有 `closed` / `wontfix` 状态不足为凭）；补齐缺失索引，从有效决策集中剔除待复核或已取代条目。
2. **覆盖度检查与合成**：逐项核对有效结论与原 Destination 及完成标准，检查结论兼容性、衔接缺口与下游猜测风险；**基于 ticket 详情（而非仅 map 一句话摘要）** 合成承诺产物，只做表达润色，发现重大缺失、矛盾或未决前提即退回探索；合法留待下一阶段决定的参数显式声明边界。
3. **交付与关闭**：保留原 Destination 并附上产物链接/约定路径文档；发布或关闭前按并发规范刷新 map 与子票，在关闭前补发含产物、已定边界与交接说明的总结并关闭 map（承认并发读写下的 best-effort 极限）。

*完成条件*：全部子票具合法终态处置，承诺产物已依据有效结论完整合成并回读一致，map 已收官关闭。
