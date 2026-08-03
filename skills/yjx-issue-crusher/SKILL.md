---
name: yjx-issue-crusher
description: 按 kanban 对 feature 做 issue 串行接力编排（Chain Run）：经 Tracker 端口读自动候选，spawn 独立前台 Worker，盯 Closed 完成闸门。一期 local-markdown；测试可注入假 Tracker/Launcher。调度 TUI + CLI chain 一键开链。
argument-hint: "<feature-slug>"
disable-model-invocation: true
---

# Issue Crusher（编排器 skill）

`yjx-issue-crusher` 是 **issue 串行接力编排器** 的独立 skill 包。实现与测试在本目录；试点仓（如 `issue-crusher`）只消费本 skill，**不内嵌**编排器源码。

## 现状（ticket 07–13）

已具备：

- **Chain Run** 测试缝：可注入假 `TrackerPort` + 假 `WorkerLauncher` + 假/真 `ModeConfig`
- **local-markdown** Tracker 适配：读 fixture/真实 `.scratch/<feature>/issues`，自动候选与 ralph 合同对齐；`getBoard()` 只读依赖投影
- **CLI**：
  - `recommend`（只读下一张）
  - `probe-launch`（真启动器 dry-run / 可选前台 spawn）
  - **`chain`**（一键开链：绑定 cwd + feature，调度 TUI；ticket 13）
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
  - 启动 `mode` / CLI `--mode` 仅本进程，默认**不**写仓
  - `setMode`（调度拨杆）立即写仓，只影响**后续** spawn；当前活 Worker 在 spawn 时钉死 mode，禁止热切合同
  - 切到 vibe 时发出一行后果事件 `mode-consequence`
  - **无**用户级本机总默认、**无** feature 级 mode 层
- **非 ready / Wayfinder HITL（ticket 11）**：
  - 自动区间**仅** `ready-for-agent` 普通 impl；Wayfinder（有 `Type`）/ human triage / 未知类不自动 spawn
  - 仅 HITL 候选时：`step` → `needs-confirmation` 事件 + `pendingHitl`；**不占** Worker 槽
  - `confirmHitl()` / `rejectHitl()` 与票 11 合同一致
- **真前台 Worker 启动器（ticket 12）**：
  - `scripts/real-launcher.mjs`：与假 Launcher **同一 launch DTO**，可注入 Chain Run
  - 前台可介入；**不**把 headless `-p` 当默认主路径
  - resume：`--resume <已记 id>`，**不**重塞 skill 入口
- **调度 TUI + CLI 开链（ticket 13）**：
  - `chain` 一命令绑定 product `cwd` + `feature` 启动**一条**链进程
  - 调度侧展示：有效 mode、槽状态（软卡住 / 等退出 / needs-resume / 空槽）、只读看板依赖投影（**不可图上派票**）
  - 人操作：mode 拨杆（写仓 + 切 vibe 一行提示）、Closed 后强制推进、needs-resume 一键恢复、HITL 同意/拒绝、停链
  - 交互 TUI **后台 poll**（默认 2s）自动 `tick`：Worker 满足双条件后无需手按 `t` 即可开下一张（可 AFK 接力）
  - `stop()` 后不再自动 spawn；Worker 仍在独立前台窗，编排器不内嵌终端

## 安装与试点开链（消费说明）

### 1. 安装独立包

本 skill 位于 skills monorepo 的 `skills/yjx-issue-crusher/`。与 `yjx-local-kanban` **同根安装**（local-md 适配相对 import kanban）。

在 skills 仓：

```bash
# 链接到本机 Agent skills 根（示例）
make link
# 或：
npm run link
```

链接后 skill 目录通常为：

```text
<agent-skills-root>/yjx-issue-crusher
```

Windows 下常见 junction：`%USERPROFILE%\.agents\skills\yjx-issue-crusher` → monorepo 源目录。

**不要**把编排器源码复制进试点产品仓业务树；试点仓只调用 CLI / 文档说明。

