---
name: yjx-local-kanban
description: 只读解析 Matt Local Markdown tracker 的 implementation issue 依赖图，输出人类看板、完整 JSON 图或 Mermaid；不选票、不改状态。
argument-hint: "[feature 目录]"
---

# Local Kanban

`yjx-local-kanban` 是 Matt Local Markdown tracker 加 `Closed` 扩展协议的只读事实提供者。它解析 `.scratch/<feature>/issues/*.md`，不修改 issue，不选择下一张 issue，也不替 implementation 流程决定生命周期。

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

分组顺序：

```text
CLOSED
BLOCKED
WAITING FOR INFO
NEEDS TRIAGE
OTHER / WARNINGS
HUMAN READY
AGENT READY
```

优先级：

1. 合法 `Closed: true` → `CLOSED`；
2. 元信息或依赖图无法可靠解释 → `OTHER / WARNINGS`；
3. 任意合法未关闭 issue 有开放依赖 → `BLOCKED`；
4. 无开放依赖时，再根据 canonical `Status` role 进入等待、Human 或 Agent 分组。

只查看可立即交给 Agent 的人类列表：

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs \
  --ready-only .scratch/<feature-slug>
```

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

也兼容 Matt `to-tickets` 粗体格式：

```markdown
**Status:** ready-for-agent
**Closed:** false
**Blocked by:** 01 — Foundation
```

Blocker 可以使用：

- issue 文件名或指向它的 Markdown 链接；
- Windows 或 POSIX issue 路径；
- 唯一编号；
- 编号加标题。编号重复时必须由标题唯一消歧，否则 fail-closed。

## 元信息与 fail-closed

以下情况禁止 issue 进入 `AGENT READY`：

- `Status` 缺失、冲突或不能映射到 canonical role；
- `Closed` 缺失、冲突或不是 `true|false`；
- `wontfix / Closed: false`；
- blocker 引用无法解析或不存在；
- 自依赖或依赖环。

`Closed: true` 不要求某个固定 Status。Matt 默认 `/implement` 可以完成后保持原 Status 并直接关闭；项目 implementation skill 也可以定义自己的关闭前流程。

Comments 中出现的字段示例或历史记录不能覆盖头部真源。

只冻结受影响分支：独立且自身合法的 issue 仍可进入 frontier。

## Wayfinder 排除

只处理普通 implementation issues。以下工件不进入图：

- `map.md`；
- `Type: research|prototype|grilling|task`；
- 未映射为普通 triage role 的 `Status: claimed|resolved`。

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
- 不替代 `to-spec`、`to-tickets`、`implement`、项目 implementation skill 或 `yjx-local-ralph`。
