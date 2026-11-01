# 控制环境部署与维护

环境缺失、迁移、WDA 签名安装或服务修复时读取。适用 macOS 控制真实 iPhone；需要已安装 Xcode/开发者工具、配对、Developer Mode 和 UI Automation。skill 负责检查、组织准备及验证；Xcode 登录、管理员密码、手机信任等本人步骤明确交接，凭据不入文件或输出。

## 本机配置与发现

```bash
node scripts/iphone-environment.mjs discover
node scripts/iphone-environment.mjs discover --udid <UDID> --output <local-config-path>
```

默认配置路径为 `~/.config/yjx-iphone-app-ops/config.json`，可用 `IPHONE_OPS_CONFIG` 覆盖。发现只读取已安装 Appium 服务、设备列表及已有 WDA 构建标识；多个可用设备时必须选目标，不能随意挑选。旧 session 仅在设备身份匹配时复用。

查看发现结果后显式保存；不覆盖既有配置。配置包含工具路径、设备、WDA 标识、端口与服务归属记录，不保存凭据。新的 WDA 标识使用独立控制工具命名并匹配可用签名团队；可以从已授权签名环境发现，目标团队无法确定时才询问。已有部署的历史标识可以保留为本机值。

没有既有构建时，在本机配置中补 `wdaBundleId`；先根据下节安装工具，再重新发现路径。环境变量 `IOS_DEVICE_UDID`、`IOS_WDA_BUNDLE_ID`、`IOS_DEVICE_NAME`、`IOS_PLATFORM_VERSION`、`APPIUM_URL`、`IOS_WDA_LOCAL_PORT`、`IPHONE_OPS_SESSION_FILE` 可覆盖本机值。不要将个人路径写回模板。

## 依赖与 WDA

```bash
node scripts/iphone-environment.mjs dependencies
node scripts/iphone-environment.mjs dependencies --apply --exclusive
node scripts/iphone-environment.mjs wda build --team-id <TEAM_ID> --exclusive
node scripts/iphone-environment.mjs wda install --exclusive
```

依赖安装只补缺失项，不自动升级正常工具链。当前支持路径使用 Appium 3.8.0 / XCUITest 12.20.0，升级需另做协议及真机回归；`driver doctor` 检查 Xcode 和依赖。安装完成重新发现/更新本机工具路径，再部署服务。

WDA 构建通过官方 `WebDriverAgent.xcodeproj` 的 `WebDriverAgentRunner` scheme，使用 Xcode/keychain 已有签名账户。`--allow-registration` 显式允许 provisioning 更新和设备注册；否则保留账户既有配置。默认构建目录在本机配置旁的 `wda-build`；`wda install --app-path <signed-WDA.app>` 可指定已有签名产物，安装前检查对应 WDA bundle、Runner 插件和签名。这里不安装业务 App。

签名、信任失败时说明具体步骤并交接用户；不要把 simulator 的 `build-wda` 命令当真机方案，不要求导出或保存 P12 密码。

## 服务归属与修复

```bash
node scripts/iphone-environment.mjs service status appium
node scripts/iphone-environment.mjs service plan appium
node scripts/iphone-environment.mjs service adopt appium --exclusive
node scripts/iphone-environment.mjs service install appium --exclusive
node scripts/iphone-environment.mjs service start appium --exclusive
```

`tunnel` 同理。需要管理员认证前，先向用户说明维护对象、故障原因、具体动作及影响；凭据由用户通过系统/终端自行输入，不保存密码。调用方授权维护不等于用户已经理解一次突然出现的认证窗口。`plan` 仅生成参数化定义；检查现有服务的 label、工具路径、配置内容及使用者后，才可 `adopt` 记录本机归属。`--exclusive` 表达调用方已实际确认唯一 owner，不是自动取得跨项目租约。

隧道模板启用无限次指数退避重连。当前支持版本的驱动脚本默认关闭断线重试；隧道死亡后进程可能继续运行、registry 为空，`KeepAlive` 不会因此重启进程。已有服务需检查实际启动参数；变更参数须重新加载后才生效。`refresh-services` 仅刷新已有隧道的服务目录，不能重建已删除的隧道；新建 Appium session 也不负责重建它。初始无设备、配对失败或重连持续失败仍需分层诊断，不能把重试配置当作实际恢复证据。

修改前校验配置指纹、session marker 和设备锁；旧配置先留恢复副本。配置被其他任务修改时停止并报告，不覆盖未知配置。只对指定归属的 launchd label 执行 `start/restart/stop`；端口占用不明时保留现场，不 kill 占用者。旧脚本 `launchd/install-root-tunnel.sh` 仅转发到同一入口，不再批量结束进程。

`bootout` 返回后仍需等指定 label 确认移除，再执行 `bootstrap`；CLI 最多等待 10 秒，读取失败或卸载结果未确认时停止加载并保留诊断，避免 launchd 的 `Operation already in progress` 竞态。

如果安装后服务核验失败，保留已安装/已加载阶段及备份路径，按同一归属规则恢复之前配置；无法恢复需具体交接，不能声称部署已完成。设备锁也用于维护串行化，存在未知请求或 session 创建结果未知时先诊断，禁止直接重启绕过。

## 整链验收

```bash
node scripts/iphone-app-ops.mjs doctor
node scripts/iphone-app-ops.mjs wda-health
node scripts/iphone-app-ops.mjs session
node scripts/iphone-app-ops.mjs recover --bundle-id <target-bundle>
node scripts/iphone-app-ops.mjs observe --bundle-id <target-bundle>
```

分阶段记录：依赖存在 → 服务响应 → 设备/隧道就绪 → WDA 命令可用 → 目标 App 实际前台与页面可观察。需要验证交互时执行任务授权的元素动作和状态断言。LaunchDaemon 进程、registry OK、WDA status 或安装命令成功均不能代替最后阶段。

官方依据：[XCUITest driver scripts](https://appium.github.io/appium-xcuitest-driver/latest/reference/scripts/)、[capabilities](https://appium.github.io/appium-xcuitest-driver/latest/reference/capabilities/)、[real-device setup](https://appium.github.io/appium-xcuitest-driver/latest/preparation/real-device-config/)。操作前核对安装版本及实际 CLI 帮助，不凭历史命令升级共享环境。
