# 主动投递与卡片更新

## 职责与当前能力

飞书侧负责目标群核对、消息呈现、图片上传、发送/更新及回执。信息来源、内容筛选、紧急判定和触发时间由调用方确定，不把某个班级或某个每日时间写成所有推送的通用规则。

主动投递不要求用户先 @ 机器人，也不要求改动飞书群到 Codex 聊天的入站绑定。入站会话与生成摘要的来源会话可以不同；发送目标必须来自本次用户授权，不能用来源聊天或最近群推断。

| 能力 | 当前状态 |
|---|---|
| 文本、富文本（post）、带本地图片的卡片（interactive） | 2026-10-16 一次性 SDK 调用取得真实发送回执，用户比较并接受修订版卡片 |
| 通用发送/图片上传命令 | `outbound.mjs send` 支持 text/post/interactive 及本地图占位符 |
| 更新原卡片 | `outbound.mjs update` 已实测共享卡片原位更新，消息 ID 不变 |
| 编辑后是否再次触发通知 | 未实测；不能依赖编辑承担提醒 |
| 自动调度、消息源下载 | 不由接收器提供，也不因发送成功而自动开启 |

本页需要账本的投递统一从 `outbound.mjs` 执行；独立的一次性消息操作按 [外部工具分工](feishu-cli.md#职责选择) 使用 `lark-im`。SDK 凭证通过 `loadCredentials` 读取，日志只输出必要回执或数值错误码，不输出 Token、Secret 或 SDK 请求配置。

## 命令与输入

从仓库根目录执行，或相对于技能目录定位脚本：

```text
node skills/yjx-feishu-agent/scripts/outbound.mjs send --input /path/to/send.json
node skills/yjx-feishu-agent/scripts/outbound.mjs update --input /path/to/update.json
node skills/yjx-feishu-agent/scripts/outbound.mjs status --request-id digest-20261016
node skills/yjx-feishu-agent/scripts/outbound.mjs preflight --input /path/to/send.json
node skills/yjx-feishu-agent/scripts/outbound.mjs recheck --request-id digest-20261016
node skills/yjx-feishu-agent/scripts/outbound.mjs reconcile --request-id digest-20261016
```

均支持 `--state-dir PATH`，默认复用桥接状态目录与凭证。发送/更新退出码：0 已确认，2 受阻或输入错误，3 结果未知。status 的0只表示存档读出，仍检查状态字段；缺回执返回 missing、submitted:null 和退出码3。参数/版本错误只输出通用安全错误，先核对存档，不换编号重发。

发送 JSON 示例（群 ID 替换为已授权目标）：

```json
{
  "requestId": "digest-20261016",
  "chatId": "oc_GROUP",
  "msgType": "interactive",
  "content": {
    "header": {"title": {"tag": "plain_text", "content": "当天汇总"}},
    "elements": [
      {"tag": "div", "text": {"tag": "lark_md", "content": "**事项**：完整执行要求"}},
      {"tag": "img", "img_key": "local:notice", "alt": {"tag": "plain_text", "content": "通知原图"}}
    ]
  },
  "images": {"notice": "./notice.png"}
}
```

图片路径相对输入 JSON 解析；单图非空且不超过10MB。摘要和上传使用同一份字节。已有飞书图片标识可直接填入，不必再上传；无图则省略 images。首发与更新自动显式设置 `config.update_multi:true`，拒绝独享卡片。文本用 `msgType:text`、`content:{"text":"提醒正文"}`；富文本按官方 post 结构提供。

需要引用回到发送会话时，在 send/update 输入显式提供 `sourceThreadId`（当前已授权的本机 Codex 聊天 UUID），见 [引用路由](routing.md)。调用方从实际会话标识取得它，不从群默认绑定或最近聊天猜测；该字段参与请求指纹，并在消息写调用前保存。未提供时仍可正常投递，但不会猜测来源；更新已登记卡片时缺少来源会令新版本不可路由。来源在本地成功记账后生效，结果未知时暂停新引用；恢复只补原请求的元数据，不换编号重发。

更新 JSON：使用新的 requestId、`targetRequestId` 为最初发送编号、`expectedRevision` 为最后确认版本，提供 `msgType:interactive` 及完整 content/images，省略 chatId。初始版本1，确认更新后加1。只操作本工具当前应用下已记账的原卡片；不导入任意消息 ID。旧版本和前次结果未知的更新拒绝。

另发提醒使用独立 send 编号，可设置 `requiresUpdate` 为更新编号。命令在原卡片锁内确认它为同应用、同群且仍为最新的成功更新，再发送提醒；不能依赖失败或过时更新。重复相同输入返回存档；若原本地图被移动或修改，先用 status 核对，不换编号重发。

状态位于 `outbound-v1/<app hash>/requests`、`messages`，文件名为区分大小写逻辑编号的 SHA-256。新请求记录 version:2，保留原始请求、首次提交时间、成功 acknowledgement 或本次失败证明；不自动迁移或改判旧记录。请求/目标分别加锁，不抢残留锁。外部提交前记账；收到成功回执先持久化 acknowledgement，再写带 pending 的目标快照、操作回执，最后清 pending。任一步崩溃保留门禁。

## 投递核查与本地恢复

`recheck` 只读，不上传、不重新发送、不更新远端、不覆盖原账本；旧 `--input` 形式仅读取 requestId，原图丢失也不触发重新准备。返回 `readOnly:true`、`retried:false` 与 outcome，退出码依次为 sent=0、not_submitted=2、unknown=3。有原消息 ID 时最多查询一次该消息，并核对群归属；远端查询只补充可见性信息，不用相似正文反推请求身份，也不把404、空列表或权限失败当成从未发送。

| outcome | 证据与处理 |
|---|---|
| sent | 已有成功回执，或 version:2 中持久化的 acknowledgement；不再发送。若目标状态尚未写完，可用 reconcile 修复本地记录 |
| not_submitted | version:2 对原尝试的明确失败证明：消息写调用之前失败，或已经核定的服务端拒绝（当前仅230099卡片内容拒绝）；修正输入后调用方可在原任务授权内建立关联的新尝试，保留旧记录 |
| unknown | 缺回执、未知提交、旧 blocked 无新证据、无法关联原请求；保持 pending 和依赖门禁，不生成新编号绕过 |

`preflight` 无凭据检查当前输入，scope 为 current-preflight；它的 submitted:false 只表示这次预检没有发消息，不能证明更早的请求未提交。也不能用“缺账本＋当前预检失败”解除历史门禁。未知业务错误不能统一归为明确拒绝；原卡片更新结果未知时，看到旧内容不能证明更新从未执行。

`reconcile` 不执行远端写入，只对 version:2 且消息类型完整的记录，用已有持久化成功回执修复本地目标和请求状态，按发送相同的锁顺序重核群、消息、版本及 pending；拒绝覆盖后来版本或其他请求的门禁。重复执行可返回 reconciled:false。旧成功记录仍可查询和去重，但不自动迁移恢复；不能用它把未知结果变成成功，不能导入任意消息 ID，证据不足保持待办。

核查按调用方已有执行节奏进行，不新增后台轮询或调度。调用方负责逻辑投递与重试关联，仅阻断该投递及依赖更新/提醒；无关任务继续。相同未决状态提示一次，后续有实质变化才再次提示，可用稳定 attentionKey 去重；记录缺失时以应用与请求 ID 去重。通知沿用已有授权渠道。旧记录可能已被旧版 recheck 覆盖，不能仅凭旧 submitted:false 自动恢复；本次升级不批量修复或重放历史待办。

## 内容组织

需要分区的汇总优先使用卡片；短信式提醒可用文本。用户已选择其他格式时沿用该选择。正文按任务、行动、期限和适用对象组织；去掉重复叙述与采集技术说明，不删影响执行的限制条件，也不把推断改写成来源事实。业务所需的固定栏目由调用方提供。

图片应对应具体事项，保留原图可查看；本地路径需先上传取得飞书图片标识，不把 QQ 带鉴权参数的链接直接当成长期附件。图片获取遵循来源工作流的授权，本技能不自动扩大下载范围。文字识别失败不等于图片缺失；仅在缺失影响用户行动时提示查看原消息。

消息类型和新卡片组件按 [外部 skills 分工](feishu-cli.md#外部-skills-的复用范围) 读取 `lark-im` 参考；本地示例使用旧式卡片1.0，不能混用2.0结构。卡片 Markdown 不是完整 Markdown：已实测旧版 lark_md 将井号标题原样显示，栏目可用已验收的加粗或标题组件；不能把此限制推广为所有2.0组件均不支持标题。

首次采用或明显调整表格、分栏、折叠等布局时，用代表性内容检查目标客户端（尤其手机）的换行和信息完整性；服务端接受只证明投递成功，不证明展示可读。多列挤成省略号时可改分组列表或合并字段，不固定列数、不统一禁止表格。已验收模板继续复用，无须逐条消息重新审批；未观察客户端时说明展示未验收。

## 传输适配维护

普通 API 用法与卡片组件复用 `lark-im` 参考；本工具的 SDK 调用实现以 `scripts/outbound.mjs` 为准，使用已锁定的 `@larksuiteoapi/node-sdk`。调整传输实现时保留本页的提交前记账、成功 acknowledgement、版本锁与未知结果语义；已有账本任务继续从 outbound 入口执行。

图片上传实测返回的是顶层 `{ image_key }`，不要把所有 SDK 方法一律按 `{ code, data }` 解析。消息创建实测返回 `code: 0` 和 `data.message_id`。对当前方法的实际结构核对成功，不用“未抛异常”代替回执确认。

富文本图片节点使用 `image_key`，本次实测旧版卡片图片组件使用 `img_key`；这两个字段不要混淆。已实测卡片使用 header、elements、div/lark_md、hr、img 等组件，不等于验证了全部卡片版本。

## 同一份汇总持续更新

调用方选择持续维护当天汇总时：首次发送后保存消息 ID；后续在原卡片中合并新增或更正，标明更新时间及变化项，保留完整最新版。使用原消息 ID 更新，不重新创建一张完整摘要作为“更新”。

如调用方要求变化提醒，另发一条只说明新增/更正的简短消息，并同步更新原卡片。原卡片更新与提醒是两个独立投递操作，分别记录结果；不宣称它们具备原子性。是否提醒由来源工作流的已定规则决定，卡片编辑本身不等同已通知用户。

实施时在仓库外持久保存应用/目标群、来源标识、逻辑请求编号、原消息 ID、已确认内容版本和独立提醒记录，区分发送前、结果未知和回执确认。首次发送用稳定 uuid；本地先记账再调用，避免丢回执后重复创建。更新串行化到同一消息，避免旧快照覆盖新内容；不以 SDK 接口名 patch 推断服务端只合并局部字段。

发送/更新超时或未知结果先核对原消息，不自动重新发送摘要或提醒。更新失败时保留最后确认版本及待处理变化；不能报告“已更新”。目标卡片已删除、不可编辑或权限不足时报告具体阻塞，不静默改目标群或另建替代消息。权限和卡片模式限制需按当前应用核验；本次真实成功不等于所有卡片可更新。

官方卡片更新要求同应用、未撤回、发送14天内、更新前后显式共享配置，卡片不超过30KB，同消息5次/秒。首次发送 uuid 的服务端去重仅覆盖1小时，本机长期记录需保留，不据此重试旧未知操作。文本/富文本编辑另有20次上限及管理员设定时限；本命令尚不封装此类编辑。

## 验证边界

本轮一次性投递回执保存在用户状态目录 `outbound/`，不随技能打包，也不作为其他机器的可调用样例路径。用户已确认重启后回复、多群独立上下文和卡片展示；这些不证明定时任务、增量更新或自动图片下载已完成。

2026-10-16 可复用命令实测：发送带本地图的共享卡片；原位更新后 message ID 不变、revision从1变2；依赖该更新的独立文本提醒成功；三项原输入重复执行均返回 deduplicated，没有重新调用发送/更新。测试明确标注“功能验收、非真实作业”。增量内容如何合并由调用方负责，本命令接收完整快照，不创建定时任务或下载 QQ 图片。

维护采用静态文档、链接/打包检查和可执行脚本功能测试，不进行模拟对话的提示词行为测试。

官方参考：[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)、[更新卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)、[编辑文本与富文本](https://open.feishu.cn/document/server-docs/im-v1/message/update)。
