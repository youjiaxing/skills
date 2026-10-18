# 消息诊断与并发

按用户提供的飞书消息 ID 查询本地证据。对外汇报使用 [状态表述](status.md) 的证据边界：

```text
node skills/yjx-feishu-agent/scripts/diagnose-message.mjs --message om_MESSAGE
```

支持 `--state-dir PATH`。该命令只读本机任务、入口诊断和表情日志，不调用飞书或 Codex，不重放、补发、改路由或修复表情。输出区分 admission、route、codex、reply、feedback；未找到证据为 `not_observed`，不据此断言消息没有到达。旧版本请求可能缺少阶段或错误字段。

`codex` 保留桥接收到的结果快照；`execution` 读取本机正在执行的原请求记录，显示状态观察、最近查询和实际内容变化时间。二者可能因任务尚未结束或后来只读核查而不同，不混淆为重复执行。

| 证据 | 处理 |
| --- | --- |
| `BOT_NOT_MENTIONED`、`USER_NOT_ALLOWED`、`UNSUPPORTED_MESSAGE_TYPE` 等入口原因 | 按当前群/用户授权核对，不自动扩权 |
| `QUOTE_SOURCE_UNAVAILABLE`、`DEFAULT_UNCONFIGURED` | 检查被引用消息是否登记来源、群是否配置默认会话 |
| codex 的 submitted/status/code | 判断是否已提交；未知结果保持原请求编号核查 |
| codex.waitTimedOut 为 true | 等待预算耗尽；interruptRequested 仅表示已请求中断，不证明最终状态 |
| reply 为 unknown | 回复已尝试但缺确认，不自动再回复 |
| reply.type / reply.mode | 只读记录实际选择的 `text`、`post` 或 `interactive`，不代表客户端视觉已验收 |
| reply confirmed，task.failure.stage 为 route_confirmation | 回答已送达，来源记账需另查，不能重发回答 |
| feedback.lastWarning | 仅处理标记失败；结合 desired/attempts 判断，不重跑任务 |

诊断只保留消息 ID、固定原因、处理阶段和安全数值错误码，不写消息正文或原始 SDK 异常。绑定群的被忽略事件记录在 `feishu/<app hash>/admissions`，任务仍在 messages，标记在 feedback；入口队列已满时仅记录运行日志告警，可能没有该消息的本地诊断。上述文件均在仓库外，不自动清空。

任务调度按受理时已持久化的 `threadId` 分组：同一会话跨群串行，不同会话默认最多并行 2 条；被占用的会话不会挡住其他会话。无目标的阻断提示独立调度。入口及等待队列各有 32 条上限。停止时拒绝新消息，等待此前排队受理、已排队任务和执行中的任务完成。

需要调整并发时，先停止接收器，在 `feishu/bindings.json` 顶层设置 `maxConcurrentThreads`（1–8），核对后启动。设为 1 可恢复全局串行。此配置不抢占 Codex 的跨进程会话锁，不改变来源冻结、未知请求门禁和重启不重放规则。

飞书接收器使用 `waitMode:state`，不设置任务总运行时限。每次状态查询保留独立的 RPC 超时，默认 30 秒；单次查询超时记录 `STATUS_QUERY_TIMEOUT` 后继续观察，不中断模型。通过本次唯一轮次核对完成、失败、中断，不用“最后一条助手消息”或其他会话的活动代替；运行中、等待工具、静默、完成文本尚未落盘或暂态 interrupted 均继续等待。只有可核验的完成时间及非空最终文本才返回答案；确认失败/中断后结束等待，无最终答案不会伪装成功。完成事件用于加速下一次查询，缺事件仍可从持久历史确认。

`execution.observationState` 区分 running、queued、awaiting_final、unknown 和已核实终态；`lastObservedAt` 表示进行过查询尝试，不证明查询成功，失败原因另在 `lastObservationError`；`lastProgressAt` 只在该轮历史实际变化时更新，不把反复查询当成任务进展。静默本身不触发取消或失败推断。

要调整单次接口等待，先停止接收器，在配置顶层设置 `codexRpcTimeoutMs`（1000–120000，毫秒）后启动。旧 `codexTimeoutMs` 继续允许读取，但不再限制桥接任务总时长。请求锁、初始化和提交仍有有限等待；提交结果未知不重发。独立 `agent.mjs` 的显式时限行为保持兼容。state 模式不主动调用 turn/interrupt；进程退出、协议错误或不支持的宿主交互仍会进入未决/受阻处理。失去可用客户端时现有关闭流程会结束自身 App Server 进程，可能影响正在执行的任务，不能承诺断连后继续执行；保留请求编号人工核查。

停止接收器继续等待已受理任务，可能长时间不退出；普通群消息不提供取消任务指令。需要结束任务时由用户在对应 Codex 会话处理，桥接根据确认的终态收尾。重启不会重跑未知任务。

2026-10-18 实际技术群请求在受理后约 180 秒被旧固定预算打断；会话记录仍在查资料，没有最终回答。先延长至 15 分钟后，用户明确选择按运行状态判断，新版因此取消桥接总时限；旧 `timeoutMs/waitTimedOut/interruptRequested` 仍是原请求的历史证据，不能据此改为成功。旧请求需按原编号和轮次核查；需要继续时由用户在原 Codex 会话发出明确新指令。对旧时限请求，`agent.mjs status --request-id ID --refresh` 只有对自身已请求中断的 App Server 轮次读到匹配 ID、interrupted 及有效完成时间后，才记为已确认中断并解除该请求的未决门禁。state 请求的刷新与实时观察共用终态判定，确认完成、失败或中断后更新本机记录；刷新为有限只读查询，缺证据保持未知，不续跑、不发飞书回复。

运行状态和 connection-events 保留停止原因：`control`、`sigint`、`sigterm`、`connection_failed`、`startup_timeout` 或 `runtime_failed`。接收器仍以真实 connected 和心跳确认就绪。仅有正常连接不能证明某条消息已通过授权、路由或执行；SDK 原始日志仍保持关闭，避免输出凭证。
