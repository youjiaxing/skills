# 飞书接入准备

当前包含本机 Codex 收发、凭证录入、飞书诊断、群绑定与长连接接收代码。已完成单群 @ 消息与已有 Codex 聊天的实际往返验收；其他安装环境仍需按本节完成配置和验收。

在飞书开放平台创建企业自建应用、启用机器人后，将机器人加入测试群。消息接收事件使用 `im.message.receive_v1`，订阅方式选择长连接。把明确的群 ID、发送者 ID 与 Codex 聊天 UUID 绑定后再启动转发。

## 本地录入凭证

在用户自己的交互式终端中运行，替换 App ID 和脚本路径。仅依赖 Node.js 20+，同一脚本用于 Windows、macOS 和 Linux：

```sh
node /path/to/skills/skills/yjx-feishu-agent/scripts/setup-feishu.mjs --app-id cli_your_app_id
```

从开放平台的“凭证与基础信息”复制 App Secret，在脚本的隐藏输入提示中粘贴并按回车。该操作由用户在终端完成，Secret 不经过聊天，也不作为命令参数出现。

默认写入用户主目录下的 `.yjx-feishu-agent/secrets/feishu.json`；设置 `YJX_FEISHU_AGENT_HOME` 或传入 `--state-dir` 可指定另一个本地状态目录，选择仓库外路径。

凭证采用未加密 JSON 存储，由文件系统权限保护；隐藏输入只防止终端回显，不是磁盘加密。Unix 新建目录权限为 `0700`、文件为 `0600`；Windows 继承所选用户目录的 ACL，Node 的 mode 参数不提供 Windows ACL 隔离。目录应仅供本人使用，避免共享目录、同步目录及仓库。脚本不依赖 PowerShell、DPAPI 或平台专属命令。

脚本不会覆盖已有凭证，运行结束仅说明凭证已保存，尚未验证 App Secret 有效，也没有启动网络连接。后续接入进程通过 `scripts/feishu-credentials.mjs` 的 `loadCredentials` 读取，日志和错误输出应保持 Secret 隐藏。若已运行旧 PowerShell 版并生成 DPAPI 文件，读取器会明确拒绝该格式；先将旧文件移到别处备份，再运行新版录入，避免静默覆盖或依赖 Windows 解密。

群消息第一轮验收使用明确的 `@机器人` 文本。Codex 的对话上下文来自绑定的已有聊天，接收一条新消息不要求重新发送全部历史。未被飞书投递的群消息则不会自动成为 Codex 上下文。

## 安装、诊断与接入

从仓库根目录执行；SDK 固定版本和锁文件在技能目录内，不改仓库根依赖：

```sh
npm ci --ignore-scripts --prefix skills/yjx-feishu-agent
node skills/yjx-feishu-agent/scripts/feishu.mjs diagnose
node skills/yjx-feishu-agent/scripts/feishu.mjs discover
```

`diagnose` 仅输出 HTTP 状态、业务码、Log ID 和是否取得令牌，不输出 Token。失败退出码为 2；`21001` 分类为 `access_control_denied`，先排查飞书侧访问控制，不反复改 Secret。`discover` 读取机器人信息、所在群及群成员，供核实绑定，需要相应读取权限。若仅缺少成员列表权限（99991672），仍返回群 ID、群主 open_id，成员查询标记为 `permission_required`，不会因一个可选查询失败丢弃群信息。用户自己创建的测试群可经核实先仅允许群主；群主信息不代表授权所有成员。

在用户确认群和用户身份、已有聊天 UUID 后执行（值均为占位符）：

```sh
node skills/yjx-feishu-agent/scripts/receiver.mjs stop
node skills/yjx-feishu-agent/scripts/feishu.mjs bind --chat oc_GROUP --user ou_USER --thread CHAT_UUID --codex /path/to/native/codex --cwd /path/to/workspace
node skills/yjx-feishu-agent/scripts/receiver.mjs start
```

Windows 将 `--codex` 替换为原生 `codex.exe` 路径；`--cwd` 是该 Codex 请求的工作目录，路径带空格时加引号。以上命令均支持 `--state-dir`。绑定保存在状态目录 `feishu/bindings.json`；再次绑定另一个群可添加映射，同一群已有映射时拒绝覆盖。变更配置先停止接收器，再核实并编辑该本机文件；`codex` 和 `cwd` 为进程共用配置。

## 查询与重新绑定

