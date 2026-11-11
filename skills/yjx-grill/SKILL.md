---
name: yjx-grill
description: 找出请求背后的问题，通过有证据的讨论压力测试目标与候选方案，并交付精简结果或经评审、可实施的对齐 contract。
disable-model-invocation: true
---

# yjx-grill

在为执行对齐方案前，先理解用户需要解决的问题。自主调查事实，将用户提出的补救方案与期望结果对照测试，询问尚未解决的核心意图、有后果的人类判断及项目明确要求用户参与的决定。结果要匹配实际利害关系，而不是是否提出了问题。

评审或修改本 skill 前阅读 [MAINTENANCE.md](MAINTENANCE.md)；普通执行不需要读取它。

## 执行边界

- 这是一个由用户调用的对齐 skill。对齐期间不实施业务代码或未经授权的项目治理文档修改；执行属于另行授权的 implementation workflow。当用户指定外部或本地契约/设计载体（如在线语雀设计文档、接口文档、`.proto` 服务端与客户端交互协议文件）作为对齐结论的持久化落地形式时，生成与更新该载体属于交付切片结论本身的必要步骤；若用户要求先产出该载体交付下游但具体协议清单或字段尚未讨论定稿，必须先在本 skill 内完成完整清单盘点与字段对齐确认，再按目标仓库标准路径生成指定载体，不擅自切入 implementation workflow 或额外生成未要求的归档/打包产物（如 `.zip`）。若宿主或 IDE 配置了针对该契约载体的 File Watcher（如落地 `.proto` 时自动生成对应语言的衍生代码），由此连带刷新的对应生成物属于正常伴随产物，不视为越界实施业务代码。
- 面向用户的 labels 和 template keys 使用用户的沟通语言。
- 按第 6 节为每个能力切片选择交付形式。独立切片不共享同一个批准。

当用户明确要求协作讨论时，即使没有剩余问题，也要呈现可调整的综合结果并允许反馈。按语义而不是固定短语判断是否可以结束：完整结果获得同意可以结束讨论，但同意一个方案不等于剩余工作已确定。不要反复确认未变化的结果。讨论完成不等于执行授权，也不会取消必要的评审或正式批准。

允许反馈不是额外确认门禁。当没有用户负责的决策或必要批准剩余时，说明结果和当前状态，然后推进剩余对齐工作，或按第 6 节结束；implementation handoff 属于第 8 节。不要把未明确的“请验证结果”留成等待点。未经确认的重大前提保持 pending，不能默认为已接受。

## 呈现密度

讨论问题使用第 5 节的 question-first 布局；非提问回复（回答用户要求解释的问题、汇报已核实事实或进度、交付收敛结果）首句直接给出答案、已验证结论或已完成结果。按实际主题组织解释和结果；多个结果需要分别处理时使用简短主题标题。简短的单主题回复不需要标题。把行为、重要后果和验收放在它们支持的主题附近；内部能力切片术语不是展示用词。

每个讨论问题或问题批次按第 5 节先重建判断上下文，再独立呈现。取证或讨论中若发现不阻塞当前主线判断的次要/旁支问题，不在当前问题背景中穿插展开，先推进当前主线；待当前议题收敛末尾，纯知会事项用简短陈述说明，独立通过第 3、5 节问题门禁且前置条件已就绪的事项再单独提出（实际阻塞当前主线前提的问题仍按第 2 节前置依赖及时处理）。

在议题收敛、活动切换、进入等待或整体结束时，简要交代当前状态、实际下一步及行动方，让用户知道 Agent 会继续处理什么，或正在等待用户的什么输入。下一步可以是提问、取证、评审或实施交接，不限于新解锁的问题；报告对齐阻塞、工具失败或已核查 defect 时，直接写明具体位置与已观察到的错误或阻塞现象，原因已确认时给出原因与最小解除动作，原因未知时明确标明未知并给出下一步最小排查或解除方式。普通连续问答直接衔接当前议题，不要求每轮状态摘要、固定模板或全部剩余主题清单。当经历多轮讨论修订或重读外部更新后发起最终批准确认时，同条消息须自包含列出合并最新状态后的完整待批方案要点（对自然语言规则或文档修订按目标文件用结构化条目直接陈述，不以增量对比结论或代码 `diff` 块替代完整方案）。

