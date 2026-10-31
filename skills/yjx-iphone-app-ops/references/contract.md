# 运行契约

链路为 `Agent → CLI → Appium 4723 → XCUITest Driver → RemoteXPC 隧道 → iPhone 上的签名 WDA Runner → 原生 App`。

Appium 与 RemoteXPC 隧道是共享运行服务。查询使用预安装 WDA，不在每轮重新构建或签名。首次 WDA 安装、Xcode 账户、开发者模式和 UI Automation 设置属于人工设备准备。

当前 Appium 用户 LaunchAgent 和管理员隧道 LaunchDaemon 已安装，Mac 重启并登录后的自动启动已实测；iPhone 配对与隧道可用，预安装 WDA 可按需建立新 session。App 切换按[恢复流程](recovery.md)先等前台信号收敛，再以完整页面树和后置状态确认就绪；不能把服务就绪视为整轮查询成功，详见[验收记录](roadmap.md)。Mac 登录前运行、用户登出和 iPhone 自身重启后的首次解锁仍未验收。

隧道迁移脚本（需管理员密码）是：

```bash
zsh skills/yjx-iphone-app-ops/launchd/install-root-tunnel.sh
```

脚本只有在 `http://127.0.0.1:42314/remotexpc/tunnels/<UDID>` 返回 `status=OK` 时才报告成功；root 进程存在但 `activeTunnels=0` 仍视为失败。

Appium 用户服务安装后用 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yjx.iphone-appium.plist` 加载。加载前先停止占用 4723 的旧 Appium 进程，避免两套实例竞争端口。

一台物理设备只允许一个自动化租约。CLI 自己的命令通过临时锁串行化，但无法发现另一个 Appium 项目持有的 session；多个项目必须约定唯一 owner 或使用不同设备/端口。当前 Appium 版本的 session 列表端点不可用，因此状态文件不是设备租约的唯一证明。

## 环境变量

本机值可用环境变量覆盖；不要把凭据放入文件、命令输出或对话。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `APPIUM_URL` | Appium 服务地址 | `http://127.0.0.1:4723` |
| `IOS_DEVICE_UDID` | 目标设备 | 当前 XS Max UDID |
| `IOS_DEVICE_NAME` | 设备名 | `iPhone XS Max` |
| `IOS_PLATFORM_VERSION` | iOS 主版本 | `18.7` |
| `IOS_WDA_BUNDLE_ID` | 已安装 WDA 基础 bundle ID | 当前已签名 WDA ID |
| `IOS_WDA_LOCAL_PORT` | 当前 Appium session 所属 WDA 本机状态端口，供 `wda-health` 诊断 | `8100` |
| `IPHONE_OPS_SESSION_FILE` | session 状态文件路径 | 系统临时目录下按设备区分 |
| `IPHONE_OPS_TIMEOUT_MS` | Appium 请求 deadline；至少 `35000` 且默认 45 秒，高于当前 XCUITest 30 秒 WDA proxy deadline | `45000` |
| `IPHONE_OPS_NEW_COMMAND_TIMEOUT_SEC` | 覆盖 Appium session 空闲寿命；`0` 表示 CLI 显式管理且不自动过期 | `0` |
| `IOS_APP_BUNDLE_ID` | 默认目标 App | 无 |

状态文件仅保存设备 UDID、session ID 和创建时间，权限设为 `0600`；不保存凭据、页面内容或截图。

## 可观察证据

- `doctor`：Appium 状态、指定设备行和隧道进程。
- `session`：Appium session 创建或复用成功，WDA 页面树可读；默认 `newCommandTimeout=0`，由 CLI 明确管理 session 生命周期，不因 10 分钟空闲自动销毁。
- 原生查找达到固定 WDA 代理期限后返回 miss 时，只能确认查找结果未确认；`wda-health` 显示 `element-lookup-outcome-unconfirmed`，不声称收到明确的 WDA timeout。该状态保留会话恢复标记并停止其他 session 命令。
- Mac 重启后尚未建立 session 时，本机 WDA `8100` 可以没有监听；若设备、Appium 和隧道正常且没有未知请求标记，按标准流程运行 `session` 再验证，不据此重新签名或重启共享服务。
- `wda-health`：分别探测 Appium、RemoteXPC 隧道 registry、配置的本机 WDA `/status` 端点和现有 session 页面树；没有持久化未知请求时，页面树失败再单独请求 activeAppInfo 区分完整 AX 快照与命令通道问题；有未知请求标记时跳过所有 session 命令。锁屏页面树可读是健康结果。默认 WDA 本机端口为 `8100`，多会话或端口变化时设置 `IOS_WDA_LOCAL_PORT`。
- `recover`：目标 bundle 是页面树根应用。
- `element read/click/set-value`：动作前目标 bundle、active app 和 `queryAppState=4` 一致；动作后页面树可再次读取。
- 二维码只读：轻量会话检查、前后 active bundle/状态与同屏完整分店名/二维码；不要求深度 XML 快照，不放宽实际点击的门禁。
- 页面截图：只证明该时刻设备显示状态，不证明内容真实或最新。


大众点评分页、产物、schema 和停止状态见[查询契约](query-contract.md)。
