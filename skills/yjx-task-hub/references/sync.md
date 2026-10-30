# TB 收集与生命周期

只在用户要求刷新/整理或明确加入跟进时运行，使用当前 `mcp__teambition_mcp__*` 工具；工具不可用时停止 TB 分支。完整处理顺序是：核对配置和身份 → 持锁与未决检查 → 完整 Notion 清单 → 发现新候选/刷新已跟踪 → 写入协议 → 核对 `stop` 覆盖率并汇报。协议命令及标准化形状见 [本地写入协议](operations.md)。

## 候选发现

调用 `SearchUserTasksV3(roleTypes="executor", tql="isDone = false AND isArchived = false")`，保持筛选条件遍历 `nextPageToken` 直至空；短页、count、最后一个非空页都不是终止依据。分页不保证并发快照一致，按 taskId 去重并在收录前重新读详情。明确出现范围外记录或分页失败时停止本次候选覆盖声明。

MCP 返回的 `content[].text` 通常是 JSON：先检查工具错误及业务 `code`，再取 `result` 数组（详情也是数组）。按接口当前字段适配，不能假定 native SDK 形状：

| TB 字段 | 协调器 task 字段 | 核实要求 |
| --- | --- | --- |
| taskId | id | 唯一 24 位小写 ObjectId |
| content | title | 非空标题 |
| executorId | executorId | 明确 ID；明确无执行人才传 null，字段缺失是未知 |
| executorId | executorName | executorId 非空时：等于 tbUserId 用 GetUsersMe 核实的本人姓名；其他非空 ID 按需去重调用 PostV3MemberQuery(userIds="<id1>,<id2>") 解析唯一有效 name；接口不可用或未唯一匹配时省略并报告 |
| isDone / isArchived | 同名 | 显式布尔值，不从显示名称猜测 |
| created / updated | createdAt / updatedAt | 原 ISO 8601 时间；保留时区 |
| parentTaskId | parentId | 直接父任务；ancestorIds 仅作必要上下文 |
| tfsId | statusName | 用 SearchTaskflowStatusesV3 / QueryTaskTfs 按项目、状态 ID 映射 |
| dueDate | dueDate | 按当前返回值核实，有值才初始化 |
| sprintId | iteration | 按 projectId 和 sprintId 查询 SearchSprintsV3 的唯一名称；明确 sprintId 为 null 时传 null，缺失、查询失败或未唯一匹配时省略 iteration 并报告，保留 Notion 原值 |
| 项目 prefix + uniqueId | shortId | 必须核实项目前缀，不跨项目拼错 |

自动新候选：自己负责、未完成、未归档，且不存在于完整 Notion 来源索引、忽略名单或未决操作；`max(created, updated)` 在滚动 `activeWindowDays` 内（默认 90 天）才列候选。时间未知单独报告，不当作陈年单静默丢弃。窗口只影响发现，不裁剪任何已跟踪项或显式报单。

先按身份、状态布尔值、去重、忽略名单和时间窗口确定候选范围，再为候选及时间未知项映射状态名称，随后提交完整列表给 `candidates`。已排除的旧单和忽略单不需要状态名称；有效候选在生成写入计划前再核实迭代与负责人姓名。

不以“有父任务”过滤。按父任务聚合候选：
- 组内仅 1 条且父任务未在清单中跟踪（`autoIntake: true`）：重读详情核实仍在活跃候选范围后，按 executor 自动收录为 `待安排`（`prepare` 传 `confirmed: true`）。
- 父任务已在清单中跟踪，或同父有 2 条及以上候选（`decisionGroups`）：分组展示标题、来源链接、父任务和建议粒度，由用户选：跟踪子单、跟踪父单或忽略。未回答保持未收录。

读取父单用 `QueryTaskV3(taskId=<parentTaskId>)`；其 `parentTaskId` 参数用于找子单，不能用于读父单。选择父单时先核实详情：自己负责按 executor，否则加入 watched；未入库子单仅按明确选择忽略，已有子单单独处理，不默认删除/完成。用 `configure` 写入被确认的 watchedTasks/ignoredTaskIds；忽略持续有效直到用户撤销。

