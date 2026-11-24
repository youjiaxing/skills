---
name: yjx-t3-antigravity-proxy
description: 管理 T3 Code 的 Antigravity ACP 上下文封顶代理（macOS 与 Windows）：配置或重装代理入口、调整模型窗口档位与自动压缩阈值、检查运行状态，以及停用并恢复原始配置。
---

# T3 Antigravity 上下文封顶代理

面向 T3 Code 的 `providers.antigravity.binaryPath` 独立 ACP stdio 代理，通过 [agy-proxy.mjs](scripts/agy-proxy.mjs) 将上游动态下发的 Antigravity 模型展开为可配置的上下文封顶变体，并在接近上限时于下一轮对话前自动执行纯 `/compact`。

仅作用于 Antigravity provider 的外置启动入口与运行目录，不修改 T3 Code 的 `app.asar`，不接管其他 provider，也不替代 `yjx-agent-doctor` 处理通用 Agent 故障。对宿主机真实 `~/.t3/userdata/settings.json` 执行 `--setup` 或 `--restore` 前，确认已获得当前会话对真实配置写入的授权。

## 1. 前置检查与安装位置

运行代理与安装脚本要求 Node.js `>= 22.13.0`（需内置 `node:sqlite` 以只读校验 Antigravity 会话步骤结果）。

永久安装目录默认位于 `<t3Home>/tools/antigravity-proxy/`（默认 `~/.t3/tools/antigravity-proxy/`）：

- `bin/antigravity`（macOS / Linux）或 `bin/antigravity.cmd`（Windows）：固化绝对 `nodePath` 与 `--install-dir`，供 T3 Code 脱离交互式 Shell PATH 直接拉起。
- `runtime/`：安装时从本 skill 的 `scripts/` 拷贝独立副本，使运行态不依赖源码仓库当前工作区状态。
- `config.json`：外部可变配置（`defaultCapTokens`、`compactTriggerRatio`、`variantCaps`、`includeFullVariant`），修改后由后续新拉起的 ACP 进程直接生效，无需修改源码。
- `cache/`：按 SHA-256 键存放已观测模型原生窗口（`models/`）、不可变变体别名映射（`variants/`）与会话所选变体（`sessions/`）。

## 2. 按任务分支执行

根据用户需求选择唯一入口：

### 初次部署或升级运行时（`--setup`）

在仓库更新代理代码后，或在新机器（macOS / Windows）首次启用时执行：

1. 先执行预览检查（不写入文件）：
   `node scripts/agy-proxy.mjs --setup --dry-run`
   若存在多版本 Node，通过 `--node-path <绝对路径>` 显式绑定支持 `node:sqlite` 的 Node 可执行文件；若 T3 目录非默认路径，传 `--t3-home <目录>`。
2. 确认无报错且已获得写入真实 T3 配置的授权后执行落盘：
   `node scripts/agy-proxy.mjs --setup`
3. 提示用户：若 T3 Code 正在运行且已有活跃 Antigravity 会话，新配置将在新建或重连 ACP 进程后生效。

完成条件：`--setup` 返回 `ok: true`，`settings.json` 中 `providers.antigravity.binaryPath` 指向 `<installDir>/bin/antigravity`（Windows 为 `antigravity.cmd`），且首次切换已生成备份记录。

### 调整窗口档位或压缩阈值（`config.json`）

读取并编辑 `<installDir>/config.json`（禁止在模型原生窗口未知或已处于原生最大档时强行压缩；修改参数时保持与 `DEFAULT_CONFIG` 相同的字段结构）：

- `defaultCapTokens`：默认原模型 ID 对应的封顶窗口（默认 `512000`）。
- `compactTriggerRatio`：触发下一轮前置 `/compact` 的比例阈值（默认 `0.9`）。
- `variantCaps`：额外变体后缀列表（如 `{ "suffix": "-256k", "label": "256k", "capTokens": 256000 }`）。
- `includeFullVariant`：是否为超过默认封顶的模型暴露原生无封顶 `-full` 档（默认 `true`）。

原生窗口未知时仅暴露上游原始模型 ID，不根据默认封顶猜测并创建档位；收到可靠的实时 `usage_update.size` 后，自动向当前代理进程中受影响的会话发布适用变体，无需新建会话。刷新保留当前模型、变体选择与其他配置；失败时保留待刷新状态，在后续实时用量通知或配置操作结束时重试。已有会话的持久化档位选择会为恢复连续性保留。

完成条件：`config.json` 可通过 `node scripts/agy-proxy.mjs --status` 解析并回显预期参数。

### 检查状态与排障（`--status`）

执行：
`node scripts/agy-proxy.mjs --status`

核对输出中的 `installed`、`settingsPointingToProxy`、`nodeCheck.ok` 与 `upstream.binaryPath`；若升级 T3 Code 后发现异常或需排查原生行为差异，可对照 `--status` 结果与 `cache/` 状态定位。

完成条件：能够明确给出代理是否生效、绑定的 Node 与上游二进制路径及配置状态。

### 停用并恢复原配置（`--restore`）

执行：
`node scripts/agy-proxy.mjs --restore`

仅依据首次安装留存的 `runtime/settings-backup.json` 将 `providers.antigravity.binaryPath` 还原或移除，保留 `installDir` 中的缓存与备份元数据以备后续排查或重新启用。

完成条件：`--restore` 返回 `changed: true`（或确认当前已非代理托管），且 `--status` 中 `settingsPointingToProxy` 为 `false`。

## 3. 代码维护与验证

在仓库内修改 [store.mjs](scripts/lib/store.mjs)、[acp-proxy.mjs](scripts/lib/acp-proxy.mjs) 或 [agy-proxy.mjs](scripts/agy-proxy.mjs) 后：

1. 在隔离临时目录运行核心回归测试：
   `node --test tests/agy-proxy.test.mjs`
2. 确认静态语法与空白检查通过：
   `git diff --check`
3. 若本机已通过 `--setup` 启用代理，在获得用户确认后再运行 `--setup` 将已验证代码同步到 `<installDir>/runtime/`。

完成条件：测试全部通过，变更边界与是否已同步到运行目录向用户交代清楚。
