# yjx-skills

个人维护、面向开源社区与多 Agent 平台的通用 Skills 库。Skill 统一采用 `yjx-` 前缀以降低命名冲突。

全库脚本均以 **Node.js 标准库**为主，无专有 SDK 或专有运行时依赖，兼容 Claude Code、Codex、Google Antigravity 等各类支持 Agent Skills 的平台。

## 安装

通过 Skills CLI 安装全量或指定 Skill：

```bash
# 安装全部 skills
npx skills add youjiaxing/skills

# 只安装指定 skill
npx skills add youjiaxing/skills --skill yjx-grill
```

---

## 为什么会有这些 Skills？（背景与演进）

本仓库的核心技能源于对经典 Agent 工作流（特别是 [`github.com/mattpocock/skills`](https://github.com/mattpocock/skills)）在真实复杂工程与深度决策场景下的反思、重构与精准替换。

### 演进与替换对照表 (Evolution & Replacement Matrix)

| 原版 (mattpocock/skills) | 本仓库强化版 (yjx-skills) | 解决的核心痛点与关键演进 |
| :--- | :--- | :--- |
| `grilling` | **`yjx-grill`** | **解决问卷风暴与盲从陷阱**：动态决策树剪枝，显式呈现场景代价与关键假设；严格分离 P0 用户决策与 P1 伴随推断；输出 4 部分领域自适应对齐产物，杜绝长文叙事幻觉。 |
| `to-spec` | **`yjx-to-spec`** | **解决 User Story 语义通胀与遗留系统破坏**：废除八股模板，以状态转移表与强类型接口为真源；引入 `Touched Areas`（物理修改白名单）与 `System Invariants`（系统不变量）；内建 ADR-Lite 记录被废弃方案以防反复回退。 |
| `wayfinder` | **`yjx-wayfinder`** | **解决跨 Session 上下文爆炸与虚假发票**：构建轻量决策地图（Map as Index），仅实例化当前无阻塞的 Frontier 票；支持决策划线作废；闭环时自动将碎片化决策合成最终交付物。 |
| `setup-matt-pocock-skills` (Local) | **`yjx-local-tracker-setup`**<br>**`yjx-local-kanban`** | **规范完成语义与只读可视化**：将完成真源对齐为 `Status: resolved`（`+resolved-v1` 协议）；提供零依赖的人类看板、完整 JSON 依赖图与 Mermaid 拓扑。 |
| *(GitHub 轨缺失)* | **`yjx-gh-kanban`**<br>**`yjx-gh-ralph`** | **原生扩展至 GitHub Issues 并杜绝失控 Auto-Run**：通过 `gh` CLI 统一管理 GitHub Issues 依赖树；单票手动确认 $\rightarrow$ 实施验证 $\rightarrow$ 提交收尾，**严禁无人看管的连续多票死循环**。 |
| — | **`yjx-discuss`** | **轻量收敛工具**：提供每轮一问、事实先行的极简讨论流，在进入深度拷问或正式出图前快速收敛想法。 |

---

## Skills 全景与工作流

本仓库 Skills 按 Agent 认知与执行的完整生命周期进行组织：

```
[1. 认知与对齐]                 [2. 规划与规范]                [3. 跟踪与实施]
 ├─ yjx-discuss (快速收敛)       ├─ yjx-wayfinder (迷雾决策地图)  ├─ Local 轨 (setup + kanban)
 └─ yjx-grill (深度拷问对齐) ───►└─ yjx-to-spec (规范蓝图编译) ─►└─ GitHub 轨 (kanban + ralph)
```

### 1. 认知与对齐 (Thinking & Alignment)

- **`yjx-discuss`**：轻量对话收敛想法。按“暂缓执行、事实先行、每轮一问、主动质疑、收敛总结”原则推进，用于早期的模糊想法梳理。
- **`yjx-grill`**：深度拷问与压力测试。通过决策树剪枝、显式区分用户决策（P0）与 Agent 推断（P1），输出包含核心模型、推断规则、执行规格与禁止事项的 4 部分对齐产物。

### 2. 规划与规范 (Planning & Specification)

- **`yjx-wayfinder`**：跨 Session 大型模糊目标的探索式规划。在 Issue Tracker 上维护一张轻量决策地图，探索前沿决策票并逐层驱散认知迷雾，最终合成交付物。
- **`yjx-to-spec`**：将讨论共识/对齐产物/规划图编译为高内聚、自包含的规范蓝图（Spec Blueprint）。明确声明系统不变量、修改物理白名单（Touched Areas）与准备度雷达。

### 3. 任务跟踪与实施 (Trackers & Workflow)

#### Local Markdown 轨（本地文件式）
- **`yjx-local-tracker-setup`**：为 Local Markdown tracker 写入 `+resolved-v1` 机器配置，并对齐约束文档为 `Status: resolved` 真源。
- **`yjx-local-kanban`**：只读输出 Local Markdown issues 的人类看板、完整 JSON 依赖图和 Mermaid。

#### GitHub Issues 轨（云端协作式）
- **`yjx-gh-kanban`**：基于 `gh` CLI 输出 GitHub Issues 人类看板（同构版式）与 `--json` / `--agent` / `--ready-only` 机器契约。
- **`yjx-gh-ralph`**：从 GitHub READY 池推荐并启动单张 issue；用户确认后实施、验证并提交；单票结束，**禁止 auto-run**。

#### 双轨看板特性对比

| 特性 | `yjx-local-kanban` | `yjx-gh-kanban` |
| :--- | :--- | :--- |
| **数据源** | `.scratch/<feature>/issues/*.md` | GitHub Issues（通过 `gh` CLI） |
| **作用域** | 对应 feature 目录 | 默认整仓；可选 `--parent <id>` |
| **人类视图** | LEGEND / 依赖树 / NOW 聚焦区 | 同构版式（符号与排版语义严格对齐） |
| **机器契约** | 完整 JSON 依赖图 / Mermaid 拓扑 | `--json`（含 `next`/`ready`）/ `--agent` |
| **调度伙伴** | — | `yjx-gh-ralph`（单票确认实施，无失控循环） |

---

## 开发者指南

用于本仓库自身的开发维护与本地链接同步（普通 Skill 使用者无需此配置）。

### 环境与初始化

- 要求：Node.js 20+、npm、（可选）GNU Make
- 初始化：
  ```bash
  npm install
  npm run init    # 本地首次初始化 developer-targets.local.yaml
  ```

### 维护命令

```bash
npm run link                    # 创建或校验到各 Agent 目录的开发链接
npm run status                  # 检查链接状态（只读，不修改文件）
npm run force                   # 强制清理冲突并重建链接
npm run prune                   # 清理本仓库已删除 skill 的陈旧链接
npm test                        # 运行单元测试
```

*Makefile 提供相同入口：`make`、`make link`、`make status`、`make test` 等。*

### 跨平台挂载机制
- `skills/` 的直接子目录只要包含 `SKILL.md` 即被识别为有效 skill。
- **Claude Code / Codex** 等：采用目录软链接（macOS 为符号链接，Windows 为 junction）。
- **Google Antigravity**：采用原生配置挂载（自动维护 `~/.gemini/config/skills.json` 中的 `entries`，避开 Windows 软链接跨盘与穿透限制）。
- 隔离验证步骤请参阅 [`docs/development/verification.md`](docs/development/verification.md)。
