# 可选外部飞书 CLI

用于桥接相关的群/消息查询、群管理及 CLI 配置诊断。桥接运行不依赖它；不复制 CLI 源码或安装其全部 Agent skills。官方入口：[larksuite/cli](https://github.com/larksuite/cli)。

## 发现与调用

先运行 `lark-cli --version`、`lark-cli --help`。未安装时可通过 npm 按需执行已核对版本，无需修改项目依赖或全局安装：

```text
npm exec --yes --package=@larksuite/cli@1.0.98 -- lark-cli --help
```

以下用 `lark-cli` 简写；未安装时替换为上述 npm 调用前缀。`1.0.98` 是 2026-10-16 核对版本，不代表最新版。其他版本先核实命令帮助，不自动升级已有安装。

## 身份与凭证

1. 用 `lark-cli profile list` 查找对应 profile，后续显式带 `--profile <名称>`，不切换默认 profile。
2. 用 `lark-cli --profile <名称> whoami` 核对应用、品牌和身份，与本次目标及桥接应用相符再操作。仅保留必要身份字段，不输出完整认证配置。
3. 缺少配置时先看 `config init --help`。复用已有桥接 App ID，不用 `--new` 创建另一应用。CLI 凭证存储独立，不会自动读取桥接的 `secrets/feishu.json`。
4. 配置命名 profile 的入口为 `config init --name <名称> --app-id <AppID> --brand feishu --app-secret-stdin`。先检查同名配置，避免覆盖；Secret 仅通过隐藏终端输入或本机进程 stdin 提供，不放进参数、聊天、日志或 shell 字面量。不用 `config show` 或导出配置全文排查凭证。

CLI 未配置时可继续使用桥接的 `feishu.mjs diagnose|discover`；不把 CLI 未登录误报为桥接鉴权失败。配置完成后核对身份及所需只读查询，安装成功不代表接通。

## 按任务调用

先读目标命令 `--help`，匹配任务时优先官方 `+` 快捷命令；参数或权限不明确时使用 `schema <service.resource.method>`，不猜字段。

| 任务 | 命令入口 |
|---|---|
| 本地配置检查 | `doctor --offline` |
| 配置、鉴权及联网检查 | `doctor` |
| 当前身份 | `whoami` |
| 所在群 | `im +chat-list --help` |
| 群成员 | `im +chat-members-list --help` |
| 群消息 | `im +chat-messages-list --help` |
| 创建/修改群 | `im +chat-create --help` / `im +chat-update --help` |
| 用户授权的发送/回复 | `im +messages-send --help` / `im +messages-reply --help` |

实际查询的身份和范围参数以该命令帮助为准，只读取本次任务所需群及时间范围。缺少权限时报告具体缺项，不自动扩大权限或换账号。

写入沿用本次用户授权，执行前明确目标群/消息与内容；高风险命令的确认按实际帮助执行。`--dry-run` 预览不代表服务端允许写入，CLI 的 `--yes` 不授予额外权限。

桥接已处理或正在处理的消息，不用 CLI 再回复一次。明确需要人工补发时，先核对原 Codex 请求及飞书现状，保留原编号和独立补发记录，不重提 Codex 任务。超时或结果未知先查询，不自动重试写入。

## 接收边界及验证状态

不为同一应用同时启动 CLI `event consume` 和 SDK 接收器，事件可能分发到不同连接。SDK 继续承担白名单、去重、持久化和 Codex 路由。以后替换接收层需单独实现并验证这些语义。

已实际执行 `1.0.98` 的根帮助、`config`、`config init`、`profile`、`doctor`、`im` 帮助，核对上述入口及 stdin 凭证选项。尚未配置 CLI profile 或通过 CLI 调用真实 API；运行时仍使用官方 Node SDK。
