## 沟通与交付

- 使用中文沟通。回复首句直接给出结论、已完成结果或下一步动作，用直接动词陈述事实、边界与行动，回答完毕即停。
- 权限内可安全执行的查询、修改与验证由 Agent 直接完成闭环；受阻或报错时直报具体位置、已观察到的错误、已确认（或标明未知）的原因及最小下一步动作。
- 需要用户选择时，直接在回复正文用从 `1` 开始的数字列表给出选项（不调用提问工具）：将推荐项置为 `1` 并说明推荐理由，其余选项说明适用条件与当前不采纳理由。
- 调用了 Skill 时，在回复中列出所使用的 Skill 名称。
- Git 提交信息使用 `<type>(<scope>): <中文摘要>` 格式。

## 工具与技能选择

- 浏览器测试优先使用宿主内置浏览器。
- Notion 页面、数据库与工作区操作默认使用已安装的 Notion MCP/插件；仅当 MCP/插件不可用或无对应能力时，先说明原因并确认目标页面与写入范围后再操作 Notion 桌面应用，打开链接或检查页面时保持既有页面结构（不新建空白页面）。
- 当 `writing-for-agents` 与 `skill-creator` 同时可用时，仅加载并使用 `writing-for-agents`。

## Subagent Orchestration

Delegate to conserve primary context and cost, and obtain independent scrutiny.
Exploration benefits from delegation when most intermediate material can be
discarded after synthesis and the benefit justifies coordination cost.

- **Ownership.** The primary frames the problem, synthesizes the design,
  makes final decisions, and performs all project implementation edits.
  Subagents investigate bounded questions, compare alternatives, gather
  evidence, and provide independent scrutiny.
- **Dispatch.** Default to the host's native subagent tool (such as `spawn_agent`
  via `multi_agent_v1`, `Agent`, or `task`, loading its tool group first when
  deferred); use external delegation tools only when host routing rules require
  them. When the native tool is unavailable or fails, handle ordinary work in
  the primary agent and report a concrete blocker whenever independent scrutiny
  or a specific delegation mode is required.
- **Early delegation.** Delegate substantial exploration before broad reading.
  Prefer delegation when deciding who should perform evidence-heavy work.
  Handle small targeted lookups and tight editing-and-verification loops
  directly. Before implementing, inspect decisive sources and verify critical
  claims. Repeat broad exploration only when evidence gaps or conflicts
  warrant it.
- **Useful separation.** Each child needs a distinct question or independently
  useful result. Parallelize independent objectives; serialize dependencies
  and conflicting operations. Shared read-only evidence is acceptable.
  Combine duplicate investigations and reuse established results.
  Default to one delegation level.
- **Bounded work.** Start every subagent with a fresh context window (do not
  fork the current conversation). Pass the explicit isolation setting when the
  tool schema exposes one (`fork_context: false` or `fork_turns: "none"`), and
  keep read-only investigation, independent review, and option comparison
  isolated; for other tasks, pass the smallest positive `fork_turns` only when
  they depend on recent decisions, or full history (`fork_context: true` or
  `fork_turns: "all"`) only when irreplaceable and justified. State the goal,
  scope, available capabilities, allowed side effects, and completion
  conditions. Return once the question is answered; cancel work that can no
  longer affect the task. Return conclusions, key evidence locations, and
  actual blockers. Use available, authorized equivalents when they establish
  the same evidence; otherwise return supported partial findings and the
  blocker for primary reassessment. Escalate scope or access expansion to the
  primary. Temporary verification artifacts require explicit scope, isolation,
  and cleanup responsibility.
- **Independent scrutiny.** Review substantive design choices, consequential
  assumptions, and material impact risks. Assess reversibility by actual
  effects; investigate unclear impact or recovery through read-only work
  or isolated tests. Review costly-to-reverse actions before execution and
  broad-impact changes before activation; otherwise review the settled
  proposal or verified implementation before delivery. Match review scope
  and verification depth to concrete risks. Small changes with clear outcomes,
  known local impact, easy recovery, and direct verification need only
  primary verification.
- **Review closure.** The initial reviewer must be independent of proposal
  formation. Supply original goals, constraints, and evidence. Findings require
  concrete evidence and impact; no findings is valid. The primary resolves
  findings with evidence and verifies the actual implementation. Resume the
  same reviewer for warranted, targeted follow-up. Independently review any
  material choices or risks introduced beyond previously reviewed scope.
