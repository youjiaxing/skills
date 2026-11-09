# 维护：yjx-upstream-review

## 定位与已确认取舍

本仓库 Agent 使用的项目级维护 skill，正文位于 `.agents/skills/`，Claude 入口为相对符号链接；不属于顶层 `skills/` 中维护和全局链接的对外技能产品。

2026-11-08 对齐：对应来源变更精读加上游仓库轻量扫描；由用户决定是否吸收。调用只允许必要调查和真实核查进度维护，运行规则修改另行授权。本次创建入口不等于已执行首轮上游评估。

`metadata.internal: true` 利用 Skills CLI 的默认过滤，不是访问控制。创建时核对本机 Skills CLI 1.5.19 的发现和解析实现：默认跳过内部 skill，显式指定或 `INSTALL_INTERNAL_SKILLS` 可包含它。其他安装器或后续版本需重新核实。禁止模型自动调用由 `disable-model-invocation: true` 与 `agents/openai.yaml` 的 `policy.allow_implicit_invocation: false` 控制，正文不重复调用触发或频率说明。

具体来源关系和评估进度以各本地 skill 的 `MAINTENANCE.md` 为真源。README 的演进映射用于发现线索，不另建重复的固定来源名单。`yjx-retro-skill` 复盘实际使用，本入口评估上游变化。

## 仓库级扫描记录

### 2026-11-09 首轮检查

本次检查沿用已有宿主任务，不创建或调整调度；检查与评估不授予吸收改动的权限。

工作目录与 Git 根均为本仓库。当前宿主的技能列表未展示此内部入口，首次调用因此误判缺失；用户明确给出 `.agents/skills/yjx-upstream-review` 后读取完整入口继续。此事实不证明后续宿主已刷新发现列表。未修改入口、全局安装或调度；后续无人值守调用是否能定位入口仍需验证，不把这次显式路径补足当作发现机制已修复。

| 来源与关系 | 上次仓库扫描 | 本次固定目标（实际默认分支均为 main） | 扫描及评估范围 |
| --- | --- | --- | --- |
| mattpocock/skills；README 映射及各技能来源记录 | 未建立；多个路径有 2026-11-01 来源快照 `4ae2317…`，不是已完成的仓库扫描 | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | 首次盘点当前树、skill 描述、近期提交、CHANGELOG/changesets 和重点新增/删除。已知路径精读范围与结果记录在下列各技能维护文件；不声称全仓正文或脚本均已审计 |
| Panniantong/Agent-Reach；video-course 的获取路线参考 | 未建立；已知视频参考为 `94f06c1969dfc1834001269d79d3ad0972d9dee6` | `c70ae6da5d39bc90e09ad2ae0575ccc89f31e284` | 扫描引用版本到目标的路径变化和相关视频提交，追踪被删 video.md 到统一入口/能力边界与频道实现；详见 video-course 维护记录 |
| humanlayer/skills；用于核实 show-me 来源冲突的候选来源 | 未建立；不把当前安装锁视为历史派生基线 | `4d69d20f6e9b57b4fcf0d501ccfb1be961f0f329` | 列出当前 plugin/skill 路径，检查近期提交；精读 show-me 及相关调用策略提交、MIT LICENSE，并将固定目标文件 blob 与本地已记指纹核对。未评估其余 plugin 的行为 |
| bangtutorial/bang-motion；video-course 动画分支运行时依赖 | 未建立；已记录安装基线 `c1aa65e…` | `c1aa65e921c970d858705fcb4a53a8294d1a4131` | 当前树/提交与已记录安装基线一致，相关入口、references 和 starters 无提交增量；未升级或重新验收依赖 |

这是首次仓库级扫描；不能用上表声称此前未知扫描区间的新增、删除或重大调整已全部识别。Matt 的已记录来源快照与本次目标相等，故那些路径没有快照之后的新提交；prototype 的准确派生基线到目标全目录无增量。其余仅有来源快照的技能本轮补做首次当前能力评估，不把当前能力称为本次刚新增。

**已完成的路径评估与后续处理（各目标维护记录为真源）：**

- [yjx-implement](../../../skills/yjx-implement/MAINTENANCE.md)：I1，引用工单时读取实际正文、核实唯一身份并展示目标；后续经用户明确实施指令，已落地文档。
- [yjx-local-tracker-setup](../../../skills/yjx-local-tracker-setup/MAINTENANCE.md)：T1，兼容上游合法省略 triage 映射文件，缺省仅维护既有机器 JSON；已落地，并联动 [local-kanban](../../../skills/yjx-local-kanban/MAINTENANCE.md) 前提与 T2 旧 Closed 说明清理。
- [yjx-video-course](../../../skills/yjx-video-course/MAINTENANCE.md)：V1，yt-dlp 证书错误的条件化恢复已落地文档；参考获官方固定版本说明支持，未做本机网络验收。VTT 解析修复已有覆盖；不移植上游会话复制/云端转写。
- [yjx-show-me](../../../skills/yjx-show-me/MAINTENANCE.md)：S1，Matt 来源声明与一手证据冲突，已记录为待核；Humanlayer 固定目标文件与已记 blob 一致，但创作时安装来源和许可链仍未知。未改运行规则或 LICENSE。
- [yjx-to-spec](../../../skills/yjx-to-spec/MAINTENANCE.md)、[yjx-to-tickets](../../../skills/yjx-to-tickets/MAINTENANCE.md)、[yjx-wayfinder](../../../skills/yjx-wayfinder/MAINTENANCE.md)、[yjx-grill](../../../skills/yjx-grill/MAINTENANCE.md)、[yjx-prototype](../../../skills/yjx-prototype/MAINTENANCE.md)：当前相关能力已有覆盖，保留已确认的本地取舍，无新增采用项。
- [yjx-gh-kanban](../../../skills/yjx-gh-kanban/MAINTENANCE.md)：与上游 GitHub tracker 契约对应评估；保留原生关系边界，缺失标签映射已有默认值，无新增采用项。

