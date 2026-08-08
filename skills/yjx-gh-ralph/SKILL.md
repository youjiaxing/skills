---
name: yjx-gh-ralph
description: 为 GitHub Issues 手动选择并启动一张 READY 实施票；默认推荐看板 next，等待用户确认，implement 验证后自动 commit，遵守项目 issue-tracker 收尾；单票结束，禁止 auto-run。
argument-hint: ""
disable-model-invocation: true
---

# yjx-gh-ralph

`yjx-gh-ralph` 是 GitHub Issues 轨的 **manual single-issue** 调度入口，与 `yjx-local-ralph` 成对。

- **Local 轨**：`yjx-local-ralph` + `yjx-local-kanban`（Markdown issues）
- **GitHub 轨**：本 skill + `yjx-gh-kanban`（`gh` Issues）

从看板 READY 池推荐一张票，**等待用户确认**后再进入实施；单票结束后停止。

## 依赖与前提

必须同时安装到同一 Agent skills 根目录：

```text
yjx-gh-kanban
yjx-gh-ralph
```

```bash
npx skills add youjiaxing/skills --skill yjx-gh-kanban
npx skills add youjiaxing/skills --skill yjx-gh-ralph
```

开发者 monorepo 链接：

```bash
# 在 youjiaxing/skills 仓库
npm run link   # 需先配置 developer-targets.local.yaml
```

要求：

- Node.js 20+
- 已登录且能访问目标仓库的 GitHub CLI（`gh`）
- 当前工作目录可被 `gh` 识别为 GitHub 仓库（或等价远程配置）

项目应通过 `setup-matt-pocock-skills`（或等价配置）使用 GitHub Issues tracker，并具备：

```text
docs/agents/issue-tracker.md
docs/agents/triage-labels.md
```

若 tracker 文档缺失，停止并要求先完成项目 tracker 配置；不要自行发明生命周期。

## 可移植脚本

```text
scripts/select-issue.mjs
```

根据当前 Agent 提供的 skill 加载信息定位本 `SKILL.md`，再解析相邻 `scripts/`；不要假设固定全局目录。下文用 `<ralph-skill-dir>` 表示本 `SKILL.md` 所在目录。

脚本通过 **路径发现** 调用已安装的 `yjx-gh-kanban` board CLI（`--json`），不复制 board 引擎，不解析人类看板文本。发现顺序：

1. **同根相邻安装**：与本 skill 并列的 `yjx-gh-kanban/scripts/issue-board.mjs`（monorepo 兄弟目录或同 skills 根 link/install）
2. 再委托 kanban 的 `resolve-board-script.mjs`：`YJX_SKILLS_ROOT` / `AGENT_SKILLS_ROOT` → `~/.agents/skills` → `~/.claude/skills` → `~/.codex/skills` → 可选 `--project-root` 下 `.agents/skills`

找不到看板脚本时失败并给出安装/link 提示；**禁止**静默回退到已删除的应用仓本地 `kanban` / `ralph` 路径。

候选命令：

```bash
node <ralph-skill-dir>/scripts/select-issue.mjs
node <ralph-skill-dir>/scripts/select-issue.mjs --json
node <ralph-skill-dir>/scripts/select-issue.mjs --project-root <path>
```

也可直接调用看板（与路径发现约定一致）：

```bash
# 将 <kanban-skill-dir> 换成本机 skills 根下的 yjx-gh-kanban 目录
node <kanban-skill-dir>/scripts/issue-board.mjs --json
node <kanban-skill-dir>/scripts/issue-board.mjs --agent
node <kanban-skill-dir>/scripts/resolve-board-script.mjs
```

脚本只依赖 Node.js 标准库 + 已安装的 `yjx-gh-kanban` + `gh`（由 kanban CLI 调用）。不依赖 Claude API / Agent SDK。

## 首屏流程

开始 implementation 前必须：

1. 确认当前 GitHub repo（`gh repo view --json nameWithOwner,url`）；
2. 展示当前分支最近 5 条 commits（`git log -5 --oneline`）；
3. 用本 skill 脚本或 kanban `--json` / `--agent` 读取 READY 候选；
4. 列出全部 READY 候选（不得混入 BLOCKED / SPEC / wayfinder / OTHER OPEN / CLOSED）；
5. 默认推荐 board 的 **`next`**（多候选时与看板优先级一致，不是模型语义猜测）；
6. 提示确认后默认使用 **`implement`** skill 实施，并在验证通过后 **自动提交** 本票本轮变更；
7. 请求用户确认是否处理推荐票，或在 READY 集合内指定另一张。