### 2. 对试点 feature 开链

在**产品仓**根（含 `docs/agents/local-tracker.json` 与 `.scratch/<feature>/issues`）执行：

```bash
# 交互调度 TUI + 真前台 Worker（一链一进程）
node <skill-dir>/scripts/cli.mjs chain \
  --cwd <product-repo> \
  --feature <feature-slug> \
  --runtime grok
# 或 --runtime claude
```

常用选项：

| 选项 | 含义 |
|------|------|
| `--cwd` | 产品仓工作目录（Worker 启动 cwd） |
| `--project-root` | Tracker 根（默认与 cwd 相同） |
| `--feature` | feature slug（必填） |
| `--runtime` | `grok` \| `claude`（真启动必填） |
| `--mode` | 仅本进程 `review`\|`vibe`，默认不写仓 |
| `--fake-launcher` | 假启动器（空链/单票冒烟，不开真窗） |
| `--once` | 非交互：tick 后打印帧并退出 |
| `--stop` | 与 `--once` 联用：tick 后停链（验收路径） |

空链 / 停链冒烟（假启动器，不依赖本机 Grok/Claude）：

```bash
node <skill-dir>/scripts/cli.mjs chain \
  --cwd <product-repo> \
  --feature <feature-slug> \
  --fake-launcher --once --stop
```

多 feature / 多仓 = **多开** `chain` 进程；不做跨项目总控壳。

### 3. 调度 TUI 键位

```text
m review | m vibe   mode 拨杆（写仓；切 vibe 有一行后果提示；只影响后续票）
f                   强制推进（仅当前票 Closed 可用）
r                   needs-resume 一键恢复（真/假 launcher 的 resume 合同）
y / n               HITL 同意 / 拒绝
s                   停链（此后不再自动 spawn）
t                   手动 tick 一次
q                   停链并退出 TUI
```

看板区为 **read-only**；看不到、也没有图上拖拽派票入口。

## 依赖与可移植脚本

- Node.js 20+；只使用 Node 标准库，不调用 Claude API / Agent SDK / 专有运行时
- **local-md 适配**软依赖**同一 Agent skills 根目录**下的 `yjx-local-kanban`
- **不**运行时硬依赖 `yjx-local-ralph`；候选过滤在本包 `select-candidates.mjs`
- 根据当前 Agent 提供的 skill 加载信息定位本 `SKILL.md`，再解析 `<skill-dir>`；不要假设固定全局目录

## 测试

在 **skills monorepo 根**：

```bash
node --test skills/yjx-issue-crusher/tests/*.test.mjs
# 或：
npm test
```

主 seam：**Chain Run**（`tests/chain-run.test.mjs`）。  
调度面：**Dispatch Surface**（`tests/dispatch-surface.test.mjs`）+ CLI chain 冒烟（`tests/cli-chain.test.mjs`）。  
local-md fixture：空 frontier / 唯一 ready / mixed / hitl-only / `getBoard`。

## 其它 CLI

```bash
# 只读推荐下一张
node <skill-dir>/scripts/cli.mjs recommend \
  --project-root <repo> \
  --feature <feature-slug>

# 真启动器 dry-run
node <skill-dir>/scripts/cli.mjs probe-launch --runtime grok --cwd <repo>
```

程序内注入：

```js
import { createRealLauncher } from './real-launcher.mjs';
import { createChainRun } from './chain-run.mjs';
import { createDispatchSurface } from './dispatch-surface.mjs';
import { runDispatchTui } from './dispatch-tui.mjs';

const chain = createChainRun({
  tracker,
  launcher: createRealLauncher(),
  feature,
  cwd,
  runtime: 'claude',
  modeConfig,
});
const surface = createDispatchSurface({ chain, tracker });
await runDispatchTui({ surface });
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
- 失败或未关票时停开下一张；`stop()` 后冻结自动接力
- 图/看板仅只读投影，**不**用于派票或改串行规则
