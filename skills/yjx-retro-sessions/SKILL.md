---
name: yjx-retro-sessions
description: 按需基于本地多条历史会话（T3 Code、Codex CLI、Claude Code CLI）与存量规则体检挖掘共性瓶颈，沉淀或精简 Skill、提示词与确定性自动化护栏。仅在用户显式要求回顾多条历史会话、跨会话找重复工作流或对规则库做静态健康体检时调用。
disable-model-invocation: true
---

# yjx-retro-sessions

由用户手动触发，负责**按需跨本地多会话历史挖掘能力提升机会**及**0-token 规则库静态健康体检**，不设任何后台定时任务或常驻观察进程（单次任务深挖由 `yjx-retro` 负责）。默认只调查、聚类并交付待确认建议，未获明确授权不修改业务文件、Skill、配置或脚本。

若需要共享台账或单会话原文定位提取能力，通过宿主技能发现机制按注册名定位 `yjx-retro` 并解析其安装路径下的脚本（不得硬编码跨包相对路径或机器专有路径）；若 `yjx-retro` 当前未安装，如实说明可选依赖缺失并降级为无持久化台账的只读挖掘。

## 0. 确定性预扫与额度保护（先压后看，严禁通读全库）

禁止直接用模型遍历或读取大体积会话日志。必须先运行本 Skill 内置的 0-token 本地脚本完成去重、过滤、打分与聚类压缩：

```bash
node "<this-skill-dir>/scripts/mine-sessions.mjs" --days 14 --sources t3,codex,claude --top 10 --format md
```

常用范围参数：`--days <N>` / `--since <ISO>` / `--until <ISO>`、`--cwd <项目目录>`（限定当前项目时优先传入）、`--sources t3,codex,claude`、`--top <K>`。脚本内置硬约束：
- **跨源去重**：自动提取 T3 `statev2.sqlite` 中的 `nativeThreadRef.nativeId` 与导入记录，同时在 T3 与 Codex/Claude CLI 存在的会话仅保留 T3 侧，绝不重复扫描；
- **噪声剥离与脱敏**：自动过滤子代理线程、定时空跑、纯自复盘会话，并对输出摘要做凭据脱敏；
- **窄窗口防误删门禁**：`disuseEvidence.sufficient` 为 `false`（如限定了 `--cwd`、有效会话 `< 20` 或跨度 `< 7` 天）时，脚本输出显式禁删标记，**严禁依据零命中提议删除或停用任何 Skill / MCP / 插件**。

若安装了 `yjx-retro`，同步查询同作用域台账基线：

```bash
node "<yjx-retro-dir>/scripts/retro-ledger.mjs" query --cwd "<workspace>" --format md
```

先向用户简短汇报预扫覆盖范围（时间窗、各源保留条数、T3 去重数、高频报错与重复指令聚类、待查 Top K 高摩擦会话以及台账内已达晋升门槛的候选/需 Follow-through 的历史改动）；若待深挖范围超出默认 Top 10 或需拆批处理，先确认窗口后再继续，避免盲目消耗额度。

## 1. 高摩擦切片深挖与可选规则体检

1. **小批量定焦深挖**：优先由主代理直接审阅预扫压缩摘要与 Top K 候选列表；仅对其中确实值得深究的高摩擦会话，通过已定位的 `yjx-retro` 脚本 `extract-session-evidence.mjs` 提取单会话精简索引或 `--item-id` 精准回查关键片段。仅在用户明确授权扩大到大量会话并发拆读时，才委派上下文隔离的只读子代理分段提取（Start every subagent with a fresh context window (do not fork the current conversation).），且子代理只返回带定位的精简证据包。
2. **前次建议落地回查（Follow-through）**：对照台账 `followThrough` 中最近 `applied` 记录，结合本次跨会话窗口核实规则是否仍在且是否抑制了同类报错/纠错；若已写入规则仍跨会话复发，升级为“精简重写或下沉为确定性护栏”的强证据。
3. **存量规则 0-token 静态体检（按需运行）**：用户要求顺带给规则/Skill 库做健康体检，或本次涉及修改现有规则文档时，运行内置静态检查脚本：
   ```bash
   node "<this-skill-dir>/scripts/health-check.mjs" --root "<workspace>" --format md
   ```
   只消费其输出的死链、缺失脚本、frontmatter 异常与体量超限（如规则逼近 24,000 字节上限、Skill 超 500 行）告警，不让模型凭印象猜测整仓健康度。

单会话深挖沿用 `yjx-retro` 的关联范围和双线筛选：在已选切片中同时检查过程改进与知识收获，知识按其 `references/knowledge-capture.md` 核验真源与落点，不写入改进台账正文。该交接不改变本 Skill 的高摩擦预扫、Top K 排序与人工调用边界；未入选的低摩擦会话并未因此得到知识覆盖。

## 2. 跨会话去重、介质分流与最小改进收敛

结合 `writing-for-agents` 标尺整合预扫聚类、高摩擦定位线索、台账 `readyCandidates` 与静态体检结果：

- **过滤已拒绝项**：台账 `rejectedKeys` 中已有的同源建议默认不重复推销，仅在出现跨会话强新证据或用户主动点名重审时才附新证据重提；
- **跨会话归因门槛**：
  - 重复手敲的工作流指令 / 多轮试错绕弯 → 若现有 Skill 可覆盖则尖锐化其触发 `description` 与步骤，否则输出“新 Skill 概要卡片”（跨会话 `>= 2` 且属按需多步场景）；
  - 跨会话高频重复的机械错误 / 漏检步骤 → 优先建议仓库确定性脚本、`package.json` script 或 Git Hook（仅当明确面向 Claude Code 环境且适用时可选 `hookify`/Hook）；
  - 单次偶发或尚未跨会话重复的弱信号 → 不强改正式文档，可建议暂存 `retro-ledger` 候选池；
  - 宽窗口下确认零使用且无 `referenced_by` 引用（且非高危安全底线）的冗余自定义 Skill → 仅作为“请用户确认是否归档/清理”的建议项，不自动删除；
- **体量与精简优先**：向任何现有文档/Skill 提议改动前检查 `health-check` 体量结果，逼近上限时优先建议精简、合并或按作用域拆分到 `references/`，不盲目追加。

## 3. 交付、讨论与台账落盘

交付遵循“直白问题 + 跨会话实证 + 具体拟改文件与内容 + 预期收益/代价”，禁止把内部脚本字段或未实施提案写成已完成。存在方案取舍或新建/拆分决策且用户未要求只出报告时，按宿主技能发现加载 `yjx-grill`（不可用时用其他可用讨论 Skill 或直接对齐）。

用户对每批建议做出采纳、延后或拒绝决定后，若 `yjx-retro` 可用，调用 `retro-ledger.mjs`（`record-decision` / `record-candidate` / `mark-followthrough`）落盘状态；若获授权实施文档/Skill 修改，按 `AGENTS.md` 仅执行静态检查与链接校验（严禁为提示词/Markdown 编写模拟对话行为测试），并在涉及新脚本逻辑时运行对应功能测试。