缺少任一项时不得开始实施。确认前不修改 issue，不进入大范围实现。

推荐确认结构（选项从 1 编号，标出推荐项）：

```text
## Repo
<nameWithOwner>
<url>

## 最近变更
<last 5 commits>

## READY issues
1. #<number> <title>
   <url>

## 推荐处理
推荐：#<number> <title>
理由：kanban board.next（READY 优先级排序第一）

## 默认实施入口
确认处理后，默认使用 implement skill 实施，验证通过后自动提交本 issue 的本轮变更。

## 等你确认
1. 处理推荐票（推荐）
2. 处理另一张 READY 票：#N
3. 暂不处理
```

## 候选合同

只接受看板机器输出中的 **`ready`** 数组。

```text
候选 = board.ready
推荐 = board.next   # 多候选时必须等于 next；空池时为 null
```

- BLOCKED、SPEC、wayfinder、OTHER OPEN、CLOSED **不可入选**
- 用户只能在 READY 候选内改选；不得把非 READY 票硬开
- 若 `next` 为空或 READY 为空：停止并说明事实（全关、阻塞、等待人类、关系 fail-closed 等）；不要绕过看板猜测

## 用户确认后

只处理用户确认的那一张 issue：

1. `gh issue view <number> --comments` 读取全文与评论；
2. 从本轮 board 条目的 `parent` 读取 native parent（若有），再 `gh issue view <parent> --comments` 作为背景；**不要**解析正文 `## Parent` 当机器真源；
3. 按项目 `AGENTS.md` / Docs 加载索引读取最小必要文档；
4. 明确宣布使用 **`implement`** skill，按其流程实施、验证与审查要求执行；
5. 保持单 issue 范围，不顺手处理其他 READY 票；
6. 验证通过后，将用户确认视为本轮 **自动 commit 授权**（见下节）；
7. 按项目 **`docs/agents/issue-tracker.md`**（或项目指定 tracker 文档）做 comment / checkbox 同步 / close 等收尾；
8. **单票结束即停止**。

## 自动提交

用户确认处理本票后，即授权本轮 issue 完成时自动提交；实现完成后不要再次询问是否 commit。提交前必须：

1. issue 范围内变更已保存；
2. 与风险匹配的验证已运行并通过；失败或未跑关键验证则不提交；
3. 用 `git status` / `git diff` 核对 scope，只 stage 本票本轮变更；
4. dirty worktree 中与本票无关的 WIP 保持未 staged；无法隔离时停止并说明；
5. 提交信息遵循项目约定（常见：`type(scope): 中文描述`）。

提交后在完成输出中报告 hash、标题与真实验证结果。

## 收尾（issue-tracker）

实施与提交成功后，必须遵守项目 issue-tracker，而不是只推代码：

- 补完成 comment（变更摘要、commit、验证证据）；
- 若 body 有已完成 checklist，优先同步勾选；
- 验收已覆盖且无需跟进时，comment 后 **关闭** issue，并复核 `state`；
- 评论使用真实换行（`--body-file` 或 `printf`），禁止字面量 `\n` 字符串糊进 `gh`。

项目 tracker 若要求人工 review 后再关，则保持 open 直到项目条件满足。

## 禁止 auto-run / 队列循环

本 skill **不包含、不初始化、不文档化、不执行** 任何自动循环：

- 禁止 auto-run / 持续消费 READY 队列
- 禁止「成功后自动开下一张」
- 禁止生成 `.ralph/` 自动 runner、auto 模板或 `ralph-auto*` Makefile 入口
- 禁止在同一会话内在用户未再次确认的情况下连续处理多张 READY

每张新票都必须重新走：读看板 → 展示 → **用户确认** → 实施。

## 完成输出

结尾包含：

- Selected issue number 与 URL
- 实际改动摘要
- 验证命令与结果
- Commit hash 与标题（或未提交原因）
- Issue comment / close 结果
- 剩余风险或需要的人类动作

## 边界

- 一次只启动和维护一张 GitHub issue
- 不创建或重拆 issues / 不改 native 依赖图
- 不解析 Kanban 人类树文本；只用 `--json` / `--agent` / 本脚本
- 不推荐、不询问其它 implementation skill 清单；确认后默认 `implement`
- 不替代项目 issue-tracker 生命周期约定
- 不包含任何具体应用仓库名或业务协议硬编码
