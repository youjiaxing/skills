---
name: yjx-local-tracker-setup
description: 在 Matt Local Markdown tracker 上写入 resolved-v1 机器配置，并强制对齐约束文档完成真源为 Status: resolved；先预览后确认再写；Closed 仅 legacy。
argument-hint: "[项目根目录]"
disable-model-invocation: true
---

# Local Tracker Setup

为已经由 `setup-matt-pocock-skills` 配置为 **Local Markdown** 的项目：

1. 写入 **kanban 可读的机器配置**（`+resolved-v1`）；
2. **强制对齐约束文档**：完成真源改为 **`Status: resolved`**（`Closed: true` 为废弃旧写法，仅 legacy 只读兼容）。

本技能不是 Matt setup 的替代品，也不复制 `to-spec`、`to-tickets` 或 `implement`。

**无附属脚本。** Agent 直接读文件、改文件；不要找 `scripts/` 或跑 Node setup。

**完成判据：** 机器配置已是下方目标 JSON（protocol `+resolved-v1`，`statusRoles` 与 triage 一致）**且** 约束文档已以 `Status: resolved` 为主完成真源。只写 JSON、不改仍写「Closed 完成」的合同 = **setup 未完成**。

## 前提

项目必须已经存在：

```text
docs/agents/issue-tracker.md
docs/agents/triage-labels.md
```

`issue-tracker.md` 必须声明 Local Markdown，且路径形态为 `.scratch/<feature>/issues/<NN>-<slug>.md`。不满足则停止，要求先跑 `setup-matt-pocock-skills` 并选 Local Markdown。

默认项目根 = 当前工作区；用户若给了路径则用该路径。

## 协议（机器配置）

写入固定路径：

```text
docs/agents/local-tracker.json
```

目标内容（`statusRoles` 的**值**必须从 `docs/agents/triage-labels.md` 表「Label in our tracker」列读取；下表仅为 Matt 默认同名示例）：

```json
{
  "schemaVersion": 1,
  "protocol": "matt-local-markdown+resolved-v1",
  "trackerRoot": ".scratch",
  "completionField": "Closed",
  "statusRoles": {
    "needs-triage": "needs-triage",
    "needs-info": "needs-info",
    "ready-for-agent": "ready-for-agent",
    "ready-for-human": "ready-for-human",
    "wontfix": "wontfix"
  }
}
```

| 字段 | 规则 |
|------|------|
| `schemaVersion` | 固定 `1` |
| `protocol` | 固定 `matt-local-markdown+resolved-v1`（若现有为 `+closed-v1`，确认后升级） |
| `trackerRoot` | 固定 `.scratch` |
| `completionField` | 固定 `"Closed"`——仅供 kanban **读取** legacy 字段名，**不是**要求新票写 Closed |
| `statusRoles` | 五个 canonical key 齐全；value 来自 triage 表，彼此不重复 |

### 完成语义（与 yjx-local-kanban 一致）

| 字段 | 含义 |
|------|------|
| **`Status: resolved`** | **主完成真源**（implementation 与 Wayfinder 统一） |
| **`Status: wontfix`** | 终态；解除下游阻塞 |
| **`Status: claimed`** | 进行中 / 认领（可选执行锁） |
| **`Closed`** | **legacy**：kanban 过渡期仍认 `Closed: true`；**新票不要写** |

**约束文档必须写清上述语义。** 禁止再写「Closed 唯一真源」「新票必须 `Closed: false`」「完成必写 `Closed: true`」。

Wayfinder：开放未领可无/空 `Status`；领取 `claimed`；完成 `resolved`。本 setup **不**改 wayfinder 票正文。

## 流程

### 1. 只读预览（不改文件）

读取并核对：

1. **前提**：`issue-tracker.md`、`triage-labels.md` 存在且为 Local Markdown。
2. **目标 config**：按上节拼出目标 `local-tracker.json`（含真实 `statusRoles`）。
3. **现有 config**（若有 `docs/agents/local-tracker.json`）：
   - 不存在 → action `create`
   - 存在且与目标一致 → action `none`
   - 存在但不一致（含 legacy `+closed-v1`）→ action `replace`（注明将升级）
4. **约束文档**（存在则读；主 tracker 必读）：

