# 个人全局提示词

本目录维护跨 Agent 复用的个人全局指令源文件，通过 [`scripts/link-skills.mjs`](../scripts/link-skills.mjs)（`npm run link` / `npm run status` / `npm run force`）以操作系统原生文件符号链接（File Symlink）方式挂载到各 Agent 的用户级全局指令路径。

## 唯一真源与默认入口映射

- [`AGENTS.md`](AGENTS.md)：跨平台共享的唯一真源，涵盖沟通与交付、工具与技能选择，以及子代理职责、调度、上下文隔离与审查边界。

`developer-targets.local.yaml` 中的 `prompt_targets` 默认支持将以下 6 类 Agent 的用户级全局入口直接软链接至 [`prompts/AGENTS.md`](AGENTS.md)（支持 `AGENTS.md` 的宿主均优先使用 `AGENTS.md`）：

- **Codex（Desktop & CLI）**：`~/.codex/AGENTS.md`
- **Grok Build**：`~/.grok/AGENTS.md`
- **Antigravity IDE & Agy CLI**：`~/.gemini/config/AGENTS.md`
- **Claude Code**：`~/.claude/CLAUDE.md`
- **CodeBuddy（IDE & CLI）**：`~/.codebuddy/CODEBUDDY.md`

## 编辑与跨机器同步机制

- **随手编辑即改真源**：各宿主入口均为指向本目录源文件的操作系统符号链接。在 VS Code 或任意编辑器中直接修改任一已链接入口（如 `~/.codex/AGENTS.md`）并保存，所有已挂载入口在磁盘上即时共享同一份内容；各宿主在启动新会话或重新加载配置时读取最新规则。
- **跨机器同步**：新机器首次克隆仓库后运行一次 `npm run init` 与 `npm run force`（将已有普通文件安全备份为 `.bak-before-link*` 后建立符号链接）；此后日常 `git pull` 更新仓库文件即可直接更新所有已链接入口的磁盘内容，未提交的本地修改由 Git 原生检测与合并机制保护。
- **按宿主扩展独立源文件**：若某个特定 Agent 需要使用不同于默认 [`AGENTS.md`](AGENTS.md) 的独立提示词文件，可在 `prompt_targets` 中使用对象格式 `{ target: "~/.some-agent/AGENTS.md", source: "prompts/some-agent.md" }`（或指向已被 Git 忽略的 `prompts.local/` 下的私有文件）。

## 公开边界与维护原则

- 可以公开的通用规则维护在 [`AGENTS.md`](AGENTS.md)；包含身份、公司内部约定、凭据或机器专有路径的私密提示词放在仓库根目录的 `prompts.local/`（已被 Git 忽略）。
- 遵循 `writing-for-agents` 准则：同类规则同位归并（Co-location），每项语义只保留单一权威位置，优先使用正向动词描述目标行为，剔除解释性赘述与默认已遵守的 No-op。
