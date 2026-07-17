---
name: yjx-local-ralph
description: 为 Matt Local Markdown tracker 手动选择并启动一张合法、无阻塞的 implementation issue；开始前确认，完成单票后停止，不自动循环。
argument-hint: "<feature 目录>"
---

# Local Ralph

`yjx-local-ralph` 是 Local Markdown tracker 的 **manual single-issue** 调度入口。它从当前 frontier 推荐一张票，等待用户确认，然后只处理该票；不连续循环，不创建或重拆执行图。

## 依赖与前提

必须同时安装：

```text
yjx-local-kanban
yjx-local-ralph
```

项目必须已经运行 `yjx-local-tracker-setup`，并存在最终 planning 工件：

```text
.scratch/<feature-slug>/PRD.md
.scratch/<feature-slug>/issues/*.md
docs/agents/local-tracker.json
```

如果 PRD 或 issues 缺失，停止并要求回到项目 planning 流程、`to-spec` 或 `to-tickets`；不要自行补写合同或拆票。

## 可移植脚本

候选选择脚本位于本 skill 目录：

```text
scripts/select-issue.mjs
```

根据当前 Agent 提供的 skill 加载信息定位本 `SKILL.md`，再从其所在目录解析脚本；不要假设 skill 安装在 `.claude`、`.agents`、`.codex` 或固定全局目录。

脚本通过相邻安装的 `yjx-local-kanban` 模块读取完整图，不复制 parser。两个技能必须安装到同一 skills 根目录下；缺少依赖时停止并提示安装。脚本只依赖 Node.js 20+ 标准库，不调用 Claude API、Claude Agent SDK 或 Claude Code 专有 API。

下文用 `<ralph-skill-dir>` 表示本 `SKILL.md` 所在目录。

## 首屏流程

开始 implementation 前必须：

1. 确认 feature 目录；
2. 完整读取该 feature 的 PRD；
3. 使用本 skill 的非交互脚本读取候选；
4. 报告 Kanban warnings；
5. 列出全部合法候选；
6. 推荐编号最小的一张，并说明推荐只来自稳定编号顺序，不是语义优先级猜测；
7. 提示用户可以为当前 issue 指定 implementation skill；
8. 请求用户确认是否处理推荐票或指定另一张合法候选。

缺少任一项时不得开始实施。确认前不修改 issue，不读取大范围实现代码。

候选命令：

```bash
node <ralph-skill-dir>/scripts/select-issue.mjs \
  --json \
  .scratch/<feature-slug>
```

需要时加 `--project-root <path>`。

## 候选合同

脚本直接从 Kanban JSON 筛选：

```text
closed == false
&& statusRole == "ready-for-agent"
&& metadataValid == true
&& blockedByOpen 为空
&& blockedByMissing 为空
&& blockedByInvalid 为空
&& dependencyCycle 为空
```

多个候选按数字编号升序，再按文件名稳定排序。默认推荐第一张。不要根据标题、工作量、代码位置、最近提交或模型判断重排；用户可以显式选择其他合法候选。

若没有候选，停止并说明事实：可能是全部关闭、存在开放依赖、等待人类/信息、或受 warning 冻结。不要绕过 Kanban 或手动猜测可执行票。

## 用户确认后

只处理选定 issue：

1. 完整读取 issue；
2. 读取 issue 声明的 `Required context`、稳定合同和项目 tracker 文档要求的上下文；
3. 若 issue 声明 `Implementation skill: /<name>`，先调用该 skill；
4. 未声明时使用 Matt `/implement`；
5. 保持单 issue 范围，不顺手处理其他候选或改依赖图；
6. 根据实际实现范围读取代码、测试和项目约束；
7. 完成实施与验证后，按项目 tracker 文档和 implementation skill 维护当前 issue 的 Status、Closed 与 Comments；
8. 完成单票后停止，不继续下一张。

项目 implementation skill 的规则优先于本技能的默认生命周期，但不能违反 tracker 的机器真源：只有 `Closed: true` 才解除下游依赖。

## 默认生命周期

当 issue 没有声明 implementation skill，且项目 tracker 文档也没有更具体规则时，采用 Matt 默认路径：

1. 调用 `/implement` 完成实现、验证及其要求的 review/commit 流程；
2. 成功完成后把当前 issue 的 `Closed` 改为 `true`；
3. `Status` 可以保持原项目值，不创建 `after-implement`、`done` 等新状态；
4. 在 `## Comments` 追加必要的完成证据，不能覆盖历史；
5. 如果实现或验证未成功，不关闭。

若项目文档规定实现后先等待人工 review、授权提交或其它阶段，则严格按项目规则保持 `Closed: false`，直到项目规定的真正关闭条件满足。

## 合同缺口与失败

- 无法由 issue、PRD、项目文档和代码事实唯一决定的实施合同，按项目 tracker 规则处理；若没有规则，停止并向用户询问，不自行扩大合同。
- implementation skill、测试或提交失败时如实报告，不把 issue 标为完成。
- 不根据 acceptance checklist、commit 历史或 `ready-for-human` 猜测关闭状态。
- 只允许修改当前 issue 的生命周期记录；需要重拆、改 blocker 或修改其他 issue 时回到 planning。

## 完成输出

结尾包含：

- 当前 issue 路径；
- 实际改动；
- touched git roots；
- 验证命令与结果；
- 当前 Status 与 Closed；
- 剩余 blocker 或需要的人类动作；
- 若下一步明确是提交且项目要求人工授权，给出建议 commit message，但不自行提交。

## 边界

- 一次只启动和维护一张 issue；
- 不创建或重拆 issues；
- 不重写 PRD；
- 不解析 Kanban 人类文本；
- 不连续启动其他候选；
- 不自动提交，除非用户或项目 implementation skill 已明确授权；
- 不包含任何具体项目、仓库名、业务协议号或专用生命周期硬编码。
