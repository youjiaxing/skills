---
name: yjx-implement
description: 按既定工程原则实施已对齐的设计或 spec，执行基于证据的验证、强制 code review 和项目治理。
disable-model-invocation: true
---

# yjx-implement

把已对齐的设计、specification 或评审共识转为生产代码。在项目架构内使用以下原则指导工程判断；执行流水线定义交付门禁。

## 维护

评审、演进或修改本 skill 时，先阅读 [`MAINTENANCE.md`](MAINTENANCE.md)。运行时不需要读取它。

## 1. 工程原则

- **Asset Reuse**：搜索并优先使用项目已有库和 wrappers，其次使用符合习惯的标准库能力。新增外部依赖需要批准。
- **YAGNI**：实现已确认的需求，而不是假设性的灵活性。新增内容必须由其支持的行为或责任说明理由。
- **Information Hiding**：让决策和不变量归属于权威 owner；暴露意图，但不要泄露调用方必须复制的内部知识。
- **High Cohesion, Low Coupling**：聚合相关责任并限制变更传播。按边界隔离的内容判断边界，不按实现数量或架构标签判断。
- **Deep Modules & Production Shape**：让生产责任决定结构。只有间接层承担生产责任时才添加或保留它，例如隐藏重要知识、拥有不变量、保护已确认 contract、隔离真实变化源，或实质降低调用方复杂度/变更传播。仅为测试方便不足以证明生产结构合理。
- **Compatibility**：除非已确认 requirements 授权变更，否则保留现有消费者保证。缩窄共享 contract 前，评估编辑范围之外的受影响消费者。
- **Cost Model**：沿真实执行路径评估计算、内存和 I/O。优化实际成本而不牺牲清晰度；更窄的表示或更少跳转不天然更便宜。
- **Minimal Diff**：每个变更都必须与任务存在因果关系，包括必要测试和集成变更。不要做无关重构或格式化。
- **Readability**：让生产行为对维护者清晰。选择支持可靠测试的验证 seam，不要遮蔽责任或引入无依据复杂度。
- **Intentional Comments**：用命名和结构解释机制；注释只用于非显然约束、理由和 trade-offs。

## 2. 执行流水线

### Phase 1：范围与基线
1. **Project Context**：加载适用的项目规则，定位 owner repository 或 package 及其 workspace 配置，并在该上下文中运行命令。
2. **Contract**：从 spec、ticket 或已同意对话中确定已确认行为、受影响责任和兼容性义务。保留 `需求`、`事实`、`决策`、`推断` 的区分；实施前解决有后果的歧义。
3. **Lightweight Pre-flight**：识别有边界、非交互的构建和验证命令；不要在 pre-flight 中运行长时间套件。
4. **Review Baseline**：编辑前记录起始 commit，以及已有 staged、unstaged 和 untracked 变更。保留已有工作，并区分它们与本任务变更，即使共享文件也一样。
5. **Branch Baseline**：从 `AGENTS.md` 或关联交付文档读取仓库分支命名规则。当前分支有效时保留；checkout detached 或项目要求 feature branch 时，在编辑前创建要求的分支。不要假设 `codex/` 通用：使用仓库前缀，否则回退到 `agent/<agent-id>/<task-slug>`。远程操作遵守分支保护；本地 commit 授权由本 skill、项目规则和用户指令共同决定。
*Completion Criterion*: Requirements and execution boundaries established; verification approach identified; review and branch baselines recorded.

### Phase 2：实施
#### 仅呈现变更
按实际影响分类变更，不要按是否编辑 CSS、DOM 或 frontend 文件分类。纯粹影响字体、颜色、间距、装饰和非功能布局的视觉变更，使用轻量呈现验证。记录 `Test admission not triggered` 及变更范围；该路径既不要求 red-green 或 refactor-green 证据，也不要求枚举候选测试或完整的 `No new test` 说明。

