# 来源与维护取舍

维护本 Skill 或比较上游变化时读取。这里保留必要的来源、版本与本地取舍；执行规则以 [SKILL.md](../SKILL.md) 及其参考为准。

## 2026-11-22：知识复盘能力的参考与吸收

以下为本次实际参考的固定版本和相关路径，是机制启发，不代表整包派生或运行时依赖。核查范围限于所列内容，未作上游全仓审计，也不替代本 Skill 更早的来源历史。

- **EveryInc / compound-engineering-plugin**，`58d1a83d9207c96c9fb4934589b8b5967849dfdb`：[refresh/classify.md](https://github.com/EveryInc/compound-engineering-plugin/blob/58d1a83d9207c96c9fb4934589b8b5967849dfdb/skills/ce-compound/references/refresh/classify.md)、[schema.yaml](https://github.com/EveryInc/compound-engineering-plugin/blob/58d1a83d9207c96c9fb4934589b8b5967849dfdb/skills/ce-compound/references/schema.yaml)。吸收“无法核验不等于错误”、描述漂移与仍有效规范的区分，以及条件性重验、知识消费入口的思路；本地承接于 [知识筛选与沉淀](knowledge-capture.md) 的“先查真源再提落点”“复用与重新核验”“修订传播与后续使用”。
- **pskoett 来源谱系**：[pskoett-ai-skills 的 context-maintenance.md](https://github.com/pskoett/pskoett-ai-skills/blob/878b0e48bca74849c6219815882e75e60cfa2b72/skills/self-improvement/references/context-maintenance.md)，固定版本 `878b0e48bca74849c6219815882e75e60cfa2b72`；[self-improving-agent 的 SKILL.md](https://github.com/pskoett/self-improving-agent/blob/e958afb5bf697c7d22898f9bba53406e2e3261bd/self-improving-agent/SKILL.md)，固定版本 `e958afb5bf697c7d22898f9bba53406e2e3261bd`。作为同一谱系处理，不算两份独立验证。吸收按事实、决定、依赖变化重验，区分历史事件解决、当前知识核验与规则更新，以及修订传播；承接于 [知识参考](knowledge-capture.md) 的“复用与重新核验”“修订传播与后续使用”。
- **makenotion / claude-code-notion-plugin**，`016c74ffc568920a385186fb9d2d9d2801e0be09`：[knowledge-capture/SKILL.md](https://github.com/makenotion/claude-code-notion-plugin/blob/016c74ffc568920a385186fb9d2d9d2801e0be09/skills/notion/knowledge-capture/SKILL.md)。吸收冲突不静默覆盖、保留必要旧理由的处理方式；承接于 [知识参考](knowledge-capture.md) 的冲突与替代处理。OpenAI 收录版本按同源处理；本地不依赖 Notion 存储。
- **softaworks / agent-toolkit**，`3027f20f3181758385a1bb8c022d4041dfb4de84`：[lesson-learned/SKILL.md](https://github.com/softaworks/agent-toolkit/blob/3027f20f3181758385a1bb8c022d4041dfb4de84/skills/lesson-learned/SKILL.md)。吸收从实际差异与提交理由提炼正向经验的方法；承接于 [知识参考](knowledge-capture.md) 的“判断是否值得留下”。本地先核任务关联，不采用默认最近若干提交来代替任务范围。
- **open-gsd / gsd-core**，`3087de34ddccc5b2e32008bab9fc0a937fb6e724`：[extract-learnings.md](https://github.com/open-gsd/gsd-core/blob/3087de34ddccc5b2e32008bab9fc0a937fb6e724/gsd-core/workflows/extract-learnings.md)。吸收意外发现及来源归因；承接于 [知识参考](knowledge-capture.md) 的认识、证据与预期差异检查。本地复用已有真源，不要求新建统一 `LEARNINGS.md`。

相关规则已在本地提交 `dc967cf`、`5eba1c2` 中实施；本记录补充来源与取舍。静态核查只证明正文与引用可检查，未来实际使用效果仍需真实任务证据。

## 保留的本地边界

- **按需检查**：不引入后台观察、定时全库重验或统一知识 TTL；变化信号与本次任务决定核验范围。
- **按证据判断**：不引入主观 confidence 分数；一次可靠核验可支持有边界的知识，过程改进弱候选的重复门槛不套用于知识。
- **沿用既有体系**：不自动创建 Skill、知识库或全局提示词；先核已有真源与使用入口，写入沿用本次授权。
- **职责分开**：知识正文不进 `retro-ledger`，其 schema、TTL 与计数职责保持不变。

后续比较从上述固定版本与路径开始，分别记录已评估范围和实际吸收结果。来源迁移、规则变化或出现反证时重新核对相关取舍；本记录不表示持续跟踪了上游最新版本。