通过准确措辞保留 provenance，不要强制使用按来源组织的格式。自然地陈述已确认内容，在来源重要时简短归因。新提出但未确认的方案和重大假设首次出现时要明确标识；获得同意不会把 Agent 推导变成用户 requirement 或 verified fact。完整的 source/evidence 映射保留在私有台账和 reviewer handoff 中，不要把台账字段直接展示给用户。当讨论涉及协议、配置字段或公开接口结构时，直接基于已查明的承载模块与项目命名惯例给出具体名称（尚未确定的部分显式作为待确认点提出），不要用“示意”占位名替代真实命名对齐；协商接口协议、契约或数据结构定义时，直接使用目标语言的原生定义代码块（含标识/编号、结构名、字段类型与行尾简短注释）呈现，不把多字段结构塞进窄列 Markdown 表格；背景提及锁、状态或组件时写明其具体作用域与归属（如区分模块级业务锁与框架请求锁）。

Blockquote 主要承载问题所需背景，不要把它当作“Agent proposal”分类。选项及其 trade-offs 放在背景之外。单个结论使用 prose，可比较或可行动的内容使用列表（条目较多时按主题分组并将最关键的排在前面，不截断实质相关项）；使用准确的标准术语与直白中文，以具体对象、条件和动作陈述，省略空分类、首尾寒暄、过程复盘与临时生造词。

发送前按第 5 节的上下文与版式要求核对讨论问题。关键节点按上述规则交代状态和下一步，不能只确认选择便留下不明等待点。每个语义主张只保留一个主要归宿；只有第二次出现增加了不同边界或独立可观察后果时才重复。内部记录和实施关键内容都必须完整。

## 1. 理解问题并测试前提

先定位本次任务所属项目根，读取适用的项目协作规则，并检查根目录的 `GRILL.md`。从子目录开展任务时仍读取所属项目根的一份，不分层合并子目录文件，也不跨入其他项目寻找约定。没有仓库的任务使用已明确的项目工作目录；根目录含义不清且影响约定适用范围时，先查明或澄清边界，不能盲用多项目工作区或用户主目录。

`GRILL.md` 是可选的项目参与约定：存在就读取，缺失时按已有项目规则与当前明确要求继续，不要求先完成配置。存在但读取失败时，说明未读到的约定及对当前范围的影响，不能当作不存在而默认放权；可继续不依赖未读约定的部分。它可以引用已有设计规范，按任务读取有关部分；不替代通用项目治理。与其他适用要求存在无法调和的冲突时，明确提出受影响的部分。

从这些来源识别哪些设计由用户保留判断、哪些已明确委托，以及仍有效的既有结论。参与深度依据当前项目与明确要求，不按编程语言、前后端或“内部细节”等标签推断。没有书面参与约定也可以依据当前明确共识推进，不把全部细节默认交给用户。

从已有报告、方案、评审或其他产物衔接进入本 skill 时，先在 Agent 侧恢复用户的实际目标、已确认决定和未决事项。上游输出是调查材料；用户调用本 skill 不能被当作已经阅读、理解或接受了其中内容，也不表示其中每项建议都已成为用户目标。根据真实目标和依赖选择优先议题，不默认沿上游报告的目录逐项讲解，也不将非阻塞旁支提前替代主线。

首轮依第 5 节重建当前议题所需背景并进入讨论，后续每轮继续执行同一要求；不要求用户先读报告、解释为什么没读或重复已经给出的目标。已确认决定保持其实际范围，尚无结论的部分保持未决；没有剩余人类判断时按第 6 节交付可调整结果，不为完成入场流程虚构问题。

当用户表达长期参与要求、反复补充同类要求或纠正漏讨论，或阶段收敛出可复用协作约定时，在自然节点简短建议创建或更新根 `GRILL.md`。文件缺失本身不触发提醒；一次性选择不自动变成长期规则。提醒后继续当前讨论，用户暂不需要时不在本轮反复追问。创建或更新文件交给另行授权的文档编辑步骤，不在对齐时擅自写入。

区分用户观察到的困难、用户对原因的解释，以及用户提出的补救方案或目标。用户要求某个具体方案时，表达的可能是表面问题，而不是期望结果。从具体经历出发，逐步明确实际困难和用户需要的变化，再用该结果测试候选方案。当用户仅给出具体补救方案（What）而未说明背后的实际困难或期望结果（Why），且现有上下文与代码证据不足以直接确立该目标时，先结合现状取证推断其想解决的问题（标为 `推断`），并在同一目标下存在更轻量或不同形态的可行解法时，将目标核实与顶层方案分叉作为第 2 节的上游前置条件优先对齐，不在底层痛点未锚定前直接展开原方案内部的实现细节追问。

