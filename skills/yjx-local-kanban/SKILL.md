---
name: yjx-local-kanban
description: 只读解析 Matt Local Markdown tracker 的普通 implementation issue 或 Wayfinder child ticket 依赖图，输出人类看板、完整 JSON 图或 Mermaid；用于 make kanban、查看执行 frontier、核对阻塞关系或为执行者提供 requiredSkill，不选票、不改状态。
disable-model-invocation: true
---

# Local Kanban

`yjx-local-kanban` 是 Matt Local Markdown tracker 的只读事实提供者。它自动识别普通 implementation issue 与 Wayfinder child ticket，解析 `.scratch/<feature>/issues/*.md`，不修改 issue、不选择下一张 issue，也不替对应流程决定生命周期。

## 前提与真源

项目必须先运行 `yjx-local-tracker-setup`，并存在：

```text
docs/agents/local-tracker.json
```

项目业务合同继续来自：

```text
docs/agents/issue-tracker.md
docs/agents/triage-labels.md
```

机器配置只决定 tracker 根目录、完成字段和 canonical triage role 映射；它不覆盖项目文档中的生命周期规则。

## 可移植脚本

确定性脚本位于本 skill 目录：

```text
scripts/issue-board.mjs
```

根据当前 Agent 提供的 skill 加载信息定位本 `SKILL.md`，再从其所在目录解析脚本；不要假设 skill 安装在 `.claude`、`.agents`、`.codex` 或任何固定全局目录。脚本只依赖 Node.js 20+ 标准库，不调用 Claude API、Claude Agent SDK 或 Claude Code 专有 API。

下文用 `<kanban-skill-dir>` 表示本 `SKILL.md` 所在目录。

## 人类看板

项目根目录运行：

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs
```

多个 feature 时，人类 TTY 会显示 feature 列表并请求选择；只有一个 feature 时自动选择。已知 feature 时应显式传入：

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs .scratch/<feature-slug>
```

默认文本看板不再按分组长列表输出，而是按依赖关系渲染树状投影：

```text
LEGEND  ✓ 已完成 | > 已领取/进行中 | × 被阻塞 | ○ 可实施 | ? 等待人工 | ! 异常
ISSUES ...
DEPENDENCY TREE
├─ ✓ 01 [grilling] Foundation
│  └─ × 02 [impl] Feature <- 01
└─ ○ 03 [research] Parallel feature

NOW  可新增并行实施：1 | 进行中：0
可新增并行实施
- ○ 03 [research] Parallel feature
  /rename <feature-slug>/03-Parallel feature
  /wayfinder .scratch/<feature>/issues/03-parallel-feature.md
```

- 每张 issue 在依赖树中只出现一次；多父依赖以 ` <- 01, 02` 保留全部真实 blocker；
- 树线只选择编号靠后的 blocker 作为视觉主父节点，行尾 ` <- ` 列表才是完整依赖真源；
- 行内类型标签**始终**打印：有 `Type` 时为 `[research]` / `[grilling]` / `[task]` / `[prototype]`；无 Type 的实施票为 `[impl]`（纯 implementation 与 mixed 图一致）；Wayfinder 缺 Type 时为 `[unknown]`。是否完成看行首符号（`✓` = 已完成 / resolved），不是 type 字段；
- `NOW` 永远是最后一段，`可新增并行实施` 只统计无开放依赖且未 claim 的 issue；`进行中` 统计 `Status: claimed` 的票（Wayfinder 与 implementation 均适用）；
- 可实施项第一行保留状态符号、编号、类型标签和标题；随后依次缩进输出 `/rename <feature-slug>/<issue-number>-<issue-title>` 与当前可执行命令。`feature-slug` 取 feature 目录 basename（与 `KANBAN` 头、`.scratch/<feature>` 一致），便于多 feature 并行会话在 tab/列表中辨识；不另造 short slug。Wayfinder 命令为 `/wayfinder <repo-relative-issue-path>`，普通 implementation 命令为 `/implement <repo-relative-issue-path>`；路径相对项目根目录并统一使用 `/`；
- `○` 的数量就是当前还能新增的并行实施数。

机器分组仍使用普通 implementation issue 的以下角色：