新增冻结呈现细节的自动断言（如计算样式、精确尺寸或位置、像素或截图快照），必须有用户明确指令，或适用项目规则明确要求这类自动检查。视觉需求、设计参考、品牌规范、已有视觉测试或 “stable contract” 标签本身都不授权这些断言，也不会强制走 test-first 证据路径。按 Phase 3 的 Behavior Preservation 和 Evidence Integrity 规则维护过时的视觉预期；这类维护本身不会使行为切片进入准入。明确要求呈现自动化会移除默认排除，但不能绕过下方 Test Value Admission。如果必需检查无法通过准入，报告冲突并保持验证门禁未完成，等待澄清；不要静默替换为浏览器检查。

业务结果、交互状态、权限、键盘操作和无障碍语义仍受行为测试准入约束。即使只编辑 CSS，只要布局变更实际阻止点击、键盘使用或焦点操作，就属于功能变更。验证受影响的用户结果，不要冻结视觉机制；无障碍或布局标签本身不授权呈现细节断言。分别处理混合的呈现与行为变更，保留每个已准入行为切片所需的证据。

#### 行为测试准入
对于属于行为准入或用户明确要求的呈现自动化，创建测试文件、扩展自动测试、实质修改测试/断言，或选择现有测试作为变更前证据之前，先做 **Test Value Admission** 决策。只有四个条件全部满足时，才准入测试候选：

1. **Pre-change Signal**：对于新行为、变更行为或 defect，测试必须因该行为缺失或错误而在变更前实现上失败。行为保持型重构的 characterization test 可以在变更前通过，但应会在合理的行为回归下失败。
2. **Stable Observation**：通过合适边界断言外部有意义的业务结果或稳定 contract，同时受上方仅呈现变更排除规则约束。
3. **Independent Discrimination**：预期结果来自 requirement 或其它独立 oracle，并能拒绝一种合理但错误的实现。
4. **Maintenance Return**：回归保护的价值足以抵偿 fixture、设置、运行和未来更新成本。

不满足任一条件的候选不得进入 diff。通过准入的现有测试即使不修改测试文件，也属于已准入候选，必须参与 red-green 或 refactor-green 证据路径。对于受行为准入约束的工作，只有没有任何新建、修改或现有候选通过准入时，`No new test` 才有效；在相关业务实现前记录该决策、被拒候选或理由、已有覆盖、替代性定向验证和评审/交付限制。该决策改变证据收集方式，但不会豁免验证。

对于已准入的新行为、变更行为或 defect 测试，默认使用垂直 red-green 切片：

    1. 在最窄的适当边界上，为已有或新建立的可执行 contract 定义一个行为切片。
    2. 在添加相关业务行为前运行测试，确认出现针对目标的失败。
    3. 只添加该切片所需的生产增量，然后运行同一测试使其变为 green。
    4. 在开始下一个切片前，为 Phase 4 reviewers 记录 red 命令及结果、green 命令及结果和执行顺序。

The red failure must reach the missing or incorrect business behavior. A compile failure caused by an invented API shape, an environment/setup failure, an unrelated panic, or another failure unrelated to the target contract is not a red signal. An early return is not disqualifying by itself when it is the target defect; it is invalid only when it prevents observing the target contract without being caused by that defect. When a new contract is required, a test may be preceded only by the minimum declarations or explicit unimplemented placeholder needed to run it; that preparation must not implement the behavior under test. “Minimal” limits the behavior slice, not the production-quality, ownership, compatibility, or resource-cost requirements.

For behavior-preserving refactors subject to test admission, an admitted characterization candidate starts from green coverage and proceeds through refactor-green checks; it does not require manufacturing a red test. Record the pre-refactor green command and result and the post-refactor green command and result. If no characterization candidate passes admission, use a complete `No new test` decision with substitute verification and disclosed limits rather than manufacturing a low-value test. Documentation, configuration, and other changes without a stable business behavior use the most relevant substitute verification. Only a project rule or an explicit user direction to use a different test order or waive the default red-green order may create an override; record the exact source, scope, and verification consequences, and do not treat ordinary implementation authorization as an override. A user direction cannot waive a higher-priority project rule. If a project rule or explicit user direction requires TDD or test-first development, follow `/tdd` as well, including its seam-confirmation rules; the bounded default loop does not replace that requirement.

An admitted behavior slice may proceed to delivery only through one of these paths: complete red-green evidence; a recorded `authorized override` with its source, scope, and substitute verification; or a complete `No new test` decision where no candidate passed admission. A behavior-preserving refactor subject to test admission uses the recorded pre- and post-refactor green evidence when a characterization candidate passed admission, or the complete `No new test` path otherwise. Required red-green or refactor-green evidence missing without an authorized override or complete `No new test` decision keeps the task incomplete.

