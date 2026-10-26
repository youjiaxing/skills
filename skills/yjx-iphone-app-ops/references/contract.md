# 运行契约

链路为 `Agent → CLI → Appium 4723 → XCUITest Driver → RemoteXPC 隧道 → iPhone 上的签名 WDA Runner → 原生 App`。

Appium 与 RemoteXPC 隧道是共享运行服务。查询使用预安装 WDA，不在每轮重新构建或签名。首次 WDA 安装、Xcode 账户、开发者模式和 UI Automation 设置属于人工设备准备。

当前 Appium 和管理员隧道由既有进程运行，未配置 launchd 开机服务。Mac 重启、用户登出或设备重启后的首次解锁不在当前自动恢复保证内；需要按人工恢复边界处理。

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
| `IPHONE_OPS_SESSION_FILE` | session 状态文件路径 | 系统临时目录下按设备区分 |
| `IOS_APP_BUNDLE_ID` | 默认目标 App | 无 |

状态文件仅保存设备 UDID、session ID 和创建时间，权限设为 `0600`；不保存凭据、页面内容或截图。

## 可观察证据

- `doctor`：Appium 状态、指定设备行和隧道进程。
- `session`：Appium session 创建或复用成功，WDA 页面树可读。
- `recover`：目标 bundle 是页面树根应用。
- `element read/click/set-value`：动作前目标 bundle、active app 和 `queryAppState=4` 一致；动作后页面树可再次读取。
- 页面截图：只证明该时刻设备显示状态，不证明内容真实或最新。

