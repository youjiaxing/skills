---
name: yjx-codex-cu
description: 将真实 GUI 检查委托给 Codex CLI Computer Use。
argument-hint: "[--model <id>] [--reasoning <effort>] [--fast on|off]"
disable-model-invocation: true
---

# Codex Computer Use 委托

## 维护

在评审、修改或重新设计本 skill 前，先阅读 [MAINTENANCE.md](MAINTENANCE.md)。正常执行时不需要读取它。

## 使用边界

本 skill 只在用户为当前任务调用时生效。加载 skill 不会自动开始测试，任务结束后其作用域失效。

实现与修复仍由当前 Agent 完成。Codex 只负责 GUI 测试：可以准备、构建、启动应用，操作界面并报告证据，但不得修改产品代码。

## 工作流

1. 先完成实现，并完成无需委托 GUI 控制即可进行的所有有意义验证。
2. 判断剩余结论是否必须通过真实 GUI 交互验证。若当前 Agent 能直接完成等价的真实 GUI 验证，就直接完成；若不存在 GUI 缺口，则不要启动 Codex。
3. 编写一份面向结果的测试简报，包含：
   - 要验证的用户可见行为；
   - 理解该行为所需的最少实现背景；
   - 要构建和启动的确切产物，以及能识别该构建的标识。调试构建和已安装的发布构建通常使用相同产品名，仅靠名称无法区分；
   - 所需的应用、设备、账号或平台边界；
   - 预期结果和有用的失败证据。
4. 保持简报灵活。由 Codex 自行决定如何准备、构建、启动、导航和从普通 UI 误操作中恢复；不要把简报写成逐点击脚本。
5. 相对于本 `SKILL.md` 解析 `scripts/run-codex-cu.mjs`，不要假设固定的全局 skill 目录。把简报通过标准输入传入，并从被测项目运行脚本。只有显式指定模型、reasoning 或 Fast 时才传入相应参数。
6. 将 runner 视为一个长任务，等待其终端结果，不要把一次 GUI 测试拆到多个 Codex 会话。
7. 读取 runner 的 JSON 摘要。只有摘要报告 `PASS` 且包含 Computer Use 证据时，GUI 结论才算已验证。出现 `FAIL` 后继续由当前 Agent 实现或修复；出现 `BLOCKED` 后说明环境阻塞。
8. 修复后若需要再次 GUI 检查，重新启动一份完整测试简报，不要逐步恢复测试员状态。

## Runner 接口

```text
Usage: node run-codex-cu.mjs [options]

完整 GUI 测试简报从标准输入读取。
```

使用 `node <skill-dir>/scripts/run-codex-cu.mjs --help` 查看当前选项和默认值。runner 负责 model/Fast 策略、Codex CLI 参数、临时事件存储和证据解析。

## 委托边界

runner 会在每份简报前加入固定通知，用于限定委托会话范围而不是削弱能力：通知会说明测试员负责准备、构建、启动、操作界面和报告证据，不负责产品代码、配置或修复；会把本 skill（`yjx-codex-cu`）及其 runner 列为不可调用对象，并禁止再委托给嵌套 Codex 会话、子代理或 Computer Use harness。其它 skill 仍可用，只有本 skill 被排除。

测试员读取宿主 skills 后可能再次学习如何委托 GUI 控制，也可能去查找调用 Agent 的进程、日志或会话记录，转而进行元调查。通知明确点名本 skill 并声明职责边界，就是为了阻止这两类偏移。

通知还要求确认构建身份：必须连接任务描述的副本，不能连接同产品的已安装或已运行副本；如果无法区分，报告 `BLOCKED`。同一产品的调试构建和已安装发布构建可能同名，没有构建标识的简报会让测试员误测并给出看似确定的错误结果。

## 最终报告

当前 Agent 的回复必须包含：

- `PASS`、`FAIL` 或 `BLOCKED`；
- Codex session ID，以及可复制的 `codex resume <session-id>` 命令；
- 请求的和实际记录的 model/reasoning 值；
- Fast 是请求启用、禁用，还是已独立确认；
- Codex 实际执行的 GUI 路径；
- 相关结果、失败或阻塞详情；
- 仍由当前 Agent 负责的实现或修复。

缺失证据必须如实写明。请求 Fast 并不证明服务实际启用了 Fast。
