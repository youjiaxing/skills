---
name: yjx-issue-crusher
description: 按 kanban 对 feature 做 issue 串行接力编排（Chain Run）：经 Tracker 端口读自动候选，spawn 独立前台 Worker，盯 Closed 完成闸门。一期 local-markdown；测试可注入假 Tracker/Launcher。
argument-hint: "<feature-slug>"
disable-model-invocation: true
---

# Issue Crusher（编排器 skill）

`yjx-issue-crusher` 是 **issue 串行接力编排器** 的独立 skill 包。实现与测试在本目录；试点仓（如 `issue-crusher`）只消费本 skill，**不内嵌**编排器源码。

## 现状（ticket 07–12）

已具备：

- **Chain Run** 测试缝：可注入假 `TrackerPort` + 假 `WorkerLauncher` + 假/真 `ModeConfig`
- **local-markdown** Tracker 适配：读 fixture/真实 `.scratch/<feature>/issues`，自动候选与 ralph 合同对齐
- 最小 CLI：`recommend`（只读下一张）；`probe-launch`（真启动器 dry-run / 可选前台 spawn）
- **impl launch 合同**（假 Launcher）：必填 runtime/cwd/feature/issue；标题 `<feature>/<NN>-<slug>`；`initialPrompt` 含 `/implement <相对路径>`（不贴全文）；Grok 首行 `/rename`，Claude 用结构化 `title` 供 `-n`；mode 硬默认 **review**（禁自动 commit/关票），链上解析为 vibe 时换文案；可选 `model`/`effort`（空则不传 flag）
- **双条件接力**：可开下一张 = `Closed` ∧（进程退出 ∨ 已 Closed 下 `forceAdvance`）；只退未关 / 只关未退均不 spawn 下一张
- **边沿状态（ticket 09）**：
  - `soft-stuck`：进程存活 + 未 Closed → 禁止下一张，不杀进程
  - `awaiting-worker-exit`：已 Closed + 进程未退 → 可观测，自动路径仍禁止下一张
  - `forceAdvance`：仅 Closed 可用；默认不强杀旧进程；`killWorker: true` 为显式 opt-in
  - `needs-resume`：死进程 + 未 Closed → 禁止下一张；`resume()` 按已记 session id + 原 runtime/cwd 续聊，**不**重塞 `/implement` / `/wayfinder`
  - **逻辑单槽**：槽占用期间第二次自动 spawn 被拒绝
- **review/vibe 选定（ticket 10）**：
  - 硬默认 `review`；仓级配置持久真源（`ModeConfig` / 默认 `.issue-crusher/config.json` 的 `mode` 键）
  - 启动 `mode`（CLI 日后 `--mode`）仅本进程，默认**不**写仓
  - `setMode`（调度拨杆）立即写仓，只影响**后续** spawn；当前活 Worker 在 spawn 时钉死 mode，禁止热切合同
  - 切到 vibe 时发出一行后果事件 `mode-consequence`
  - **无**用户级本机总默认、**无** feature 级 mode 层
- **非 ready / Wayfinder HITL（ticket 11）**：
  - 自动区间**仅** `ready-for-agent` 普通 impl；Wayfinder（有 `Type`）/ human triage / 未知类不自动 spawn
  - 仅 HITL 候选时：`step` → `needs-confirmation` 事件 + `pendingHitl`（runtime、model/effort 或 runtime-default、title、入口类）；**不占** Worker 槽
  - `confirmHitl()`：按类预填入口（wayfinder → `/wayfinder` 路径；human/unknown → 中性打开路径、无具体 skill slash）；mode 与票 10 解析一致、spawn 钉死
  - `rejectHitl()`：零 spawn，槽保持空闲
  - ready auto 与 HITL 互不误判：有 ready 时仍直接 spawn `/implement`