| 路径 | 角色 |
|------|------|
| `docs/agents/issue-tracker.md` | **主合同**（必对齐） |
| `agents-local.md` / `agents-global.md` | Agent 纪律（若谈关票/完成） |
| `Agents.md` / `AGENTS.md` / `Claude.md` / `CLAUDE.md` | 入口纪律（若谈关票/完成） |
| `CONTEXT.md` | 若写完成闸门 / 调度关票语义 |

对齐判定（主 tracker **全部**满足；其它文件仅在「谈关票/完成」时适用）：

- **已对齐**：明确完成 = `Status: resolved`（可写 `wontfix` 终态）；`Closed` 若出现，只作 legacy 只读兼容说明，**不是**完成必做步骤。
- **未对齐**：完成仍要求 `Closed: true`；或把 Closed 当唯一真源；或主 tracker 完全没有 implementation 的 `resolved` 完成合同（Matt 默认模板常见）。
- 允许在「已 resolved 为主」的文中提及 legacy `Closed: true`（不算未对齐）。

5. **票盘点（可选摘要，非阻塞）**：粗扫 `.scratch/*/issues/*.md` 即可——约多少实施票、是否仍见 legacy `Closed`、是否明显缺 `Status`。**不要**把「缺 Closed」当必须迁移；**不要**在本 skill 批量改票。

把预览摘要用中文给用户（config action、是否需升级协议、哪些约束文档未对齐）。**此步不写盘。**

### 2. 请求确认

选项从 1 编号，**推荐项必须是 1**：

1. **写机器配置 + 对齐约束文档到 `Status: resolved`**（推荐）  
   - 推荐理由：配置与合同一致；Agent / kanban / implement 关票不再分裂。
2. **仅预览 / 暂不改**  
   - 不采纳为默认：问题仍在。

**不要**把「只写 JSON、文档以后再说」标成推荐项。  
**不要**提供「给票塞 `Closed: false`」类迁移（已废弃）。

若 config 已是目标且约束文档已对齐：说明 **setup 已完成**，无需再写。

只有用户明确确认选项 1 后才进入写入。

### 3. 写机器配置

用户确认后，写入（或覆盖）`docs/agents/local-tracker.json` 为步骤 1 拼出的目标 JSON（合法 JSON，缩进 2 空格，文件末尾换行）。

### 4. 对齐约束文档（必做，若步骤 1 判定未对齐）

#### `issue-tracker.md` 必须写明

- 完成：`Status: resolved`（`wontfix` 亦为终态）；
- 可领取：triage 五态（如 `ready-for-agent`）或 Wayfinder 空/`open`；
- 认领（可选）：`Status: claimed`；
- **`Closed: true` 仅 legacy**；**新票不要写 Closed**；
- 哪个 skill 在实现成功后写 `resolved`（默认：`/implement` 成功后关票，或本仓 agents-local 纪律）。

最小完成头示例：

```markdown
**Status:** resolved
```

#### 改写规则

- 把「完成 = `Closed: true`」改为「完成 = `Status: resolved`」；
- 若需提及 Closed：仅说明 kanban **过渡期只读兼容**，不得再当必做步骤；
- 同步改步骤 1 列出的、谈关票/完成的其它纪律文件；
- 不批量改 `.scratch` 旧票；不推断旧票是否已完成；
- 不改 wayfinder `map.md` 与票正文（除非用户另开任务）。

### 5. 复核

再读一遍 `local-tracker.json` 与改过的约束文档：

1. config 与目标一致（protocol `+resolved-v1`，roles 正确）；
2. 约束文档以 `Status: resolved` 为主完成真源。

可选：若装了 `yjx-local-kanban`，用 `make kanban` 等核对图（非必须）。

未满足 1+2 不得宣称 setup 完成。

## 边界

- 不发布或重拆 issues；
- 不推断旧票是否已完成；
- 不通过 checklist/commit 猜测完成；
- 不修改 wayfinder 的 `map.md` 或带 `Type: research|prototype|grilling|task` 的票；
- 不要求必须安装 kanban 才能跑 setup；
- 不塞、不迁移票上的 `Closed` 字段；
- 与 **`yjx-local-kanban`** 合同一致：`+resolved-v1` + legacy `Closed: true` 只读兼容。