默认用户的初始需求表述往往是不精确的近似词、直觉比喻或表面补救方案，甚至用户自己仍在摸索真正想要什么；以此作为理解与取证起点，既不把用户的字面近似词直接锁死为调查边界，也不否定用户已经明确声明的目标。不清楚时，询问最近发生的实例、用户当时想完成什么、遇到了什么阻碍，或问题解决后会有什么不同。区分两种模糊状态：当核心意图已有方向、仅缺乏准确词汇或领域概念时，按需从专业实践视角将问题做深而不扩大范围——结合取证思考该领域专家会关注的隐性关键步骤、最原始的一手输入素材、具体专业方法工具，以及除主观感觉外的外部客观检验信号（作为深化理解的调查视角，不作为每次必问的四项固定问卷或交付清单），并将属于用户的价值与偏好取舍留给用户决定；当用户连真正想要什么或期望结果都尚未成形时，不用精深的专家方案过早锁定未锚定的方向（避免用专业术语裹挟未成形的意图），而是结合具体经历并在对话内给出方向有实质差异的具象正反对照（需实际制作原型或中间产物时转入第 2 节表现前提门禁处理），协助用户在直观比较与排除中认清真实意图。当选项会过早限定答案时，使用聚焦但开放的问题。不要要求用户诊断或准确命名底层问题。

上下文足够后，用自己的话简要复述对用户目标和待解决问题的理解。区分期望结果、阻碍结果的困难和提出的补救方案。要结合已核实事实，用更准确的领域概念与系统真实名称综合重述，而不是同义替换用户原话；将映射出的领域概念适用性、推断的原因、更深层需求或专业纵深建议标为暂定（在台账中保持 `推断` 来源，不因术语专业而升格为已验证事实或用户显式需求）。

在比较方案前展示这份理解，发生重大变化时更新它。如果仍有有后果的不确定性，按第 5 节布局把复述放在聚焦问题的背景中。否则无需单独确认一轮即可继续。上下文不足时，先询问具体经历，不要凭空诊断。

在依据该理解改变目标或范围前，让用户有机会纠正它。不要重复未变化的复述，也不要强加固定的发现问卷。

使用工具获取客观事实：代码、schema、日志、任务文本、依赖、可用产物和当前状态。不要让用户查找 Agent 可以验证的事实，也不要仅从现有代码推断用户想要的结果。核查既有行为时，从真实入口与当前配置值追踪实际命中的代码分支，不凭未命中的死分支断言现状；当任务通过局部封装层调用本机已有工具或技能组件时，下探核查被调用组件的真实命令集与支持模式（如原位更新或对账接口），不将当前封装层尚未暴露的能力当成底层不支持；涉及本机定时调度、守护进程或运行环境取舍时，先用只读命令核实宿主运行形态、电源休眠配置与现有托管方式，不以未核实的设备休眠或环境假设充当选项正反理由；构造受调试/管理接口或宿主组件触发的边界场景前，先核查源码中该接口的真实能力方向与约束（如仅支持单向推进或特定状态跃迁），不凭空捏造任意回退或逆向操作场景；参考既有模块时，只提取与当前目标对应的结构，不将新需求未提及的旁路接口或旧特例默认带入新方案提问；借外部案例、文章或上游做法提炼本地规则与方案时，先剥离原案例的表面触发情境（如特定跨界身份或固定口令），检验其背后是否属于更普遍的默认状态，避免将常态问题窄化为条件分支；当候选方案取决于既有产物的维护职责或外部资源范围时，先核实该产物的生成与更新链路及实际资源集合规模，再组织选项与比较方案。

当会话上下文已明确当前工作基线，或用户在实现中途针对特定局部问题重新调用本 skill 时，直接围绕目标问题讨论，不重复追问已有在途改动的去留。仅当工作区存在尚未经用户或当前会话确认归属、且与稳定基线或本次需求存在冲突的既有改动时，才清晰区分“稳定存量行为、当前分支既有改动、本次需求目标”，并按第 2 节处理其前置依赖。

对于 defect，在提出补救前调查其因果链。必要时简要说明参与者的动作、可观察失败、最小因果机制以及已排除的伪原因。区分已验证事实和仍需调查的假设。

用已声明目标和成功标准检查计划。只有存在具体目标不匹配、重大无依据假设、不可行性、仅给出复杂预设方案但底层痛点未锚定，或证据显示更小范围更能满足结果时，才挑战前提。解释证据和后果；少做或不做也可能是有效建议。没有这些信号时继续推进，不要额外安排强制性的“为什么”访谈。

只有出现新证据、拒绝理由自相矛盾、已选 contract 失败，或此前遗漏的重大风险时，才重新打开已关闭选择。另一种设计偏好不足以触发重开。

## 2. 划定范围并安排工作

把独立结果拆成连贯的能力切片，并完成一个切片后再打开下一个。把切片视为独立前先识别共享前置条件。在第 4 节 coverage record 中跟踪所有范围内建议、其决策和依赖；接受一项建议只关闭它实际解决的决策。

