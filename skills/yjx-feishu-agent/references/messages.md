# 引用上下文与群消息读取

## 接收与按需查询

接收器仍要求绑定群、白名单用户、明确 @ 当前机器人，接受 text 和 post。post 使用接收格式的 title、content/content_v2，优先后者以保留 md，不要求用户把图文手动重写为纯文本。普通群消息不会自动触发 Codex。

首次入站自动附上当前消息之前本群最近最多5条可见消息，包含其他会话推送的卡片；后续省略已成功传达的同一消息版本，修改后的正文可再次附带。首次成功请求的时间保存为固定基线，后续只补基线后的新增、已知消息的修改，或更新时间达到基线的旧消息；不会逐轮倒灌首轮未选中的老记录。基线不随请求前移，预算超限未送出的新增消息仍可在后续窗口补上。未附带过的旧消息若缺少更新时间，无法自动辨认其编辑，需显式引用或查询。

按时间从旧到新呈现，排除本次消息和引用链已出现的消息。以事件 create_time（毫秒）为截止，API用向上取整的秒值缩小范围后，再逐条严格过滤，避免秒精度造成混入后续消息。已知在请求后被编辑的旧消息也跳过；历史查询不是版本化快照，无法还原每条消息过去的所有版本。时间缺失时不使用当前系统时间冒充事件时间，跳过自动历史并注明。

每次自动历史最多5条，单条文字最多2000字符，消息列表 JSON 预算6000字符（不含显式引用和本次问题），最多查询两页、每页20条；系统消息不占窗口。截断的版本记为已附带过节选，需要余下正文时按消息 ID 查询。近期历史中的图片只附标识，Agent 判断相关时用 image 命令再取，不批量下载。达到数量、预算或分页上限时仅覆盖近期窗口；完整话题回复仍需单独查询。

去重账本按应用、群和绑定的 Codex 聊天隔离，保存在状态目录 `feishu/<app hash>/context`，只保存消息 ID、内容摘要和确认时间，最多1000条，每条保存最近成功版本；正文改回更早版本也会重新附带。仅在 Codex 返回 completed 后确认本次问题、引用和历史；确认发生在飞书回复之前，回复失败不撤销已传达记录。成功发送的机器人回复另记真实消息 ID 与实际文本版本，避免再次塞入自身回复。明确引用始终展开，不受自动历史去重影响。

接收器重启保留账本；改绑到新聊天重新取得小窗口，改回旧聊天复用旧账本。账本损坏或写入失败会注明/记录告警并继续处理当前问题，可能重复附带；被淘汰的老记录、结果未确认或升级前的请求也可能重复。账本不自动重放任务，也不保证目标聊天压缩上下文后仍保留所有原文，需要时显式查询。

理解请求时明确引用优先；没有引用时结合近期历史。多个推送均可能对应问题时先澄清，不猜对象，不因历史包含任务就再次执行。读取历史失败或权限不足时保留原问题和已取得的引用，并注明历史缺失，不把失败当作群内无消息。

每条入站请求保留 chatId/messageId，话题存在时带 threadId，末尾提供本技能的绝对路径作为按需操作入口；固定规则和查询命令不逐次重发。非默认状态目录另带 stateDir，查询时传 `--state-dir`。成功且没有增量时省略 recentHistory，无引用或图片时省略对应数组；消息中省略重复群标识、空图片列表及 false 默认状态。缺失、限额、撤回和正文截断仍显式标记；省略历史字段只表示未附带增量，不表示群内没有消息。

引用通过 parent_id 逐层获取，最多3条，同群校验，保留原文为引用资料；带资料的入站仍有“非新指令”短标记。话题场景的 parent_id/root_id 可能均指话题根，不代表最近一条发言。链达到上限、读取失败或权限不足时显示缺失，不猜原文。

引用中的 text/post/interactive 展开可读文字，单条引用文本最多4000字符并标记截断。当前富文本或引用里的图片通过消息资源接口下载到状态目录 `feishu/<app hash>/images`，一条请求最多4张、单张10MB；不遍历下载整个群的资源。已撤回/删除消息只返回状态，不展示正文或下载其图片。

