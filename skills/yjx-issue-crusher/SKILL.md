---
name: yjx-issue-crusher
description: 按 kanban 对 feature 做 issue 串行接力编排（Chain Run）：经 Tracker 端口读自动候选，spawn 独立前台 Worker，盯 Closed 完成闸门。一期 local-markdown；测试可注入假 Tracker/Launcher。
argument-hint: "<feature-slug>"
disable-model-invocation: true
---

# Issue Crusher（编排器 skill）

`yjx-issue-crusher` 是 **issue 串行接力编排器** 的独立 skill 包。实现与测试在本目录；试点仓（如 `issue-crusher`）只消费本 skill，**不内嵌**编排器源码。

## 现状（ticket 07 骨架）

已具备：

- **Chain Run** 测试缝：可注入假 `TrackerPort` + 假 `WorkerLauncher`
- **local-markdown** Tracker 适配：读 fixture/真实 `.scratch/<feature>/issues`，自动候选与 ralph 合同对齐
- 最小 CLI：`recommend`（只读下一张，不 spawn 真 agent）

尚未具备（后续票）：完整 launch 合同、双条件接力、边沿态、mode、真 Worker 启动、调度 TUI。

## 依赖

- Node.js 20+
- **local-md 适配**软依赖同 skills 根下的 `yjx-local-kanban`（解析看板图；不硬编码安装路径以外的包管理）
- **不**运行时硬依赖 `yjx-local-ralph`；候选过滤在本包 `select-candidates.mjs` 语义对齐

## 测试

在 **skills monorepo 根**或本 skill 目录：

```bash
node --test skills/yjx-issue-crusher/tests/*.test.mjs
# 或在 monorepo 根：
npm test
```

主 seam：**Chain Run**（`tests/chain-run.test.mjs`）。  
local-md fixture 覆盖空 frontier / 唯一 ready / 排除 Wayfinder·closed·blocked（`tests/local-md-tracker.test.mjs`）。

## 最小 CLI

```bash
node <skill-dir>/scripts/cli.mjs recommend \
  --project-root <repo> \
  --feature <feature-slug>
```

输出 JSON：`candidates`、`recommended`。不启动 Grok/Claude。

## 自动候选合同（与 ralph 同向）

```text
closed == false
&& statusRole == "ready-for-agent"
&& metadataValid == true
&& blockedByOpen / Missing / Invalid 皆空
&& dependencyCycle 为空
```

编号升序；Wayfinder（有 `Type:`、无 `statusRole`）**不进**自动候选。

## 边界

- 编排策略只依赖 **Tracker 端口**，不解析人类看板文案
- Worker 为独立前台会话；本包一期不内嵌终端
- 业务完成闸门：普通 impl 认 issue 头 `Closed: true`（读侧）
- 失败或未关票时的整链停、双条件接力等见后续实现票
