# 本地写入协议

本协议只处理个人总清单属性与 TB 同步；项目页正文、模块表和项目待办走[项目写入协议](project-operations.md)。

协调器只管理本地状态与计划，**不会调用 Notion/TB**。Agent 根据返回的计划调用当前 MCP 工具，并将真实响应结果送回协调器。写入授权来自用户指令及已配置规则，JSON 的 confirmed 是 agent 对已存在授权的记录，不是向用户另设固定措辞。

## 持锁会话与标准输入

```text
node <skill-dir>/scripts/hub.mjs start
node <skill-dir>/scripts/hub.mjs start --sync
node <skill-dir>/scripts/hub.mjs request --session <start返回的token> [--file <json-path>]
node <skill-dir>/scripts/hub.mjs stop --session <token>
```

`start` 启动独立本地 Node 协调进程，持有 lock.json 跨越多次 MCP 调用；Windows 使用本地 named pipe，POSIX 使用私有根内 socket，未开放 HTTP 端口。进程只为当次操作持锁，结束或等待用户决定新候选时 stop，下次重新 start/读取。协调器默认以 30 分钟空闲 watchdog 兜底（`YJX_TASK_HUB_IDLE_TIMEOUT_MS` 可设 100–2147483647 的整数毫秒，无效值使用默认值）：连续 30 分钟没有通过会话令牌校验的 IPC 请求时，自动记录 `incomplete` 并释放进程锁。计时从监听就绪后开始，使用单调时钟。通过令牌校验的请求刷新活动时间；错误令牌、无效 JSON 和未完成数据包不续期。处理中的请求不会被 watchdog 中断，关闭后拒绝排队请求并有界销毁连接。它不是后台同步任务，不会主动查询外部服务。

TB 完整同步使用 `start --sync`，在私有目录写入 `sync-run.json`，独立 `status` 返回 `lastSync` 和锁状态，`history` 返回各轮记录。启动后记录为 `running`；正常 stop 时，只有全部检查通过并明确提交 `sync-attest` 才记录 `verified`，否则为 `incomplete`。空闲 watchdog 或信号收尾只记录 `incomplete`，保留所有未决意图；它不证明外部请求未落地。进程被强制终止时可能留下 `running`；下一次成功取得锁的同步启动会把遗留 `running` 标为 `incomplete`，原因记为 `process_restarted`，不修改未决操作。收尾记录含 `stopReason`，可区分 `stop`、`idle_timeout`、信号退出和锁归属变化；记录写入失败也继续关闭并释放属于自己的锁。记录是调用方核验的摘要；未启动协调器的调度不会产生记录，也不能由旧记录推断本次运行成功。`verified` 不单独证明锁已释放，应同时检查 `lock:null`。

同一配置一次只有一个会话；IPC 请求再串行执行。本地客户端超时视为本地提交结果未知，先 status 对账。当会话中断导致后台协调进程已退出、`request` 或 `stop` 返回 `connect ENOENT` 时，表示原监听管道已关闭：此时直接运行 `start`，由 `acquireLock` 验证旧 PID 已退出（`ESRCH`）后回收旧锁，并由 `Coordinator` 构造器自动回滚仅处于 `prepared` 阶段的未发出意图（任何 `dispatched` 未决项仍保留，仅阻断对应事项待对账），随后使用新 token 重新提交完整 `inventory` 继续。Windows 使用系统 PowerShell/.NET 的进程创建时间核对 PID 身份：PID 已被复用时按死持有者走互斥回收；身份查询失败时保留活锁，不按锁龄强抢。其他平台保留 PID 存活检查。旧版锁没有创建时间指纹时，仅在当前进程出生时间晚于旧锁创建时间时确认 PID 已复用。

启动前先验证本轮所需 MCP 已可调用；连接缺失时直接报告，不启动持锁会话。取得 token 后用 `try/finally` 或等价收尾保证成功、报错和等待用户时均执行 stop，再独立 status 确认锁释放；Agent 被强制取消时由 watchdog 兜底。旧轮次 `incomplete` 本身不阻断新轮次。新轮次先检查 pending，已有未知写入只跳过对应 key，其余事项继续；本轮有未决则记录 `incomplete` 并在当前会话报告 opId、目标和需要的对账证据。

`init` 与 `request` 支持 `--file <json-path>` 直接按 UTF-8 读取本地 JSON 文件，也兼容从 `stdin` 读取。批量 `inventory`、`candidates` 或含长标题的请求优先写入仓外私有临时文件并通过 `--file` 传入，用后即删；不要把大段 JSON 或不可信任务正文直接拼进 shell 命令行，以免触发 Windows 命令行长度限制（`os error 206`）或转义损坏。需要从会话构造文件时使用可读的 UTF-8 JSON/单引号 here-string，不用 Base64 负载代替结构化输入。

工具原始返回需先适配为以下形状。属性值为 view/rows/fetch 实际读取的扁平字段值，缺失字段显式为 null；每次映射保持一致。

