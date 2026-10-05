---
name: yjx-wayfinder
description: 将大型需求或规划拆分为适合并行会话的连贯 decision tickets，使用 yjx-grill 探索，并把有效结论合成为已达成共识的 destination。
disable-model-invocation: true
---

把大到无法在一个会话完成的需求或规划拆成 **decision tickets**：每个 ticket 是连贯的问题，其答案是决策或 verified facts，而不是 implementation slices。独立会话可以并行推进不同 tickets；**map** 在它们的结论形成完整、一致的 **destination** 前保持上下文连接。

destination 定义范围和完成标准。它可以是技术 specification、架构决策、课程大纲、组织计划、书籍大纲或园艺设计。保持工作流 **domain-agnostic**。

## 维护

评审、修改或重新设计本 skill 时，先阅读 [`MAINTENANCE.md`](MAINTENANCE.md)。其中记录 skill 的设计意图、演进理由和反漂移检查；普通运行不需要读取它。

## 规划，不执行

Wayfinder 默认只做 **planning**。交付 Destination 承诺的决策、证据和规划产物，而不是其中描述的实现。记录在 **Notes** 中的明确 execution authorization 可以扩展工作范围；记录决策、关闭 ticket 或调用 helper skill 本身永远不会授予该授权。

## 按名称引用

每个 map 和 ticket 都是 issue，因此都有一个 **name**，即标题。在人类阅读的所有内容（叙述、map 的 Decisions-so-far）中都用该名称引用，不要只写 id、编号或 slug。把链接包在名称中，例如 `[<title>](link)`，不要让裸数字代替名称。

## Map

map 是本仓库 issue tracker 中带有 `wayfinder:map` label 的单个 issue，是 canonical artifact。它的 tickets 是 map 的 child issues。

map 是 **index**，不是 store。详细结论存放在各自 tickets 中；map 只做摘要和链接，并明确区分有效结论、under review 结论和 superseded 结论。最终产物综合这些来源，不引入第二套决策。

map、child tickets、blocking 和 frontier 查询的物理位置由 tracker 决定。阅读 tracker 文档的 “Wayfinding operations” 章节，了解本仓库如何表达它们。没有配置 tracker 时，默认使用 local-markdown tracker。

### Map 正文