```text
node skills/yjx-feishu-agent/scripts/bindings.mjs list
node skills/yjx-feishu-agent/scripts/bindings.mjs check --chat oc_GROUP
node skills/yjx-feishu-agent/scripts/receiver.mjs stop
node skills/yjx-feishu-agent/scripts/bindings.mjs rebind --chat oc_GROUP --expected-thread OLD_UUID --thread NEW_UUID
node skills/yjx-feishu-agent/scripts/receiver.mjs start
```

以上命令均支持 `--state-dir PATH`。list 只读本机配置；check 通过原生 App Server 的 `thread/read` 只读核对目标，不续写、不解归档。当前版本按返回 path 的独立目录组件区分 sessions 与 archived_sessions；路径缺失/未知为 unknown，notLoaded 不能证明删除。已核实的 `thread not loaded: UUID` 错误归为 unavailable，原因可能是未加载或数据缺失，不声称永久删除。

发送前核查目标。默认绑定路径的 archived、unavailable、unknown 均阻断；只有按全局默认规则使用 [引用路由](routing.md) 且来源明确的引用请求，可自动解归档精确目标并读回核实后提交。恢复失败、响应未知或状态无法确认均不提交、不改投其他会话。已提交但未知的请求仍按旧编号只读核对；旧入站事件不会自动重放。

rebind 仅更改已存在群的 threadId，要求旧 UUID 完全匹配、新目标可读且未归档；保留用户白名单、其他群、原请求/投递日志。它与接收器共用应用锁，必须先优雅停止；残留锁需核查而非强行删除。写入前保存 previous/next 到 `feishu/binding-history`，存档是变更意图和恢复依据，不单独证明配置写入成功。重启后新消息才使用新目标；不会迁移上下文、创建会话或重放任务。新增群的 bind 命令也使用同一应用锁，需先停止接收器。手工编辑无法参与锁协调，必须停服并串行维护配置。

准备阶段已通过执行脚本测试、真实目标只读检查、隔离不存在 UUID 的未提交验证。随后用户完成归档/恢复的实群验收：2026-10-16 23:54（北京时间），归档目标的入站请求返回 TARGET_ARCHIVED、blocked、submitted=false，飞书提示投递成功；2026-10-17 00:05，用户恢复同一聊天后发送的新请求 completed，回答原上下文编号，飞书记录 replied。旧归档请求仍保持未提交，没有自动重放。不存在 UUID 只证明不可用分支，不等同真实删除验收；2026-10-17 又完成重新绑定实群验收：第二群临时切换到另一条测试聊天后，新消息回复该聊天的编号；恢复原绑定后，新消息再次回复原编号。两次均有 completed 与 replied 日志佐证，变更前后配置分别保存于 binding-history，当前已恢复原映射。此验收只覆盖明确改绑与恢复，不代表自动迁移上下文或真实删除恢复能力。

## 接收器运行管理

`receiver.mjs` 使用 Node.js，管理命令在三个平台共用：

```sh
node skills/yjx-feishu-agent/scripts/receiver.mjs start
node skills/yjx-feishu-agent/scripts/receiver.mjs status
node skills/yjx-feishu-agent/scripts/receiver.mjs stop
```

支持 `--state-dir PATH`。`start` 会等待心跳显示 `running` 且连接为 `connected` 才报告启动成功，随后仍须实群消息验收。`status` 区分运行、停止、死亡进程遗留锁、无 owner 的不完整锁以及未知状态；不能把一个残留 PID 文件当作接收器正在运行。`stop` 写入带当前实例 token 的停止请求，由接收器优雅关闭长连接、等待已接任务完成，再释放锁并退出；不会按 PID 强杀进程。

Windows 使用原生 `schtasks.exe` 注册当前用户的任务：InteractiveToken、LeastPrivilege，当前用户登录时自动触发，不保存登录密码、不提升权限，执行时限设为无限，切换电池不停止。主任务保留失败后每分钟、最多3次的重启；另注册 `<主任务名>-watchdog`，每分钟执行一次 `receiver.mjs ensure`。恢复启用且接收器确认 stopped 时请求主任务启动，不因主任务耗尽重试而永久停止检查；running 不重复启动，stale_lock、incomplete_lock 和 unknown 记录 blocked，留待人工检查，不强杀或清理请求锁。注册后读回核对任务动作和触发配置。

