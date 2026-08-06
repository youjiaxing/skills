---
name: yjx-issue-crusher
description: 按 kanban 对 feature 做 issue 串行接力编排（Chain Run）：经 Tracker 端口读自动候选，spawn 独立前台 Worker，盯 Closed 完成闸门。一期 local-markdown；测试可注入假 Tracker/Launcher。交互 dual-TTY 为 Ink 全屏调度 TUI；CLI chain 一键开链。
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
| **编排器（CLI ± Ink 全屏调度 TUI）** | 读候选/完成态；全屏下按「开始/自动开下一张」门闩 spawn Worker；盯完成闸门；按 review/vibe 与自动开关决定可否开下一张；失败/未关票停开下一张；全屏分区调度与只读图 | 不当 agent 主界面；不自动换模/effort；不把进程退出当唯一成功；**不内嵌 Worker 终端**；不做多仓总控；**全屏进门不擅自开 Worker** |
| **Worker（Grok Build / Claude Code 独立前台窗）** | 在指定 cwd 做票；人可介入；会话可回看；与调度 TUI **分窗** | 不选下一张、不跨 feature 调度 |
| **Tracker 适配器** | 读候选 / 完成 / 只读看板投影 | 不含编排策略、不 spawn Worker |

### 三概念与可开下一张

| 概念 | 定义 | 真源 |
|------|------|------|
| **业务完成** | 本票在看板上已完成 | 普通 impl：issue 头 **`Closed: true`**（读侧）；Wayfinder：`Status: resolved` |
| **会话成功结束** | 编排器收到统一结束信号 | `sessionEnded: success`（runtime 适配器映射；测试可注入）。**仅进程死亡 / 单轮 stop / 静默 N 秒不算** |
| **可自动开下一张** | 自动路径允许 spawn 下一张 ready impl | **业务完成 ∧ `sessionEnded === success`**（顺序与中断细则见双真源后续切片），且还要过 **交接倒计时**（默认 9s，可取消）；**或** 已 Closed 下人手 **`forceAdvance`**（跳过等结束信号） |

禁止把进程退出单独当成功。  
**禁止**仅凭 Closed / `Status: resolved` 就强杀仍在跑的 Worker。**自动路径永不 `kill` 本槽进程**；未 Closed 时编排器**绝不**结束任何进程。  
**无会话成功结束信号时**（诚实降级）：即便 `autoAdvance` 为开，也**不得**仅凭 Closed/自然退出自动 spawn 下一张；状态停在 `awaiting-session-end`（或等进程自退时的 `awaiting-worker-exit`），须人 **Enter** / **`f`**。  
Wayfinder（含 grilling 等）完成：**不**触发自动开下一张；进程仍活则原窗可续聊。

### 边沿状态

| 状态 | 条件 | 行为 |
|------|------|------|
| `soft-stuck` | 进程存活 + 未 Closed | 禁止下一张；**绝不**杀进程 |
| `awaiting-worker-exit` | 已 Closed + 进程未退 | 可观测（`refresh`）；**只等自退**，**绝不** auto-kill；可用 `f` 强制推进（默认 orphan） |
| `awaiting-session-end` | 已 Closed + 进程已退 + 尚无 `sessionEnded: success` | **不杀、不自动下一张**；可 `f` 跳过等结束信号，或 Enter 腾槽开下一张 |
| `handoff-countdown` | 双真源已满足（或 `f` 跳过）+ 自动开着 | 倒计时（默认 **9 秒**）结束后才开下一张；**`c` 取消**倒计时（腾槽、不自动开下一张）；`f` 可跳过倒计时 |
| `needs-resume` | 死进程 + 未 Closed | 禁止下一张；`r`/`resume` 按已记 session id + 原 runtime/cwd **挂回旧会话历史**（须非空白），**不**重塞 `/implement`/`/wayfinder`，**不**开下一张；无 session id 时 `r` 不可用（原因 `no-session-id`），不静默开空窗 |
| 逻辑单槽 | 任意时刻 | 最多一个活 Worker；槽占用时拒绝第二次自动 spawn |

