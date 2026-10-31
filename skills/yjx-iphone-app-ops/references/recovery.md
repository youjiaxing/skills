# 恢复流程

## 阶段状态

1. `device-ready`：配对设备被 `devicectl` 识别。
2. `wda-ready`：Appium session 存在，WDA source 可读取。
3. `screen-ready`：唤醒后页面树可读取；锁屏按页面树特征判断。
4. `app-ready`：页面树根应用的 bundle ID 与目标一致。

没有通过前一阶段，不报告后一阶段完成。

## 锁屏恢复

1. 检查并复用有效 session；无效时最多创建一次预安装 WDA session。
2. 读取页面树。`SBCoverSheetWindow` 或 `lockscreen-date-view` 是锁屏特征；仅出现 SpringBoard 根应用不能区分锁屏与普通主屏。
3. 仅在页面树显示锁屏时发送 Home 唤醒；未锁屏直接启动目标 App。
4. 仍为锁屏且无密码提示时，从底部短上滑一次；不调用曾超时的 `mobile: unlock`。出现密码输入即停止。
5. 调用 `mobile: launchApp` 启动目标 bundle。
6. 启动后以 8 秒为轮询预算，先读取 `activeAppInfo`，其 bundle 匹配后再读 `queryAppState`。两者均确认目标在前台时才取完整页面树；根 bundle 匹配后再回读一次 active bundle 和运行状态。仅后置检查也匹配且状态为 `4` 才算 `app-ready`。前置状态不能代替页面树或后置检查，旧应用的树不算恢复成功。
7. 预算到期后不再发送新命令；已在途的单条 WDA 请求仍受 45 秒传输 deadline 约束，超时按 unknown 处理，不能为赶预算重叠发送页面读取。后置校验未完成时保持未就绪。

一次 XS Max、iOS 18.7.10 的实测中，`isLocked` 返回了陈旧 `false`，`mobile: lock` 超时；锁屏后通过唤醒和启动目标 App，最终确认小红书位于前台。该实测不证明其他 iOS 版本、重启后的首次解锁或有密码设备可无人值守恢复。

## 故障分流

| 症状 | 处理 |
| --- | --- |
| Appium 不可达 | 报告服务问题；仅在确认服务未运行且不影响其他任务时启动，不杀进程重启 |
| 设备缺失 | 检查配对、连接和 Developer Mode；需要手机确认时交给用户 |
| `devicectl device info apps` 报未配对 | 保留现有 WDA 会话验证证据；下次冷连接前在手机上重新信任/配对，不重复建会话 |
| WDA 未安装或无法启动 | 报告一次性签名/授权准备缺失，不在查询中改签名 |
| `invalid session id` / `session-missing-or-expired` | 删除过期状态文件并只创建一次新 session；其他超时保留 session 状态并用 `wda-health` 分层检查 |
| `element-lookup-outcome-unconfirmed` | 原生查找到 30 秒代理期限才返回 no such element，可能是被驱动掩盖的错误；保留原始 driverCode，不当成普通元素缺失，不继续点击/坐标回退，按匹配 session 的 reset-required 原因做有界恢复 |
| `isLocked=false` 与页面树冲突 | 以页面树为准，执行唤醒和前台确认 |
| `mobile: lock` 超时 | 不用它作为锁屏或恢复前置；通过真实系统自动锁屏或用户侧键测试 |
| 目标 App 未到前台 | 检查错误、页面树及截图；最多重试一次启动，不连续重放写操作 |
| 登录、验证码或敏感权限提示 | 停止并由用户处理，不输入凭据或绕过验证 |

恢复重试仅限连接、读状态和打开目标 App。收藏、关注、发布、下单等有副作用操作不自动重试。


## 会话创建与设备锁

source 只有明确返回 invalid session id 才使缓存失效；普通读取超时保留会话。默认 HTTP 命令 deadline 为 45 秒，不能配置到 35 秒以下，长于 XCUITest 到 WDA 的 30 秒代理超时，避免客户端先断开而 Appium 命令仍在后台运行。超时 outcome 一律 unknown；`wda-health` 遇到这种结果时不再向同一 session 发送 activeAppInfo，避免重叠。观察当前状态前不重放动作。创建 HTTP 超时为 120 秒，超过 WDA 的 60 秒启动预算。创建结果未知时保留系统临时目录下的 `.creating` 标记，阻止重复建立孤立会话；验证或清理明确返回 `invalid session id` 时才清除该标记。收到已完成的 WDA proxy timeout 响应时写入 `.reset-required`，下一次命令只替换对应的缓存 session；标记与缓存不一致则停止并要求诊断。恢复时先读 Appium 日志确认创建的最终结果，不能仅因超时删除标记再次创建。

