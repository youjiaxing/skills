---
name: yjx-gh-kanban
description: 只读 GitHub Issues 看板（gh + Node 引擎）：人类依赖树/LEGEND/NOW，以及 --json / --agent / --ready-only 机器契约；支持 parent 过滤与 limit；可从常见 Agent skills 根解析脚本路径。不改 issue、不选票。
disable-model-invocation: true
---

# yjx-gh-kanban

GitHub Issues 轨的只读看板 skill，与 `yjx-local-kanban` 成对。

- **Local 轨**：`yjx-local-kanban` 解析 `.scratch/<feature>/issues/*.md`
- **GitHub 轨**：本 skill 通过 `gh` 读取 Issues + native parent / `blockedBy`

## 安装

```bash
npx skills add youjiaxing/skills --skill yjx-gh-kanban
```

开发者 monorepo 链接：

```bash
# 在 youjiaxing/skills 仓库
npm run link   # 需先配置 developer-targets.local.yaml
```

要求：Node.js 20+、已登录且能访问目标仓库的 GitHub CLI（`gh`）。脚本只用 Node 标准库，不依赖 Claude 专有 API。

## 可移植脚本

```text
scripts/issue-board.mjs          # CLI：参数 → gh 拉数 → board 引擎 → 打印
scripts/board-engine.mjs         # 纯函数引擎（fixture 单测友好，不访问网络）
scripts/resolve-board-script.mjs # 在已安装 skills 根下解析 board CLI 路径
```

根据当前 Agent 提供的 skill 加载信息定位本 `SKILL.md`，再解析相邻 `scripts/`；不要假设固定全局目录。下文用 `<kanban-skill-dir>` 表示本 `SKILL.md` 所在目录。

应用仓库的 Makefile / Ralph 等消费者应通过路径发现定位脚本，**禁止**写死开发机 monorepo 绝对路径，也**禁止**静默回退到已删除的应用仓本地 `kanban` 路径。

### 路径发现

```bash
node <kanban-skill-dir>/scripts/resolve-board-script.mjs
# 可选：--project-root <path>  额外搜索 <path>/.agents/skills
```

搜索顺序：

1. 环境变量 `YJX_SKILLS_ROOT` 或 `AGENT_SKILLS_ROOT`
2. `~/.agents/skills`
3. `~/.claude/skills`
4. `~/.codex/skills`
5. （可选）`<project-root>/.agents/skills`

找不到时错误信息会给出 `npx skills add` / `npm run link` 提示。

也可在代码中：

```js
import { resolveBoardScript } from '.../resolve-board-script.mjs';
const { scriptPath } = await resolveBoardScript({ projectRoot: process.cwd() });
```

## 人类看板

在已配置 `gh` 的 GitHub 仓库根目录运行：

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs
```

默认输出对齐 Local 看板版式：`LEGEND`、摘要、`DEPENDENCY TREE`、`WARNINGS`、底部 `NOW`。

按 parent（spec/PRD issue）过滤人类依赖树：

```bash
node <kanban-skill-dir>/scripts/issue-board.mjs --parent 102
node <kanban-skill-dir>/scripts/issue-board.mjs --parent '#102'
```

parent 视图会拉入子票与 **blocker 闭包**（含理解阻塞所需的 closed 票）。  
**注意**：`--parent` 只缩小默认人类树投影；与 `--json` / `--agent` / `--ready-only` 组合时，机器侧 READY / `next` 仍是当前 limit 窗口的整仓分类（避免改变 Ralph 全局队列语义）。

## 机器接口

```bash
# 结构化 JSON：next / ready / blocked / specs / ...
node <kanban-skill-dir>/scripts/issue-board.mjs --json

# 紧凑 agent 输出：ready=… / next=… / READY 列表
node <kanban-skill-dir>/scripts/issue-board.mjs --agent

# 仅 READY 候选（含 /rename 与 gh issue view 提示）
node <kanban-skill-dir>/scripts/issue-board.mjs --ready-only
```

其它选项：

| 选项 | 含义 |
| --- | --- |
| `--limit N` | 拉取 issue 上限，默认 `200` |
| `--ready-label LABEL` | 覆盖 ready 标签（默认读 `docs/agents/triage-labels.md` 映射，否则 `ready-for-agent`） |
| `--project-root PATH` | 解析 triage 文档用的项目根，默认 cwd |
| `-h` / `--help` | 帮助 |

输出优先级：`--json` > `--agent` > `--ready-only` > 默认人类树。

## 合同要点

- 关系真源：GitHub native parent / native `blockedBy`；**不**解析正文 `## Parent` / `## Blocked by`
- READY：open + ready 映射标签 + 无 open blocker + 非 SPEC + 非 wayfinder
- SPEC：正文同时具备 `## Problem Statement` / `## Solution` / `## User Stories`
- 无 parent 的 ready 实施票合法；parent 不是 blocker
- 候选关系缺失或不可靠 → **fail-closed**，不输出可用 `next`
- 依赖树：视觉主挂载优先 native parent；行尾 ` <- #a, #b` 列出完整 blockedBy；每票至多一次
- NOW：可实施 READY + 进行中（assignee 近似，**不**改 READY 契约）

## 单测

```bash
# 在 skills monorepo 根目录
node --test skills/yjx-gh-kanban/tests/*.test.mjs
# 或
npm test
```

引擎与路径发现、CLI（注入假 `gh`）均可在无网络环境下验证。

## 边界

- 不修改 GitHub issue、label、assignee 或关系
- 不选择或确认下一张实施票（见后续 `yjx-gh-ralph`）
- 不替代项目 `docs/agents/issue-tracker.md` 中的生命周期约定
- 不提供 Mermaid 输出（Local 轨专属能力，非本 skill 必达）