**交接倒计时（自动开下一张为开）：** 仅在自动 handoff 已允许后进入 `handoff-countdown`，默认等待 **9s**（`handoffCountdownMs`，可测注入）再 spawn 下一张 ready impl。期间 **`c` 取消**只腾槽、不自动开下一张；人手 **`f`** 跳过等结束信号 / 倒计时。**自动路径永不 `kill` 本槽进程。** 旧「Closed 后 safe-reap 必杀」合同已废除。

`forceAdvance`：仅 Closed 可用；默认不强杀旧进程（`killWorker: true` 为显式 opt-in）；跳过「等退出 / 等结束信号 + 倒计时」。

### review / vibe

| | review（硬默认） | vibe |
|--|------------------|------|
| commit / 关票 | **禁止**自动；须人授权 | 合同内默认可自动 commit + `Closed: true` |
| 可开下一张 | 同一双真源（Closed ∧ session success 或 `f`）；Closed 须来自授权后的关票 | 同一双真源 |

**选定层（仅此）：**

1. 启动 `--mode`（仅本进程，默认**不**写仓）— 若尚未被 TUI 拨杆取代  
2. 否则仓级配置  
3. 否则 **`review`**

- 仓级路径：产品仓根 **`.issue-crusher/config.json`**  
  - 键 **`mode`**：`"review"` \| `"vibe"`  
  - 键 **`runtime`**（可选）：`"grok"` \| `"claude"`，供 CLI 省略 `--runtime` 时使用  
  - 键 **`autoAdvance`**（可选布尔）：全屏「自动开下一张」偏好；缺省 / 非 `true` = **关**；`s` 与干净 Enter 开自动时写仓；`q` 退出**不**抹掉  
  - 键 **`workers.<runtime>.{model,effort}`**（可选）：按 runtime 分桶的 subsequent 模型/强度；空或省略 = 不传 flag  
- 调度 TUI 拨杆：立即写仓，只影响**后续** spawn；当前 Worker 在 spawn 时**钉死** mode  
- 切到 vibe：一行后果提示（将自动 commit/关票）  
- **无**用户级本机总默认、**无** feature 级 mode

### subsequent model / effort

进程内维护 subsequent **model**、**effort**（可空 = 不传 flag），与 subsequent mode 并列。

**启动初值（不为 model/effort 弹选单；启动 flag 默认不写仓）：**

1. CLI `--model` / `--effort`（有则用；按维独立）  
2. 否则仓内 `workers.<当前 runtime>.model|effort`  
3. 否则空（运行时产品默认）

**全屏键 `o`（仅 dual-TTY 全屏；`--once` / 非 TTY 不挂）：** model 列表 → effort 列表，两级都确认才提交；任一级 `q`/Esc 取消则 subsequent 与仓均不变。列表首项恒为「运行时默认」（不传 flag）。

- **model 目录：** 编排器透传字符串，不维护权威全量表。Grok：可注入发现端口，默认 best-effort 跑 `grok models`（失败/超时仅保留「运行时默认」等降级项，不挂死）。Claude：静态常见别名提示（如 sonnet/opus/haiku）+ 默认。  
- **effort 目录：** 首项默认 + 至少 Claude 公开档位提示（low/medium/high/xhigh/max），两侧一律字符串透传；非法值交给 Worker。  
- **一期无** TUI 自由文本手填；列表没有的 id 仍走 `--model`/`--effort` 或手改 json。

**提交（`setModelEffort` / 调度 surface 端口 / `o` 事务确认）：** 立即写仓到当前 runtime 分桶，只影响**之后** spawn；当前槽在 spawn 时钉死的 model/effort **不热切**。空/空白读侧一律当不传 flag。  
**无**跨 runtime 扁平顶层 `model`/`effort` 真源。

**与「不自动换模」：** 编排器仍不在无操作者意图时自行改 model/effort。`o`、CLI flag、仓分桶都是**操作者显式设定 subsequent**，不是策略引擎自动调参。

### 启动与标题