```text
CLOSED
BLOCKED
CLAIMED
WAITING FOR INFO
NEEDS TRIAGE
OTHER / WARNINGS
HUMAN READY
AGENT READY
```

Wayfinder child ticket 的机器分组角色：

```text
RESOLVED
BLOCKED
CLAIMED
OTHER / WARNINGS
FRONTIER
```

优先级：

1. 合法完成（`Closed: true`，或 `Status: resolved` 且未显式 `Closed: false`）→ `CLOSED`；
2. 元信息或依赖图无法可靠解释 → `OTHER / WARNINGS`；
3. 任意合法未关闭 issue 有开放依赖 → `BLOCKED`；
4. 合法未关闭且 `Status: claimed` → `CLAIMED`（已领取/进行中，不进 frontier，也不解除下游依赖）；
5. 无开放依赖时，再根据 canonical `Status` role 进入等待、Human 或 Agent 分组。

只查看可立即交给 Agent 的列表：

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs \
  --ready-only .scratch/<feature-slug>
```

`--ready-only` 仍返回普通图的 `AGENT READY` 或 Wayfinder 图的 `FRONTIER`；每项先保留编号和标题，再依次输出 `/rename <feature-slug>/<issue-number>-<issue-title>` 和当前可执行命令。默认人类看板还会在底部输出 `NOW`，并明确 `required_skill=/wayfinder`。任何执行 Wayfinder ticket 的 Agent 都必须先调用 `/wayfinder`，再按该 skill 的 claim/resolve 合同工作。

## Agent 非交互接口

Agent 不得依赖默认交互选择。先列 feature：

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs \
  --list-features --json --non-interactive
```

再读取明确 feature 的完整图：

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs \
  --json --non-interactive .scratch/<feature-slug>
```

也可从子目录运行并通过 `--project-root <path>` 明确项目根目录。

JSON 是唯一机器接口：

```json
{
  "feature": "<feature-slug>",
  "workflow": "implementation",
  "requiredSkill": null,
  "summary": {},
  "issues": [
    {
      "id": "03-example.md",
      "number": "03",
      "title": "Example",
      "status": "ready-for-agent",
      "statusRole": "ready-for-agent",
      "hasStatusField": true,
      "closed": false,
      "closedRaw": "false",
      "hasClosedField": true,
      "closedImplicit": false,
      "metadataValid": true,
      "metadataErrors": [],
      "path": ".scratch/<feature>/issues/03-example.md",
      "blockedBy": [],
      "blockedByOpen": [],
      "blockedByMissing": [],
      "blockedByInvalid": [],
      "unlocks": [],
      "dependencyCycle": []
    }
  ],
  "warnings": []
}
```

Wayfinder 图使用 `workflow: "wayfinder"`，顶层和每张 ticket 都返回 `requiredSkill: "/wayfinder"`；ticket 使用 `type`、`status`、`resolved`、`claimed`，不伪造普通 issue 的 `Closed` 或 triage role。

- `id` 是 feature 内稳定文件名 ID；
- `status` 是项目实际值；`statusRole` 是 Matt canonical role；
- `issues` 是完整扁平图，不返回 `next`、推荐或裁剪后的 ready 数组；
- 消费者读取结构字段，不解析 warning 文案或人类看板。

## 支持的票据格式

兼容项目扩展格式：

```markdown
Status: ready-for-agent
Closed: false

## Blocked by

- `01-foundation.md`
```

也兼容 Matt `to-tickets` 原生粗体格式；原生模板没有 `Closed` 时，等价于 `Closed: false`：

```markdown
**What to build:** <end-to-end behavior>
**Status:** ready-for-agent
**Blocked by:** 01 — Foundation
```

JSON 会保留 `hasClosedField: false` 并返回 `closedImplicit: true`，使消费者能够区分该兼容情况与显式 `Closed: false`。缺少 `Closed` 的其它 implementation issue 仍然 fail-closed。

Blocker 可以使用：

- issue 文件名或指向它的 Markdown 链接；
- Windows 或 POSIX issue 路径；
- 唯一编号；
- 编号加标题。编号重复时必须由标题唯一消歧，否则 fail-closed。

也支持 Wayfinder 本地格式：

```markdown
# <ticket title>