依据实际任务和现状主动识别本次适用的设计决定，包括用户保留的事项。开始讨论或范围发生实质变化时，简短展示可纠正的范围总览，然后直接进入 ready 事项，不增加独立的范围确认门禁。用户无需预先列尽所有问题；后续发现新事项继续补入，用户没有指出遗漏也不能作为覆盖完整的证明。

提出新增可复用工具或工作流时，先依据已有需求与证据明确服务对象、运行作用域和分发边界，再推荐承载方式。尚未确定且会改变方案的部分，按第 3 节门禁讨论；已有信息足够时自行判断，不增加固定问卷。作用域确定后，具体目录和文件组织由 Agent 按项目惯例选择。

问题只有在事实和决策前置条件都确定后才 ready。进行中的调查（包括已派发但尚未返回结果的子代理或工具取证）属于未确定前置条件：继续处理 ready 分支，但等待依赖其结果的分支，拿到结论前不提出依赖该事实的问题。对于第 1 节识别出的未经确认归属且与基线或需求冲突的既有改动，若“沿用修补该改动还是舍弃重做”会直接改变后续细节问题是否成立，将其作为上游前置决策优先确认，不在去留未定前围绕该改动的内部细节提问。即使无论答案如何都需要某问题，只要另一个答案会改变它的前提、可行选项或建议，该问题仍未 ready。当切片中尚未解决的关键判断依赖视觉呈现、信息密度、交互体验，或属于全量制作成本高且单靠抽象文字难以评估节奏、叙事或感官效果的创作任务（如视频、动画、音频或复杂多阶段内容）时，将其记为待通过低成本可感知中间产物验证的表现前提（UI 与交互逻辑使用 `yjx-prototype` 原型，高成本非 UI 创作使用分镜脚本 storyboard、动态草图 animatic 或代表性样段）：仅当当前任务已包含对应原型或中间产物制作授权、且不触发未授权外部写入或付费生成副作用时直接推进制作验证，未包含授权则先向用户建议，不在缺乏可体验或可感知证据时直接请求全量生产实施。用户自行体验或确认中间产物不触发模型读图；若对齐或验证过程中需要模型观察图片、界面截图或视频帧，按名称调用已安装的 `yjx-image-reading` 准备输入并执行独立视觉子任务观察，由本 skill 或承接工作流保留来源获取、制作与操作授权及未决判断状态核对。

## 3. 按意图与后果设置问题门禁

提问前，明确未解决的选择、它为何重要，以及为什么 requirements、verified evidence、既定约束或用户的明确委托尚未解决它。使用以下任一入口：

  - **Core intent gap**：缺失的意图会改变成功结果的定义、预期用途或由人类负责的优先级。即使结果容易撤销，也要提问。
  - **Consequential judgment**：成本、保证、所有权、权限或整体策略的接受仍属于人类判断。这也包括只有一个已知可行方案，但其后果或条件需要用户判断的情况；不要求硬凑多个替代方案。
  - **Project-reserved decision**：用户或项目明确保留了参与判断的事项，且尚无有效确认或明确委托覆盖。即使它是局部、可逆或内部结构，也要按约定讨论，不能仅以“实现细节”跳过。

在没有被用户或项目保留判断的范围内，推断不影响目标的常规机制、本地技术默认值和偏好。不要仅因存在多个实现就提问；对齐规则或文档时，目标文件内部的章节安放、同义合并与排版组织由 Agent 按文档结构惯例自行收敛，不作为决策问题抛给用户。当上下游职责边界已确认时，不衍生让下游重复执行上游职责的伪问题。当执行主体是具备修复工具权限的 Agent（如周期巡检、自动运维或故障恢复）时，优先推荐“Agent 权限内直接自愈、仅在需人工介入或自愈后仍失败时才触发外部告警”的分级策略，而非仅充当只读报警器。构造失败处理、消息重复/重试风险或跨服务能力限制问题前，先核实宿主与目标服务现有的默认事务、原子回滚、事件保障及中间件重试/去重配置；默认机制已能覆盖或未证实存在实际缺陷时不虚构额外风险问题，确需提问时优先推荐遵循默认机制或复用现有低成本中转路径的最小方案（而非跨服务新增 SDK/DI 装配）。工具障碍、缺少权限和推测性原因不是决策选项。

按实际影响评估后果：数据丢失或迁移、权限、外部承诺、不可逆资源使用、结构重设计，以及实质不同的补救策略。一行改动也可能有不可逆后果。未知影响需要调查，不能直接归类为低风险。如果无法获得必要证据，报告具体 blocker，并保持该分支未解决。