- **必填：** `runtime`（`grok` \| `claude`）、`feature`、`issue`、`cwd`  
- **可选：** `model`、`effort`（见上 subsequent 初值；省略则不传 flag，用运行时产品默认）  
- **标题：** `<feature>/<NN>-<slug>`；Claude `-n`；Grok **进程外**写 `summary.json`（**不要**把 `/rename` 放进初始 prompt：行首会空启动，行内只当纯文本）  
- **impl 入口：** `/implement <票相对路径>`（路径引用，不贴全文；prompt **以 skill 斜杠开头**）  
- **Wayfinder 入口：** `/wayfinder <票相对路径>`（人手 Enter 直接开；**不**进自动接力）  
- 每票**全新顶层会话**；可恢复路径禁止关闭 session 持久化  
- **`r` / resume（仅 `needs-resume`）：** 用已记 session id 开 **同一会话**（`--resume <id>`），挂回完整历史；**不是**开下一张 ready 票；**不**重塞 skill 入口。无 session id → 动作不可用 / `no-session-id`，禁止静默空窗。历史是否非空可用 Grok `chat_history.jsonl` 探针（须含真实 `user_query`，仅 skills system-reminder 算空白）

### 自动候选（与 ralph 同向）

```text
closed == false
&& statusRole == "ready-for-agent"
&& metadataValid == true
&& blockedByOpen / Missing / Invalid 皆空
&& dependencyCycle 为空
```

编号升序。Wayfinder（有 `Type:`）：**不**自动 spawn，但全屏 **Enter 可直接开**（`/wayfinder <path>`，无二次确认）；human / 未知类仍 **先问人** 再 spawn。

### 一期明确不做

- 默认 headless 静默跑完整链（可 AFK ≠ headless）  
- 编排器自动换模 / 自动调 effort  
- 跨项目总控壳、图上拖拽派票、内嵌 Worker 终端  
- GitHub 等非 local-md 适配器（二期）  
- 改写 tracker 完成语义；把 ralph 改成自动循环  
- 默认自动 resume N 次、默认 PTY 注入 continue/`/quit`  
- 多 Worker 并排视图作为默认

### 全屏：开始与「自动开下一张」（交互合同）

仅 **dual-TTY 全屏** 适用。非全屏见下节「何时全屏 / 何时打印帧」。

| 规则 | 约定 |
|------|------|
| 刚进全屏 | **不**自动弹 Worker；**自动开下一张** 读仓偏好（缺省 **关**）；即使为开也 **handoff-only**（空槽不冷启动） |
| 列表导航 | `j` / `k`、**方向键 ↑↓**、`1–9`：只移动「现在可执行」高亮 |
| **Enter** | 开 **一张**：有高亮 → 该票；无高亮 → 看板默认下一张（与自动候选同一套 frontier 规则） |
| 第一次成功 Enter 开票 | 同时把 **自动开下一张** 打开（此后可 AFK） |
| 自动开着时 | 条件满足（`Closed` ∧（**`sessionEnded: success`** ∨ 强制推进），且成功路径已过 **交接倒计时** 或被 `c`/`f` 处理）后按 **看板** 开后续 ready 票，**忽略** 高亮；**无结束信号不得假 AFK 推进** |
| 自动开着且槽空（未在接力收尾中） | **不**因 poll/tick 自动开；须 **Enter** 开工；`s` 只拨杆 |
| **`s`** | **切换**「自动开下一张」开 / 关（**纯拨杆**；不立即 spawn；**立即写仓**） |
| 用 `s` 关掉之后 | 再 Enter **只开一张**，**不**把自动开回来；恢复自动只能再按 `s`（本会话锁；仓偏好已为关） |
| 空槽且 `s` 拨到开 | **不**自动开票；第一张 / 空槽开工仍须 **Enter**；自动只在当前票可收尾后接力 |
| 干净路径第一次成功 Enter 开自动 | 同时 **写仓** `autoAdvance: true`（与顶栏一致） |
| **`q`** / Ctrl+C | 本进程关掉自动并退出全屏；**不**把关写回仓（偏好跨重启保留） |

