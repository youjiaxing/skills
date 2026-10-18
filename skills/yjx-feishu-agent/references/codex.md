# Codex 本机适配：首版本

## 范围与要求

提供一次文字请求的发送、状态查询及最终回答读取。只接受已有聊天 UUID，不新建、归档或接管 Desktop 正持有的聊天。飞书长连接与接收器管理见 [飞书接入](feishu.md)，主动消息、图片和卡片的验证状态见 [投递说明](outbound.md)；这些不扩展本 Codex 文本传输模块的输入类型。其他 Agent 的具体适配将在有真实实现时增加，当前记录中 `agent` 固定为 `codex`。

依赖 Node.js 20+ 和已登录的本机 Codex 原生可执行文件，不安装额外依赖。优先显式指定与 Desktop 相同版本的程序；Windows 使用 `codex.exe`，不经 `.cmd`、`.ps1` 或 shell 转发。PATH 中只有 npm 包装器时，传 `--codex` 或设置 `CODEX_CLI_PATH`。

## 命令

从仓库根目录运行，UUID、程序路径和请求编号替换为本次真实值：

```text
node skills/yjx-feishu-agent/scripts/agent.mjs send --thread <UUID> --request-id summary-001 --message "请总结上一轮调查的结论。" --codex <原生程序路径>
node skills/yjx-feishu-agent/scripts/agent.mjs status --request-id summary-001
node skills/yjx-feishu-agent/scripts/agent.mjs status --request-id summary-001 --refresh
```

也支持 `--message TEXT`、`--state-dir PATH`、`--cwd PATH`、`--timeout-ms N`，以 `--help` 为准。标准输入原样保留，包括换行；若用同一请求编号从另一种输入方式重试，应保证消息字节对应的文本相同，否则会报告冲突。

发送退出码：`0` 获得最终文本，`2` 未提交/明确失败/中断，`3` 待确认。查询退出码 `0` 仅表示读取记录成功，调用方仍需检查 `status`。命令 stdout 只输出一个 JSON 记录，程序故障输出 `status=error`。

关键字段：

| 字段 | 含义 |
|---|---|
| requestId | 调用方的幂等编号；不指定时随机生成，收到结果后保存它 |
| threadId / turnId | 目标已有聊天和本次实际轮次 |
| status | waiting、submitting、running、completed、failed、interrupted、blocked 或 unconfirmed |
| submitted | 保守标记：可能已交付外部，不代表执行成功 |
| route | app-server：外部进程恢复；queue：交给已有写入者 |
| answer / answers | 本轮支持的最终文本；多段文本按轮次原顺序保留 |
| error | 明确错误或待确认原因，不能用它推断未执行过 |

## 分流与结果关联

Codex 模块先尝试 `thread/resume`，仅对服务端明确的 `already has an active writer` 错误转队列；其他错误保留原状。外部恢复后用 `turn/start`，按实时 `turn/completed` 的聊天和轮次 ID 确认终态，再读取持久化的最终文本。

队列路径在消息前添加随机传输标记，只在用户消息中匹配该标记以关联轮次；它会在聊天历史中可见。队列回执 ID 不等于轮次 ID。首次匹配后固定轮次，分页查历史，不取“最新助手消息”。查询遇到多轮匹配、接口不兼容或分页上限会保留待确认，不猜测结果。

独立进程读取持久化历史时，执行中轮次曾短暂显示 `interrupted` 且无 `completedAt`。队列路径只在 `completed`、完成时间存在且有可识别的最终文本时确认成功。优先读取显式 `final_answer`；Desktop 实测会返回 `phase: null`，仅在已完成且有完成时间、最后一项为非空文本 `agentMessage` 且阶段为空或缺省时，以该最后一项作为兼容结果，不拼接此前无阶段文本。显式 `commentary`、末尾工具/推理项及暂态轮次均不触发兼容。该规则是本适配器基于实测的保守兼容，并非官方对空阶段的最终回答保证。其他失败/中断在队列路径可能只能报告待确认；外部执行路径可依据实时完成事件识别。