路径会放入 Codex 请求作为图片查看工具的输入，不等于 App Server/queue 已收到多模态附件。Agent 需要实际用可用工具查看，与问题相关但无法查看时说明限制，不能声称看过。外部 Codex 缺少宿主工具时仍受 [Codex 限制](codex.md)约束。

## 查询命令

以下入口用于桥接上下文补读，沿用入站绑定与 SDK 身份。独立的群搜索、消息搜索或通用附件操作优先使用 `lark-im`，分工见 [职责选择](feishu-cli.md#职责选择)。保留这些脚本以供现有接收器和调用方使用，不因 CLI 可查询而改变其授权范围。

从仓库根执行，或相对本技能定位脚本。所有操作只读，不发送消息，不改绑定，不创建任务：

```text
node skills/yjx-feishu-agent/scripts/read-feishu.mjs history --chat oc_GROUP --limit 20
node skills/yjx-feishu-agent/scripts/read-feishu.mjs history --chat oc_GROUP --page-token TOKEN --limit 20
node skills/yjx-feishu-agent/scripts/read-feishu.mjs history --chat oc_GROUP --start-time EPOCH_SECONDS --end-time EPOCH_SECONDS
node skills/yjx-feishu-agent/scripts/read-feishu.mjs history --chat oc_GROUP --thread omt_THREAD --limit 20
node skills/yjx-feishu-agent/scripts/read-feishu.mjs message --chat oc_GROUP --message om_MESSAGE
node skills/yjx-feishu-agent/scripts/read-feishu.mjs image --chat oc_GROUP --message om_MESSAGE --image-key img_KEY
```

均支持 `--state-dir PATH`，命令前后都可放该参数；默认复用桥接凭证。群必须已绑定，单条和资源查询必须验证消息属于该群；图片 key 需实际出现在该消息正文中。资源下载返回本地路径。状态目录可能含私密原图，应放仓库外。

history 每次1–50条，默认20条、按创建时间倒序，返回 hasMore/nextPageToken；要读完整范围需继续分页，不能把首屏当全群。时间参数为秒，消息创建时间为毫秒。普通群历史不含全部话题回复，需使用返回的 threadId 另查，话题容器不支持起止时间。查询仅覆盖平台对当前机器人可见的数据，群历史限制、入群时间和保密设置仍可能阻止读取。

## 权限核对

事件接收与历史查询是不同能力。仅有 `im:message.group_at_msg` 或 `im:message.group_at_msg:readonly` 可接收 @ 事件，不保证获取任意引用原文或群历史。官方 GET 群消息要求基础 `im:message` / `im:message:readonly` 与 `im:message.group_msg`；历史列表也要求基础读取权限与 `im:message.group_msg`。机器人须在群内。事件权限表中的 group_msg:readonly 与 API 文档要求不完全相同，不凭名字猜等价关系。

本机当前应用对用户反馈的绑定群已实测成功读取历史、单条消息及引用图片，无需为本次修复扩大权限。换应用/环境时重新查询验证；若出现数值权限错误，在开放平台检查对应 scope、发布及授权状态，不把所有失败都说成没入群，不自动申请全量权限。

## 本次故障证据与边界

2026-10-17 用户反馈带引用 @ 后 Codex 不知道上下文。原日志证明文字已 completed/replied，API显示 parent_id 指向图片；旧接收器未使用 parent_id，也只接收 text。新增协议测试先复现 post 被忽略，再验证其接收、引用正文展开、同群隔离、图片落盘和错误提示。现有记录仅只读核对，未重放旧任务。新消息的用户端到端验收需在接收器加载新版后进行。

官方资料：[接收事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md)、[接收正文格式](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content.md)、[消息查询](https://open.feishu.cn/document/server-docs/im-v1/message/get.md)、[群历史](https://open.feishu.cn/document/server-docs/im-v1/message/list.md)、[资源读取](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get.md)。
