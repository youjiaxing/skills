# 项目写入协议

仅用于已授权的项目页正文、模块和重要待办。个人总清单属性/TB 同步仍用[本地写入协议](operations.md)。脚本不调用外部服务，不判断需求语义或验证结果是否充分；Agent 先核实范围、来源和[阶段规则](project-tracking.md#开发阶段与证据)，再派发当前宿主的 Notion MCP 工具。

## 会话与目标绑定

```text
node <skill-dir>/scripts/hub.mjs status --project
node <skill-dir>/scripts/hub.mjs start --project
node <skill-dir>/scripts/hub.mjs request --session <token> --file <json-path>
node <skill-dir>/scripts/hub.mjs stop --session <token>
```

首次私有目录尚不存在时直接 `start --project`。项目会话无需 TB/config 初始化，不与 `--sync` 混用。命令与总清单会话共用 `lock.json`，锁跨越 MCP 调用，结束前必须 stop；相同私有目录中的其他会话因此串行运行。`project-state.json` 保存资源身份、未决意图和最近 30 条核对回执，不是项目进度数据库。源码不存真实 ID 或任务内容。仅持锁进程可写日志，`status --project` 只读。

所有 JSON 都发送给 `request`。创建私有临时输入文件放在仓外，用后删除。`confirmed:true` 只是记录已有授权，不是授权本身。

先 fetch 项目根、嵌入数据库、数据源与相关页面，验证实际父子关系。把查明的身份传入 `bind`，资源可分批追加，key 由语义角色构造并保持稳定，例如 `modules-db`、`modules-source`、`module:catalogue`；不是显示标题，不因重命名变更。先核对旧绑定和实际页面再新增，绑定冲突停止，不自动改绑。

```json
{
  "action": "bind",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "parentId": "collection://22222222-2222-4222-8222-222222222222",
  "confirmed": true,
  "evidence": "已确认本项目的维护范围，并读取实际父子链",
  "resources": [
    {"id":"33333333-3333-4333-8333-333333333333","kind":"database","parentId":"11111111-1111-4111-8111-111111111111","key":"modules-db"},
    {"id":"collection://44444444-4444-4444-8444-444444444444","kind":"data-source","parentId":"33333333-3333-4333-8333-333333333333","key":"modules-source"},
    {"id":"55555555-5555-4555-8555-555555555555","kind":"page","parentId":"collection://44444444-4444-4444-8444-444444444444","key":"module:catalogue"}
  ]
}
```

`projectId` 是总清单那一行的页面 ID；它在内部父链中是范围根，实际外部父节点另存 `parentId`，真正的工作区根才用 null。新项目先经个人总清单路径建立或复用该行，再绑定项目范围；项目路径不修改根的属性。data-source/view 使用 `collection://` / `view://` ID，其他节点用 UUID；脚本统一 UUID 大小写和连字符。一个节点不能属于两个项目，父链必须完整无环。

## 预写、派发与核对

每次只处理一个外部调用。`prepare` 先持久化意图；`dispatch` 返回 `permitted:true` 后才发 MCP 请求。写前重新读取当前目标及其到项目根的父链，写后按返回 ID 重新读取同一身份链。同一项目有未决时先对账，其他项目可继续。

`current` 和 `readback` 均采用 `{id,parentId,state,ancestors}`。ancestors 按直接父节点到项目根的顺序列出 `{id,parentId}`；目标就是项目根时用空数组，项目根外部父节点只填在该根节点的 parentId，不再加入 ancestors。属性更新的 state 为完整可写属性，正文更新为完整字符串；创建派发的 current 是父容器身份，其 state 可省略。创建回读的 ancestors 从该父容器开始，state 为事先定义的投影。脚本在写前就验证身份和完整父链，页面或容器已经移出项目时保持 prepared，取消后核查，不等写完才发现越界。

### 属性更新

`prepare` 使用 `kind:properties`，另传 `projectId`、模块/待办的 `targetId`、`confirmed:true`、`evidence`：

```json
{
  "action": "prepare",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "targetId": "55555555-5555-4555-8555-555555555555",
  "kind": "properties",
  "confirmed": true,
  "evidence": "用户明确反馈该模块适用自测已全部通过",
  "before": {"模块":"图鉴","开发阶段":"等待自测","人工核对结论":"保留原文"},
  "patch": {"开发阶段":"等待联调"},
  "allowedProperties": ["开发阶段"]
}
```

`before` 必须是完整可写属性快照，示例只省略与说明无关的字段。只读/计算/系统属性不回传。`patch` 是最小变化；名称含“人工”的字段还须列入 `explicitHumanProperties`，且确有用户点名授权。缺失不等于空值，清空须有相应授权。`prepare` 产生 `expected`（完整快照合并补丁），`unchanged:true` 则免写。

派发传 `action:dispatch`、`opId` 和上述 current，state 取重读的完整可写属性。脚本核对身份父链以及 current.state 与 before 一致；MCP 更新的可写属性取返回 expected，防止未提交字段被隐式重置。schema 不支持保真回传时停止，不猜格式。

### 正文更新

先阅读宿主提供的 Notion Markdown 规范。fetch 完整正文并确认未截断；读取结果中的包装、系统属性、抓取时间不属于正文快照。`prepare` 采用 `kind:content`，`before` 是正文字符串，`sections` 是允许修改区段的原始文本数组，`edits` 为精确的 `[{"old":"唯一原文","new":"修改后原文"}]`。sections 是调用方依据授权选择的边界，脚本不替代授权判断；尽量按小区段授权，保留人工补充及已有子库标签。

脚本要求每个区段和替换锚点唯一、替换不越界且不重叠；只有空白页可用空锚点初始化。派发 current.state 为重读正文，并附身份父链；使用 MCP 的定点内容更新，替换集合取 edits，不对已有页整篇覆盖。`expected` 是完整预期正文，用于写后核对。若工具改变了表示方式，先按已核实的等价规范适配前后快照；无法保真比较则保持未决，不临时放宽断言。

### 创建资源

仅在已授权新建范围内使用 `kind:create`，传实际父节点 `targetId`、`resourceKind`（page/database/data-source/view）、稳定 `resourceKey` 及非空 `expected` 对象。expected 是先根据真实工具 schema 定义的最小核对投影，如标题、配置的 schema/关联与正文；前后使用相同字段与结构，包含决定用途的配置，不只比较标题。脚本不把这个投影直接转换成 MCP 参数。

如果返回 `existing:true`，先读取该节点再判断是否满足要求，不把身份已存在误当内容已正确。派发前须读完目标父节点/数据源的相应范围，核对不存在同义记录，传父容器 current 及 `absenceVerified:true, inventoryComplete:true`。不因相似名称就新建第二份。

按项目页、模块数据库、待办数据库的依赖顺序逐个创建，再用实际 ID 建关联和视图。一次 MCP 创建数据库可能同时建立数据源和默认视图：先 fetch 返回的数据库取得子资源，以 bind 登记，已有资源直接复用，不能再发一遍创建。待办的关联模块必须指向实际模块数据源；已有 schema 只在明确授权下调整，本协议不提供删除/重建/任意 schema 改写捷径。

### 提交与恢复

接口明确成功且回读通过后发送：

```json
{
  "action": "commit",
  "opId": "<派发操作ID>",
  "apiSucceeded": true,
  "readback": {
    "id": "<实际返回ID>",
    "parentId": "<读取到的实际父节点ID，工作区根为null>",
    "state": "<属性更新为完整可写属性对象，正文为完整正文字符串，创建为expected同形投影>",
    "ancestors": [{"id":"<直接父节点ID>","parentId":"<该父节点的实际父ID>"}]
  }
}
```

state 为示意说明，实际必须传对应类型的数据而非占位文本。脚本检查身份、父节点和内容；创建提交后绑定实际资源 ID。核对失败则保留 dispatched。之后明确告知用户变化和依据；本地 committed 不代表已向用户告知。

- 还没 dispatch 的 prepared 可用 `cancel` 取消；新进程恢复时自动清理这类未发意图。dispatch 前绝不调用外部 API。
- 请求超时、API 成功但回读失败、CLI 本地结果未知时，先 `status --project` 对账。不得重发 create/append，也不能凭一次“没查到”认定原请求没有执行。
- dispatched 只能走 `resolve`：传 `confirmed:true`、`requestSettled:true`、对账 `evidence` 和 `outcome:applied`（附实际 readback），或 `outcome:not-applied, noEffectVerified:true`。未执行的更新还须回读等于原快照。只有原请求已终结且结果已核实才可解除，不清楚就保持未决并报告，不臆造成功响应。
- 若原请求已终结，但用户随后补充了备注/正文，实际页面既不等于 before 也不等于 expected，先展示差异。用户明确确认采纳当前状态后才用 `resolve` 的 `outcome:accept-current, acceptCurrent:true`，并传上述终结证明、真实 readback 及确认依据。脚本记录差异和实际回执后解除未决，不向 Notion 写回旧快照，不要求撤销人工内容；这项确认不能由一般的项目维护授权代替。正文差异记录前后哈希，详细内容从真实页面核对。
- 读取/回传的快照由调用方负责完整性和实际来源，布尔 attestation 不证明外部事实。进程锁仅协调本工具的本地会话，不能消除其他客户端在读取与写入之间的竞态；发现冲突停止该项目的后续写入并报告。

结束时 stop 并检查未决与锁释放。项目会话没有 TB 同步覆盖率或 sync-attest；恢复时依据真实页面和请求记录，不把本地日志当业务进度真源。