顶栏须可读展示「自动开下一张：开/关」，并让操作者分清边沿状态：`awaiting-worker-exit`（等进程自退、不杀；可按 `f`）、`awaiting-session-end`（缺会话结束信号；可按 `f` 或 Enter）、`handoff-countdown`（显示剩余秒数；按 `c` 取消）、`needs-resume`（有 id 提示按 `r`；无 session id 明示不可静默空窗）。AFK 接力靠 **Closed ∧ sessionEnded success ∧ 倒计时结束**（或人手 `f`），**禁止**凭 Closed 强杀进行中的 Agent，**禁止**无结束信号仍自动开下一张。UI/文档宜用直白用语。

### 测试 seam

- **编排主 seam：Chain Run** — 注入假 TrackerPort + 假 WorkerLauncher + ModeConfig + 人事件，断言 spawn / 自动门闩 / 强制推进 / resume / 候选 / mode / subsequent model·effort / 单槽。  
- **全屏交互 seam：Dispatch Surface + 全屏键位** — 初始不自动开、Enter 开高亮或默认、`s` 切换、关自动后 Enter 不恢复自动、自动 tick 忽略高亮；`o` 事务选单与 `setModelEffort` 写仓可测。  
- **Resume 历史探针：** `classifyGrokChatHistory` / `readGrokChatHistory` 对 `chat_history.jsonl` 做空白 vs 有历史红绿判定（不依赖「进程 spawn 成功」 alone）。  
- **vibe 接力验收（20260805-1244 起，20260806-1636 收紧）：** `tests/vibe-handoff-acceptance.test.mjs` 三阶段（A Closed 后不杀、无会话结束信号不自动下一张 · B needs-resume 历史非空白 · C 未 Closed 不误杀）；失败信息带稳定 stage/code（`not-closed` / `no-exit` / `resume-blank` / `wrong-kill`）。双真源 / 倒计时单元测在 `chain-run.test.mjs`（可注入时钟与 `reportSessionEnded`）。也可用 `scripts/run-vibe-handoff-acceptance.mjs` 拿进程退出码（0 绿；2/3/4 对应 A/B/C）。  
- **发现端口：** 注入假 discoverer 断言失败/超时降级；CI 不依赖真实 `grok models` 登录。  
- 不测真 Grok/Claude 窗体内部。

---

## 能力清单

- **Chain Run** 测试缝与状态机（双条件、边沿、单槽、自动开下一张门闩）  
- **local-markdown** Tracker 适配 + 只读 `getBoard()`  
- **假 / 真** WorkerLauncher（同一 launch DTO；真启动器开 **独立前台窗**，不进调度屏）  
- **mode** 解析与仓文件写回  
- **subsequent model/effort** 初值（CLI → 仓分桶 → 空）与 `setModelEffort` 写仓  
- **全屏 `o`**：model→effort 事务选单；Grok 可注入 model 发现（`grok models` best-effort 降级）；Claude 别名 + effort 档位提示  
- **HITL** confirm/reject（human / 未知；Wayfinder 改由 Enter 直接开）  
- **CLI：** `recommend` · `probe-launch` · **`chain`**（默认命令；可选假启动器）  
- **交互 dual-TTY 主路径：Ink 全屏调度应用**（alternate-screen；顶栏 / 中部依赖图 / 当前槽 / 底栏；**Enter 开始**、列表导航、自动开下一张开关、`o` model/effort）  
- **启动期全屏选单**：缺 feature / runtime 时用 Ink 列表（`j`/`k`/方向键/数字 + Enter；`q` 取消）；**不为** model/effort 强问  
- **非全屏路径：** `--once` / 非 TTY / 非交互 → 打印调度帧后退出；**仍可**在 tick 时按看板尝试开票（不套全屏「默认不开」）；**无** `o` 选单  
- 交互全屏 **后台 poll**（默认 2s）在 **自动开下一张为开** 时支持 AFK 接力  
- **全屏呈现**：铺满终端高度、进入/退出清残影、主/次信息分层、选中与当前槽可辨；无复杂动画

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

**交互 dual-TTY（stdin+stdout 皆 TTY，且未传 `--once`）** 进入 **Ink 全屏调度应用**（像全屏工具，不是日志滚动页）：

