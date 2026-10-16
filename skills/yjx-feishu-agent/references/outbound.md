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

需要执行时按已授权范围调用官方 SDK/API，或已核对身份的外部 CLI；不编造现有脚本的子命令。SDK 凭证通过 `loadCredentials` 读取，日志只输出必要回执或数值错误码，不输出 Token、Secret 或 SDK 请求配置。CLI 流程见 [外部工具说明](feishu-cli.md)。

## 命令与输入

从仓库根目录执行，或相对于技能目录定位脚本：

```text
node skills/yjx-feishu-agent/scripts/outbound.mjs send --input /path/to/send.json
node skills/yjx-feishu-agent/scripts/outbound.mjs update --input /path/to/update.json
node skills/yjx-feishu-agent/scripts/outbound.mjs status --request-id digest-20261016
```

均支持 `--state-dir PATH`，默认复用桥接状态目录与凭证。发送/更新退出码：0 已确认，2 准备受阻或输入错误，3 结果未知。status 的0只表示存档读出，仍检查状态字段。参数/版本错误时 CLI 仅输出通用安全错误，先核对输入和存档，不换编号重发。

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

更新 JSON：使用新的 requestId、`targetRequestId` 为最初发送编号、`expectedRevision` 为最后确认版本，提供 `msgType:interactive` 及完整 content/images，省略 chatId。初始版本1，确认更新后加1。只操作本工具当前应用下已记账的原卡片；不导入任意消息 ID。旧版本和前次结果未知的更新拒绝。

另发提醒使用独立 send 编号，可设置 `requiresUpdate` 为更新编号。命令在原卡片锁内确认它为同应用、同群且仍为最新的成功更新，再发送提醒；不能依赖失败或过时更新。重复相同输入返回存档；若原本地图被移动或修改，先用 status 核对，不换编号重发。

状态位于 `outbound-v1/<app hash>/requests`、`messages`，文件名为区分大小写逻辑编号的 SHA-256，避免 Windows 路径别名。保存正文、回执和最后确认版本；不自动迁移旧的一次性脚本记录。请求/目标分别加锁，不抢残留锁。外部提交前记账；成功后先写带 pending 的新快照，再写操作回执，最后清 pending。任一步崩溃保留门禁，人工核对消息及日志再恢复，不自动推断提交成功。

## 内容组织

需要分区的汇总优先使用卡片；短信式提醒可用文本。用户已选择其他格式时沿用该选择。正文按任务、行动、期限和适用对象组织；去掉重复叙述与采集技术说明，不删影响执行的限制条件，也不把推断改写成来源事实。业务所需的固定栏目由调用方提供。

图片应对应具体事项，保留原图可查看；本地路径需先上传取得飞书图片标识，不把 QQ 带鉴权参数的链接直接当成长期附件。图片获取遵循来源工作流的授权，本技能不自动扩大下载范围。文字识别失败不等于图片缺失；仅在缺失影响用户行动时提示查看原消息。

## SDK 调用入口

技能目录固定依赖 `@larksuiteoapi/node-sdk`。先核对当前版本字段及权限：

| 操作 | SDK/API | 关键内容 |
|---|---|---|
| 上传本地图片 | `client.im.v1.image.create` / `POST /im/v1/images` | `data.image_type: 'message'`，`data.image` 为文件流；取得 `image_key` |
| 主动发消息 | `client.im.v1.message.create` / `POST /im/v1/messages` | `params.receive_id_type: 'chat_id'`；data 中指定 receive_id、msg_type、JSON 字符串 content、稳定 uuid |
| 更新卡片 | `client.im.v1.message.patch` / `PATCH /im/v1/messages/:message_id` | path.message_id 指向原消息；data.content 为完整更新后卡片的 JSON 字符串 |
| 编辑文本/富文本 | `client.im.v1.message.update` / `PUT /im/v1/messages/:message_id` | path.message_id；data.msg_type 为 text/post，data.content 为对应 JSON 字符串 |

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