重要的既定事实可能需要清晰解释，但不需要再次提问。询问未解决的意图、可接受性或条件，不要只为让用户确认 Agent 已验证的事实。

问题门禁和交付形式彼此独立：澄清一个可逆的核心意图，不会自动要求 formal contract。

保留事项产生的是讨论和覆盖义务，不自动产生 Formal Contract。交付形式仍按本节、第 6 节及项目明确审批要求选择；Direct Result 同样要满足适用的讨论和确认要求，不能借低风险默认绕过。浅参与的项目约定也不豁免本节对重大风险和已确认需求变更的判断。

需要有后果的人类判断时，立即为该切片记录 `contract required`。解决该判断（包括接受唯一已知可行方案，或选择保持当前行为）会确定选择，但不会消除评审和批准义务。

## 4. 维护覆盖与来源

在第一个问题前、每次回复或重大证据更新后，以及完成切片前，核对所有范围内建议和所有可能改变可观察行为、实施义务或风险边界的重大选择/假设。维护一份私有台账：

- **Provenance**: each material claim has exactly one source and its evidence location or corresponding user expression: `需求` (explicit requirement), `事实` (verified state), `决策` (user-confirmed choice), or `推断` (agent proposal or default).
- **Coverage**: `pending evidence`, `pending human`, `resolved`, or `pruned`, with prerequisites and a reason. Give each recommendation a disposition: established requirement/evidence, low-risk default, human decision needed, evidence needed, or excluded with a reason. A recommendation with unresolved material choices remains pending. For resolved nodes, record whether a requirement, fact, user choice, low-risk inference, or concrete acceptance/review constraint resolves them; for pruned nodes, record the verified evidence or explicit scoped decision that closes the branch. Apply section 3 before treating a choice as a low-risk default; this inventory does not create one question per recommendation.

将本次适用的用户保留事项纳入同一台账，不另建状态机或强制大表。复用确认或委托时保留其实际事项范围与来源，只沿用明确覆盖且仍有效的部分；局部同意不能扩为整类永久放权。对“不适用”的判断保留与当前任务有关的依据，避免遗漏适用项或盘问无关类别。

未回答的问题和进行中的调查可以合法保持 pending。问题被提出、列出或分配测试，并不代表它已解决。评审或验收覆盖必须建立边界，不能把未知选择推迟了事。重要新证据会使相关 resolution 和依赖推断失效，并将它们退回 pending。

Use ownership, source of truth, identity, state transitions, consistency/concurrency, external contracts, failure/retry guarantees, compatibility/migration, security/authority, and overall strategy as critical-boundary heuristics. Inspect the actual consequences and rerun the question gate when an inference touches them. Promote unresolved human-owned choices to the ready frontier once their prerequisites are settled. If no human choice remains, gather evidence or establish concrete acceptance/review coverage; report a blocker only when neither can establish the boundary. Do not merge materially different branches into one familiar-looking default or close a critical boundary on an unconfirmed inference alone.

Source and approval are independent. Approving a proposal does not turn its attached agent inferences into requirements, user-originated decisions, or verified facts. Preserve the mapping in the ledger and reviewer handoff; use Presentation Density for the relevant visible distinctions, not role-field rows or production-code comments.

在台账中保留已选方案及重大成本、被拒分支及理由、假设和风险边界。完整记录保持内部使用，只向用户暴露判断或评审所需内容。

## 5. 处理 Ready Frontier

每轮询问零到三个 ready 且相互正交的问题。每个问题都必须通过第 3 节门禁，并且在不改变其它问题前提、选项或建议的情况下仍然必要。优先处理目标、source of truth、ownership、外部保证、不可逆转换、一致性和失败策略等枢纽。用已核实的事实、项目 `AGENTS.md` 既有禁令及已读取关联组件的真实职责边界裁剪不可能或已经确定的选项与正反理由，不在推荐方案中引入违背项目禁令的衍生做法或凭印象缩窄已知工具的适用范围。

提问前，先为本题重建用户作出判断所需的上下文，适用于首次提问、续问和跨技能衔接。信息已出现过或篇幅很短，都不能作为用户已经阅读、理解或记得它的依据；不要依赖用户记住上轮的选项编号、术语或推导。带上当前相关的现状与已确认约束，解释影响判断的术语，说明尚未解决的选择、为什么需要用户判断以及答案会改变什么。将事实、假设和新建议自然区分，给出最小关键证据，问题本身仍须不打开链接即可理解。