**轻量扫描的其他结果：**

- Matt [implement-spec 的每票 fresh implementer](https://github.com/mattpocock/skills/commit/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa) 与 DAG/integration branch 编排值得检查，但本仓库 `yjx-issue-flow` 已有逐票 worker、frontier、指针交接、双轨集成和父级验收。本轮主代理核对了该入口与 worker-contract 的相关规则，撤销子调查因未覆盖此本地技能而提出的“缺少整份 spec 编排”候选，不另建重复入口；不声称全量运行验收。
- Matt [software-factory](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/in-progress/software-factory/SKILL.md) 与 chief-of-staff 属实验能力；触发去重/人类再介入以及有日期、commit 的知识记录有参考价值。本地交付、保存上下文和本入口的进度边界已有对应约束；未发现足够具体的新缺口，不新建 factory/wiki 或自动调度。
- Matt 的 `resolving-merge-conflicts` 在 [daa01d8](https://github.com/mattpocock/skills/commit/daa01d8aa68ad5c61b68970ec2018d0ce9567be6) 删除，发生在已记录快照之前，不是本轮新删除。没有发现本地需要随之删除的技能；不把 CLI 删除第三方安装副本等同于本地能力应该移除。
- 当前仓库的来源声明/演进映射中未确认 anthropics/skills、vercel-labs/skills 或 ConardLi/garden-skills 与本地产品技能的派生关系；早先全局更新日志不能单独建立关系，本轮不扩大到这些安装来源。Appium、飞书 CLI/SDK、FFmpeg 等常规工具/协议引用也不作为技能派生仓库全部巡检。

**限制与收尾：** 初始派生版本未知处保持未知；show-me 历史来源与许可链未解。首轮检查仅提出 I1/T1/T2/V1，随后四项方案经独立只读审查与用户明确实施指令，已在对应正文和维护记录落地；这不扩大本入口自行修改运行规则的权限。没有安装更新、提交推送、外部写入、真实看板/原型/下载验收或模拟对话测试。临时研究仅使用 `tmp/research/upstream-review-20261109/`，结论与必要证据入维护记录后由主代理定向清理；其他任务材料保留。

收尾静态验证：12 份维护文件中的 28 个本地链接与 26 个上游 commit/path 对象核对通过，`git diff --check` 通过；保留既有文档空白和其他任务的并行改动。此前本会话 grill 维护修改的原有内容核对保留。两组独立只读调查均已完成，由主代理复核决定性证据并综合记录；未把调查称为实施后独立评审。以上静态证据不证明提示词在实际任务中的可靠性。

同日吸收落地验证：相对编辑前工作区逐文件核对本任务差异；10 份变更文档的 24 个本地链接、3 个章节锚点、代码围栏与新增差异空白检查通过，3 份技能入口 frontmatter 未变。保留其他任务已有改动；未新增或运行提示词行为测试，静态检查不替代实际任务效果或证书环境验收。

未对应现有本地 skill 的有价值候选保留证据与待定状态；对应关系确认后，后续评估与决策转入目标 skill 的维护记录，并在此保留指针。

## 维护验证

使用静态文档审阅、YAML 解析、入口与链接检查、现有全局链接扫描及 Skills CLI 默认发现核验。核查默认过滤和显式发现时使用只列出能力，不执行安装。

遵守根 `AGENTS.md` 的 Skill Verification：不创建模拟会话或提示词行为测试。静态检查不能证明 Agent 在真实任务中稳定执行本流程；真实检查效果待实际调用观察。

2026-11-08 创建验证：YAML、技能内文档链接与 Claude 相对链接通过；现有全局链接扫描不收录本入口；本机 Skills CLI 1.5.19 的本地 `add . --list` 默认跳过本入口，增加 `--skill yjx-upstream-review` 时可以发现。独立评审因服务 HTTP 503 未返回结果，完成当前会话静态自审；未执行首轮上游检查或模拟行为测试。

同日按用户指定的 `gpt-6.1-sol @ medium`，通过宿主委派入口重试独立只读静态评审，评审完成且无修改发现；CLI 核验沿用主代理证据，评审者未独立复跑。原生子代理入口此前的 503 根因未确认，本次成功不作为原入口已恢复的证明。