```json
{
  "action": "inventory",
  "complete": true,
  "pages": [
    {
      "pageId": "33333333-3333-4333-8333-333333333333",
      "properties": {
        "任务": "示例事项",
        "来源标识": "TB:bbbbbbbbbbbbbbbbbbbbbbbb",
        "个人状态": "进行中",
        "下一步动作": "核对接口",
        "个人顺序": null
      }
    }
  ]
}
```

`complete:true` 只用于**已经读完**无过滤全库分页的结果；空库同样须取得终止分页证据。view 模式先 fetch 检查无过滤且全字段展示，逐页累积；有过滤/隐藏所需字段则换可完整读取的方式，权限/额度限制时停止写入，不拿抽样冒充全量。

## Notion 属性保护

编辑页面时先单页回读完整属性，以用户明确指令或[字段所有权](setup.md#字段所有权)为依据建立允许改变的字段清单。名称含“人工”的字段只有用户明确点名时才可列入。`dispatch` 返回字段补丁；由调用方核对补丁中的每项变化都已获准，再把补丁覆盖到快照，按当前 Notion 工具的 schema 写回全部可写属性，其余可写字段原样保留。只读、计算和系统属性不回传；无法读全属性、无损回传可写属性或确认字段权限时，停止该页写入。缺失不表示空值；只有已授权的清空操作才传空值。

每次 `update_page` 明确成功后，按返回的 `pageId` 回读完整属性：核对允许修改的字段与拟写值一致，其余可写字段与更新前快照一致。只读属性的系统更新或重新计算不视为字段误改。回读失败、属性缺失或比对不一致时，保持操作未决并停止后续批量写入。批量更新逐页执行和核对。

**Notion 读取反斜杠转义知识与单次入口解码**：已观察到 Notion 读取接口（`view` / `rows` / `fetch`）的文本属性会对下划线追加反斜杠转义（例如将 `3.5.1_hotfix_2026.10.29` 返回为 `3.5.1\_hotfix_2026.10.29`）。协调器在 `inventory`（及显式传入的外部页面）适配入口处，会自动对受控同步字段 `迭代` 与 `来源状态` 执行**单次** `\_ → _` 还原；调用方直接传入读取到的属性即可，无需手写反转义。人工自由编辑字段（`任务`、`下一步动作`）保持原样不作反转义。TB 原值和内部合成页面不再解码；受控字段若本就包含字面量 `\_`，本适配规则会将其视为 `_`，不能用它声称字节级保真。

## 计划与外部执行

所有下面 JSON 均发送到 `request --session <token>`（可通过 `--file` 或 `stdin`）；`action:status` 可查看全局未决条目与当前覆盖率（活跃会话用 `request` 的 `action:status` 获取；独立 CLI `status` 只读持久化状态，不含本轮覆盖率）。协调器启动时独立扫描全部 pendingOp，不受候选范围影响。

| action | 输入要点 | 完成条件 |
| --- | --- | --- |
| inventory | complete:true、pages | 单次解码受控字段，返回条数/重复冲突/未决；重置覆盖率并失效旧计划 |
| candidates | complete:true、tasks | 返回候选、autoIntakeIds、decisionGroups、老单 ID、时间未知项；置 `candidatesChecked: true` |
| adapt-tasks | tasks、statuses、sprints、members、projects 数组和已核实的 tbUserName | 将已获取的 TB 原始字段映射为 task；逐项返回结果或错误，状态项需附所属 projectId；未知迭代不会伪造 |
| configure | confirmed:true、patch | 修改 watchedTasks/ignoredTaskIds/activeWindowDays/autoCompleteOnTbEnd；要求全局无未决，传完整新值 |
| plan | task | 读取标准化 TB 详情并记入 `plannedKeys`；若已跟踪且无实质变化，直接返回 `unchanged:true, committed:true` 免除外部写入，否则返回 planId/key/type/properties/notices |
| plan-batch | tasks 数组 | 逐项执行 plan，返回各自计划或错误；失败项不计覆盖，成功项仍需分别处理写入 |
| sync-attest | identityVerified、paginationVerified、iterationsVerified、writesVerified、candidatesHandled 均为 true | 核实身份和策略、分页终点、迭代、写入回执及候选处理后提交；有未决、未处理计划或覆盖不足时拒绝 |
| plan-personal | pageId（编辑时）、properties | 新人工事项或个人安排生成计划；个人顺序须有用户确认 |
| prepare | planId、confirmed:true（创建/个人编辑必需） | 持久化 prepared 意图，返回 opId |
| prepare-batch | items 数组（每项含 planId、confirmed） | 逐项持久化 prepared 意图，返回各自 opId 或错误；仍须逐项走 `dispatch → 外部调用` |
| dispatch | opId、currentPage（更新传入）或 noMatchConfirmed（创建可选） | 核对页面快照与唯一性，持久化 dispatched，返回 permitted:true 及精确拟写 properties 补丁 |
| commit | opId、apiSucceeded:true、pageId、page（传回读结果，形状同 inventory） | 调用方核对完整属性后，协调器校验页面身份及拟写字段，提交基线 |
| commit-batch | items 数组（每项同 commit） | 各项均已完成回读核对才提交；未知或失败项保持 `dispatched` 禁止重发，留待 `resolve` |
| cancel | opId | 仅取消 prepared，外部未发请求 |
| resolve | opId、confirmed:true、outcome 等 | 人工对账，见下节 |

`task` 形状由 [TB 适配表](sync.md#候选发现) 定义；必填 id/title/executorId/isDone/isArchived/statusName，非空 executorId 需按适配表解析 executorName，候选筛选另外需要 createdAt/updatedAt。先完整定位和映射再提交，不用假值补齐字段。

若目标数据源有 `迭代` 属性，提交 plan 前按 TB 适配表解析迭代；只有明确名称或明确无迭代时传入 `iteration`。读取失败或映射不唯一时省略该字段并报告；未知不等于无迭代。

每条任务处理按顺序：

1. `plan` 或 `plan-personal` 生成计划。若 `plan` 返回 `unchanged: true`（`committed: true`），说明 Notion 当前页面属性与最新 TB 快照完全一致且本地基线已对齐（即便同时附带 `notices` 提示，也无需为提示重复写回相同属性），**直接结束该条，不发任何外部 Notion 写入请求**，仅按需向用户汇报 `notices`。个人编辑传用户要求的最小 patch；暂停/等待他人要连同恢复位置写入 `下一步动作`，内容缺失先询问或从实际进度取证，不编造。
2. 需要写入的计划调用 `prepare`；`prepare` 成功前不发外部请求。
3. 所有更新均在派发前单页重读，按[属性保护](#notion-属性保护)用快照和计划补丁核对字段权限并组装 `properties`，再按 inventory 的字段形状传 `currentPage` 给 `dispatch`。读取或校验失败时取消 prepared 并报告；页面与计划快照不符则取消 prepared，按最新快照重算。创建校验来源唯一性。重读与外部写入之间仍有竞态。
4. `dispatch` 返回 `permitted: true` 后，创建按派发结果向配置数据源调用 `create_pages`；更新核对返回的补丁与已校验的计划补丁一致，再用组装好的 `properties` 向返回的 `pageId` 调用 `update_page`。如果派发后才发现无法满足写入条件，不发送外部请求，按未决流程对账。此流程不写回 TB。
5. 接口明确返回成功（创建返回 `pages[].id` 或更新返回 `page_id`，且无 `isError`）后，按返回 ID 回读页面。更新按属性保护比对，创建核对拟写字段及来源标识。核对通过才调用 `commit`，传 `apiSucceeded: true`、返回的 `pageId` 和按 inventory 形状构造的回读 `page`。回读未知或不一致时保持 `dispatched`，停止后续批量写入。
6. TB 同步轮次先用 `action:status` 检查遗漏并补齐。核实身份及策略、分页终点、迭代、实际写入回执和候选均已处理后提交 `sync-attest`；存在待决候选、读取失败或结果未知时不提交。随后调用 `stop --session <token>`，检查返回的覆盖、未决和 `syncStatus`，再以独立 `status` 确认锁已释放。诊断只统计成功判定与候选计算；调用方仍须核实外部证据。读取受阻时照常 stop 并报告；个人编辑会话不要求 TB 覆盖。

## 未决与人工对账

prepared 表示尚未获得派发许可，重启可安全清理；dispatched 表示请求可能已经发出，即使中断在真正调用前也保守视为未知。超时、断连、进程退出或报错（结果未知）严禁调用 `commit` 盲提交，也禁止未经对账直接重发。不得仅凭当前字段等于目标或原值推断操作归属。

向用户展示目标、拟写内容、当前 Notion 值（此时可单点 `fetch` 或查询核实）及已知 API 结果。不能确认则保持该项阻断。人工结论映射如下，单次原子提交同时完成业务状态和清除日志：

| outcome | 所需事实与输入 | 本地结果 |
| --- | --- | --- |
| adopt | 用户确认采纳此操作；page 回读等于计划 | 采纳 next 基线：自动完成设标记、自动重开消费标记、创建绑定唯一页面；清除 pendingOp |
| user_state | 当前值由用户安排；page、currentExecutorId、requestSettled:true；创建另需 uniquePageConfirmed:true | 绑定实际页面，清除自动完成标记、按当前负责人建基线、清除 pendingOp |
| not_applied | 用户确认未生效且旧请求已终止；requestSettled:true | 保留操作前基线和标记，仅清除 pendingOp；重读重算，创建仍须重新查重 |
| 未能确认 | 无 | 保持 pendingOp，继续阻断 |

requestSettled 需要旧请求不会再落地的证据；单次查询无结果/字段相等或“等了一会”都不足以证明。无法建立这一边界时，保留未决，避免用户误以为清除日志能取消网络请求。

resolve 完成后重新提交完整 inventory；人工接管创建结果时，核对页面属于配置数据源、来源唯一及页面 ID，保留用户改后的字段，不要求改回原始草稿来通过对账。

本地写入损坏、数据源绑定不符、来源重复、schema 变更都先停在具体条目或会话边界；保留 Notion 与 state，不自动回滚、删页或重建库。重复页面合并/删除属于另行授权的维护动作。
