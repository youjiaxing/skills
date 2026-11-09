# 维护：yjx-gh-kanban

## 上游参照与关系

README 将本技能标为 Local 看板体系向 GitHub Issues 的独立扩展，未声明来自某个上游 GitHub 看板。本轮参照 Matt setup 的 GitHub tracker 契约，不因此补造直接派生关系或最初版本。

2026-11-09 固定 `mattpocock/skills@4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`，对照 [issue-tracker-github.md](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md)、setup 与 triage 映射，以及本地正文、ready label 缺省读取和关系加载相关代码；未做全量脚本审计或 GitHub 在线验收。

- 上游允许未装 triage 时不生成标签映射。本地 `resolveReadyLabel` 已只在 ENOENT 时使用默认值，无需重复添加缺失文件逻辑；不可读或损坏不按缺失处理。
- 上游 native parent/blockedBy 与正文 fallback 并存；本地明确仅认 native 关系、无法取得可靠关系时 fail-closed，保留该消费者边界，不因模板支持 fallback 就猜正文关系。
- 上游写入者需确认目标仓库、读完整 PR body、先评论再关闭等修正，不移植为只读看板的写入职责。

本次当前能力对应评估无新增吸收项，未改运行规则、未访问或修改真实 Issues。没有可信旧评估版本，不能把首次评估说成历史增量已全部吸收。