- **真前台 Worker 启动器（ticket 12）**：
  - `scripts/real-launcher.mjs`：与假 Launcher **同一 launch DTO**，`createChainRun({ launcher })` 可替换注入
  - 前台可介入：`detached` + 可见控制台；**不**把 headless `-p` / `--print` / `--single` 当默认主路径
  - 省略 `model`/`effort` 时不传对应 flag；可恢复路径**禁止** `--no-session-persistence`
  - Claude 初始带 `-n <title>`；Grok 初始靠 prompt 首行 `/rename` + `--cwd`
  - spawn 记账至少 `pid`；默认预分配 UUID 经 `--session-id` 写入（`sessionIdStatus: preallocated`）；关闭预分配时 `sessionId: null` + 明确 `sessionIdNote`，不假装已记
  - resume：`--resume <已记 id>` + 原 cwd/runtime，**不**重塞 skill 入口

尚未具备（后续票）：调度 TUI 完整 UI / 整链 CLI 产品面（ticket 13）。

## 依赖与可移植脚本

- Node.js 20+；只使用 Node 标准库，不调用 Claude API / Agent SDK / 专有运行时
- **local-md 适配**软依赖**同一 Agent skills 根目录**下的 `yjx-local-kanban`（相对路径 import 其 `issue-board.mjs`）
- **不**运行时硬依赖 `yjx-local-ralph`；候选过滤在本包 `select-candidates.mjs`，语义与 ralph 对齐
- 根据当前 Agent 提供的 skill 加载信息定位本 `SKILL.md`，再解析 `<skill-dir>`；不要假设安装在 `.claude`、`.agents`、`.codex` 或固定全局目录

## 测试

在 **skills monorepo 根**：

```bash
node --test skills/yjx-issue-crusher/tests/*.test.mjs
# 或：
npm test
```

主 seam：**Chain Run**（`tests/chain-run.test.mjs`），含 HITL 未同意 / 同意 wayfinder / 拒绝 / ready 不误判。  
local-md fixture 覆盖空 frontier / 唯一 ready / mixed 排除 Wayfinder·closed·blocked / hitl-only（`tests/local-md-tracker.test.mjs`）。

## 最小 CLI

```bash
node <skill-dir>/scripts/cli.mjs recommend \
  --project-root <repo> \
  --feature <feature-slug>
```

输出 JSON：`candidates`、`recommended`。不启动 Grok/Claude。

### 真启动器探测（ticket 12）

默认 **dry-run**（只打印 argv / session 记账，不起进程）：

```bash
# Grok 前台启动合同（省略 model/effort）
node <skill-dir>/scripts/cli.mjs probe-launch --runtime grok --cwd <repo>

# Claude 前台启动合同（含 -n 标题）
node <skill-dir>/scripts/cli.mjs probe-launch --runtime claude --cwd <repo> \
  --feature issue-chain-orchestrator \
  --issue .scratch/issue-chain-orchestrator/issues/12-real-worker-launcher.md

# resume 形状（不重塞 /implement）
node <skill-dir>/scripts/cli.mjs probe-launch --runtime claude --cwd <repo> \
  --resume <session-uuid>
```

可选本机前台 spawn（会开独立控制台；探针可用 `--kill-after` 收回）：

```bash
node <skill-dir>/scripts/cli.mjs probe-launch --runtime grok --cwd <repo> --run --kill-after 3000
node <skill-dir>/scripts/cli.mjs probe-launch --runtime claude --cwd <repo> --run --kill-after 3000
```

程序内注入：

```js
import { createRealLauncher } from './real-launcher.mjs';
import { createChainRun } from './chain-run.mjs';

const chain = createChainRun({
  tracker,
  launcher: createRealLauncher(),
  feature,
  cwd,
  runtime: 'claude', // or grok
});
```

## 自动候选合同（与 ralph 同向）

```text
closed == false
&& statusRole == "ready-for-agent"
&& metadataValid == true
&& blockedByOpen / Missing / Invalid 皆空
&& dependencyCycle 为空
```

编号升序；Wayfinder（有 `Type:`、无 `statusRole`）**不进**自动候选。

## 边界

- 编排策略只依赖 **Tracker 端口**，不解析人类看板文案
- Worker 为独立前台会话；本包一期不内嵌终端
- 业务完成闸门：普通 impl 认 issue 头 `Closed: true`（读侧）
- 失败或未关票时停开下一张（双条件 + soft-stuck / needs-resume / 单槽已落地）
