# 兼容性与维护

## 环境

- Node.js 20+，仅标准库，无 npm/pip 安装或二进制编译要求。
- 官方 GoLand launcher 及其内置 Groovy JSR-223 引擎。脚本通过官方 ideScript 入口执行；IDE 未启动时，直接 ideScript 是执行后退出的命令模式，因此先正常启动并打开项目。
- 启动、停止和调试控制首批面向本地 Go Build/Application 配置。读取其他配置可以提供信息，但不推断为支持远程、复合配置或其他语言 runner。
- profile、IDE 路径及运行数据均可配置，不绑定当前维护者的工作目录。

Windows、macOS、Linux 有各自的发现和启动路径；实际平台验收状态以本文件后续记录为准，未实测不能标记通过。

## 已知兼容性要点

- GoLand 的 CLI 没有直接的配置 start/stop/restart 命令；本实现调用 IDE 的 Execution/XDebugger API。官方文档：[命令行](https://www.jetbrains.com/help/go/working-with-the-ide-features-from-command-line.html)、[IDE 脚本](https://www.jetbrains.com/help/go/ide-scripting-console.html)、[调试](https://www.jetbrains.com/help/go/debugging-code.html)。
- 2026.2.2.1 的分离式调试器会对 `XDebugSession.getRunContentDescriptor` 报错。本实现通过调试器枚举对象登记不复用的 session 句柄，不调用该接口；普通 Run 描述符通过 RunContentManager 读取。
- 使用正常 invokeLater 调度模型操作，不能用 ModalityState.any 绕过模态窗口执行配置/断点写操作。doctor 等只读诊断可以在模态状态观察阻塞。
- 变量、栈和求值是异步回调；必须校验暂停身份与时限，不在 EDT 阻塞等待。
- 原脚本结束后的后台调度在分离式 IDE 中存在任务上下文与生命周期差异；本实现使用新的固定 ideScript 观察调用推进原已登记请求，不依赖原命令的后台计时器。观察不会重新派发原写操作。
- 部分实现使用 IntelliJ 内部 API，包括进程停止、配置克隆、控制台 delegate 和变量展示文本提取。升级 GoLand 后必须重跑真实 IDE 验收；API 不支持时报告具体能力缺口，不自动改走 MCP、进程强杀或任意脚本执行。
- project.save 返回不代表独立事务提交。复制和更新需要回读，并通过重开项目测试持久化；正常保存可能包含其他设置。

## 验证入口

离线定向功能测试：

```sh
node --test skills/yjx-goland-ops/tests/transport.test.mjs
```

真实 IDE 测试是显式 opt-in，在 Windows 创建单独 config/system/plugins/log、临时 Go 项目和测试进程；需要指定已安装 launcher、Go SDK 及个人许可证源文件。许可证只复制到私有临时 profile，不写入输出或源码，收尾删除。没有这些变量时测试标记跳过。

环境变量：`GOLAND_OPS_LIVE_IDE`、`GOLAND_OPS_LIVE_SDK`、`GOLAND_OPS_LIVE_LICENSE`。使用仓库中的 `tests/live-ide.test.mjs` 定向执行。测试不得使用业务项目或既有业务服务；失败证据暂留在输出的临时目录，排查结束清理属于本任务的目录。

静态文档检查只证明链接、格式和打包一致性，不证明 Agent 必然按提示正确操作。维护只测试关键协议、持久化、凭据、并发和重试等功能，不编写模拟用户/助手对话。

## 当前验收

2026-11-12，正式 Node/Groovy 实现在 Windows、GoLand 2026.2.2.1（GO-262.10315.160）、Go 1.25.8、Node 24.14.0 完成验收：

- 18 项离线功能测试通过，覆盖请求去重、跨目标缓存拒绝、超时恢复、原子路由文件、敏感 JSON 错误、未决项目打开、迟到 probe 不误删新锁、首次回执缺失恢复、固定观察协议及安装链接下的 CLI 入口执行。
- 真实隔离 IDE 端到端测试通过，产生73条命令证据，其中包含预期失败和冲突拒绝；这不是73个独立测试。
- 覆盖个人/共享配置及启动前任务保存重开、手动运行会话、具体编译错误、凭据脱敏、日志清空断档、Debug 断点/变量/栈/字段求值/单步与继续、未决长单步中断、同配置双 Debug 会话隔离、过期请求不执行及用户断点保护。
- 复验日志 ERROR/SEVERE 为0，没有 Write-unsafe context 或旧调试描述符接口错误。测试实例与进程已结束，用户原有 IDE 保留。

macOS/Linux 的发现与启动代码已实现，尚未实机验证。远程/复合配置、附加调试、条件/日志断点、goroutine 切换、单步进入/跳出不在首版验收范围。
