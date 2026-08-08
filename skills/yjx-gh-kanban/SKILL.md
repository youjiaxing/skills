---
name: yjx-gh-kanban
description: 只读 GitHub Issues 看板引擎与投影（READY/BLOCKED/SPEC、依赖树、NOW、JSON/agent 契约）；纯函数可 fixture 单测。CLI / gh 拉数与路径发现见后续包装；不改 issue、不选票。
disable-model-invocation: true
---

# yjx-gh-kanban

GitHub Issues 轨的只读看板 skill，与 `yjx-local-kanban` 成对。

## 本阶段范围（board 引擎）

当前交付的是 **可导出的纯函数 board 引擎**，不访问网络、不调用 `gh`：

```text
scripts/board-engine.mjs
```

注入 `issues` + native `relations` + `readyLabel` 后，可得到：

- 机器契约：`classify` → `next` / `ready` / `blocked` / `specs` / …（兼容旧 Python 看板关键字段）
- 人类投影：`renderHuman` → LEGEND、DEPENDENCY TREE、WARNINGS、NOW
- Agent 投影：`renderAgent` → `ready=…`、`next=`、READY 列表
- 作用域：`selectViewNodes`（默认整仓 open + 理解阻塞所需 closed blocker；可选 parent 过滤 + blocker 闭包）

真 `gh` CLI 薄封装、脚本路径发现与可安装包装由后续 ticket 完成。

## 合同要点

- 关系真源：native parent / native `blockedBy`；**不**解析正文 `## Parent` / `## Blocked by`
- READY：open + ready 映射标签 + 无 open blocker + 非 SPEC + 非 wayfinder
- SPEC：正文同时具备 `## Problem Statement` / `## Solution` / `## User Stories`
- 无 parent 的 ready 实施票合法；parent 不是 blocker
- 候选关系缺失或不可靠 → **fail-closed**，不输出可用 `next`
- 依赖树：视觉主挂载优先 native parent；行尾 ` <- #a, #b` 列出完整 blockedBy；每票至多一次
- NOW：可实施 READY + 进行中（assignee 近似，**不**改 READY 契约）

## 单测

```bash
# 在 skills monorepo 根目录
node --test skills/yjx-gh-kanban/tests/board-engine.test.mjs
# 或
npm test
```

## 边界

- 不修改 GitHub issue、label、assignee 或关系
- 不选择或确认下一张实施票（见 `yjx-gh-ralph`）
- 不替代项目 `docs/agents/issue-tracker.md` 中的生命周期约定