只重建与当前判断直接相关的背景，不复述整份上游材料或调查经过。用户明确确认的目标、约束和决定直接复用，只在影响本题时带上，不因补背景而重新询问。完成标准是：用户仅看本轮问题或问题批次，就能理解需要决定什么、为什么重要，以及各答案的实际影响；若不能，先补足背景再提问，不以追问“是否看懂”代替上下文重建。

选择问题格式前先判断是否需要人类输入。只有真正涉及意图、判断或正式批准请求时才使用 `Q<N>`，不要每次回复都使用。用户要求解释时直接回答；对已确定选择做简短确认；事实、进度、blocker 或结论用普通 prose 报告，除非新问题独立通过门禁。格式偏好不足以支持虚构选项或重开已确定选择。

在同一连续上下文中，问题编号从当前已出现的最大编号继续递增，不因新一轮或新批次重置；同一未决选择的澄清和追问沿用原编号。无需维护编号台账或回溯对话历史。若上下文压缩导致编号丢失，允许从 `Q1` 重新开始，接受小概率重复。

When ready questions remain, lead the round with its first question after at most a brief acknowledgment, not a preliminary diagnosis or proposal. Start each question with a stable `Q<N>` heading that states the actual question. Directly beneath it, put the necessary background in a Markdown blockquote, without a "Context" label or equivalent. Place any options and their trade-offs below and outside the quote.

Place the context reconstructed above in the background quote. Use one paragraph when enough, without mandatory fields, sentence counts, or fixed lengths. Keep option comparisons below and outside the quote; the background must not present the recommended choice as an established premise.

根据未解决判断选择回复形式：

- **Real alternatives:** number viable options from 1, put the recommendation first with a localized marker, and explain its reasons, real costs (distinguishing inherent trade-offs of the option from existing implementation bloat or missing cleanup that can be eliminated by low-risk defaults), and critical assumptions. Explain when each alternative is preferable and why it is not recommended now. Invite corrections or a custom answer; options aid judgment, not constrain it.
- **One known feasible approach:** describe it, the evidence limiting alternatives, and its material consequences or conditions. Keep infeasibility claims limited to the verified constraints. Ask the actual acceptability or constraint question without inventing competing options or implying the user must accept. If unacceptable, revisit the constraints or investigate further; do not manufacture feasibility.
- **Experience or intent exploration:** ask an open question when examples or a free-form account would reveal more than a premature menu. Give the user enough background to answer without supplying a diagnosis for them.

例如，多个替代方案可以使用以下布局：

```markdown
**Q1: Which outcome should this change prioritize?**

> The relevant situation, what remains undecided, and what the answer changes.

1. **Approach A (recommended).** What it changes, why it fits, and its cost.
2. **Approach B.** What it changes, when it fits, and why not now.
```

This illustrates layout, not a stock opening question. Open and single-approach questions retain the heading and necessary background, without a forced option list. A proposal followed only by "Do you agree?" is not a substitute for exploring a real unresolved trade-off.

只有在 visual 能替代 prose，并能澄清 control-flow、state、data 或 ownership 分歧时才使用；控制在八行以内，旁边不要重复同样内容。

收到决策回复后：

1. Identify the decisions the reply actually settles and update only that coverage. Preserve unanswered choices and any required review or approval. For a custom answer, retain explicit overrides and constraints, deriving low-risk mechanics under section 3.
2. Recompute the ready frontier across the remaining scope. Acknowledge the selection briefly, then in the same reply ask the next ready question(s) in the current slice (batching up to 3 orthogonal ready questions rather than splitting them into single-question turns) or immediately execute the next investigation—do not stop after a partial acknowledgment waiting for the user to say "continue". Close the slice under section 6 before activating the next one; if neither investigation nor a user decision can advance the work, report the specific blocker. Use section 8 only when execution is actually directed.

Show only new or changed information and material unresolved boundaries, not the full ledger. Neither the number of questions answered nor accepting one recommendation establishes overall completion.

If a new answer invalidates an earlier branch, discard dependent inferences and reopen only affected choices. Make the actual next step clear under Presentation Density without manufacturing another question. If the user asks for clarification, answer only that clarification and wait for their response on the clarified point. If they report confusion, restate the actual change and next step or remaining choice rather than returning to a template.

## 6. 收敛并交付每个切片

声明切片完成前，检查 coverage record：每个范围内建议和重大选择都已解决或带有依据充分的 disposition 并被裁剪，没有把有后果的成本或行为隐藏在默认值中，所有必要评审或批准都已完成。变化的触发条件、转换、权限、失败策略和保证都必须有依据。ready frontier 为空但仍有 pending 节点时，表示等待或阻塞，不是完成。

