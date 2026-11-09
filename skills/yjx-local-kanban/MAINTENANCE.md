# 维护：yjx-local-kanban

## 来源与首次评估

README 演进映射将本技能及 `yjx-local-tracker-setup` 对应到 Matt 的 Local tracker setup；这是协议兼容与本地可视化扩展，不声明 Git fork。最初参考提交未知。

2026-11-09 固定上游 `mattpocock/skills@4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`，首次对照 [Local tracker 模板](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md)、setup 与 triage 映射，以及本地正文、配置验证、Status/Closed 解析和依赖分组相关代码；不是脚本全文审计，也没有可信历史增量基线。

每票一文件、Status/Comments、map/children、claimed/resolved、阻塞依赖均已有承接。保留完整图只读投影、Wayfinder/implementation 混合图、Status 主完成、legacy Closed 兼容与不替用户选择 next 的边界。

## 已采用项（2026-11-09）

- **T1 联动：** 已同步 [SKILL.md](SKILL.md) 的消费者前提，允许上游合法省略 `triage-labels.md`；设计与主要记录归 [tracker setup 维护记录](../yjx-local-tracker-setup/MAINTENANCE.md)。本技能不新建另一套缺省映射。
- **T2：清理 Closed 说明残留。** 已将“支持的票据格式”中的缺省等同显式 false、其它缺 Closed 票必须 fail-closed 两处旧说明统一到实际 Status 主完成协议，并澄清 `closedImplicit` 只标记缺字段且符合 Matt 原生模板识别条件的票。保留 legacy 字段兼容及缺 Status/冲突字段/无效依赖的处理。价值是避免合法票被误判或重新补入废弃字段；仅修改说明，成本低。这是本地一致性问题，不是上游新增功能。

两项经独立方案审查与用户明确实施指令后已落地文档；静态核对说明与相关脚本、链接的一致性，未改脚本或执行看板功能、模型行为测试。后续比较上述版本之后的相关变化，两项不再作为待采用项。
