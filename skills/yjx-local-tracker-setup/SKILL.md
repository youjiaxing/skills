---
name: yjx-local-tracker-setup
description: 在 Matt Pocock Local Markdown issue tracker 项目上增量启用可判定的 Closed 完成字段和机器配置；默认只预览，确认后才写入或迁移旧票。
argument-hint: "[项目根目录]"
disable-model-invocation: true
---

# Local Tracker Setup

为已经由 `setup-matt-pocock-skills` 配置为 **Local Markdown** 的项目增加确定性完成协议。本技能不是 Matt setup 的替代品，也不复制 `to-spec`、`to-tickets` 或 `implement`。

## 前提

项目必须已经存在：

```text
docs/agents/issue-tracker.md
docs/agents/triage-labels.md
```

Tracker 文档必须声明 `.scratch/<feature>/issues/<NN>-<slug>.md` 形式的 Local Markdown tracker。前提不满足时停止，并要求先运行 `setup-matt-pocock-skills`、选择 Local Markdown；不要自行猜测或创建一套不同 tracker。

## 可移植脚本

确定性脚本是本 skill 目录下的：

```text
scripts/setup-local-tracker.mjs
```

根据当前 Agent 提供的 skill 加载信息定位本 `SKILL.md`，再从其所在目录解析脚本；不要假设 skill 安装在 `.claude`、`.agents`、`.codex` 或任何固定全局目录。脚本只依赖 Node.js 20+ 标准库，不依赖 Claude API、Claude Agent SDK 或 Claude Code 专有运行时。

下文用 `<setup-skill-dir>` 表示本 `SKILL.md` 所在目录。

## 协议

写入固定路径：

```text
docs/agents/local-tracker.json
```

配置只保存 parser 必需的机器事实：

```json
{
  "schemaVersion": 1,
  "protocol": "matt-local-markdown+closed-v1",
  "trackerRoot": ".scratch",
  "completionField": "Closed",
  "statusRoles": {
    "needs-triage": "needs-triage",
    "needs-info": "needs-info",
    "ready-for-agent": "ready-for-agent",
    "ready-for-human": "ready-for-human",
    "wontfix": "wontfix"
  }
}
```

`statusRoles` 的实际值从 `docs/agents/triage-labels.md` 读取，不要求项目使用上述英文值。

`Status` 表示 triage 角色；`Closed` 表示依赖是否解除和生命周期是否结束。两者不能互相推断。不要增加 `closeWhen`、状态机配置或自然语言生命周期配置。

## 流程

### 1. 只读预览

始终先运行：

```bash
node <setup-skill-dir>/scripts/setup-local-tracker.mjs \
  --project-root <project-root>
```

需要机器结果时加 `--json`。预览必须展示：

- 即将创建、保持或替换的机器配置；
- 扫描到的 feature 和普通 implementation issues；
- 缺少 `Closed` 的旧票；
- 可安全补 `Closed: false` 的票；
- 因缺少 `Status` 而不会自动迁移的票。

默认命令不修改任何文件。

### 2. 请求确认

把预览摘要给用户，明确区分：

1. 只写或校正机器配置；
2. 同时为预览列出的旧 implementation issues 补 `Closed: false`。

只有用户明确确认后才能执行。不要把安装本 skill、运行预览或先前讨论视为迁移授权。

### 3. 应用

只写配置：

```bash
node <setup-skill-dir>/scripts/setup-local-tracker.mjs \
  --project-root <project-root> \
  --apply --yes
```

同时迁移预览过的旧票：

```bash
node <setup-skill-dir>/scripts/setup-local-tracker.mjs \
  --project-root <project-root> \
  --apply --yes --migrate-closed
```

迁移保持原字段风格：`Status:` 对应 `Closed:`，`**Status:**` 对应 `**Closed:**`。只在首个二级章节前的头部字段区插入；不修改 Comments，不覆盖已有 `Closed`，不迁移 wayfinder 工件。

### 4. 复核

应用后重新运行只读预览。若项目也安装了 `yjx-local-kanban`，再用它的 `--list-features --json` 和单 feature `--json --non-interactive` 检查图事实。

## 项目接入

项目 tracker 文档应明确：

- 新 implementation issue 必须显式包含 `Closed: false`；
- `Closed: true` 是依赖解除的唯一机器真源；
- 缺少或非法 `Closed` 必须 fail-closed；
- 哪个 implementation skill 负责何时关闭，或项目无特殊流程时采用默认规则：`/implement` 成功完成实现与验证后直接把 `Closed` 改为 `true`，不为此创造新的 `Status` 值；
- 状态、评论、人工 review 和提交等更细生命周期继续由项目 tracker 文档或 implementation skill 定义。

## 边界

- 不发布或重拆 issues；
- 不推断旧票是否已经完成；旧票一律只补 `Closed: false`；
- 不通过 checklist、commit、`ready-for-human` 或其它 Status 猜测完成；
- 不修改 wayfinder 的 `map.md`、`Type: research|prototype|grilling|task` 或 `Status: claimed|resolved` 工件；
- 不要求安装 `yjx-local-kanban` 或 `yjx-local-ralph` 才能运行 setup。