实际接收器由 Windows 任务服务启动，与 Desktop 终端生命周期分开；保持当前用户登录。`start` 启用本安装的自动恢复并可立即启动，Windows 重启后登录仍可触发；`stop` 先持久禁用恢复，再优雅停止，直到用户再次 `start`，登录及 watchdog 均不会重新拉起。受管 serve 在建立 receiver owner 时与 start/stop 共用生命周期锁并复核恢复意图，防止延迟启动绕过停止。若生命周期锁残留需人工检查，不自动抢占。删除安装时先 stop，再按 `task-registration.json` 和 `watchdog-registration.json` 删除两个任务。

macOS/Linux 使用 detached Node 进程，将标准输出记录在运行目录的 `receiver.log`；未做这两个平台的实机验收，也不安装 launchd/systemd 或定时 watchdog。`ensure` 可以单次检查，但不表示已安装调度。各平台的 `status.json` 保存实时心跳，`connection-events.ndjson` 保存连接状态变化，位于用户目录 `.yjx-feishu-agent-receivers/runtime/<app hash>`。`recovery.json` 保存启停意图，`watchdog-status.json` 保存最近检查结果，`last-failure.json` 与 `failures.ndjson` 保存故障阶段和允许的系统/API码，不保存原始异常、堆栈、消息正文或凭证。`receiver.mjs status` 一并显示恢复开关、最后检查及最近故障。心跳原子替换遇到短暂 EPERM/EACCES/EBUSY 时有限重试，持续失败仍保留错误。任务参数和日志不保存 App Secret；请求结果仍在原状态目录。

每个应用同一系统账户只允许一个接收器，锁在固定的用户目录 `.yjx-feishu-agent-receivers/locks/<app hash>`，与自定义状态目录无关。死亡进程留下的锁不会自动抢占，明确检查后可执行：

```sh
node skills/yjx-feishu-agent/scripts/receiver.mjs recover-lock
```

该命令串行核对 owner 和 PID，仅回收已确认不存在的接收器进程锁，不改 Codex sender locks 或请求日志。权限不足、PID 仍存在、owner 缺失都拒绝恢复；`incomplete_lock` 或恢复互斥目录遗留时需先检查相关进程和目录，不能直接按 PID 强杀或批量删状态。其他电脑或系统账户上的同应用实例也应关闭，飞书会在多个长连接间分发事件。

`feishu.mjs serve` 仍可用于独立终端前台调试，Ctrl+C 或 SIGTERM 优雅停止。若从 Codex Desktop 的工具终端启动，Desktop 退出可能连带停止它；日常使用应走上述管理命令。

接收器接受绑定群、白名单用户发出的 text/post，且必须明确 @ 当前机器人。会补入同群引用链的文字/卡片内容与图片路径，另提供按需历史查询，见 [消息上下文](messages.md)。事件以应用 ID + 飞书 message ID 生成稳定请求编号；接收日志写入并同步文件后才向 SDK 返回，Codex 执行在队列中串行完成。入口和执行队列各有 32 条上限，超限返回失败。仍以文本回复原消息，过长时截断并提示到 Codex 查看；不支持普通附件自动解析或主动定时推送。主动卡片/图片投递见 [投递说明](outbound.md)，与接收器能力区分。

进程中断后的日志保留在 `feishu/<app hash>/messages`，重启报告 `unsettled`，不会自动重放。日志不保存原消息全文：`accepted` 且无对应 Codex 请求记录时，正文需从飞书人工找回；`processing`、`replying`、`unconfirmed` 则先查 `agent.mjs status --request-id ... --refresh` 和飞书是否已有回复，不能直接删日志重发。写入文件使用 sync 和原子 rename；目录元数据未做跨平台断电保证。回复 API 返回未知时不自动重发，避免重复回复。实际模型执行权限、Desktop 宿主限制沿用 [Codex 接入说明](codex.md)。

## 飞书 CLI 的用途

可选外部 CLI 的发现、身份核对及按任务调用步骤见 [CLI 工具流程](feishu-cli.md)。

已用官方 npm 包 `@larksuite/cli@1.0.98` 运行帮助命令核实：CLI 支持群管理、消息发送/回复、`doctor` 诊断，也支持 `event consume im.message.receive_v1` 将实时事件输出为 NDJSON。因此它既可作为配置与排查工具，也具备成为事件接入层的能力。