新 unattended session 使用 `newCommandTimeout=0` 禁止 Appium 因无命令 600 秒后主动销毁 session。显式 `close` 和 Appium 服务生命周期仍可终止它；断连后的 `invalid session id` 由 `ensureSession` 识别并只重建一次。`IPHONE_OPS_NEW_COMMAND_TIMEOUT_SEC` 可显式覆盖以诊断，普通查询不要设置有限空闲值。session 的 DELETE 只有收到成功响应后才移除状态文件；明确的 `invalid session id` 清理已过期状态，网络超时或其他不确定结果保留状态并标记命令结果 unknown。

CLI 锁文件记录 PID 与随机 owner 标识，不按持续时间抢锁。死亡进程或过期残缺锁返回 stale device lock，保留现场；确认没有设备 owner、没有在途请求后移除指定锁文件。PID 复用可能造成保守拒绝，不会自动接管。正常释放只移除自己的 owner 标识。未收到 HTTP 响应的 session 命令会将 session ID、命令阶段和时间写入同目录 `.unknown` 标记。`wda-health` 仍可检查 Appium、隧道和 WDA `/status`，但不向该 session 发任何其他命令。普通 CLI 操作等待 35 秒代理期限余量，确认基础传输可用后只读重验证原 session；通过后清除标记，确认 `invalid session id` 后才移除旧 session 并创建一次新 session。未知 session 没有缓存 ID 时拒绝新建以避免孤立 session。HTTP 已响应的 WebDriver 错误仍可能标记操作 outcome unknown，但不会生成“仍在执行”的标记。`close` 在 session DELETE 得到响应前保留状态；若已有未知请求标记则暂停关闭，避免与在途命令重叠。其他 Appium 项目仍须遵守唯一 owner 约定；此标记只协调本 CLI。

空 OCR 或黑屏不证明 App 无内容。先回读状态；允许一次唤醒/激活并重新观察，仍空则返回 screen-not-readable。不要把不确定根因写成已确认的 iOS 限制。

若连续读取与 Home 命令超时，而 WDA status、设备配对和隧道仍正常，先确认本轮独占设备、等待在途命令结束。允许人工诊断下关闭本轮持有的 session 并创建一次新 session；保留共享 Appium 和 tunnel，不把这项诊断自动放入每轮重试。2026-10-27 曾用此方式恢复 WDA 页面读取。关闭结果未知时保留状态并报告，不能循环建会话。

2026-10-27 的连续实测出现过 session 运行一段时间后 UI 命令无响应；只读 status 仍可能正常。2026-10-31 的重启验收先复现了切换后的 30 秒 source 超时，随后对照实验发现 launch 返回时 AX 当前应用仍可能是旧应用。直接取树会读到旧 bundle 或阻塞；修正为上述先等待状态收敛、再取树并做后置核验后，连续切换回归通过，详见[验收记录](roadmap.md)。这修复了本次复现的切换竞态，不代表所有 XCTest 无响应都由同一原因引起；其他超时继续保留原有分流与恢复保护。

2026-10-27 探针结果：锁屏页面树读取约 5.9 秒成功；一次自然 4 分钟空闲后设备已锁屏，页面树约 5.8 秒仍成功。旧 session 的历史日志显示 Appium 明确等待 600 秒后结束 session；这与 30 秒 WDA proxy timeout 是不同故障。旧 CLI 20 秒 abort 早于 driver 30 秒 proxy timeout，可能留下服务端在途请求并让紧随操作排队，因此现提高客户端默认 deadline 到至少 35 秒（默认 45 秒），并将 GET 超时也标为 unknown。新 session 已设置 `newCommandTimeout=0`；当日实测创建后空闲超过 15 分钟，健康探针确认锁屏页面树可读，随后无需密码完成唤醒、上滑和小红书前台校验，并连续三次读取页面树成功。该空闲验收不代表 App 切换后的页面读取稳定性已通过。
