---
name: yjx-implement
description: 按既定工程原则实施已对齐的设计或 spec，执行基于证据的验证、强制 code review 和项目治理。
disable-model-invocation: true
---

# yjx-implement

把已对齐的设计、specification 或评审共识转为生产代码。在项目架构内用工程原则指导判断，以流水线门禁保证交付质量。

## 维护

评审、演进或修改本 skill 时，先阅读 [`MAINTENANCE.md`](MAINTENANCE.md)；运行时不读取。

## 1. 工程原则

- **Asset Reuse**：搜索并优先复用项目已有库和 wrappers，其次标准库能力；新增外部依赖须先批准。
- **YAGNI**：只实现已确认需求，不为假设性灵活性加代码；新增结构必须由生产责任证明。
- **Information Hiding**：让决策和不变量归属权威 owner；暴露意图而不泄露调用方须复制的内部知识。
- **High Cohesion, Low Coupling**：聚合相关责任并限制变更传播；按所隔离的变化内容划边界，不按数量或架构标签判断。
- **Deep Modules & Production Shape**：结构服从生产责任——仅当间接层隐藏重要知识、拥有不变量、保护已确认 contract、隔离真实变化源或实质降低调用方复杂度/变更传播时才保留；移除它若不影响已确认 contract，视为范围或复杂度风险。仅为了测试便利不构成生产结构理由。
- **Compatibility**：保留既有消费者契约，除非已确认需求授权变更；缩窄共享 contract 前评估编辑范围外的受影响消费者。
- **Cost Model**：沿真实执行路径评估计算、内存与 I/O；优化实际访问、分配与往返成本而不牺牲清晰度，更窄的数据表示或更少跳转不天然更便宜。
- **Minimal Diff**：每项改动都与任务有因果关联（含必要测试与集成），不夹带无关重构或格式化。
- **Readability**：让生产行为对维护者清晰；选择支持可靠测试的 seam，避免遮蔽责任或堆砌无依据复杂度。
- **Intentional Comments**：用命名和结构自解释机制；注释只写非显然约束、理由与 trade-offs。

## 2. 执行流水线

### Phase 1：范围与基线

1. **Project Context**：加载适用项目规则，定位 owner repository / package 及 workspace 配置并在该上下文执行命令。
2. **Contract**：从 spec、ticket 或已同意对话确认行为边界、责任归属与兼容性义务。输入为 tracker 工单编号或链接时，按项目 tracker 解析目标、读取正文与相关决策，并以标题和链接（本地工单用路径）说明对象；无法读取或目标不唯一时先澄清。材料已完整且身份明确时直接开始。区分 `需求`、`事实`、`决策`、`推断`，实施前解决关键歧义。
3. **Lightweight Pre-flight**：确定非交互、有边界的构建与验证命令，避免在 pre-flight 跑耗时全量套件。
4. **Review Baseline**：编辑前记录起始 commit 及已有 staged / unstaged / untracked 变更；保留已有工作并在共编文件内与本任务改动严格区分。
5. **Branch Baseline**：从 `AGENTS.md` 或交付文档读取分支命名规则。有效分支直接沿用；detached checkout 或项目要求 feature branch 时先建合规分支（使用仓库前缀，否则回退 `agent/<agent-id>/<task-slug>`，不假设 `codex/` 通用）。

*Completion Criterion*：需求、执行边界、验证方式及 review / branch 基线全部落定。

### Phase 2：实施

按原则实现需求，为重大语义新增或边界调整明确权威 owner 与现有复用候选；在合适节点运行类型检查与相关单测，不为让中间检查通过而改写后续计划或加临时实现。

变更分类与测试准入遵循 [验证与测试准入门禁](references/verification-gates.md)（唯一规则来源）：
- **仅呈现变更**（按实际效果而非文件后缀判定；阻断交互或混合改动拆分开处理）：记录 `Test admission not triggered` 与范围，走轻量验证。
- **行为变更 / 重构**：先执行 **Test Value Admission** 4 条件（含 `Mock 自证测试` 排除，薄外部桥接不造 test seam）。已准入的行为切片走默认垂直 **red-green**（先在最窄边界令目标测试因缺失行为失败，再补最小生产增量转 green，保留命令/结果/顺序）；已准入 characterization 的重构走 **refactor-green**；无候选通过准入时记录完整 `No new test` 决策。仅项目规则或用户明示可设 `authorized override`（需 `/tdd` 时一并遵守其 seam 规则）。

*Completion Criterion*：目标行为已实现且因果受限；结构新增均具生产责任；已记录对应测试准入/仅呈现路径、兼容性及资源成本评估。

### Phase 3：验证

