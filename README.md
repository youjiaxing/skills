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
- macOS 使用目录符号链接，Windows 使用目录联接（junction）。

开发链接 CLI 的隔离验证步骤见 [`docs/development/verification.md`](docs/development/verification.md)。