当前桥接仍用官方 SDK 接收并执行已有的白名单、去重和 Codex 路由逻辑；CLI 是管理补充，尚未配置应用凭证或启用 CLI 事件进程。不要为同一应用同时启动 SDK 接收器和 CLI 事件总线，避免事件分发到不同连接。若以后改为 CLI 接入，需明确替换接收层并保留桥接的请求状态语义。CLI 凭证配置是独立体系，不应把 Secret 作为命令行参数或输出配置全文。

能力参考：[官方 CLI](https://github.com/larksuite/cli)、[事件消费文档](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)。读取该文档用于核对能力，不代表本技能要求安装其全部 Agent skills。

## 2026-10-16 接入阻塞与排查

本次应用调用官方 `tenant_access_token/internal` 接口返回 HTTP 200、业务码 `21001`，提示访问控制拒绝；官方 SDK 与 Node 原生 fetch 均复现。控制台显示“正式应用@豆包账号”，安全设置 IP 白名单未见配置。未取得令牌，因此没有创建实际群绑定或启动接收，也没有完成群内往返。

[官方项目仓库的同类问题 #639](https://github.com/larksuite/openclaw-lark/issues/639) 及其 2026-10-15 评论也报告相同错误、“正式应用@豆包账号”以及接入管控升级。该信息是用户报告，不能视为官方确认根因或保证某种迁移方式有效。不向外部消息或 issue 粘贴 Secret、Token 或完整配置文件。

后续自行排查已核对官方新版 OAuth 文档，并完成最小消息权限、错误 Secret 和 DIRECT 路由对照：当前应用的消息权限令牌明确被平台数据安全策略拒绝；普通凭证错误返回不同错误码。官方 CLI 源码也将 21001 归为 Policy/AccessDenied。详情、证据边界及可自助验证路径见 [21001 排查记录](access-control-diagnosis.md)。尚未确认具体内部规则，不应把所有个人账号一概判定为不可用。

同日后续，用户更换账号与应用并更新凭证后，旧版与新版令牌接口均返回 `code=0`，机器人身份和群列表查询成功；先前的鉴权阻塞已解除。用户将新机器人加入「Agent 接入测试」群后，已完成群主白名单绑定，长连接实测达到 `connected`。

## 实群往返验收

2026-10-16 15:54–15:55（北京时间），用户在测试群明确 @ 机器人，询问已有 Codex 测试聊天最初的标记，消息正文未附带标记本身。接收器把消息交给同一已有聊天，返回「松林-7429」，并通过飞书 reply API 回复原消息。用户截图与本机请求日志相互印证：Codex 状态为 `completed`，飞书投递日志为 `replied`，本轮走外部 `app-server` 恢复路径。

本次证明单群、群主白名单、明确 @ 文本、历史上下文延续和飞书回复链路可用。Desktop 持有聊天时的 queue 路径此前有独立本机验收，本次实群验收未覆盖该路径；也不代表 Desktop 宿主工具或其他群映射已验收。电脑休眠、进程退出或网络中断仍会影响接收。

同日用户重启 Desktop 后发现新消息无回复。排查确认旧前台接收器 PID 已不存在，只有死亡进程锁，消息未进入本机日志，鉴权与绑定均正常。随后改用独立启动管理：Windows 当前用户任务由任务服务承载、实际接收器父进程为 `svchost.exe`，实测启动连通、优雅停止和再次启动均通过；后续已升级为当前用户登录触发，Windows 重启后登录会自动启动。停机期间的消息不自动补发。

2026-10-16 16:53–16:54，用户在未再次重启 Desktop 的情况下询问临时编号。截图显示机器人答出「青石-5831」；16:53:50 入站请求的本机记录同时确认 `route=queue`、Codex `completed`、飞书 `replied`。本次覆盖修复后的 queue 实群往返及原聊天上下文，未覆盖再次重启场景。另有 16:54:30 入站请求 Codex 已完成但投递为 `unconfirmed`，不据此前一成功推断所有投递都成功，不自动重发。

后续用户明确完成 Desktop 重启验收并提供正确编号回复截图；又在两个群分别询问编号，截图显示各自返回对应聊天的不同编号。由此补齐本环境重启后往返及多群上下文隔离的用户验收。此后的主动摘要、卡片/富文本和本地图片投递也取得 API 成功回执，用户选定修订版卡片；卡片原位更新尚未实测。前述待验收描述为当时阶段记录，不代表仍要求用户重复测试。

## 官方参考

- [飞书开发者后台](https://open.feishu.cn/app)
- [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)