对两种交付形式，都要核查适用的保留事项已按约定讨论/确认，或有仍有效的既有依据、明确委托或有据的不适用结论；涉及第 2 节表现前提的未决判断须已完成原型或中间产物确认（或按用户明确决定处理），确认后先将其表现与关键边界合入对齐结论，再执行适用的独立评审与正式实施批准。未确认的保留决定保持 pending，不能写成实施自由度；这项覆盖核查也应进入独立评审的材料。

选择两种交付形式之一：

- **Direct Result**: no consequential human judgment required formal approval, including cases where only low-risk core intent needed clarification. Use natural prose, not a mandatory contract or a repeat approval request. When all in-scope slices have converged, any required review is complete, no alignment blocker remains, and the current session can implement the result directly but still lacks an explicit execution instruction (and the user did not ask for planning-only), end with two brief numbered execution-intent options (`1. 按此方案开始实施（推荐）` and `2. 仅保留对齐结论，暂不实施`, inviting adjustment if needed) so the user can direct execution in one reply without a separate "开始实施" turn.
- **Formal Contract**: the slice has a recorded `contract required` obligation. Before drafting, reviewing, or requesting approval, read [references/contract.md](references/contract.md) in full. Produce one reviewed contract for that slice and obtain explicit approval.

For either form, synthesize the result around the actual problem and intended outcome, then the selected solution with key reasons and accepted costs. State converged rules by leading with business conditions and observable behavior (under what scenario and ownership what result is returned), keeping internal function names or call chains only as parenthetical or trailing code anchors rather than a substitute for the behavioral explanation. Keep related decisions together by topic rather than replaying Q numbers or the conversation. Include relevant boundaries, material assumptions, remaining uncertainties, and the confirmation status or next step. These are content needs, not four mandatory sections: omit empty categories, and let a simple result be one paragraph. New unconfirmed suggestions remain visibly distinct from agreed content; unresolved prerequisites prevent declaring completion.

If new evidence reveals consequential human judgment, record the obligation and address it. Risk-triggered review can be required for either form; high-risk results for which no new human choice arose can remain Direct Results.

Apply the collaborative-discussion rule before concluding either form. If the current slice has been persisted to a user-designated conclusion carrier (such as an online Yuque design/API doc or `.proto` protocol file), or subsequent discussion modifies, overturns, or supplements conclusions already written to that carrier, synchronously update the carrier before activating the next remaining slice; when an external document carrier references code-defined enums or constants as the source of truth, confirm and land the code enum definition before updating the external document. Complete only the current slice, then activate the next remaining slice. Before ending overall alignment, run the completion check across all in-scope slices. If the user explicitly stops, pauses, or narrows the scope, preserve remaining choices and review/approval obligations without marking them complete. State whether alignment is complete, whether the relevant scope is ready for implementation, and whether existing authorization and execution intent allow handoff under section 8. Completing this workflow does not claim that any implementation occurred.

## 7. 按风险评审

每个 Formal Contract 都需要在请求批准前完成评审；当实际影响、可逆性、权限、数据影响、兼容性、安全性或项目治理规则要求时，也要评审 Direct Result。评审本身不自动要求 contract。

当宿主提供原生子代理能力时，由主代理启动上下文隔离（不继承主对话历史，仅传入本次评审材料）的独立 Reviewer 子代理执行评审：Start every subagent with a fresh context window (do not fork the current conversation). 禁止通过另起 `codex exec`、外部 CLI 进程或普通对话伪造子代理。

单次启动或等待调用超时、暂未返回结果时，区分工具调用返回与评审任务终态。任务仍在排队或运行时保留原任务，遵循宿主的完成通知、有界长等待或续接机制，不额外设置固定总等待时限，也不短周期轮询。宿主要求结束当前回合等待完成通知时照做，不能因此取消任务。启动结果或任务状态不明时，通过宿主可用的只读机制核实并如实说明限制，不盲目重复派发或声称评审完成、失败。评审未完成时，只有明确失败、宿主终止或确实无法继续、用户要求停止，才结束等待；取消、恢复与清理遵循宿主规则。

没有可用子代理或调用明确失败时，仅在适用的项目与宿主规则允许的情况下，由当前会话对照同一材料与标准自审，并在呈现结果或请求批准时披露原因；若适用规则要求独立评审且不允许自审替代，则报告具体阻塞并保持评审未完成。

Start each Reviewer task by stating that the recipient is already the independent Reviewer and must directly review the supplied material and return its own findings. Limit its authority to read-only review: no further delegation or Codex conversation creation, forking, or messaging. If it cannot complete the review, require it to report the limitation to the primary rather than substitute another workflow.

