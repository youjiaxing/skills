# yjx-skills

个人维护、面向开源社区与多 Agent 平台的通用 Skills 库。Skill 统一采用 `yjx-` 前缀以降低命名冲突。

脚本以 **Node.js 标准库**为主；图片准备等能力按各 skill 声明 Python、Pillow 或编码工具依赖。工作流面向 Claude Code、Codex、Google Antigravity 等支持 Agent Skills 的平台，具体宿主能力按技能说明核验。

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
| `prototype` | **`yjx-prototype`** | 保留多布局比较、交互和逻辑演示；按需求选择沿用或重构，分阶段提供可判断的视觉与关键交互，将确认的产品表现交给正式实施。支持模型自动与手动调用，上游基线及本地取舍可追溯。 |
| `grilling` | **`yjx-grill`** | **解决问卷风暴与盲从陷阱**：动态决策树剪枝，显式呈现场景代价与关键假设；严格分离用户决策与伴随推断；输出单一语义归宿的实现契约，消除模板重复并保留实施关键约束。 |
| `to-spec` | **`yjx-to-spec`** | **解决过早生成、模板膨胀与遗留系统破坏**：先检查关键承诺是否就绪，再按领域编译并发布规格；保留行为边界、系统不变量、可验证的验收依据及已知决策理由，以现有契约为真源。 |
| `to-tickets` | **`yjx-to-tickets`** | **解决过度碎片化、魔数硬限与需求孤儿化**：以因果自洽、单会话无损收敛与审查自解释性为切分准则；内建覆盖率自检与不变量伴随注入；AFK 优先并显式分离 `ready-for-human` 门禁。 |
| `wayfinder` | **`yjx-wayfinder`** | **解决跨 Session 上下文爆炸与虚假发票**：构建轻量决策地图（Map as Index），仅实例化当前无阻塞的 Frontier 票；支持决策划线作废；闭环时自动将碎片化决策合成最终交付物。 |
| `setup-matt-pocock-skills` (Local) | **`yjx-local-tracker-setup`**<br>**`yjx-local-kanban`** | **规范完成语义与只读可视化**：将完成真源对齐为 `Status: resolved`（`+resolved-v1` 协议）；提供零依赖的人类看板、完整 JSON 依赖图与 Mermaid 拓扑。 |
| `implement` | **`yjx-implement`** | **解决五行裸指令、资产绕行、绿灯造假与过度测试**：遵循资产复用阶梯优先复用既有统一封装（如 `pkg/time`）；严禁私自删改断言伪造绿灯；可读性高于可测试性，禁止为 Mock 滥造伪接口；Pre-flight 基线勘测防历史旧账背锅；梯度验证梯杜绝全量测试卡死；严格服从项目治理，兼容多工单追溯。 |
| *(DingTalk 轨缺失)* | **`yjx-dingtalk`** | **只读解析本机钉钉缓存**：会话查找、按时间范围读取、关键词搜索、消息上下文展开，并尽力复用已有图片 OCR；严格只读共享、不重启客户端、不注入，撤回正文全通道默认隐藏。 |
| *(GitHub 轨缺失)* | **`yjx-gh-kanban`** | **原生扩展至 GitHub Issues 只读看板**：通过 `gh` CLI 统一解析 GitHub Issues 原生 `parent` 与 `blockedBy` 依赖树，提供终端依赖树与机器 JSON 契约。 |

---

## 核心交付主线与独立看板

本仓库构建了两条清晰、自包含的工程交付主线，以及独立的只读可视化跟踪支撑：

```
主线 1（单会话确定性工程交付）：
/yjx-grill ──────────► /yjx-to-spec ──────────► /yjx-to-tickets ──────────► /yjx-implement
(深度决策对齐)          (高内聚规范蓝图)         (原子因果切片)             (手术级精准实施)

主线 2（跨会话大迷雾探索交付）：
/yjx-wayfinder ──────► /yjx-to-spec ──────────► /yjx-to-tickets ──────────► /yjx-implement
(迷雾探索与收官合成)     (高内聚规范蓝图)         (原子因果切片)             (手术级精准实施)

══════════════════════════════════════════════════════════════════
独立支撑层（只读可视化依赖看板）：
├─ Local 轨: yjx-local-tracker-setup + yjx-local-kanban（.scratch/ Markdown 看板）
└─ GitHub 轨: yjx-gh-kanban（GitHub Issues 原生依赖看板）
```

### 1. 深度对齐与迷雾规划 (Alignment & Cartography)

- **`yjx-grill`**：深度拷问与压力测试。通过决策树剪枝、显式区分用户决策与 Agent 推断，输出以单一语义归宿组织的实现契约（预期表现、实现契约与验收标准），杜绝模板冗余与实施断层。
- **`yjx-wayfinder`**：跨 Session 大型模糊目标的探索式规划。在 Issue Tracker 上维护一张轻量决策地图，探索前沿决策票并逐层驱散认知迷雾，最终合成交付物。

