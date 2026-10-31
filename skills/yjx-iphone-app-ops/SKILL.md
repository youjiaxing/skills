---
name: yjx-iphone-app-ops
description: 在网页入口受限、缺少关键功能或需要真实原生 App 页面时，通过已授权的 macOS、Appium、XCUITest 与 WebDriverAgent 链路操作 iPhone；触发于小红书、大众点评等原生 App 查询、页面读取和锁屏恢复。
---

# iPhone 原生 App 操作

把 iPhone 当作受控查询终端。此 skill 负责设备预检、会话、页面操作和恢复；来源可信度、事实核验、推荐和结果交付由调用方负责。

## 预检

先读[运行契约](references/contract.md)，需要查询小红书或大众点评时再读[已验证 App 配置](references/apps.md)，然后检查设备与服务：

`<skill-dir>` 是本 `SKILL.md` 所在目录。

```bash
node <skill-dir>/scripts/iphone-app-ops.mjs doctor
node <skill-dir>/scripts/iphone-app-ops.mjs wda-health
```

`doctor` 检查设备、Appium、隧道和 WDA 安装；`wda-health` 区分 Appium 状态、RemoteXPC registry、本机 WDA 端点、session、AX 页面树与自然锁屏。锁屏下页面树可读算 WDA 健康，之后再执行恢复。`devicectl` 显示 `available` 不是会话可用的充分证据。

## 会话

复用仍有效的会话；失效时以预安装 WDA 建立新会话：

```bash
node <skill-dir>/scripts/iphone-app-ops.mjs session
```

CLI 将非敏感 session ID 存在系统临时目录，权限为当前用户可读写。正常查询完成后保留 Appium 和隧道服务；不为单次任务重建 WDA 或停止共享服务。

Session 默认不因空闲自动超时，由 CLI 复用并恢复；客户端命令期限至少 35 秒，默认 45 秒，高于当前 XCUITest WDA 30 秒代理期限。超时的动作结果视为未知；先运行 `wda-health`，它不会在未知结果后向同一 session 发送重叠命令。

本机已安装 Appium LaunchAgent 与管理员隧道 LaunchDaemon，Mac 重启并登录后的服务自动启动已实测。切换 App 时先等前台信号收敛再取页面树；验收范围与结果见[实施目标与验收记录](references/roadmap.md)。

仓库提供 `launchd/` 配置模板。Appium 可安装为当前用户的 LaunchAgent；XCUITest 隧道官方脚本要求 root，首次迁移时由用户运行 `zsh <skill-dir>/launchd/install-root-tunnel.sh` 并在 sudo 提示输入管理员密码。脚本不会保存密码或修改 sudoers。

可用 `source` 读取脱敏状态摘要，`source --output <path>` 显式保存页面树，`screenshot --output <path>` 显式保存当前截图；本轮设备操作结束且确认不会影响共享任务时，才用 `close` 关闭 session。

## 恢复并打开 App

```bash
node <skill-dir>/scripts/iphone-app-ops.mjs recover --bundle-id <bundle-id>
```

按[恢复流程](references/recovery.md)读取页面树，仅在锁屏时唤醒并按需短上滑，启动目标 App，并等待页面树、active bundle 和前台状态一致。`mobile: isLocked` 仅作辅助信号，三者一致才是完成标准。

页面操作优先用 accessibility id、iOS predicate 或稳定语义；WebView 再使用已验证的 DOM 标识。截图用于视觉确认和故障诊断，不将坐标作为普通按钮的默认定位方式。原生树为空或评估读取效率时，读[读取路径与依据](references/reading-methods.md)。

大众点评查询先读[分页、证据与停止契约](references/query-contract.md)，使用结构化输出：

```bash
node <skill-dir>/scripts/iphone-app-ops.mjs dianping-search \
  --query '<query>' --max-pages 3 \
  --extract-output /tmp/dianping-new-run.json
```

默认最多读取 3 屏，原生文本优先，本机 Vision OCR 兜底；图片默认不落盘。输出 schemaVersion 2，含屏幕覆盖、停止原因、逐字段证据和复核状态，事实仍为未核实。消费方先处理失败/部分结果，再核查候选。出现登录、协议或验证时按契约停止；需要诊断时才显式保存截图或页面树。

需要门店详情、真实分享入口或小红书专用搜索时，读取[原生内容操作](references/native-content.md)。

元素操作使用 CLI 的受限入口：

```bash
node <skill-dir>/scripts/iphone-app-ops.mjs element read --bundle-id <bundle-id> --using accessibility-id --selector <id>
node <skill-dir>/scripts/iphone-app-ops.mjs element click --bundle-id <bundle-id> --using accessibility-id --selector <id>
printf '%s' '<query>' | node <skill-dir>/scripts/iphone-app-ops.mjs element set-value --bundle-id <bundle-id> --using accessibility-id --selector <id>
```

支持 `accessibility-id`、`predicate` 和 `class-chain`。点击或输入请求发出后不自动重试；先重新读取页面树、前台 bundle 和目标页面状态，再决定是否继续。

## 操作边界

- 默认进行页面读取、搜索、滚动、打开页面和输入查询词。
- 仅在用户明确授权时执行收藏、关注等可撤销轻量写入，并回读确认结果。
- 遇到登录凭据、验证码、付款、下单、发布、私信、不可逆删除或敏感权限提示时停止并交给用户处理。
- 不记录或传输 Apple ID、设备密码、App 密码、验证码和 Cookie；不绕过风控或安全验证。
- 输出保留平台、查询词、读取时间、页面状态和未核实字段。读取成功不代表事实已核实。

## 完成与失败

普通页面操作需确认设备、WDA 会话、页面树、目标 App 前台四个阶段。二维码只读观察按原生内容规则，用前后 App 状态和同屏像素文字确认；该路径不执行页面写入。失败时报告最后通过阶段和错误类别；HTTP 成功、进程存在或 unlock 返回成功都不能单独证明已恢复。按[故障分流](references/recovery.md)处理，不重放具有外部副作用的写操作。


维护、解释进度或继续建设时，读取[实施目标与验收记录](references/roadmap.md)。