加载这份低分辨率视图来定位每个 session；在修改前按[轻量并行更新](#轻量并行更新)刷新它。通过 tracker 发现开放子项，不要在 map 中重复维护它们的状态。

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

## Ticket 粒度

A ticket 应该值得单独开一个会话，但不能让会话不堪重负：

- **有用结果**：答案可被另一个 session 复用，而不只是服务于一次对话轮次。单个关键事实也可以成为 research ticket 的充分理由。
- **连贯讨论**：让紧密耦合的选择共享上下文和 trade-offs。如果不同 session 会反复协商相同选择，说明拆分可能过细。
- **完成空间**：为调查、讨论、验证和记录答案留出足够注意力。多个独立上下文或未解决分支争夺同一注意力时，通常说明需要拆分。

不要按固定 token 数、轮数或“一 ticket 一决策”来决定粒度。调整大小时保留原始问题和已确认的部分结论。只有问题 ready 时才把它从 fog 移入 ticket；否则留在 fog 中。关闭收窄后的 ticket 前，验证每个下游依赖仍指向它真正需要的工作。如果无法安全表达，保留原 ticket 未完成，不要声称被省略的前提已完成。

上下文高度重叠且尚未领取的 tickets 可以合并。保留它们的身份/历史，并指向保留下来的问题；废弃重复项前先重定向受影响的依赖。合并或取消不得错误解除未完成工作的阻塞。

### Ticket Body Format

每个物理 ticket 都是 map 的 child issue：

```markdown
## Question

<the bounded question and what answering it sufficiently means>
```

只添加独立工作所需的上下文：相关前提/证据链接，以及与相邻问题的边界。每个 ticket 按 tracker 约定带有 `wayfinder:<type>` label。

## Frontier 与 Fog

**只有 ready questions 才能创建新 tickets**：问题必须属于 destination 范围、足够明确可讨论，并由已确定且仍有效的前置条件支持。下游、条件性、被阻塞或过于粗略的问题留在 **Not yet specified** 文本中。现有 ticket 后续可以被阻塞，但不能丢失其身份或历史。

**frontier** 是实质前置条件仍成立、开放、未阻塞且未领取的子项集合。tracker 关闭本身不能证明前提有效。使用已配置的 tracker 状态和依赖关系；review annotation 不是新的 status enum，`claimed` 也不能替代 blocked。

收到答案或新证据后，重新检查受影响的 fog 和新发现的问题：

- **Graduate**：问题仍然必要且现在 ready。检查是否已有等价 ticket，创建或复用它，并在删除对应 fog 文本前确认其持久身份。
- **Retain**：问题仍然需要，但条件或讨论范围尚未确定。
- **Prune**：答案使该分支不再必要。删除 fog 前，把理由记录在致因 ticket 的结论中；没有对应 ticket 时记录到 map note。

错误的分支条件不会自动变成 **Out of scope**。该章节只用于真正的 destination 边界；关闭已有 out-of-scope tickets 时记录真实理由，不要虚构决策。不要仅为了给排除项或已裁剪分支增加链接而创建 tickets。

## 轻量并行更新

独立 session 可以并行推进。claim 和 refresh 是 **best-effort coordination**，不是锁，也不保证原子性、互斥或零丢失更新。不要添加中央协调器、租约或新的 tracker protocol。

1. **领取前读取**：即使 ticket 由用户指定，也要检查当前状态、blockers、前提有效性和所有权。开始工作前通过 tracker 领取 ready ticket。记录足够的所有权上下文，区分共享同一 assignee 的 session；同一账号不等于所有权。只有确认所有权或存在明确 handoff 时，才恢复已有 claim。
2. **每次修改前刷新**：写入时读取最新 ticket 和 map。重新检查 claims、状态和相关前提。只把当前 ticket 的变更合并到最新内容，保留无关更新；不要整体提交 session 旧版 map。发生冲突时重新评估，不要直接覆盖。
3. **删除前持久化**：重试前检查已有 resolution、child 或 index entry。关闭或删除来源备注前，保存结论并确认已创建/复用的 ticket 引用。保留成功步骤，并记录部分失败后剩余的工作。
4. **回读**：验证目标更新和保留的相邻内容。发现冲突时重新读取并协调不冲突变更；矛盾结论保持未解决，不要静默选择赢家。这项检查不能消除剩余的竞态窗口。

如果另一个 session 拥有受影响的 ticket，记录变化的前提，但不要接管其 claim。关闭前由原 owner 重新验证答案的前提。中断后，在重新开始工作或委托前检查已有结果和未完成更新。

## Ticket 类型与 Skill 委托

每个 ticket 都是 **HITL**（与代表自己发言的人类共同处理）或 **AFK**（自主驱动）。结果格式不会改变该义务：绝不能为了绕过确认而把 HITL ticket 重新分类。如果 AFK 答案需要人类选择或重要但无支持的推断，就保持未解决，获取证据或通过 HITL 讨论处理。

- **`grilling` (HITL)**: Align on core trade-offs, scope boundaries, and decision forks. Delegate to the `yjx-grill` skill. Treat it as a black-box alignment engine and accept either a Direct Result or an approved Formal Contract under [Alignment Result Handoff](#alignment-result-handoff). Always consult `domain-modeling` alongside if domain terminology or models are involved.
- **`research` (AFK)**: Use `research` to investigate facts against authoritative evidence, recording sources and limits. Resolve only what the evidence supports; do not turn an unresolved product choice into a factual answer.
- **`prototype` (HITL)**: Produce a disposable artifact suited to the domain, such as an outline, spatial sketch, or UI/logic spike. Use `prototype` when its capabilities fit. Bound its write scope and capture the artifact, observations, and human conclusion; helper instructions to fold a result into production do not authorize implementation.
- **`task` (HITL or AFK)**: Non-decision manual work that must happen before a decision can be made (e.g. provisioning access, running a data-sampling query, measuring physical dimensions). Output facts and environment status; do not implement production deliverables.

### 讨论范围

给 alignment skill 当前问题、充分回答标准、相关已确认前提以及与其它问题的边界。宏观 charting 关注 destination 和问题空间的广度；ticket 工作关注该 ticket 的连贯问题。这些是语义输入，不是对 `yjx-grill` 内部章节的假设。

新发现的、可能改变当前答案有效性的前置条件，必须调查、讨论或明确保留为 blocker。后续消费该答案的问题应回到 map 的 [Frontier 与 Fog](#frontier--fog)。完成 ticket 范围即可，不要假装整个工作已完成，也不要追逐所有下游分支。

### Research 所有权

发起 session 负责领取、收集、验证和记录自己的 research 结果。worker 返回证据，不独立关闭 tickets 或修改共享 map。选择一层委托，不要通过 helper 递归生成 workers。

临时 worker 必须在同一 session 中回收。只有宿主真正支持持久执行和结果恢复时，才允许跨 session research；持久化 owner、task/result pointer 和剩余步骤。单独一个 pointer 不能维持 Agent 存活。如果无法保证回收，就把 research ticket 留给另一个 session，不要启动它。pending 或失败的 research 不是 resolution；恢复时先检查已有 task 或结果，再启动新的。

### 对齐结果交接

这些 receipt 规则适用于用户和宿主允许的对齐之后；它们不会改变 invocation permissions。

Direct Result 可能包含 verified facts、已回答的用户意图和 Agent 推断。保留这些来源，不要把整个结果当作事实或已批准 contract。未批准的 contract candidate 不是已批准的 Formal Contract。

关闭 HITL ticket（包括 `grilling`）前，确认实时人类确认明确覆盖最终结论，以及解除下游阻塞所需的每个重大前提，包括相关 Agent 推断。部分回答或确认不会批准之后新增的内容。未确认的必要前提保持未解决：不要据此关闭 ticket 或升级依赖项。若已有对同一完整范围的明确确认，直接复用，不要重复询问。

Confirmation of a Direct Result here is ticket-conclusion confirmation, not implementation authorization and not a request to turn it into a Formal Contract. A reviewed and approved Formal Contract can likewise settle a planning ticket without implementation authority, subject to the same premise and durable-resolution checks. Preserve any separately established implementation authorization at its actual scope; neither contract approval nor ticket closure grants or enlarges it or starts execution. Confirmed agent inferences retain their source; carry material boundaries and their confirmation scope into the resolution artifact and dependent decisions.

## 决策再验证与取代

当新证据实质挑战某个前提时，通过其 premise links 检查受影响的开放 tickets、已完成结论和 fog。重新检查真实依赖，不要检查所有无关决策。

- **No valid replacement yet**: Reopen the original ticket through the existing tracker lifecycle. Preserve its old answer as history; record the new evidence, affected parts, and question to re-examine. Mark the map entry as under review, not a current valid premise. Restore relevant blocking relationships and reopen affected completed tickets when their own answers need review.
- **A valid replacement exists**: Retain the original as history and link the replacing ticket. Check and update affected downstream premises and blocking relationships to the replacement before treating them as ready; the old ticket's closed state cannot justify readiness.

例如：

```markdown
- ~~[Storage selection](link): PostgreSQL~~ (under review; see the reopened ticket)
- ~~[Earlier storage decision](link): PostgreSQL~~ (superseded by [Embedded storage](link))
- [Embedded storage](link): SQLite for the confirmed local deployment
```

Neither a challenged premise nor a temporary block makes the question out of scope. Do not silently replace a human-confirmed choice. Apply the ticket's confirmation rules to the revised conclusion, then update its index entry and revisit affected questions.

## 调用模式

### Mode 1：绘制 Map（宏观建图）

用户以一个宽泛、需要多个 session 的想法调用本 skill。

1. **Name the Destination**: Use `yjx-grill` under the macro discussion scope to establish the goal, scope boundaries, promised artifact, and completion criteria. Consult `domain-modeling` for key terminology. Survey the question space breadth-first without resolving every downstream detail.
2. **Check whether a map is useful**: Identify ready questions and fog. If the whole effort is clear and small enough for this session, explain that a map is optional and ask how the user wants to proceed.
3. **Create the Map** (label `wayfinder:map`): Preserve the agreed destination and standing constraints, record actual exclusions in **Out of scope**, and sketch deferred questions and their conditions in **Not yet specified**. Start the conclusion index empty.
4. **Create Ready Tickets**: Apply the granularity and readiness criteria, checking existing children first. Keep blocked or speculative future questions in the fog.
5. **Handle Research & Stop**: Dispatch ready research only under [Research Ownership](#research-ownership). Collect temporary workers and record verified results through Mode 2's resolution steps before ending; otherwise leave durable recovery context or undispatched tickets. Charting does not work through HITL decision tickets.

### Mode 2：推进 Map（单票推进与迷雾升级）

用户以 map 或 ticket 调用（例如 `/yjx-wayfinder <map>` 或 `/yjx-wayfinder #N`）。

1. **Orient & Recover**: Load the map, including scope exclusions and Notes; consult named skills as applicable. For a supplied ticket, locate its parent map. Inspect any interrupted work or existing results before continuing.
2. **Choose & Claim**: Validate a specified ticket or select a frontier question, favoring useful bottlenecks. Follow the claim and refresh rules. If there is no ready ticket but unresolved work remains, report the actual blockers or refine the fog; an empty frontier is not completion.
3. **Work the Bounded Question**: Read related premise tickets as needed and use the matching discussion, research, prototype, or prerequisite-task method. Reassess granularity when new evidence changes the scope. Preserve partial results when blocked; do not close an unfinished question.
4. **Record the Resolution**: Revalidate current premises and apply [Alignment Result Handoff](#alignment-result-handoff) to HITL work, or verify the evidence for AFK work. Save the answer through the tracker with its key reasons, necessary evidence/premise links, important rejected alternatives, unresolved neighboring questions, source distinctions, and confirmation scope. Keep detail proportional; link assets rather than pasting them or the conversation. Close only after the answer is durable, then gist and link it in the map, repairing partial updates under the parallel-update rules.
5. **Revisit the Map**: Record newly discovered questions as well as revisiting existing fog. Apply graduation, retention, pruning, or decision revalidation as appropriate. Recording a follow-up does not require solving it in this session.
6. **Hand Off**: Prefer a fresh session for the next coherent ticket, with a name-wrapped link or tracker-appropriate invocation. In-place continuation is an exception for a tightly related follow-up with little context burden, not a fixed turn-count rule.

### Mode 3：Destination 收官（终态收官）

空的 fog 和看似完成的 tickets 只是触发 closeout 检查，并不能证明 destination 已达成。

1. **Check the whole effort**: Read the current map and **all** children, not just the frontier. Any open child (including claimed, blocked, or reopened tickets), unconfirmed conclusion, necessary fog question, or uncollected research result prevents closeout. For each terminal ticket, establish a valid conclusion or an evidenced disposition: scope exclusion, branch pruning, cancellation, or a merge/replacement linked to a ticket with a valid conclusion. `closed` or `wontfix` alone proves none of these. Repair missing result/index updates, and exclude challenged or superseded conclusions from the active decision set.
2. **Check coverage & synthesize**: Compare the effective conclusions with the original destination and completion criteria. Check compatibility, gaps between tickets, and whether the next stage can proceed without guessing important requirements. Synthesize the promised artifact from the ticket details, not only their gists. Ordinary presentation edits are allowed; a new consequential choice, contradiction, or missing prerequisite returns to exploration. Explicitly bound details legitimately deferred to the next stage instead of disguising important unresolved questions as minor parameters.
3. **Deliver & close**: Preserve the original Destination and add the verified artifact link or outcome. Write a promised project document at its agreed location. Refresh the map and children before publishing or closing; relevant changes require reconciliation and a renewed check. Post a closeout summary with the artifact, settled boundaries, and handoff, then close the map. These remain best-effort updates, not a locked snapshot.
