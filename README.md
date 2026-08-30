# yjx-skills

个人维护、可供团队使用的 Agent skills。skill 名使用 `yjx-` 前缀，以降低与其他公开 skill 的命名冲突。

## 安装

普通使用者可以通过 Skills CLI 从 GitHub 安装：

```bash
npx skills add youjiaxing/skills
```

只安装指定 skill：

```bash
npx skills add youjiaxing/skills --skill yjx-discuss
```

## 已有 skills

- `yjx-discuss`：通过简短、逐问、敢于纠错的讨论收敛想法，再形成总结。
- `yjx-grill`：通过决策树剪枝、显式区分用户决策与 Agent 推断，以及实现前的四部分对齐产物，高效校验需求理解。
- `yjx-local-tracker-setup`：为 Matt Pocock Local Markdown tracker 写入 `Status: resolved` 完成协议和机器配置，默认只预览。
- `yjx-local-kanban`：只读输出 Local Markdown implementation issues 的人类看板、完整 JSON 依赖图和 Mermaid。
- `yjx-gh-kanban`：只读输出 **GitHub Issues** 人类看板（LEGEND / 依赖树 / NOW）与 `--json` / `--agent` / `--ready-only` 机器契约；通过 `gh` 拉数，脚本路径可从常见 Agent skills 根发现。
- `yjx-gh-ralph`：从 GitHub Issues READY 池手动确认并启动单张 issue；默认推荐 board `next`，确认后走 implement、验证后自动 commit，并遵守项目 issue-tracker 收尾；**禁止 auto-run / 连续多票**。依赖同根 `yjx-gh-kanban`。

### Local Markdown tracker 组合

先通过 Matt Pocock 的 `setup-matt-pocock-skills` 为项目选择 Local Markdown tracker，再安装并运行 `yjx-local-tracker-setup`。该 skill 会生成 `docs/agents/local-tracker.json`，并在人工确认后将约束文档对齐到 `Status: resolved` 完成语义；`Closed: true` 仅作为 legacy 只读兼容。

典型安装：

```bash
npx skills add youjiaxing/skills --skill yjx-local-tracker-setup
npx skills add youjiaxing/skills --skill yjx-local-kanban
```

`yjx-local-tracker-setup` 和 `yjx-local-kanban` 可独立安装。脚本要求 Node.js 20 或更高版本，**不**依赖 Claude API、Claude Agent SDK 或 Claude Code 专有运行时，因此可由支持 Agent Skills 和 shell 命令的不同 Agent 使用。

### GitHub Issues tracker 组合

与 Local 轨成对：Local 读 Markdown issues，GitHub 轨读 `gh` Issues。

```bash
npx skills add youjiaxing/skills --skill yjx-gh-kanban
npx skills add youjiaxing/skills --skill yjx-gh-ralph
```

`yjx-gh-kanban` 可独立安装；`yjx-gh-ralph` 必须和 `yjx-gh-kanban` 安装在同一个 Agent skills 根目录。

在任意已配置 `gh` 的仓库根目录：

```bash
# 将 <kanban-skill-dir> / <ralph-skill-dir> 换成本机 skills 根下对应目录
node <kanban-skill-dir>/scripts/issue-board.mjs
node <kanban-skill-dir>/scripts/issue-board.mjs --json
node <kanban-skill-dir>/scripts/issue-board.mjs --agent
node <kanban-skill-dir>/scripts/issue-board.mjs --ready-only
node <kanban-skill-dir>/scripts/issue-board.mjs --parent 102

# Ralph 选票（只读 READY + 推荐 next；不实施、不循环）
node <ralph-skill-dir>/scripts/select-issue.mjs
node <ralph-skill-dir>/scripts/select-issue.mjs --json
```

消费者（Makefile、Ralph 等）可用路径发现脚本定位 board CLI，避免写死绝对路径：

```bash
node <kanban-skill-dir>/scripts/resolve-board-script.mjs
# 或设置 YJX_SKILLS_ROOT 指向 skills 安装根
```

对照：

| | `yjx-local-kanban` | `yjx-gh-kanban` |
| --- | --- | --- |
| 数据源 | `.scratch/<feature>/issues/*.md` | GitHub Issues（`gh`） |
| 作用域 | feature 目录 | 默认整仓；可选 `--parent` |
| 人类输出 | LEGEND / 依赖树 / NOW | 同构版式（符号语义对齐） |
| 机器输出 | 完整 JSON 图 / Mermaid | `--json`（含 `next`/`ready`）/ `--agent` |
| 调度伙伴 | — | `yjx-gh-ralph`（手动单票，无 auto-run） |

依赖分层：

- `yjx-local-tracker-setup` / `yjx-local-kanban` / `yjx-gh-kanban` / `yjx-gh-ralph`：以 **Node 标准库**为主（无 Ink）。`yjx-gh-kanban` / `yjx-gh-ralph` 另需本机 `gh`。

## 开发者设置

本节用于维护本仓库。普通使用者不需要创建目录链接。

要求：

- Node.js 20 或更高版本
- npm
- 可选：GNU Make；Windows 的 Git Bash 通常不自带 Make

安装依赖：

```bash
npm install
```

首次配置：

```bash
npm run init
```

也可以先执行 `npm run link`。本机配置不存在时，脚本会从 `developer-targets.example.yaml` 创建 `developer-targets.local.yaml`，然后停止，等待开发者确认目标目录。

本机配置不会纳入版本控制。模板中的常见 Agent 全局目录默认全部处于注释或禁用状态。

## 开发命令

```bash
npm run link                    # 创建或校验链接
npm run status                  # 只检查，不修改文件
npm run force                   # 删除冲突路径并重建链接
npm run prune                   # 清理本仓库管理的陈旧链接
npm run link -- --target PATH   # 临时追加一个目标目录
npm run link -- --no-config --target PATH
npm test
```

`--force` 会直接删除目标目录中与本仓库 skill 同名的冲突文件或目录，未同步的修改会永久丢失。脚本会先检查全部目标；发现可预见冲突时，不执行任何修改。

`--prune` 只清理目标原本指向当前仓库 `skills/`、但源 skill 已不存在的链接，不处理其他来源的链接。仓库移动后，旧链接不再能被可靠识别，需要手动清理。

Makefile 提供相同的便捷入口：

```bash
make
make init
make link
make status
make force TARGET=~/.codex/skills
make prune
make test
```

直接执行 `make` 只显示帮助。

## 维护约定

- `skills/` 的直接子目录只要包含 `SKILL.md`，就会被识别为可链接 skill。
- 不可用或未准备发布的 skill 应删除或移出 `skills/`。
- GitHub 仓库是唯一可编辑真源；Agent 全局目录中的开发链接指向该工作副本。
- Claude Code、Codex 等采用目录链接（macOS 使用符号链接，Windows 使用 junction）。
- Antigravity 采用原生配置挂载（自动维护 `~/.gemini/config/skills.json` 中的 `entries`，由 `antigravity: true` 控制，避免 Windows 软链接穿透限制）。

开发链接 CLI 的隔离验证步骤见 [`docs/development/verification.md`](docs/development/verification.md)。
