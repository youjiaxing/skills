---
name: yjx-issue-crusher
description: 按 kanban 对 feature 做 issue 串行接力编排（Chain Run）：经 Tracker 端口读自动候选，spawn 独立前台 Worker，盯 Closed 完成闸门。一期 local-markdown；测试可注入假 Tracker/Launcher。调度 TUI + CLI chain 一键开链。
argument-hint: "<feature-slug>"
disable-model-invocation: true
---

# Issue Crusher（编排器 skill）

`yjx-issue-crusher` 是 **issue 串行接力编排器** 的独立 skill 包：实现、测试、**编排合同真源**都在本目录。

任意产品仓只需安装/链接本 skill 并调用 CLI；**不要**把编排器源码复制进产品仓业务树。历史试点仓可删，不影响本包。

---

## 编排合同（稳定真源）

一期目标：在**前台可介入**前提下，对某一 feature 的 `ready-for-agent` 普通 implementation 票做**逻辑单槽顺序接力**；可 AFK，**不是**默认 headless。

### 角色

| 角色 | 做 | 不做 |
|------|----|------|
| **编排器（CLI ± 调度 TUI）** | 读候选/完成态；spawn Worker；盯完成闸门；按 review/vibe 决定可否开下一张；失败/未关票停开下一张；调度交互与只读图 | 不当 agent 主界面；不自动换模/effort；不把进程退出当唯一成功；不内嵌 Worker；不做多仓总控 |
| **Worker（Grok Build / Claude Code 前台）** | 在指定 cwd 做票；人可介入；会话可回看 | 不选下一张、不跨 feature 调度 |
| **Tracker 适配器** | 读候选 / 完成 / 只读看板投影 | 不含编排策略、不 spawn Worker |

### 三概念与可开下一张

| 概念 | 定义 | 真源 |
|------|------|------|
| **业务完成** | 本票在看板上已完成 | 普通 impl：issue 头 **`Closed: true`**（读侧） |
| **会话可收尾** | 本票 Worker 进程已结束 | **进程退出**（pid） |
| **可开下一张** | 允许 spawn 下一张 | **`Closed` ∧（进程退出 ∨ 已 Closed 下人手 `forceAdvance`）** |

禁止把进程退出单独当成功。  
Wayfinder 完成是 **`Status: resolved`**，**不进**自动 impl 接力闸门。

### 边沿状态

| 状态 | 条件 | 行为 |
|------|------|------|
| `soft-stuck` | 进程存活 + 未 Closed | 禁止下一张；默认不杀进程 |
| `awaiting-worker-exit` | 已 Closed + 进程未退 | 可观测；自动路径仍禁止下一张 |
| `needs-resume` | 死进程 + 未 Closed | 禁止下一张；`resume` 按已记 session id + 原 runtime/cwd，**不**重塞 skill 入口 |
| 逻辑单槽 | 任意时刻 | 最多一个活 Worker；槽占用时拒绝第二次自动 spawn |

`forceAdvance`：仅 Closed 可用；默认不强杀旧进程（`killWorker: true` 为显式 opt-in）。

### review / vibe

| | review（硬默认） | vibe |
|--|------------------|------|
| commit / 关票 | **禁止**自动；须人授权 | 合同内默认可自动 commit + `Closed: true` |
| 可开下一张 | 同一双条件；Closed 须来自授权后的关票 | 同一双条件 |

**选定层（仅此）：**

1. 启动 `--mode`（仅本进程，默认**不**写仓）— 若尚未被 TUI 拨杆取代  
2. 否则仓级配置  
3. 否则 **`review`**

- 仓级路径：产品仓根 **`.issue-crusher/config.json`**  
  - 键 **`mode`**：`"review"` \| `"vibe"`  
  - 键 **`runtime`**（可选）：`"grok"` \| `"claude"`，供 CLI 省略 `--runtime` 时使用
- 调度 TUI 拨杆：立即写仓，只影响**后续** spawn；当前 Worker 在 spawn 时**钉死** mode  
- 切到 vibe：一行后果提示（将自动 commit/关票）  
- **无**用户级本机总默认、**无** feature 级 mode

### 启动与标题

- **必填：** `runtime`（`grok` \| `claude`）、`feature`、`issue`、`cwd`  
- **可选：** `model`、`effort`（省略则不传 flag，用运行时产品默认）  
- **标题：** `<feature>/<NN>-<slug>`；Claude `-n`；Grok 首行 `/rename`  
- **impl 入口：** `/implement <票相对路径>`（路径引用，不贴全文）  
- **Wayfinder 入口：** `/wayfinder <票相对路径>`（须 HITL 同意后）  
- 每票**全新顶层会话**；可恢复路径禁止关闭 session 持久化

### 自动候选（与 ralph 同向）

```text
closed == false
&& statusRole == "ready-for-agent"
&& metadataValid == true
&& blockedByOpen / Missing / Invalid 皆空
&& dependencyCycle 为空
```

编号升序。Wayfinder（有 `Type:`）/ 非 ready / 未知类：**先问人**，不自动 spawn。

### 一期明确不做

- 默认 headless 静默跑完整链（可 AFK ≠ headless）  
- 编排器自动换模 / 自动调 effort  
- 跨项目总控壳、图上拖拽派票、内嵌 Worker 终端  
- GitHub 等非 local-md 适配器（二期）  
- 改写 tracker 完成语义；把 ralph 改成自动循环  
- 默认自动 resume N 次、默认 PTY 注入 continue/`/quit`  
- 多 Worker 并排视图作为默认

### 测试 seam

