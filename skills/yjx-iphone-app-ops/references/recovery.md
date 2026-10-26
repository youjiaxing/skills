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
3. 发送 Home 按键唤醒，再调用 `mobile: unlock`。
4. 页面树仍为锁屏时，从屏幕底部向上滑动一次。
5. 调用 `mobile: launchApp` 启动目标 bundle。
6. 启动后最多等待 8 秒，重复读取页面树、`activeAppInfo` 和 `queryAppState`；页面树根 bundle、active bundle 都匹配目标且状态为 `4` 才算 `app-ready`。

一次 XS Max、iOS 18.7.10 的实测中，`isLocked` 返回了陈旧 `false`，`mobile: lock` 超时；锁屏后通过唤醒和启动目标 App，最终确认小红书位于前台。该实测不证明其他 iOS 版本、重启后的首次解锁或有密码设备可无人值守恢复。

## 故障分流

| 症状 | 处理 |
| --- | --- |
| Appium 不可达 | 报告服务问题；仅在确认服务未运行且不影响其他任务时启动，不杀进程重启 |
| 设备缺失 | 检查配对、连接和 Developer Mode；需要手机确认时交给用户 |
| `devicectl device info apps` 报未配对 | 保留现有 WDA 会话验证证据；下次冷连接前在手机上重新信任/配对，不重复建会话 |
| WDA 未安装或无法启动 | 报告一次性签名/授权准备缺失，不在查询中改签名 |
| session 失效 | 删除状态文件并重新创建一次；仍失败则停止并报告 |
| `isLocked=false` 与页面树冲突 | 以页面树为准，执行唤醒和前台确认 |
| `mobile: lock` 超时 | 不用它作为锁屏或恢复前置；通过真实系统自动锁屏或用户侧键测试 |
| 目标 App 未到前台 | 检查错误、页面树及截图；最多重试一次启动，不连续重放写操作 |
| 登录、验证码或敏感权限提示 | 停止并由用户处理，不输入凭据或绕过验证 |

恢复重试仅限连接、读状态和打开目标 App。收藏、关注、发布、下单等有副作用操作不自动重试。

