# 维护：yjx-unslop

运行规则由 [SKILL.md](SKILL.md) 负责；本文件记录已核实来源、选择吸收的机制及验证边界，普通执行不加载。

## 用户目标与已确认边界

2026-11-18，用户依据多次真实使用指出：跨项目、跨 Agent 的说明和网页报告反复换角度重述、冗长失焦、信息层级混乱，机械压短又会丢失理解所需内容。Vikingar 是取证样本，不是技能适用范围。

用户确认生成前允许自动调用、已有内容可显式修订，并选择整合既有直观解释能力；明确拒绝保留第二个名字。随后批准完整方案并指示实施。对外仅注册 `yjx-unslop`，删除旧入口，不提供别名或转接；历史来源准确保留。

## 既有能力与来源承接

原 `yjx-show-me/SKILL.md` 的本地迁移基线 git blob 为 `df90a7e5efa38602c53dafeffa12a6809a97f118`。原维护记录迁入[历史记录](references/history.md)；[LICENSE](LICENSE) 保留原 Matt Pocock MIT 通知，并加入已核实的 HumanLayer MIT 原文。并列保留不表示确认双方共同创作，也不将全部表达规则称为新原创。

- 原有伪代码、调用树、真实代码缩写、组件/目录树、Mermaid、微型 diff、完整代码和受限 HTML 迁入[图示与代码表达](references/visuals.md)。代码机制走读仍优先真实代码缩写与顶层调用树；HTML 保留原触发边界并遵守宿主展示约定。
- 通用内容组织与含义核对集中于入口，正文与图示分工不再在两个技能分别维护。复杂编辑和报告规则按场景读取，普通回复不加载整套图示示例。
- 本次重新获取 [HumanLayer 固定版本原文](https://github.com/humanlayer/skills/blob/4d69d20f6e9b57b4fcf0d501ccfb1be961f0f329/plugins/show-me/skills/show-me/SKILL.md)，Git blob 为 `f0ccd047c136d7b702b385e0ecad775ccb773eae`，与早期记录一致；[该版本 LICENSE](https://github.com/humanlayer/skills/blob/4d69d20f6e9b57b4fcf0d501ccfb1be961f0f329/LICENSE) blob 为 `f7ad6f4a1d5ed9bbf0589c172c6360587d1530e3`，通知为 `Copyright (c) 2026 HumanLayer`。本次据其公开 MIT 许可承接相应内容。Matt 的[固定版本致谢](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/pr/CREDITS.md) 也将 show-me 归功于 Dex Horthy，并说明不属于该仓库。
- 2026-11-02 本机副本的实际安装渠道，以及旧 Matt Pocock 通知的附入依据仍未确认。新核查证明内容匹配和当前可用许可，不追认未知的历史取得路径。中文调整与后续合并属于本地修改。

## 社区方法的选择吸收

以下是经源码核查后的方法参考与本地综合，不作为运行依赖。未按传播量筛选，也没有运行外部候选脚本、评分器或行为评测。固定 ref 为当时核查版本；其余链接指向公开规则，后续核查应重新确认版本。历史取得路径未知不妨碍如实标记已知内容匹配。

| 来源 | 本地承接及适用限制 |
| --- | --- |
| [poteto/noodle unslop](https://github.com/poteto/noodle/blob/82d2921/.agents/skills/unslop/SKILL.md)、[pstack](https://github.com/backnotprop/pstack/blob/main/skills/unslop/SKILL.md) | 术语一致、删空话和无信息收尾；不采用补个人观点、松散结构、标点禁令。pstack 与 Cursor 收录版相同、Noodle 条目重合，不计作多套独立验证 |
| [reverse-outline](https://github.com/petar-djukic/writing-skills/blob/854ccaf40f7dbbb0afe2e5c12ab3c5d53f703226/.claude/skills/reverse-outline/SKILL.md) | 段落作用与删除损失；内部按需分析，不写入段落标记或自动按排名删除 |
| [BMAD structure](https://github.com/bmad-code-org/BMAD-METHOD/blob/main/skills/core-tools/bmad-review/references/lens-structure.md) | 结构先于措辞，删、合、移、压缩及保留理解所需内容；不引入整套开发/审查流程 |
| [human-ai](https://github.com/fabricioctelles/skills/blob/c491efea06e200e847c416effb87e566d6face3b/skills/human-ai/SKILL.md)、[work-humanizer](https://github.com/phuryn/work-humanizer/blob/main/skills/work-humanizer/SKILL.md) | 固定原始依据、双向语义核对，保护条件、责任和承诺；前者明确借鉴后者，不重复计为原创方法；不引入检测器或默认采访 |
| [Humanizer-zh](https://github.com/op7418/Humanizer-zh/blob/f4518a8/SKILL.md) | 中文含义与确定程度优先，只交最终所需内容；不只保护原结构而忽略本次获准重排 |
| [UCL-ERL structure checks](https://github.com/UCL-ERL/skills/blob/9d50603850b661a1da175ef3e330ba0b52e3efe9/skills/writing/manuscript-structure-auditor/references/structure-checks.md) | 前提依赖、独立增量与术语保护；不把论文结构套到所有回复 |
| [clarify-doc](https://github.com/jaal/claude-code-skills/blob/main/skills/clarify-doc/SKILL.md) | 先意图与阅读链，再统一术语和表达；不默认交注释稿与重写稿，也不禁止结论先行 |
| [nabokov-editor macro-pass](https://github.com/kmmbvnr/nabokov/blob/e6f98ce64b52dffe975ecd1a338490f94b6fba1c/skills/nabokov-editor/references/macro-pass.md)、[cw-dev-edit](https://github.com/EveryInc/compound-writing/blob/8fd0ec88c00976cf0274cb76552dc7ad9405ca92/skills/cw-dev-edit/SKILL.md) | 反向看主线与开篇承诺，修复真实衔接；不擅自补出缺少依据的机制 |
| [editorial-development](https://github.com/brycehamrick/editorial-skills/blob/4043b9625b5751f5b8c65de6bf08ce6ce65ae88a/skills/editorial-development/SKILL.md)、[plain-language-editor](https://github.com/marketingskills/plain-language-editor/blob/main/SKILL.md) | 标题略读路径、读者而非数据库视角、数字的统计含义；不引入固定压缩比例、英语阅读年级或强制调查 |
| [Impeccable distill](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/distill.md)、[clarify](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/clarify.md) | 区域职责、增量信息与渐进呈现；不默认改交互、重做布局或启动多代理审计 |
| [mgifford content-design](https://github.com/mgifford/accessibility-skills/blob/main/skills/content-design/SKILL.md)、[n8n content-design](https://github.com/n8n-io/n8n/blob/master/.agents/skills/content-design/SKILL.md) | 线性阅读、可访问替代、提示不复述标签，状态具体可理解；不把无障碍替代视为可删冗余 |
| [richiehakim/deslop](https://github.com/richiehakim/agent_skills/blob/cfc2013/skills/deslop/SKILL.md) | 参考其减少话题而保持完整句子、必要背景和整体位置的原则；未见明确许可，未复制其表述，不设一分钟硬上限 |
| [stephenturner 结构规则](https://github.com/stephenturner/skill-deslop/blob/a906154/references/structures.md)、[ml-slop/text](https://github.com/Max-Levitskiy/skills/blob/main/plugins/ml-slop/skills/text/SKILL.md) | 识别换比喻/角度的主题功能重复；不据此删独立证据，不引入七代理、主观加权分或列举数量限制 |
| [theclaymethod 结构包](https://github.com/theclaymethod/unslop/blob/0f4a07f/references/packs/pack-structure.md) | 识别预告—正文—总结循环；不复用仅英文的扫描阈值和实验性流水线 |

本地综合补充：按用途查原稿未覆盖的必要内容，报告状态分组，阶段结果联系总目标；将视觉选择与内容编辑纳入同一交付。所采纳的是具体机制，不代表在本地验证了上游宣称的效果。

## 激活与验证

`SKILL.md` 保留可发现的 description，不设置 `disable-model-invocation: true`；`agents/openai.yaml` 允许隐式调用。机制依据[OpenAI 技能文档](https://learn.chatgpt.com/docs/build-skills)及 [Agent Skills 集成规范](https://agentskills.io/client-implementation/adding-skills-support)：宿主按目录描述选择并加载正文，不保证每次生成前实际调用。

验证限于静态文档审阅、frontmatter、围栏/链接、原有能力覆盖和实际安装状态；独立评审检查实施是否符合已确认范围。遵守根 `AGENTS.md`，不创建或运行模拟用户/助手对话、模型或 Mock 驱动的提示词行为测试。

真实效果待实际任务回顾：相关任务是否实际加载、用户是否理解主点与必要关系、独立含义及证据是否保留。静态通过与安装成功不等于提示词行为已验证；后续用户真实纠正记录到本文件，不维护评分榜或固定对话样本集。

## 真实纠正记录

- 2026-11-23：代码审核网页报告连续三次被用户指出看不懂（凑数背景句、规范建议不说现象也不给代码）。各轮均实际加载了本技能，但正文由报告脚本的固定 7 栏模板决定，验收只核对栏目齐全，纠正后只改了栏目标签。据此在[报告组织](references/reports.md)增加“模板生成的条目”一节；对应模板修改在 Vikingar `vk-code-review-patrol` 完成。