**唯一主 seam：Chain Run** — 注入假 TrackerPort + 假 WorkerLauncher + ModeConfig + 人事件，只断言外部行为（spawn / 停链 / 强制推进 / resume / 候选 / mode / 单槽）。不测真 Grok/Claude TUI 内部。

---

## 能力清单（已实现）

- **Chain Run** 测试缝与状态机（双条件、边沿、单槽、stop）  
- **local-markdown** Tracker 适配 + 只读 `getBoard()`  
- **假 / 真** WorkerLauncher（同一 launch DTO）  
- **mode** 解析与仓文件写回  
- **HITL** confirm/reject（Wayfinder / human / 未知）  
- **CLI：** `recommend` · `probe-launch` · **`chain`**（调度 TUI + 可选假启动器）  
- 交互 TUI **后台 poll**（默认 2s）自动 tick，支持 AFK 接力  

---

## 安装

本 skill 位于 monorepo `skills/yjx-issue-crusher/`。与 `yjx-local-kanban` **同根安装**（local-md 适配相对 import kanban）。

```bash
# skills monorepo
make link
# 或
npm run link
```

链接后通常为：

```text
<agent-skills-root>/yjx-issue-crusher
```

Windows 常见：`%USERPROFILE%\.agents\skills\yjx-issue-crusher` → monorepo 源目录。

也可：

```bash
npx skills add youjiaxing/skills --skill yjx-issue-crusher
npx skills add youjiaxing/skills --skill yjx-local-kanban
```

根据当前 Agent 的 skill 加载信息定位本 `SKILL.md` 再解析 `<skill-dir>`；不要写死全局路径。

---

## 在产品仓开链

产品仓需具备 local-md tracker 约定（如 `docs/agents/local-tracker.json` + `.scratch/<feature>/issues`）。

### 日常短命令（推荐）

在 **skills monorepo** 根执行一次：

```bash
npm link
```

之后任意产品仓根目录：

```bash
ic my-feature
# 等价
issue-crusher my-feature
# 不写 feature：扫描本仓 .scratch 下的 feature，提示选取
ic
```

含义：在当前目录开链（`--cwd` / `--project-root` 默认 `pwd`），命令默认 `chain`。  
调度界面默认**中文**，含 **ASCII 依赖图**（★可执行 ▶进行中 ·阻塞 ✓完成）与「现在可执行」清单。

| 还想指定 | 写法 |
|----------|------|
| Claude | `ic my-feature --runtime claude` |
| 本进程 mode | `ic my-feature --mode vibe` |
| 只推荐下一张 | `ic recommend my-feature` |

**仓级默认 runtime / mode**（可进 git）：产品仓 `.issue-crusher/config.json`

```json
{
  "mode": "vibe",
  "runtime": "claude"
}
```

解析：  
- **runtime**：`--runtime` → 仓 `runtime` → **交互询问**（非交互/脚本须显式指定；`--fake-launcher` 冒烟默认 grok）  
- **mode**：`--mode` → 仓 `mode` → 默认 **`review`**（拨杆仍会写回仓 `mode`）

未 `npm link` 时仍可用长路径：

```bash
node <skill-dir>/scripts/cli.mjs my-feature
```

### 选项一览

| 选项 | 含义 |
|------|------|
| 位置参数 feature | `ic <feature>` 或 `ic chain <feature>` |
| `--cwd` | 产品仓工作目录（默认：当前目录） |
| `--project-root` | Tracker 根（默认：与 cwd 相同） |
| `--runtime` | `grok` \| `claude`（见上默认） |
| `--mode` | 仅本进程 `review`\|`vibe`，默认不写仓 |
| `--fake-launcher` | 假启动器（冒烟，不开真窗） |
| `--once` | 非交互：tick 后打印帧并退出 |
| `--stop` | 与 `--once` 联用：tick 后停链 |

空链 / 停链冒烟：

```bash
ic my-feature --fake-launcher --once --stop
```

包内 fixture 冒烟：

```bash
ic demo \
  --cwd <skill-dir>/fixtures/single-ready \
  --project-root <skill-dir>/fixtures/single-ready \
  --fake-launcher --once
```

多 feature / 多仓 = **多开** `ic` 进程。

### 调度 TUI 键位

```text
m review | m vibe   mode 拨杆（写仓；切 vibe 一行提示；只影响后续票）
f                   强制推进（仅当前票 Closed 可用）
r                   needs-resume 一键恢复
y / n               HITL 同意 / 拒绝
s                   停链（此后不再自动 spawn）
t                   手动 tick 一次
q                   停链并退出 TUI
```

看板区 **read-only**，无图上派票。

### 其它 CLI

```bash
node <skill-dir>/scripts/cli.mjs recommend \
  --project-root <repo> \
  --feature <feature-slug>

node <skill-dir>/scripts/cli.mjs probe-launch \
  --runtime grok --cwd <repo>
```

---

## 依赖与测试

- Node.js 20+；仅 Node 标准库  
- local-md 适配软依赖同 skills 根下的 **`yjx-local-kanban`**  
- **不**运行时硬依赖 `yjx-local-ralph`（候选在本包 `select-candidates.mjs`）

```bash
# skills monorepo 根
node --test skills/yjx-issue-crusher/tests/*.test.mjs
# 或
npm test
```

主 seam：`tests/chain-run.test.mjs`。  
调度面：`tests/dispatch-surface.test.mjs` · `tests/cli-chain.test.mjs`。  
local-md fixture：`empty-frontier` / `single-ready` / `mixed-board` / `hitl-only`。

---

## 程序内注入（可选）

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