## 并发、重复和超时

每个请求在发送前先原子占用本机编号，记录输入摘要。相同编号和输入只读回记录，不再次执行；不同输入占用同一编号会报错。该保证作用于同一状态目录，不能替代服务端幂等性。完整原消息仅写入 Codex 历史；状态文件保存摘要和回复。

同一聊天通过本机锁串行发送，不同聊天可独立运行。这个锁只协调使用同一状态目录的本模块，无法阻止人在 Desktop 或其他工具中同时发消息。混入其他来源输入时，本命令返回的是匹配轮次的最终文本，不承诺能把同轮多段回答按用户输入拆分。

超时后不自动重发。队列中的任务可能稍后执行，`status --refresh` 只读核对。上一请求已提交但结果未确认时，即使换新编号也会阻止向同一聊天继续发送，直到旧结果被确认。外部执行超时或宿主交互受阻时，若已知活动轮次，会尝试中断本模块拥有的轮次再关闭其进程；不能据此承诺已停止所有工具副作用。队列路径不会中断 Desktop。刷新过程中如果同目录发送锁仍被持有，直接返回存档并标记 `refreshSkipped`。

进程异常退出可能留下本机锁。先核查 `locks/<threadId>/owner.json` 中的进程及该请求实际状态；确认没有本模块工作进程后才能手动清理锁。清理锁不代表可重发旧请求，仍需保留请求记录。模块不会自动窃取陈旧锁，也不会为解决写入竞争归档聊天。

## 权限和兼容性

外部执行沿用现有 Codex 登录、模型、工作目录和权限配置，不增加自动审批。服务端宿主请求会被拒绝并记录 `unsupportedInteractions`；此客户端尚无 Desktop 动态工具桥接或审批界面。此类请求保持 `blocked`，刷新即使读到后来的文本也保留宿主交互错误；应人工核查，不把晚到回复当作宿主能力已补齐。真实测试仅证明文字消息与历史恢复，不能推广为所有桌面插件、远程聊天或环境完全兼容。

状态默认在 `~/.yjx-feishu-agent`，也可通过环境变量或选项选择；它保存回复及机器路径，不应提交到仓库。依靠文件系统排他创建、重命名和私有目录协调状态，状态目录应位于可信的本机文件系统，避免网络共享目录。

## 真实交互证据与维护验证

2026-10-16 的 Windows 验证使用 Desktop 捆绑 `0.163.0-alpha.10.2`：

- 已载入聊天用 CLI queue 接收多轮文字，并恢复原测试标记。
- 外部只读 `thread/turns/list` 成功读取新增轮次最终回答；修正暂态 interrupted 误判后连续两次完成。
- 未加载聊天通过独立 App Server 恢复相同 ID，连续两次在约7至9秒收到实时完成并取得回答。Desktop 原服务仍未加载该聊天，但能查询新增历史。
- 已被 Desktop 持有的聊天，外部恢复明确报 active writer。测试中临时归档/恢复只用于构造隔离条件，不是产品实现策略。

首版本 Node.js 命令也在同一隔离测试聊天完成验收：未加载条件返回 `route=app-server`、`status=completed`；Desktop 持有条件返回 `route=queue`、`status=completed`。两次都答出原历史标记。相同请求编号和文本二次调用返回 `deduplicated=true` 及原轮次 ID，没有再次发送。尚未实测其他操作系统、桌面专属工具或断电恢复。

仓库维护只进行静态文档、链接/打包检查及可执行脚本功能测试；不创建或运行 Skill 提示词的模拟对话行为测试。

官方协议：[App Server](https://learn.chatgpt.com/docs/app-server)、[CLI queue](https://learn.chatgpt.com/docs/cli/reference#codex-queue)。升级 Codex 后需重新验证字段、写入锁错误及持久化状态的兼容性。
