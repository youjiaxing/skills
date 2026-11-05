# 运行契约

链路为 `Agent → CLI → Appium 4723 → XCUITest Driver → RemoteXPC 隧道 → iPhone 上的签名 WDA Runner → 原生 App`。

Appium 与 RemoteXPC 隧道是共享运行服务。查询使用预安装 WDA，不在每轮重新构建或签名。控制环境的首次部署、WDA 签名安装和后续维护由本 skill 组织，见[控制环境维护](environment.md)。Xcode 账户、管理员密码、开发者模式/信任等需要本人完成的步骤单独交接。

当前 Appium 用户 LaunchAgent 和管理员隧道 LaunchDaemon 已安装，Mac 重启并登录后的自动启动已实测；iPhone 配对与隧道可用，预安装 WDA 可按需建立新 session。App 切换按[恢复流程](recovery.md)先等前台信号收敛，再以完整页面树和后置状态确认就绪；不能把服务就绪视为整轮查询成功，详见[验收记录](roadmap.md)。Mac 登录前运行、用户登出和 iPhone 自身重启后的首次解锁仍未验收。

本机配置和参数化模板由 `scripts/iphone-environment.mjs` 管理，安装/启动命令见[控制环境维护](environment.md)。健康服务复用，维护时先确认唯一 owner、服务与配置归属和无在途请求；端口占用不能作为停止进程的依据。未知归属时保留现场并报告具体接管动作。隧道须以目标设备 registry 返回 OK 验证，进程存在不算就绪。

一台物理设备只允许一个自动化租约。CLI 自己的命令通过临时锁串行化，但无法发现另一个 Appium 项目持有的 session；多个项目必须约定唯一 owner 或使用不同设备/端口。当前 Appium 版本的 session 列表端点不可用，因此状态文件不是设备租约的唯一证明。

## 环境变量

本机值可用环境变量覆盖；不要把凭据放入文件、命令输出或对话。

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `APPIUM_URL` | Appium 服务地址 | `http://127.0.0.1:4723` |
| `IOS_DEVICE_UDID` | 目标设备 | 本机配置，或显式指定 |
| `IOS_DEVICE_NAME` | 设备名 | 本机配置，默认 `iPhone` |
| `IOS_PLATFORM_VERSION` | iOS 主版本 | 本机配置，未设则由驱动发现 |
| `IOS_WDA_BUNDLE_ID` | 已安装 WDA 基础 bundle ID | 本机配置，或显式指定 |
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

## 通用操作结果

观察、等待、断言、WebView 和手势见[通用操作与验证](operations.md)。新结果在原字段外独立表达 `operation.outcome` 和 `verification.status`；原 `ok` 或 `action` 仅有原命令含义。专用查询 schema 和 `factStatus` 保持原语义。


## 受阻与恢复交接

以下是本 skill 向调用方交付的语义契约，复用现有命令结果和已取得的观察，不要求所有 CLI 命令返回同一 JSON，也不另建持久化交接对象。专用查询保留自己的 schema，由操作 Agent 按实际结果整理同样的信息。

| 交接内容 | 优先使用的既有信息 | 缺失或不确定时 |
| --- | --- | --- |
| 最后确认的 App 与页面 | `bundleId`、`foregroundBundle`、观察时间、`observations` 及证据引用 | 目标 bundle 只代表请求对象；未通过前台门禁不能称为已确认。保留最近一次确认时间并注明当前页面未确认 |
| 最后动作与发送情况 | `operation.method`、`operation.outcome`；专用命令保留原字段含义 | 区分本次只读命令与先前有副作用动作；未知动作不能被后续 `not-sent` 覆盖 |
| 效果是否确认 | `verification`、`reconciliation` 及对应后置证据 | 明确验证范围；单一条件通过不自动升级为业务目标完成，条件不满足不证明动作未执行 |
| 未决请求与会话保护 | `failure.transportPending`、已读到的 unknown/reset-required/creating 标记及健康检查结果 | 未检查写“未检查”；`transportPending=false` 只说明该次请求未被标成在途，不能单独证明所有会话标记均不存在 |
| 错误及恢复情况 | `status`、`phase`、`failure.category`、`recovery.readRetries/readBudgetExhausted`；恢复命令的 `steps`、`sessionRecovery` 等实际结果 | 只列实际执行过的恢复和已知局部消耗；不能把 `recovery.next` 建议当作已经执行，也不估算未记录的总次数或总时长 |
| 可安全采取的下一步 | `recovery.next`、具体阻塞及所需前提 | 建议先服从在途请求、身份、安全和授权门禁；无法确定时停止依赖该效果的动作，说明缺少的证据 |
| 必要证据 | `evidence`、产物引用、`evidenceFailure` | 取证失败附加在原错误上，不改变原动作的发送或验证状态；凭据和敏感正文不进入交接 |

动作发送与业务效果、协议结果与在途状态分别表达；保留不同命令的先后关系。交接仅汇总已有结果，不为补齐字段而向未决 session 发新命令。跨会话保存的时机、位置和格式由调用方的上下文保存机制决定，本 skill 不引入该机制为运行依赖。