| 分区 | 内容 |
|------|------|
| **顶栏** | feature · runtime · 后续 mode · **后续 model/effort**（空则「运行时默认」）· **自动开下一张：开/关** · 链状态（含 awaiting / needs-resume 操作提示） |
| **中部** | 中文 ASCII 依赖图（★可执行 ▶进行中 ·阻塞 ✓完成）+「现在可执行」清单（导航高亮；**Enter 开票**；无图上派票） |
| **当前槽** | 在跑票 / pid / Closed / 钉死 mode；有待确认时显示 HITL |
| **底栏** | 当前可用键位（含 `[o] model/effort`；与真实行为一致） |

Worker（Grok / Claude）由真启动器开在 **独立前台窗**；调度屏 **不内嵌** Worker 输出。多 feature / 多仓 = **多开** `ic` 进程（各管各的调度窗 + Worker 窗）。

**全屏进门不自动开 Worker**；开第一张用 **Enter**（见「全屏：开始与自动开下一张」）。呈现目标：根布局用 **终端行数（数值高度）** 铺满可用高（Ink 的 `height: 100%` 会塌成内容高）、中部 stretch、底栏贴底、顶栏「自动开下一张/状态」单独成行以免折行后丢失、主/次信息字色分层、选中与当前槽可辨；不追求重动画。

| 还想指定 | 写法 |
|----------|------|
| Claude | `ic my-feature --runtime claude` |
| 本进程 mode | `ic my-feature --mode vibe` |
| 本进程 model/effort | `ic my-feature --model grok-4 --effort high` |
| 只推荐下一张 | `ic recommend my-feature` |

**仓级默认 runtime / mode / workers 分桶**（可进 git）：产品仓 `.issue-crusher/config.json`

```json
{
  "mode": "vibe",
  "runtime": "claude",
  "autoAdvance": true,
  "workers": {
    "grok": { "model": "grok-4", "effort": "high" },
    "claude": { "model": "opus", "effort": "max" }
  }
}
```

解析：  
- **runtime**：`--runtime` → 仓 `runtime` → **交互 dual-TTY 全屏选单**（`grok` / `claude`）；非交互/脚本/`--once` 须显式指定（`--fake-launcher` 冒烟缺省时默认 grok）  
- **mode**：`--mode` → 仓 `mode` → 默认 **`review`**（全屏拨杆 `m` 仍会写回仓 `mode`）  
- **autoAdvance**：仓 `autoAdvance === true` 时全屏进门拨杆为开（仍不冷启动 Worker）；否则关；`s` / 干净 Enter 开自动写仓；`q` 不写关  
- **model / effort**：`--model`/`--effort` → 仓 `workers.<当前 runtime>` → 空（不传 flag）；提交 subsequent 后静默写回当前 runtime 分桶  
- **feature**：位置参数 → 否则 dual-TTY **全屏列出** `.scratch` 下 feature 选取；非交互须显式给出

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
| `--model` | 本进程 subsequent 模型初值（默认不写仓；见上优先级） |
| `--effort` | 本进程 subsequent effort 初值（默认不写仓；见上优先级） |
| `--fake-launcher` | 假启动器（冒烟，不开真 Worker 窗） |
| `--once` | **非全屏**：tick 后打印调度帧并退出（脚本/CI/冒烟）；**可**在该路径按看板尝试开票 |
| `--stop` | 与 `--once` 联用：tick 后禁止继续自动开票并结束（脚本用） |

### 何时全屏 / 何时打印帧

| 条件 | 行为 |
|------|------|
| stdin+stdout 皆 TTY，且无 `--once` | **Ink 全屏**；缺 feature/runtime 时先挂全屏选单；**默认不 spawn**，Enter / 自动开下一张 见上表 |
| `--once`、管道、非 TTY、显式非交互 | **不挂** Ink；打印一帧（或有限 tick）后退出；**不**套全屏「默认不开」，可按看板尝试开票；缺参按非交互合同 |
| 退化交互（例如仅一侧 TTY） | 可打印帧 + 行内命令后备（**不是**主 UI；日常请用 dual-TTY 全屏） |

非全屏冒烟示例：

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

### 全屏调度键位

主路径为**单键**（无 readline 行编辑）。底栏会按可用动作隐藏不可用项，文案须与行为一致。

