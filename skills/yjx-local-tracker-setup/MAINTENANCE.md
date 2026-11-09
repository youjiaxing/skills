# 维护：yjx-local-tracker-setup

## 来源与首次评估

README 演进映射将本技能及 `yjx-local-kanban` 对应到 Matt 的 Local tracker setup；本技能是其后处理扩展，不是整套 setup 的替代品。最初参考的准确提交未知，不用当前上游倒填。

2026-11-09 固定 `mattpocock/skills@4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`，首次精读 `skills/engineering/setup-matt-pocock-skills/` 的 `SKILL.md`、`issue-tracker-local.md`、`triage-labels.md`、`issue-tracker-github.md` 和 `domain.md`，对照本地正文及 Local 看板配置验证的相关代码。此前无可信已评估版本，本次为当前能力评估，不声称精确复原历史更新差异。

## 已采用 T1（2026-11-09）：允许合法缺省的 triage 映射

上游 [setup 的 Section B](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md#L53) 明确未安装 triage 时跳过标签配置，不创建 `triage-labels.md`。首次评估时本地将该文件列为硬前提，导致合法 Local setup 后仍可能无法运行本扩展；这是首次对照发现的兼容缺口，不是本轮新增的上游行为。

经独立方案审查与用户明确实施指令，已调整 [SKILL.md](SKILL.md) 的前提、映射来源、完成标准和预览步骤，并同步 `yjx-local-kanban` 的前提。缺省映射仅保存在既有 `local-tracker.json`，因为看板实际只从该 JSON 加载映射，无需再建平行 Markdown 真源。已有自定义映射保留，合法缺省、冲突及损坏的处理以正文为准；不改五态协议、不批量改票、不增加新一轮审批。

收益是让未使用 triage 的合法 Local 项目可接入；成本是少量跨文档规则调整及缺省来源澄清，核心看板脚本不必因此重写。默认角色参考 [固定上游映射](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/triage-labels.md)。

## 已有覆盖与边界

保留 `+resolved-v1`、Status 主完成真源和既有纪律迁移。远端可达性检查、平台创建标签、Git 初始化和领域文档命名仍由原 setup/项目管理，不复制到本地后处理。T1 已落地文档，验证限于静态审阅、一致性和链接检查；未运行项目 setup 或模型行为测试，未改看板脚本。后续比较固定版本之后的相关变化，T1 不再作为待采用项。
