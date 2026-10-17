# 可选外部飞书 CLI

用于桥接相关的群/消息查询、群管理及 CLI 配置诊断。桥接运行不依赖它，不复制 CLI 或外部 skill 源码。官方入口：[larksuite/cli](https://github.com/larksuite/cli)。

## 外部 skills 的复用范围

消息类型、收发参数和资源操作优先按需读取已安装的 `lark-im`；身份、权限和 CLI 输出契约读取 `lark-shared`。通过宿主提供的 skill 位置定位文件，不假定用户名、盘符或安装根目录。未安装时先用 CLI 帮助和官方文档核对，不把可选依赖变成现有桥接的启动条件。

设计新卡片时，从 `lark-im/references/card/lark-im-card-create.md` 导航到对应版本的 schema、样式和实际使用的组件；这些是卡片构造资料，不复制到本技能。已验收的旧版模板不因新参考默认推荐 2.0 而迁移。展示验收边界见 [主动投递](outbound.md#内容组织)。

持久化任务的发送、更新和恢复以本技能账本为准；使用外部资料的“失败后重试”“重新发一张”步骤前，先判断是否已有未决投递或原卡片，不能据此绕过原编号、重复发送或改变用户选定的原位更新策略。CLI 的单次幂等键不替代长期账本。SDK 与 CLI 的返回格式分别核对，不套用同一成功判断。

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

2026-10-18 本机 `1.0.98` 已通过版本、profile、离线诊断、显式 bot 身份检查及真实群列表只读查询；未借本次检查发送消息或启动 CLI 事件连接。该结果不证明其他机器的配置、用户授权或所有业务权限可用；运行时仍使用官方 Node SDK。
