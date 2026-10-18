# 消息诊断与并发

按用户提供的飞书消息 ID 查询本地证据：

```text
node skills/yjx-feishu-agent/scripts/diagnose-message.mjs --message om_MESSAGE
```

支持 `--state-dir PATH`。该命令只读本机任务、入口诊断和表情日志，不调用飞书或 Codex，不重放、补发、改路由或修复表情。输出区分 admission、route、codex、reply、feedback；未找到证据为 `not_observed`，不据此断言消息没有到达。旧版本请求可能缺少阶段或错误字段。

| 证据 | 处理 |
| --- | --- |
| `BOT_NOT_MENTIONED`、`USER_NOT_ALLOWED`、`UNSUPPORTED_MESSAGE_TYPE` 等入口原因 | 按当前群/用户授权核对，不自动扩权 |
| `QUOTE_SOURCE_UNAVAILABLE`、`DEFAULT_UNCONFIGURED` | 检查被引用消息是否登记来源、群是否配置默认会话 |
| codex 的 submitted/status/code | 判断是否已提交；未知结果保持原请求编号核查 |
| codex.waitTimedOut 为 true | 等待预算耗尽；interruptRequested 仅表示已请求中断，不证明最终状态 |
| reply 为 unknown | 回复已尝试但缺确认，不自动再回复 |
| reply confirmed，task.failure.stage 为 route_confirmation | 回答已送达，来源记账需另查，不能重发回答 |
| feedback.lastWarning | 仅处理标记失败；结合 desired/attempts 判断，不重跑任务 |

诊断只保留消息 ID、固定原因、处理阶段和安全数值错误码，不写消息正文或原始 SDK 异常。绑定群的被忽略事件记录在 `feishu/<app hash>/admissions`，任务仍在 messages，标记在 feedback；入口队列已满时仅记录运行日志告警，可能没有该消息的本地诊断。上述文件均在仓库外，不自动清空。

任务调度按受理时已持久化的 `threadId` 分组：同一会话跨群串行，不同会话默认最多并行 2 条；被占用的会话不会挡住其他会话。无目标的阻断提示独立调度。入口及等待队列各有 32 条上限。停止时拒绝新消息，等待此前排队受理、已排队任务和执行中的任务完成。

需要调整并发时，先停止接收器，在 `feishu/bindings.json` 顶层设置 `maxConcurrentThreads`（1–8），核对后启动。设为 1 可恢复全局串行。此配置不抢占 Codex 的跨进程会话锁，不改变来源冻结、未知请求门禁和重启不重放规则。

飞书请求的 Codex 等待预算默认 15 分钟，涵盖请求锁、目标核对和执行；排队期间尚未开始计时。受理时固定预算到本条任务，避免后续配置变化影响它。需要调整时停服，在配置顶层设置 `codexTimeoutMs`（60000–3600000，单位毫秒）后启动；独立 `agent.mjs` 仍默认 3 分钟。超时后，外部 App Server 路径仅对自身已知 turn 请求中断，队列路径可能继续执行，提示分别说明；不会续等后自动补答或重跑。接收器停止会等待已受理任务，因此较长预算也可能延长优雅停机时间。

2026-10-18 实际技术群请求在受理后约 180 秒被旧固定预算打断；会话记录仍在查资料，没有最终回答。新版本延长桥接预算并保留 `timeoutMs/waitTimedOut/interruptRequested` 证据，不能据此将旧请求改成成功。旧请求需按原编号和轮次核查；需要继续时由用户在原 Codex 会话发出明确新指令。`agent.mjs status --request-id ID --refresh` 只有对自身已请求中断的 App Server 轮次读到匹配 ID、interrupted 及有效完成时间后，才记为已确认中断并解除该请求的未决门禁；缺证据保持未知，不续跑、不发飞书回复。

运行状态和 connection-events 保留停止原因：`control`、`sigint`、`sigterm`、`connection_failed`、`startup_timeout` 或 `runtime_failed`。接收器仍以真实 connected 和心跳确认就绪。仅有正常连接不能证明某条消息已通过授权、路由或执行；SDK 原始日志仍保持关闭，避免输出凭证。
