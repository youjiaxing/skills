# 本地写入协议

协调器只管理本地状态与计划，**不会调用 Notion/TB**。Agent 根据返回的计划调用当前 MCP 工具，并将真实响应结果送回协调器。写入授权来自用户指令及已配置规则，JSON 的 confirmed 是 agent 对已存在授权的记录，不是向用户另设固定措辞。

## 持锁会话与标准输入

```text
node <skill-dir>/scripts/hub.mjs start
node <skill-dir>/scripts/hub.mjs request --session <start返回的token> [--file <json-path>]
node <skill-dir>/scripts/hub.mjs stop --session <token>
```

`start` 启动独立本地 Node 协调进程，持有 lock.json 跨越多次 MCP 调用；Windows 使用本地 named pipe，POSIX 使用私有根内 socket，未开放 HTTP 端口。进程只为当次操作持锁，结束或等待用户决定新候选时 stop，下次重新 start/读取。它不是后台同步任务，不会主动查询外部服务。

同一配置一次只有一个会话；IPC 请求再串行执行。本地客户端超时视为本地提交结果未知，先 status 对账。当会话中断导致后台协调进程已退出、`request` 或 `stop` 返回 `connect ENOENT` 时，表示原监听管道已关闭：此时直接运行 `start`，由 `acquireLock` 验证旧 PID 已退出（`ESRCH`）后回收旧锁，并由 `Coordinator` 构造器自动回滚仅处于 `prepared` 阶段的未发出意图（任何 `dispatched` 未决项仍保留阻断待对账），随后使用新 token 重新提交完整 `inventory` 继续。锁进程仍存在或身份无法核实时保持占用，不按时间强删。

`init` 与 `request` 支持 `--file <json-path>` 直接按 UTF-8 读取本地 JSON 文件，也兼容从 `stdin` 读取。批量 `inventory`、`candidates` 或含长标题的请求优先写入仓外私有临时文件并通过 `--file` 传入，用后即删；不要把大段 JSON 或不可信任务正文直接拼进 shell 命令行，以免触发 Windows 命令行长度限制（`os error 206`）或转义损坏。

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

**Notion 读取反斜杠转义知识与单次入口解码**：已观察到 Notion 读取接口（`view` / `rows` / `fetch`）的文本属性会对下划线追加反斜杠转义（例如将 `3.5.1_hotfix_2026.10.29` 返回为 `3.5.1\_hotfix_2026.10.29`）。协调器在 `inventory`（及显式传入的外部页面）适配入口处，会自动对受控同步字段 `迭代` 与 `来源状态` 执行**单次** `\_ → _` 还原；调用方直接传入读取到的属性即可，无需手写反转义。人工自由编辑字段（`任务`、`下一步动作`）保持原样不作反转义。TB 原值和内部合成页面不再解码；受控字段若本就包含字面量 `\_`，本适配规则会将其视为 `_`，不能用它声称字节级保真。

## 计划与外部执行

所有下面 JSON 均发送到 `request --session <token>`（可通过 `--file` 或 `stdin`）；`action:status` 可查看全局未决条目与当前覆盖率（活跃会话用 `request` 的 `action:status` 获取；独立 CLI `status` 只读持久化状态，不含本轮覆盖率）。协调器启动时独立扫描全部 pendingOp，不受候选范围影响。

| action | 输入要点 | 完成条件 |
| --- | --- | --- |
| inventory | complete:true、pages | 单次解码受控字段，返回条数/重复冲突/未决；重置覆盖率并失效旧计划 |
| candidates | complete:true、tasks | 返回候选、autoIntakeIds、decisionGroups、老单 ID、时间未知项；置 `candidatesChecked: true` |
| configure | confirmed:true、patch | 仅修改 watchedTasks/ignoredTaskIds/activeWindowDays；要求全局无未决，传完整新值 |
| plan | task | 读取标准化 TB 详情并记入 `plannedKeys`；若已跟踪且无实质变化，直接返回 `unchanged:true, committed:true` 免除外部写入，否则返回 planId/key/type/properties/notices |
| plan-personal | pageId（编辑时）、properties | 新人工事项或个人安排生成计划；个人顺序须有用户确认 |
| prepare | planId、confirmed:true（创建/个人编辑必需） | 持久化 prepared 意图，返回 opId |
| dispatch | opId（可选 currentPage / noMatchConfirmed） | 基于本轮 `inventory` 核对页面快照与唯一性，持久化 dispatched，返回 permitted:true 及精确拟写 properties |
| commit | opId、apiSucceeded:true、pageId（更新可省略，创建必填；兼容旧 page） | 当前 MCP 写入明确返回成功 `page_id` 后直接校验 ID 身份并合成提交基线，无需写后 `fetch` 回读 |
| cancel | opId | 仅取消 prepared，外部未发请求 |
| resolve | opId、confirmed:true、outcome 等 | 人工对账，见下节 |

`task` 形状由 [TB 适配表](sync.md#候选发现) 定义；必填 id/title/executorId/isDone/isArchived/statusName，非空 executorId 需按适配表解析 executorName，候选筛选另外需要 createdAt/updatedAt。先完整定位和映射再提交，不用假值补齐字段。

若目标数据源有 `迭代` 属性，提交 plan 前按 TB 适配表解析迭代；只有明确名称或明确无迭代时传入 `iteration`。读取失败或映射不唯一时省略该字段并报告；未知不等于无迭代。

每条任务处理按顺序：

1. `plan` 或 `plan-personal` 生成计划。若 `plan` 返回 `unchanged: true`（`committed: true`），说明 Notion 当前页面属性与最新 TB 快照完全一致且本地基线已对齐，**直接结束该条，不发任何外部 Notion 写入请求**。个人编辑传用户要求的最小 patch；暂停/等待他人要连同恢复位置写入 `下一步动作`，内容缺失先询问或从实际进度取证，不编造。
2. 需要写入的计划调用 `prepare`；`prepare` 成功前不发外部请求。
3. 调用 `dispatch` 取得派发许可（`permitted: true`）；协调器默认基于本轮已锁定的完整 `inventory` 快照校验更新前状态与创建去重，无需写前额外调用单页 `notion.fetch` 或第二次单库查询。
4. 只有 `dispatch` 返回 `permitted: true`，才调用 Notion `create_pages` 或 `update_page`，目标固定为配置数据源/返回 `pageId`、`properties` 固定为派发结果。不执行 TB 写回。
5. 当 Notion `create_pages` 或 `update_page` 明确返回成功（返回创建的 `pages[].id` 或更新的 `page_id`，且无 `isError`）时，直接调用 `commit`（传入 `apiSucceeded: true` 与返回的 `pageId`），**无需写后再调用 `notion.fetch` 回读页面**。协调器校验 `pageId` 身份无冲突后合成更新内存 `inventory` 并原子提交 `state.json` 基线。本地基线代表“基于本轮初始 `inventory` 快照与 API 明确成功响应确认的拟写结果”，实际落盘与跨会话并发修改留待下轮全表读取发现。
6. TB 同步轮次先用 `action:status` 检查遗漏并补齐，随后调用 `stop --session <token>` 释放锁，核对返回的 `syncCoverage.unplannedTrackedKeys` 为空且 `candidatesChecked === true`，随后报告实际结果与候选。诊断只统计成功判定与候选计算，不证明分页真实完整、迭代已核实或所有写入已提交；还需检查未决与实际写入结果。读取受阻时照常 stop 释放锁，报告部分完成及遗漏；个人编辑会话不要求 TB 覆盖。

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