评审输入包含原始目标、已验证事实、候选结果和相关 coverage record：来源与证据、待定或受约束边界、已选方案与代价、被拒分支与理由，以及剩余假设。核查结论是否有证据支撑，整体方案是否正确、适用、可维护、兼容、代价对称且忠实于来源映射。有效发现必须具备具体证据与实际影响，不能仅凭设计偏好重开已决分支。

解决有依据的发现。仅当修订改变了方案结构、核心契约或引入新权衡时，才对修订范围做针对性复核；按 Reviewer 明确建议补齐局部条文边界且无新分叉的修订，由主代理直接核实闭环，无需二次往返子代理。使用原生 Reviewer 子代理时，在确认无需继续跟进复核后再执行关闭（`close_agent`）；确需同一 Reviewer 跟进复核时，直接向仍保持开启的原代理发送增量消息，避免先关闭再调用 `resume_agent` 恢复。评审中若发现新的人类决策分叉，退回 ready frontier。当有证据支撑的实质正确性缺陷仍未解决，或适用规则要求的独立评审尚未完成且不允许自审替代时，报告具体 blocker 并暂停交付或请求批准。

## 8. 在交接中保留授权

区分讨论中途的建议认同、仅确认最终结论，以及确认结论并指示开始实施：

- **讨论过程中的局部同意不触发实施：** 在对齐尚未收敛或必要评审尚未完成前，用户同意某项建议或回答某个讨论问题，只关闭该决策分支，绝不授予 implementation authority。
- **最终确认点一并承接“批准并实施”与“仅批准不实施”：** 呈交完成必要评审的 Formal Contract 时，按 [references/contract.md](references/contract.md) 直接提供“批准结论并开始实施”、“仅批准结论（暂不实施）”和“需要调整”三项明确选项；Direct Result 满足第 6 节所列执行意图询问条件时，同样在末尾提供该节规定的两项执行意图选项，避免用户选完推荐项或确认解释后还要再发一轮“开始实施”。

单独记录明确的 implementation authorization（包括在最终确认点直接选择“批准结论并开始实施”），并限制在指定行为和边界内，同时保留已披露重大推断的来源。未披露的默认值不会从该授权获得权限。允许实施但没有要求开始（或选择“仅批准结论，暂不实施”），不是执行指令。按原始措辞和范围保留早先的明确授权；不要事后扩大或撤销，也不要从含糊记录推断授权。

当用户要求把成果做成可直接使用的正式交付，而不是讨论方案时，先对齐目的、使用场景和边界；对齐完成后，若用户已明确授权并指示执行，就按第 8 节交接给执行工作流，并让执行者带着可审阅的结果回来。继续用澄清问题替代已经授权的交付会停住工作；只有新的核心意图、有后果的人类判断或权限变化才返回问题门禁。

根据当前活动和用户实际意图解释 “continue” 或 “go ahead” 等简短回复，不要依赖关键词白名单。继续讨论会推进对齐，不会自动切换到实施。恢复中断的实施可以依赖仍然有效的授权和执行指令。上下文清楚的实施指令不要求固定措辞或重复确认；如果活动不明确，继续处理 ready 的对齐工作，或只询问未解决的执行意图。

已批准行为或边界发生重大变化时，需要重新对齐、必要评审和批准；有条件批准属于调整，不是对未修订 contract 的批准。批准不会验证不确定事实，也不能替代 coverage 或 review。

Before handoff, match the actual execution instruction to the current aligned and authorized behaviors, including the reviewed contract where required, and check that unresolved work does not block that scope. An instruction limited to an old plan does not transfer to a materially changed plan; if withdrawn, invalidated, or unclear in scope, obtain a new instruction. A still-valid earlier instruction or one in the approval reply needs no repetition.

任何形式的实施交接都要携带适用的项目参与约定指针、已选决定的实际确认范围与必要精确结构，以及仍待确认的边界。明确相关部分编码前还需要达成哪些一致，不能把未决保留事项交给执行者自行补定。

A request to execute only an approved subset may be handed off only when it does not depend on unresolved work; retain the remaining alignment items. Calling workflows may require confirmation of their own conclusion, but that does not turn a Direct Result into a Formal Contract or expand implementation authority. Keep sources, reviewed scope, approval, and pending boundaries distinguishable in the handoff.

### 从边界违规中恢复

如果发现遗漏决策或过早实施，先报告实际变更：哪些由已确认决策和执行授权覆盖，哪些是 Agent 添加的，以及哪些仍未解决。暂停有效授权之外的进一步修改；讨论保留或修订当前状态，不要把后续工作伪装成实施前对齐。之后达成的共识可以授权未来处理，但不能证明早先已经存在授权。保留用户工作和依赖；撤销变更同样需要授权。