Type: research|prototype|grilling|task
Status: open|ready-for-agent|claimed|resolved
Blocked by: none|01, 02

## Question
```

存在 `Label: wayfinder:map` 的 `.scratch/<feature>/map.md` 且**仅有** Wayfinder 票时识别为纯 Wayfinder 图；没有 map 时，也可由合法 `Type` 自动识别。同目录再出现无 `Type` 的实施票则升为 **mixed**。Wayfinder 的 `resolved` 才解除依赖；`open` / `ready-for-agent` 且无开放依赖进入 `FRONTIER`；`claimed` 单独展示。

## 元信息与 fail-closed

以下情况禁止 issue 进入 `AGENT READY`：

- `Status` 缺失、冲突或不能映射到 canonical role；
- `Closed` 缺失、冲突或不是 `true|false`；但完整匹配 Matt 原生 `What to build + Blocked by + Status` 行内模板的票据会兼容视作 `false`；
- `wontfix / Closed: false`；
- blocker 引用无法解析或不存在；
- 自依赖或依赖环。

`Closed: true` 不要求某个固定 Status。Matt 默认 `/implement` 可以完成后保持原 Status 并直接关闭；项目 implementation skill 也可以定义自己的关闭前流程。显式 `Closed: true` 时，非 canonical 的 Status（含误写的 `done`、或仍为 `claimed`）不再阻止进入 `CLOSED`，也不再把该票踢出依赖图。

implementation 的 `Status` 除 5 个 triage role 外，额外承认两个与 Wayfinder 对齐的执行态：

- **`claimed`**：已有 Agent 领取、工作进行中。它**不是** triage 配置项，也**不是**完成态。多 Agent 并行时应 claim 后再开干，避免两张手抢同一 frontier 票。
- **`resolved`**：完成别名（与 Wayfinder 同名同义）。可单独表示完成并解除下游依赖；也可与 `Closed: true` 并存。若写成 `Status: resolved` 且 `Closed: false`，看板 fail-closed 并给出 `conflicting-resolved-open`。

推荐完成写法仍是 `Closed: true`（可保留原 triage Status）；`Status: resolved` 作为兼容写法被一等支持。

**不要**用 `Status: done` 表示完成：它不是 completion 字段，不会解除依赖。看板会保留该票、标为 `OTHER / WARNINGS`，并给出 `status-done-not-completion`（以及交接时的 `non-canonical-status-on-handoff`）warning。请改用 `Closed: true` 或 `Status: resolved`。

Comments 中出现的字段示例或历史记录不能覆盖头部真源。

只冻结受影响分支：独立且自身合法的 issue 仍可进入 frontier。

## 两种工作流的边界

- `map.md` 是 Wayfinder 的低分辨率索引，不作为 child ticket 节点；
- implementation 图继续使用 `Status + Closed`，Wayfinder 图只使用 `Type + Status`；
- **同 feature 混合是正常的**：目录里同时存在 `Type: research|…` 与无 `Type` 的实施票时，看板进入 `workflow=mixed`，**全部入图**，按票自身类型解析与分组；
- 未完成的 research **只阻塞声明依赖它的下游票**，不再整板报错、也不再要求「全部决策 resolved 才能实施」；
- Wayfinder 开放态：`open` 与 `ready-for-agent`（兼容 implementation triage 写法）均可进 `FRONTIER`；完成仍是 `resolved`；
- mixed 的 NOW / `--ready-only` 合并 `FRONTIER` + `AGENT READY`，命令按票类型分别给 `/wayfinder` 或 `/implement`；
- `requiredSkill` 是执行入口（Wayfinder 票级字段），不表示看板会自行 claim、resolve 或实施 ticket。

## Mermaid

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs \
  --format mermaid \
  --output <path> \
  .scratch/<feature-slug>
```

Mermaid 是完整图投影，不是执行候选接口。

## 边界

- 不修改 issue、Status、Closed、Comments 或依赖边；
- 不创建、关闭或重写 issues；
- 不选择或推荐下一张 issue；
- 不替代 `/wayfinder`、`to-spec`、`to-tickets`、`implement`、项目 implementation skill 或 `yjx-local-ralph`。