## 显式报单

用户明确说加入/跟进某单时，绕过活跃窗口与忽略名单，先精确定位：短 ID 通过 `QueryProjectsV3(uniqueIdPrefix)` + `SearchProjectTasksV3(projectId,q="uniqueId = <id> AND isArchived = false")` 唯一定位；ObjectId 用 `QueryTaskV3(taskId)`。短 ID 查不到但可能归档时报告范围限制，不编造无此单。歧义、无权限或返回目标不一致时停止该项。

明确“跟进”加入 watched（即使当前负责人是自己）；仅要求收录自己的单可用 executor。从 ignored 移除同一 taskId，再按唯一来源复用/创建页面。明确加入指令已覆盖该项，无需再次确认同一入库选择。无法定位的单号保留待处理，不伪造 taskId。

## 已跟踪刷新

完整读取 Notion 全库，建立 `taskId → 页面集合`；重复标识阻断该项全部写入。刷新集合为全部合法 TB 来源记录（包括人工完成与自动完成项）并集 watchedTasks：
1. 每项通过 `QueryTaskV3(taskId)` 读完整最新详情；
2. 按项目去重批量调用 `SearchTaskflowStatusesV3`（映射 `statusName`）与 `SearchSprintsV3`（核实非空 `sprintId` 对应的迭代名称，禁止不查 TB 直接把 Notion 旧迭代值原样塞回）；
3. 对非本人的非空 `executorId` 去重后调用 `PostV3MemberQuery(userIds="<id1>,<id2>")` 批量映射 `executorName`；
4. 对刷新集合中的**每一项**调用协调器 `plan`：无实质变化项由协调器直接返回 `unchanged: true, committed: true` 并更新本地基线，无需外部写入 Notion；仅存在实际变化或新建项才进入 `prepare → dispatch → Notion 写入 → commit`。

新 watched 尚无页面时按明确收录指令或待确认候选处理。列表未出现、权限丢失、空结果、字段缺失不证明转派或完成，保留原状态并报告。同步结束调用 `stop` 时，必须确认返回的 `syncCoverage.unplannedTrackedKeys` 为空且 `candidatesChecked === true`。

## 状态转换

代码 `engine.mjs` 为可执行判定真源；以下约束是 agent 执行和交付时必须保留的语义：

1. 先处理 dispatched 未决；关键来源未知时不改状态。已观察到个人状态不再为已完成时，失效旧自动完成标记。watched 配置优先，进出模式清除旧标记并建立新基线；移出 watched 且当前他人负责为 inactive，不当作转派。
2. 本地基线缺失：watched 优先，否则自己负责为 executor，其余 inactive；不追溯推断转派、自动完成或重开。inactive 后来指派给自己则恢复 executor 建新基线；若个人已完成而 TB 仍未完结，提示用户是否重开。

| 已核实情况 | 个人状态 | 来源状态与反馈 |
| --- | --- | --- |
| watched / inactive | 保留 | 刷新快照；watched 在 TB 完结/归档时提示收尾 |
| executor，上次自己负责，本次明确其他人负责 | 非完成 → 已完成 | 记录转派；仅本次确实自动完成才产生自动完成标记 |
| 曾自动完成、当前个人仍完成，现转回自己且 TB 未完成未归档 | 已完成 → 待安排 | 消费标记，显著提醒重开 |
| 自己负责，TB 已完成/归档 | 保留 | 提示确认个人后续动作是否结束 |
| 其余（含无人负责、用户手动提前完成） | 保留 | 刷新快照与负责人基线 |

外部写入明确返回成功（返回 `page_id` 且无 `isError`）后才提交新基线；已跟踪且页面属性无变化的条目由 `plan` 直接确认本地基线。显式跟进单不会因负责人是他人而自动结束。本地基线记录基于本轮初始 `inventory` 快照与 API 明确成功响应确认的拟写结果；跨会话并发修改留待下一轮全表 `inventory` 读取时发现。
