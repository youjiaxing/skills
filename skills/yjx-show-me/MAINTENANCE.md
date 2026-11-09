# Maintenance: yjx-show-me

评审、修改或重新设计本 skill 时读取。运行时规则由 [SKILL.md](SKILL.md) 负责；本文件记录来源、取舍和更新依据。

## 上游与准确基线

| 项目 | 记录 |
| --- | --- |
| 来源 | 原记录为 Matt Pocock / skills；2026-11-09 核查发现归属冲突，历史来源待核，见下文证据 |
| 原记录路径 | `skills/engineering/show-me/` 未在本次 Matt 固定目标中找到；当时读取的是本机安装副本 `C:\Users\Administrator\.agents\skills\show-me\SKILL.md` |
| 基线文件指纹 | `SKILL.md` git blob `f0ccd047c136d7b702b385e0ecad775ccb773eae` |
| 关系 | 在上述已知 blob 内容基础上独立维护的个人中文增强版；内容指纹与仓库来源归属分别核实 |
| 许可 | 现有 [LICENSE](LICENSE) 为 MIT、署名 Matt Pocock；该署名的来源依据待核，本轮未改版权文件 |

## 能力承接与本地取舍

| 上游能力或做法 | 本地处理及理由 |
| --- | --- |
| 伪代码、调用树、组件树、浅层文件树、Mermaid、微型 `diff`、完整代码块、单文件 HTML | 完整保留全部最小可视化视口。 |
| `disable-model-invocation: true`（仅手动调用） | 改为模型可自动调用（移除 `disable-model-invocation: true`，`agents/openai.yaml` 设 `allow_implicit_invocation: true`），以便在项目 `AGENTS.md` 约定及代码解释场景下由模型自主触发。 |
| 逻辑统一用抽象伪代码或 Mermaid 展示 | 针对复盘证据（解释仓库既有代码实现时仅画 Mermaid/抽象伪代码导致脱离源码签名与分支细节），新增首要规则：解释或走读仓库既有代码实现机制时，优先采用“顶层精简调用树 + 保留真实函数签名、核心分支条件与状态读写的缩写代码块”并配一两句说明。 |
| 固定 `Bash(open ...)` 打开 HTML | 改为平台中立的在当前平台默认浏览器打开表述，适配 Windows 与跨平台环境；同时按本地分级限制仅当用户明确要求 HTML/网页展示，或内联代码、调用树与 Mermaid 确实无法表达多维布局/状态对比时才生成并打开 HTML，常规代码走读默认使用内联视口。 |
| 外部启发：`ayghri/i-have-adhd` 与 `panda850819/i-have-adhd-zh-tw` 的高信噪比输出原则 | 合并首段与《呈现准则》为单一权威规则：每个主题首句直接给出核心机制结论或答案并紧接放置视口，文字仅保留当前问题所需的事实、调用、状态与边界，使用直接动词与字面行动，不写首尾寒暄、过程复盘或空泛黑话；不引入强制两层缩排列表或每组 5 项硬截断。 |

## 更新核查与吸收记录

| 日期 | 核查范围与版本 | 实际吸收/保留差异 | 验证及剩余限制 |
| --- | --- | --- | --- |
| 2026-11-02 | 读取本机 `show-me/SKILL.md`（blob `f0ccd047c136d7b702b385e0ecad775ccb773eae`）全文 | 建立首版 `yjx-show-me`，改为模型可调用并补充既有源码走读的“顶层精简调用树 + 真实代码缩写块”规则 | 静态审阅与 `make link` 链接验证 |

### 2026-11-09 来源冲突与当前能力复核

- Matt 固定目标 `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` 的树和指定路径历史未找到 `skills/engineering/show-me/`；其 [pr/CREDITS.md](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/pr/CREDITS.md) 明说 show-me 来自 Dex Horthy / Humanlayer，且不属于该仓库。这是原归属的反证，不证明 Matt 历史上绝无任何其他路径的副本。
- 对候选来源 Humanlayer 固定默认分支目标 `4d69d20f6e9b57b4fcf0d501ccfb1be961f0f329` 做 `ls-tree` 与内容 hash 核对：[plugins/show-me/skills/show-me/SKILL.md](https://github.com/humanlayer/skills/blob/4d69d20f6e9b57b4fcf0d501ccfb1be961f0f329/plugins/show-me/skills/show-me/SKILL.md) 的 blob **恰为**原记录的 `f0ccd047c136d7b702b385e0ecad775ccb773eae`。这是固定 commit/path 的内容匹配，不单凭它推断 11 月 2 日安装副本的获取来源。
- 全文复核上述 blob 与本地正文、维护说明、入口配置和现有 LICENSE。全部视觉菜单已承接；本地真实源码缩写块、微型 diff 边界、跨平台 HTML 和模型可调用取舍保留。候选上游手动调用限制 [bba9d13](https://github.com/humanlayer/skills/commit/bba9d13ab34f0a87f1cc33df4dd196372393ddfc) 已在该 blob 中，本地有明确不采用理由，不作为新缺口。未发现需要新增的运行能力。
- **待核实 S1：** 历史安装源与对应许可。Humanlayer 固定目标的 [LICENSE](https://github.com/humanlayer/skills/blob/4d69d20f6e9b57b4fcf0d501ccfb1be961f0f329/LICENSE) 是 MIT、署名 HumanLayer，和本地署名不同。需要核实创作时实际来源及许可链，再决定是否补充/更正归属；不自动删除现有署名或把候选来源当作已确认派生源。

本轮仅更新来源核查记录，未改运行规则、调用策略或 LICENSE。历史来源未解决前，后续可从上述候选固定版本核对内容，但不能声称它是已确认的历史派生基线。静态检查不证明提示词行为可靠性。

### 2026-11-09 高信噪比呈现准则与 HTML 视口分级

- **外部启发吸收（`ayghri/i-have-adhd` 与 `panda850819/i-have-adhd-zh-tw`）：** 吸收“首句直给结论/答案”与“直接动词/字面行动、剔除首尾寒暄与空泛黑话”的高信噪比原则，将首段与《呈现准则》归并为单一权威定义；明确排除强制两层缩排列表与每组 5 项硬截断，避免在代码机制走读时造成信息碎片化。
- **本地用户决策（Q4）：** 保持本 skill 为模型可自动调用，同时将内联轻量视口设为默认，将“生成单文件 HTML 并在浏览器打开”限定于用户显式要求 HTML/网页展示或内联视口与 Mermaid 确实无法承载的多维布局/状态对比，消除日常代码问答自动触发时意外弹窗的干扰。

## 静态维护检查

- `SKILL.md` 不设 `disable-model-invocation: true`，与 `agents/openai.yaml` 的 `allow_implicit_invocation: true` 一致。
- 解释仓库既有代码实现机制时，“顶层精简调用树 + 关键真实代码缩写块”规则位于视口列表首位，与纯算法伪代码边界清晰。
- 微型 `diff` 视口明确限定于组件树、目录树、调用链或简短状态/配置片段等短小结构化骨架，自然语言规则、长段落文档或方案建议的增改直接使用结构化正文或列表陈述。
- HTML 浏览器视口具备明确触发边界，常规代码走读默认使用内联视口；《呈现准则》集中承载“首句结论先行 + 紧接视口 + 字面直接表述”且与首段无重复定义。
- 第三方 `C:\Users\Administrator\.agents\skills\show-me\SKILL.md` 保持未修改。

遵循仓库 [Skill Verification](../../AGENTS.md#skill-verification)：静态文档审阅、一致性、包装和链接检查，不创建或运行模拟会话行为测试。