Apply the engineering principles to the task's actual dependencies and constraints. For each material semantic addition or moved boundary, identify its authoritative owner and existing reuse candidate. Add structure only when it has a production responsibility; if removing it leaves the confirmed contract unchanged, treat it as scope or complexity risk. Reuse existing assets, implement the confirmed behavior, and examine the diff for unnecessary complexity and scope expansion without creating a separate checklist.
*Completion Criterion*: Required behavior implemented; changes causally bounded; material additions have an owner and justified production responsibility; every new indirection remains useful without its tests; the applicable behavioral test decision or presentation-only scope is recorded; relevant compatibility and resource-cost implications assessed.

### Phase 3：验证
1. **Bounded Verification**: Run applicable compile or syntax checks first, then targeted tests for the changed behavior and affected consumers. Bound execution to relevant packages or suites in medium/large workspaces; reserve full-suite runs for small projects with known short runtimes. Presentation-only changes do not themselves require a full suite; retain checks explicitly required by applicable project rules. Use non-interactive commands.
2. **Behavioral Evidence**: Test observable contracts with realistic collaborators where practical. Choose isolation based on reliability and the boundary under test, rather than prescribing a mocking mechanism. Cover critical normal, boundary, and error paths; derive expected results from requirements or independently established examples, not the implementation under test.
3. **Regression Protection**: Execute the applicable Phase 2 evidence path. For admitted red-green slices, preserve the target-specific pre-implementation failure and post-implementation success, including the commands, results, and order supplied to review. For admitted bug-fix tests, the pre-change failure is also regression evidence, but a later back-test against the old implementation cannot replace the evidence that the test preceded the related behavior implementation. For a `No new test` decision, run the recorded existing and substitute checks and report their limits. For presentation-only changes, use applicable static checks and browser inspection where needed, proportional to the affected surface; prefer the Codex built-in browser when available. Record the inspected pages, states or viewports, results, and remaining limits. Screenshots may assist inspection without becoming persistent regression baselines or requiring pixel equality. Browser inspection does not replace required evidence for an admitted behavior test.
4. **Behavior Preservation**: Refactors retain existing behavior and effective coverage while allowing tests to be reorganized. For refactors subject to test admission, record and review the pre- and post-refactor green evidence when a characterization candidate passed admission; otherwise execute the complete `No new test` decision and its substitute verification. Presentation-only refactors retain their lightweight path. Confirmed requirement changes may justify updating or removing obsolete assertions; explain that basis and verify the new contract and still-valid boundaries. No itemized scenario ledger is required.
5. **Evidence Integrity**: Weakening, deleting, or disabling checks merely to make failures pass is prohibited. For existing visual-test failures, distinguish an obsolete appearance expectation authorized by confirmed requirement changes from a genuine behavioral regression; apply Behavior Preservation above before updating or retiring assertions. For changes unsuitable for automated tests, perform relevant alternative checks and disclose their evidence and remaining verification limits, including checks that could not execute. If an admitted behavior slice lacks required red-green or refactor-green evidence without an authorized override or complete `No new test` decision, the verification gate fails and the task remains incomplete.
*Completion Criterion*: Applicable checks pass; behavior and regression evidence or justified alternative checks recorded; test changes have a confirmed contract basis; verification limits disclosed.