```text
Enter               开一张：有高亮 → 该票；无高亮 → 看板默认下一张
                    （干净开始下：成功开票后打开「自动开下一张」；
                     若刚用 s 关掉自动：只开一张，不把自动开回来）
j / k 或 ↓ / ↑     「现在可执行」高亮下一项 / 上一项（只改高亮）
1–9                 高亮对应可执行项（只改高亮）
s                   切换「自动开下一张」开 ↔ 关（纯拨杆，空槽不立刻开票；写仓）
m                   mode 拨杆：review ↔ vibe（写仓；切 vibe 一行提示；只影响后续 spawn）
o                   model → effort 两级选单（整次事务确认后写 subsequent + 仓分桶；
                    只影响之后新开的 Worker；q/Esc 取消不写）
f                   强制推进（仅当前票 Closed 可用；跳过等退出/等结束信号/倒计时；默认不杀进程）
c                   取消交接倒计时（仅 handoff-countdown；腾槽、不自动开下一张）
r                   needs-resume：挂回旧 session 历史（≠ 开下一张；无 id 不可用）
y / n               HITL 同意 / 拒绝
t                   手动 tick / 刷新一次
q                   关掉自动并退出全屏（Ctrl+C 等同）
```

看板与依赖图 **read-only**，无图上派票、无内嵌 Worker。  
自动开着时 **忽略** 列表高亮，只按看板选下一张；高亮只约束 **Enter**。  
`--once` / 非 TTY **不出现** `o` 选单（无交互 model/effort UI）。

### 启动全屏选单键位

缺 feature 或 runtime、且 dual-TTY 交互时：

```text
j / k 或 ↓ / ↑     移动高亮
1–9                 跳到对应项
Enter               确认选项（进入调度全屏，此时仍不自动开 Worker）
q / Esc             取消（不留下残缺终端状态）
```

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

- Node.js 20+  
- 运行时依赖装在 **skills monorepo 根** `package.json`（本 skill **无**独立子 `package.json`）：  
  - **`ink`** + **`react`**：交互 dual-TTY 全屏调度壳与启动选单  
  - **`yaml`**：与 monorepo 其它工具共用  
  - 编排核心（Chain Run、Tracker、Launcher 合同）仍以 **Node 标准库**为主  
- **不是**「仅 Node 标准库」包：交互全屏路径需要 Ink/React（`npm install` 装在 monorepo 根）  
- local-md 适配软依赖同 skills 根下的 **`yjx-local-kanban`**  
- **不**运行时硬依赖 `yjx-local-ralph`（候选在本包 `select-candidates.mjs`）  
- **不**依赖 Claude API / Claude Agent SDK / Claude Code 专有运行时（Worker 是外部前台进程）

```bash
# skills monorepo 根
node --test skills/yjx-issue-crusher/tests/*.test.mjs
# 或整仓
npm test
# vibe 接力 / needs-resume 验收子集（ticket 04）
node --test skills/yjx-issue-crusher/tests/vibe-handoff-acceptance.test.mjs
# 带稳定进程退出码的验收 runner（0 绿；2=A 3=B 4=C）
node skills/yjx-issue-crusher/scripts/run-vibe-handoff-acceptance.mjs
```

主 seam：`tests/chain-run.test.mjs`。  
调度 / 全屏 / 启动选单：`tests/dispatch-surface.test.mjs` · `tests/dispatch-fullscreen.test.mjs` · `tests/startup-select.test.mjs` · `tests/cli-chain.test.mjs` · `tests/interactive-prompts.test.mjs`。  
model 发现 / effort 提示：`tests/model-catalog.test.mjs`。  
vibe 接力验收：`tests/vibe-handoff-acceptance.test.mjs` + `scripts/run-vibe-handoff-acceptance.mjs`（A/B/C；失败码 `not-closed`/`no-exit`/`resume-blank`/`wrong-kill`）。  
local-md fixture：`empty-frontier` / `single-ready` / `mixed-board` / `hitl-only`。

---

## 程序内注入（可选）

```js
import { createRealLauncher } from './scripts/real-launcher.mjs';
import { createChainRun } from './scripts/chain-run.mjs';
import { createDispatchSurface } from './scripts/dispatch-surface.mjs';
import { runDispatchTui } from './scripts/dispatch-tui.mjs';

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