### 2. 规范编译与原子切片 (Specification & Decomposition)

- **`yjx-to-spec`**：检查讨论共识、对齐产物或规划图的就绪程度；关键承诺不完整时停止，通过后直接在项目配置的正式目标创建或修订规格。按领域组织契约、行为边界、不变量与验收依据，允许不改变关键承诺的实现自由；具体规则见 [skill](skills/yjx-to-spec/SKILL.md)。
- **`yjx-to-tickets`**：将实现计划、规格说明书或会话共识拆解为单会话无损收敛、因果自洽、声明显式阻塞依赖且具备可证伪验收标准的示踪弹任务票据。

### 3. 手术级精准实施 (Surgical Implementation)

- **`yjx-implement`**：将对齐方案、架构设计、评审共识或任务工单落地为高可用生产级代码。按资产复用阶梯优先调用项目既有统一基础库，核心逻辑直击因果，杜绝为测而测的伪接口包装，内置 Pre-flight 基线勘测、梯度验证、零绿灯造假门禁与跨工单原子提交。

### 4. 独立可视化看板支撑 (Independent Read-Only Trackers)

- **Local Markdown 轨**：
  - **`yjx-local-tracker-setup`**：为 Local Markdown tracker 写入 `+resolved-v1` 机器配置。
  - **`yjx-local-kanban`**：只读输出 Local Markdown issues 的人类看板、完整 JSON 依赖图和 Mermaid。
- **GitHub Issues 轨**：
  - **`yjx-gh-kanban`**：基于 `gh` CLI 输出 GitHub Issues 人类看板（同构版式）与 `--json` / `--agent` / `--ready-only` 机器契约。

#### 双轨看板特性对比

| 特性 | `yjx-local-kanban` | `yjx-gh-kanban` |
| :--- | :--- | :--- |
| **数据源** | `.scratch/<feature>/issues/*.md` | GitHub Issues（通过 `gh` CLI） |
| **作用域** | 对应 feature 目录 | 默认整仓；可选 `--parent <id>` |
| **人类视图** | LEGEND / 依赖树 / NOW 聚焦区 | 同构版式（符号与排版语义严格对齐） |
| **机器契约** | 完整 JSON 依赖图 / Mermaid 拓扑 | `--json`（含 `next`/`ready`）/ `--agent` |

### 5. 本机钉钉只读解析

- **`yjx-dingtalk`**：只在用户明确要求查询钉钉时手动调用。以共享只读方式读取本机客户端已缓存的数据库与 WAL，现场推导 V3 密钥且不落盘；副本默认存于 `~/.yjx-dingtalk/`。不关闭或重启钉钉，不注入、不读进程内存，不改钉钉数据。撤回消息只输出元数据。真实数据验证目前仅覆盖 Windows（钉钉 9.0.1），macOS/Linux 的客户端兼容性仍属验收工作。
### 6. 会话后的 Skill 复盘

- **[`yjx-retro-skill`](skills/yjx-retro-skill/SKILL.md)**：实质任务结束后手动调用，依据当前上下文或原始会话记录复盘整个任务过程与用户每一次纠正，向已用/未调用 Skill 优化、新建或拆分 Skill 提议（输出概要卡片）、项目文档/Spec 及项目/用户级 `AGENTS.md` 四层去特例化分流。当前上下文完整时由主代理单代理直读，已压缩或跨会话时委派隔离子代理取证；默认只提建议不直接修改或创建 skill。

### 7. 飞书 Agent 桥接

- **[`yjx-feishu-agent`](skills/yjx-feishu-agent/SKILL.md)**：提供飞书群与 Codex 已有聊天的双向桥接，支持白名单、多群绑定、独立接收器、归档保护及重新绑定；可主动发送带图卡片、更新原卡片并发送变化提醒。已完成实群验收，Desktop 专属工具兼容性需另行验证。

### 8. Agent 诊断与新环境预检

- **[`yjx-agent-doctor`](skills/yjx-agent-doctor/SKILL.md)**：面向不同 Agent 的故障诊断与新环境预检，首版重点为第三方模型兼容性。默认诊断并给建议，按会话要求修复；通用流程配合按需读取的 Agent 适配和问题案例，核实当前适用性，不按历史配置盲目修复。后续可继续扩展 Agent 和真实案例。

---

### 9. 生活信息查询

- **[`yjx-life-query`](skills/yjx-life-query/SKILL.md)**：查询国内吃喝门店、周边去处、旅游活动与优惠，按信息字段选择来源并核验时效，交付地点事实、比较依据和高德/点评入口。完整行程与攻略制作由下方的 `yjx-travel-planning` 负责。