1. **有界直执行**：在授权工作区内直接执行适用的编译、语法与定向测试（仅小型快测项目跑全量），不把可安全运行的检查退回给用户；呈现变更仍遵守项目必填检查。失败或无法执行时直报具体 `file:line` 或命令、观察报错、已确认原因（或明确未知）及最小可恢复下一步。
2. **证据与完整性**：执行 Phase 2 选定的证据路径（`red-green` / `refactor-green` / `No new test` / `Test admission not triggered` / `authorized override`），详见 [验证与测试准入门禁](references/verification-gates.md)。涉及用户可见 UI 须在目标渲染面实测；涉及破坏性外部状态参数须先在隔离临时域验证并确认父容器与核心数据完整。**禁止**通过削弱、删改或禁用校验伪造绿灯；缺失必需证据且无合法豁免或完整 `No new test` 时，验证门禁失败且任务保持未完成。

*Completion Criterion*：适用检查通过；对应分支的行为/回归或替代检查与限制已记录；测试调整均基于已确认契约变更。

### Phase 4：强制 Code Review

1. **双轴独立评审**：使用 `/code-review` 并行开展 **Standards** 与 **Spec** 两轴独立审查（Start every subagent with a fresh context window (do not fork the current conversation).）。主代理的风险评估不能缩减任一轴。传递本 skill 路径、适用项目标准路径、owner 仓库、Phase 1 基线及覆盖全部待交付改动（committed / staged / unstaged / untracked）的对比命令（`git diff <baseline>`、`git status --porcelain -uall`、`git log <baseline>..HEAD --oneline`），要求子代理自行读取执行，不整篇粘贴文档或 diff。非交付一次性探针/辅助脚本在 Phase 5 前清理，不经由评审交付。
2. **共同决策上下文（Decision Context）**：向两份 Reviewer prompt 传入相同上下文——选定方案与主要成本、被拒分支及理由、剩余假设与风险边界，以及按 [Phase 4 审查材料映射表](references/verification-gates.md#phase-4-审查材料映射表) 格式化的 Phase 2 证据（混合路径分开列明）。已拒绝分支仅因新证据、原拒绝理由矛盾、契约失败或新发现重大风险重开；`No new test` 只按实际证据与限制评判，不因缺新测试文件判缺陷。
3. **缺陷判定与闭环**：正确性缺陷、回归、未满足需求、违背显式规则或有实质维护/资源后果的问题列为 blocking；纯风格偏好、无实质依据的架构标签、或仅呈现路径中无实质违约的微小视觉差异不判阻塞。修复所有已证实阻塞项并重跑受影响验证后，须取得**独立复审**；任一轴未能执行或争议阻塞未解时，如实报告阻塞并保持任务未完成。

*Completion Criterion*：全部最终改动通过双轴独立评审且阻塞项清零；自检或报告不能替代独立评审。

### Phase 5：治理与交付

1. **本地提交与分支规范**：评审通过后复核项目规则与基线。默认授权在合规分支执行原子 Conventional Commits（`feat(scope): <summary>`），按仓库拆分并仅暂存任务改动，附带项目规范 ticket ID；若项目要求提交前人工审查或用户明示不提交，则保留工作区状态并生成交接报告。若改动落在 detached checkout，先建合规分支保留完整起始 diff 再提交。
2. **远程交付与停止边界**：除项目规则或用户明确收窄外，默认授权完成远程闭环（推送分支、创建/更新 PR、解决冲突、等待检查、合入目标分支并从平台核验最终合并状态）；禁止在必需人工审批前启用自动合并或手动合并。

   | 明示边界 | 允许完成至 | 明确停止于 |
   | --- | --- | --- |
   | 提交前需人工审查 | 验证与 `/code-review` 通过 | 本地 `git commit` 前 |
   | 推送前止步 | 合规本地提交 | `git push` 前 |
   | PR 前止步 | 提交并推送分支 | 创建 PR 前 |
   | 合并前止步 | 提交、推送并建/更 PR | 合并 PR 前 |
   | 无额外限制（默认） | 全部交付闭环 | 验证 PR 已合入目标分支后 |

3. **交付报告规范**：报告**首行**直接给出“已完成的可观察功能 + 可立即运行的验证命令/入口 + 当前交付终态”（或受限停止边界与待办动作），随后列出评审结果、验证证据、建议提交信息与 ticket ID；省略按时间顺序的过程流水账与首尾客套。受权限、冲突、检查失败或基础设施阻塞时保持未完成，保留可恢复状态并直报具体位置/命令、报错、确认或未知原因及最小下一步。

*Completion Criterion*：评审通过，任务临时文件已清理且不扰动原有工作，合规本地提交与（默认或边界内）远程状态均已核验。