### Phase 4：强制 Code Review
1. **Independent Review**: Use `/code-review` for parallel independent Standards and Spec reviews of the complete task changes. Both axes are required for every implementation; primary-agent risk classification cannot reduce either axis. Give `/code-review` the exact paths to this skill and the applicable project standards, and require its sub-agents to read them before review; do not paste full document contents. Review correctness and regression risks against those standards, the originating requirements, and any independently reviewed alignment contract.
2. **Decision Context**: Add the same decision context directly to both Reviewer prompts: the selected approach and material costs, rejected branches with reasons, remaining assumptions and risk boundaries, and the applicable Phase 2 evidence path. For each admitted red-green slice, include the locatable commands, target-specific red and green results, and execution order. For each behavior-preserving refactor with an admitted characterization candidate, include the pre- and post-refactor green commands and results. For the `No new test` path, include its complete decision, substitute verification, and limits. For presentation-only changes, include the `Test admission not triggered` scope and lightweight verification results and limits; do not demand a complete `No new test` justification. Keep these paths separate for mixed changes. If project rules or explicit user direction authorized an override, label it as an `authorized override` and include its source, scope, and substitute verification; if required evidence is merely missing, treat the verification gate as failed rather than as a disclosure-only gap. A rejected branch reopens only for new evidence, a contradiction in its rejection rationale, contract failure, or a previously omitted major risk. A `No new test` decision is assessed from its evidence and limits, never from the absence of a new test file alone.
3. **Complete Review Scope**: Give `/code-review` the owning repository, Phase 1 baseline, and commands such as `git diff <baseline>`, `git status --porcelain -uall`, and `git log <baseline>..HEAD --oneline`; require its sub-agents to execute them and read any new files. Use these references instead of pasting the full diff; confirm they cover every task-changed file, whether committed, staged, unstaged, or untracked. Distinguish pre-existing work from task changes without omitting surrounding context needed to assess correctness.
4. **Finding Classification**: Correctness defects, regressions, unmet requirements, and violations of explicit project rules or delivery gates are blocking. Architecture-based blockers must explain concrete correctness, compatibility, maintainability, or resource-cost consequences using the actual changes and constraints. Deviation from a preferred design form or style alone is not blocking. Neither absent style tests nor minor visual differences alone justify a blocker; identify a confirmed requirement or explicit rule violation, or a reproducible actual user impact, rather than assuming pixel-perfect fidelity.
5. **Resolution Loop**: Fix substantiated blockers, rerun affected verification, and obtain independent re-review of the fixes and any further changes before delivery. Record finding dispositions; disputed blockers remain open until independent re-review resolves them.
*Completion Criterion*: Final task changes pass both independent review axes; all blocking findings are resolved; affected verification passes. If either review fails to execute, report the concrete blocker and keep the task incomplete; self-checks or a delivery report cannot substitute for review.

### Phase 5：治理与交付
1. **Local Commit Authorization**: After review passes, recheck project rules and the branch baseline. Invoking this skill authorizes a local commit on the established branch by default. A project rule that prohibits local commits or conditions them on unmet approval overrides that default. Explicit user direction to leave changes uncommitted does the same. If edits are discovered on a detached checkout, create the repository-approved branch before committing and preserve the full starting diff. In either case, preserve the working state and output a delivery report with review results, verification evidence, a suggested message, and ticket IDs.
2. **Atomic Commits & Ticket Tracking**: When locally committing, make Conventional Commits (`feat(scope): <summary>`), staging only task changes, splitting per repository when applicable, and including detected issue/ticket IDs in the project's format.
3. **Default Remote Delivery**: Unless applicable project rules or explicit user direction impose a delivery boundary, invoking this skill authorizes the complete remote delivery flow after review and verification: push the branch, create or update the pull request, resolve merge conflicts, wait for required checks, and merge into the repository's target branch. Do not stop at a local commit or an open pull request merely because those steps succeeded.
4. **Project Delivery Boundaries**: Project rules and explicit user direction may narrow the default flow. Resolve the exact boundary rather than inferring a broader stop: a rule requiring human review before commit stops before the local commit; before push stops before push; before pull-request creation stops before PR creation; before merge allows the local commit, push, and PR but stops before merging. Never enable automatic merge or merge manually before a required human approval.
5. **Delivery Completion**: When remote delivery is allowed, verify the actual final state through the repository provider and do not report completion until the pull request is merged into the target branch. If delivery is intentionally stopped at a project- or user-defined boundary, report the boundary, completed steps, pending action, and verification evidence. If delivery is blocked by permissions, conflicts, failing checks, or infrastructure, keep the task incomplete and report the concrete blocker and next recoverable action.
*Completion Criterion*: Review gate passed; task-created temporary files removed without disturbing pre-existing work; compliant local commit and, by default, completed remote delivery verified. If a project or user boundary intentionally stops delivery earlier, produce a precise handoff at that boundary instead of claiming full completion.
