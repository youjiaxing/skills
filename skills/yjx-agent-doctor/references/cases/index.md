# 案例索引

预检按当前 Agent、服务路径和配置线索筛选；故障诊断按实际症状筛选。只读取匹配的案例，不把索引当作通用修复清单。线索命中后，仍需用当前环境证据判断是否适用。

| Agent | 故障症状或预检线索 | 读取位置 |
| --- | --- | --- |
| Codex | 模型目录有 multi_agent_version 或协作提示，但当前会话没有 spawn_agent/wait 等原生动作；需要区分模型、feature 和工具注入 | [Multi-agent编排动作未注入](codex-third-party.md#multi-agent编排动作未注入) |
| Codex | 切换模型后 Notion/MCP工具未出现在当前会话，或模型尝试调用未暴露的工具；需要区分工具集合与连接器授权 | [模型切换后的工具暴露](codex-third-party.md#模型切换后的工具暴露) |
| Codex | 自定义模型目录配置代码工具模式；出现原始代码与JSON参数格式不一致，或尚不清楚第三方接入是否支持该工具格式 | [代码工具载荷失配](codex-third-party.md#工具格式故障) |
| Codex | 混合模型子代理通信使用v2；需要核实消息投递兼容性，或接收者明确报告初始/后续任务不可读 | [子代理通信失配](codex-third-party.md#子代理通信故障) |
| Codex | 对已关闭子代理调用 `resume_agent` 并继续发送消息（或恢复会话）后报错 `function tool name "..." is duplicated`；需规避先关再开并定点修复重复工具声明 | [恢复子代理与重复工具声明](codex-third-party.md#恢复子代理与重复工具声明) |
| T3 Code / Antigravity ACP | 配置了远程 MCP（如 `serverUrl`）但会话看不到工具，或改为 `url` 后启动报错 `Unauthorized` | [配置字段 `serverUrl` 被 ACP 静默忽略](t3-antigravity-mcp.md#配置字段-serverurl-被-acp-静默忽略) / [ACP 无头模式远程 HTTP MCP 鉴权失败](t3-antigravity-mcp.md#acp-无头模式远程-http-mcp-鉴权失败unauthorized) |
| T3 Code / Antigravity ACP | 在 macOS GUI 宿主配置 `stdio` MCP 或 `mcp-remote` OAuth 桥接，或出现 `Antigravity text generation is unavailable` | [mcp-remote 常驻桥接与 GUI PATH 隔离](t3-antigravity-mcp.md#mcp-remote-常驻桥接与-gui-path-隔离) / [全局 mcp_config.json 禁用 Text Generation](t3-antigravity-mcp.md#全局-mcp_configjson-禁用-antigravity-text-generation) |

目前仅收录上述已核实案例。没有其他Agent、宿主或模型组合的已验证案例，不表示它们必然正常或异常；继续通用调查，并保留验证范围。
