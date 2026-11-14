# 桌面宿主与 ACP Harness 接入远程 OAuth MCP 故障

来源及最近验证时间：2026-11-14 对 T3 Code（Desktop）+ `antigravity-acp` 运行时接入远程 Notion MCP（`https://mcp.notion.com/mcp`）的实际故障排查与修复验证。已移除本机用户名、个人目录哈希、会话 ID、业务库及凭据内容。

## 现象和环境

桌面宿主为 T3 Code（Beta），底层通过 `antigravity-acp`（含 `agy_acp_server.par` 与 `localharness_external`）拉起会话。用户的 Notion MCP 原配置从桌面 IDE 迁移而来，同时存在一份旧的 OAuth token 缓存，但新会话中仅加载了宿主内置 MCP，看不到任何 Notion 工具。

本环境还存在两项关联约束：
- 工作区中已有任务工作流依赖 Notion 官方托管 MCP 的视图读取与全局 OAuth 权限，直接降级成仅封装基础 REST API 的本地 token 服务会导致能力缺失；
- 宿主在 macOS 图形界面启动时不继承交互式 shell 的 `nvm` `PATH`。

## 配置字段 `serverUrl` 被 ACP 静默忽略

排查 `agy_acp_server.par` 中的 `parse_mcp_config_file` 实现确认，该解析器读取 `$GEMINI_HOME/config/mcp_config.json` 时只识别 `"command"` 与 `"url"` 两个键，不识别桌面 IDE 沿用的 `"serverUrl"`。因此原配置中的 `"notion": {"serverUrl": "https://mcp.notion.com/mcp"}` 在解析阶段即被跳过，未向底层 harness 传递该服务器。

将字段由 `"serverUrl"` 改为 `"url"` 并新开会话后，底层尝试发起 MCP 握手，进入下一层鉴权故障。

## ACP 无头模式远程 HTTP MCP 鉴权失败（`Unauthorized`）

改为 `"url": "https://mcp.notion.com/mcp"` 后，新会话启动直接报错中止：

`The MCP server 'notion' failed to initialize: calling "initialize": sending "initialize": Unauthorized.`

检查对应 `antigravity-acp/mcp_oauth_tokens.json` 元数据与修改时间确认，文件仍保留两周前过期（带 `refresh_token`）的旧凭据且未被更新；ACP 无头运行时未在 `Unauthorized` 时刷新或弹窗引导重新完成浏览器 OAuth。

## `mcp-remote` 常驻桥接与 GUI `PATH` 隔离

由于 `agy_acp_server.par` 原生支持 `"command"` + `"args"` 的 `stdio` MCP，改用本地 `mcp-remote`（验证版本 `0.14.3`，Node `22.18.0`）代理连接官方远程端点 `https://mcp.notion.com/mcp`，由 `mcp-remote` 独立完成浏览器 OAuth 并将凭据持久化到 `~/.mcp-auth/`。

实施与验证中确认两项部署要点：
- **避免 GUI `PATH` 缺失**：macOS 图形界面启动的宿主默认 `PATH` 不含 `~/.nvm/.../bin`，配置里使用裸命令 `npx` 或依赖 `#!/usr/bin/env node` 可能在无头子进程启动时失败，需在 `command` 中直接写明 `node` 绝对路径。
- **避免指向易失缓存**：不应将 `mcp_config.json` 长期指向 `~/.npm/_npx/...` 缓存目录；需先将 `mcp-remote` 安装到常驻本地目录（例如 `~/.local/mcp-remote`），再把 `args[0]` 指向该常驻目录下的 `dist/proxy.js`。

验证过程与边界：
1. 在终端用绝对 `node` 路径运行一次常驻 `mcp-remote` 入口，在系统浏览器完成授权后于 `~/.mcp-auth/mcp-remote-v1/` 生成凭据文件。
2. 在仅保留 `/usr/bin:/bin:/usr/sbin:/sbin` 的最小 `PATH` 下执行无副作用只读 `stdio` 握手对照：`initialize` 成功返回 `Notion MCP 1.2.0`，`tools/list` 返回 77 个工具。
3. 旧会话不热加载 `mcp_config.json`，需在配置更新后新开 T3 Code 会话生效（本次尚未在对话内对新开 T3 Code 会话的实际工具列表做最终回读）。

## 全局 `mcp_config.json` 禁用 Antigravity Text Generation

检查 T3 Code 服务端源码（`isAntigravityTextGenerationAvailable`）与运行日志确认：只要对应 profile 目录下的 `config/hooks.json` 或 `config/mcp_config.json` 非空，T3 Code 会主动禁用 Antigravity 的后台 Text Generation（影响线程标题、commit message、分支名、PR 内容与 review guide 自动生成），日志报：

`Antigravity text generation is unavailable for profiles with global hooks or MCP configuration. Select another system model.`

主对话与 MCP 工具调用不受此限制影响。若需恢复后台自动生成，可在 T3 Code 设置中将 System Model 切换为非 Antigravity provider（本轮未实测），或另行验证将 MCP 移入工作区插件目录是否被 ACP 加载（未验证，保留为待核实路径）。