### 10. 旅行攻略与行程制作

- **[`yjx-travel-planning`](skills/yjx-travel-planning/SKILL.md)**：先将来源整理为可浏览、可复用的地点与体验攻略，保留相关图文、个人经验与避坑；需要编排本次行程时再制作时间表、路线和地图，并在计划变化时传播更新。事实查询复用 `yjx-life-query`，不在两个 Skill 中维护两套查询规则。

### 11. 原型与预期产品效果

- **[`yjx-prototype`](skills/yjx-prototype/SKILL.md)**：在任务已包含或授权原型、视觉方案比较、交互或状态演示时可自动调用，也支持手动调用。探索时制作结构不同且可操作的方案，选定后补齐确认范围；根据需求决定沿用现有页面、局部调整或整体重构。演示机制与产品设计分离，原型确认不自动启动生产实施。
- 原型制作与项目验证入口遵循目标项目规则；不要求安装上游 `prototype`。本仓库的 `yjx-wayfinder` 优先使用此 skill 处理适合的原型票。
- 已有派生 skill 的来源、历史基线缺口、当前对照快照及后续选择吸收记录，维护在各自 `MAINTENANCE.md`；“已核对来源”与“已评估或吸收行为变化”分别记录。

### 12. Agent 定时任务

- **[`yjx-scheduled-tasks`](skills/yjx-scheduled-tasks/SKILL.md)**：创建、修改或恢复 Agent 宿主的定时任务，整理已有长提示词。优先复用 skill、脚本和项目文档；需长期维护的独有任务指令保存在所属仓库，定时器只引用入口与必要参数。周期等设置留在宿主，环境现场核查；支持模型按需调用，不管理操作系统调度器。

## 通用图片读取

- **[`yjx-image-reading`](skills/yjx-image-reading/SKILL.md)**：预计持续截图、视频或素材识读的上下文累积值得隔离，或明确要求隔离时，准备保持分辨率的输入副本，并通过独立只读视觉子任务返回文字和来源索引。简单、一次性读图由主代理直接完成，不额外加载准备与派发流程；按整个任务判断，不设固定张数阈值。生活查询、旅行规划、视频课程、QQ、飞书、iPhone 和 `yjx-grill` 的隔离分支引用同一入口。依赖、运行验收和隔离限制见技能说明。

## 本仓库维护入口

在本仓库工作目录中手动调用 `$yjx-upstream-review`，检查启发来源的上游变化并获取选择吸收的建议；建议每月一次，发现上游更新时也可调用。人工确认后才实施现有 skill 的改进。

该项目级入口位于 [`.agents/skills/yjx-upstream-review/`](.agents/skills/yjx-upstream-review/SKILL.md)，Claude 通过 `.claude/skills/` 的相对链接读取同一份正文。它不属于顶层 `skills/` 的对外技能产品，也不进入 `make link` 的全局链接流程；Skills CLI 以内部标记默认过滤，显式选择仍可能安装。核查进度与实际吸收分别记录，入口创建不代表已执行检查。

## 个人全局提示词

[`prompts/`](prompts/) 保存跨 Agent 复用的个人沟通、工具选择和子代理协作规则，与可按需调用的 `skills/` 分开维护。通用公开规则收敛于唯一真源 [`prompts/AGENTS.md`](prompts/AGENTS.md)，私密或机器专有内容使用已被 Git 忽略的 `prompts.local/`。

通过 `developer-targets.local.yaml` 中的 `prompt_targets` 与 `npm run link` / `npm run force`，可将 Codex（`~/.codex/AGENTS.md`）、Grok Build（`~/.grok/AGENTS.md`）、Antigravity IDE & Agy CLI（`~/.gemini/config/AGENTS.md`）、Claude Code（`~/.claude/CLAUDE.md`）、CodeBuddy（`~/.codebuddy/CODEBUDDY.md`）等用户级全局入口以操作系统原生文件符号链接直接指向 [`prompts/AGENTS.md`](prompts/AGENTS.md)（或按对象格式指定独立源文件）。在 VS Code 中直接修改任一已链接入口即可同步更新仓库源文件与各宿主磁盘内容；详情参阅 [`prompts/README.md`](prompts/README.md)。

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
- **Claude Code / Codex / CodeBuddy Code** 等：采用目录软链接（macOS 为符号链接，Windows 为 junction）。
- **Google Antigravity**：采用原生配置挂载（自动维护 `~/.gemini/config/skills.json` 中的 `entries`，避开 Windows 软链接跨盘与穿透限制）。
- 隔离验证步骤请参阅 [`docs/development/verification.md`](docs/development/verification.md)。
