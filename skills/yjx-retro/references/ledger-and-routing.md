# 台账、落地回查与改进介质分流

本参考在 [SKILL.md 第 3 节](../SKILL.md) 评估修改落点、读写跨会话双账本或执行建议落地回查时加载。

## 跨会话双账本与防膨胀边界

统一由确定性脚本 `scripts/retro-ledger.mjs` 管理状态（默认位于 `~/.yjx-retro/`，可通过环境变量 `YJX_RETRO_STATE_DIR` 覆盖，按 `global` 与项目哈希分片，不写入业务仓库）。**严禁由模型直接读写或编辑台账文件**；脚本使用原子文件锁、临时文件原子替换及 `(patternKey, sessionId)` 幂等计数，支持多个并行 `yjx-retro` 会话同时操作。

1. **前置查询（只读压缩切片）：**
   ```bash
   node "<skill-dir>/scripts/retro-ledger.mjs" query --cwd "<workspace>" --format md
   ```
   查询仅返回当前作用域最近至多 3 条 `applied`（用于落地回查）、已达晋升门槛的 `readyCandidates`、待累积的活跃弱候选，以及 `rejectedKeys` 指纹清单（已拒绝项默认 180 天滚动保留、单作用域至多 200 条 LRU，不向用户反复推销，除非本次出现新反证或用户显式要求重审）。
2. **弱信号暂存与晋升：**
   单次会话证据不足以立刻改正式规则或 Skill 时，记录为候选（非高危安全条目默认 60 天未复发自动过期，单作用域上限 50 条 LRU）：
   ```bash
   node "<skill-dir>/scripts/retro-ledger.mjs" record-candidate --pattern-key "<slug>" --summary "<不超过200字短述>" --session-id "<id>" --scope "<project|global>" --cwd "<workspace>" [--file "<relative-path>"] [--safety]
   ```
   当不同独立会话累积达 `>= 2` 次（或属高危安全红线 `--safety`），自动进入正式修改提案。
3. **决策落地记录：**
   用户确认采纳、延后或明确拒绝后，写入最终状态（`applied` 与 `rejected` 会自动将同 `patternKey` 从活跃候选池移除）：
   ```bash
   node "<skill-dir>/scripts/retro-ledger.mjs" record-decision --pattern-key "<slug>" --decision "<applied|deferred|rejected>" --summary "<短述>" --target "<目标文件路径>" --session-id "<id>" --scope "<project|global>" --cwd "<workspace>" [--file "<relative-path>"]
   ```

## 前次建议落地回查（Follow-through）

若前置 `query` 返回了同作用域最近 `applied` 记录：

1. 检查目标文件或近期提交中是否仍能定位到对应规则/脚本；若找不到（或脚本已自动报 `missingFiles`），诚实记为 `missing`（未见落地证据），不得猜成已完成。
2. 对照本次会话过程：若规则已落地但仍发生同类纠错或绕过，将状态标为 `ineffective`（文字规则失效），优先在本次提议升级为确定性脚本/Hook，或精简重写该规则；验证仍有效则标为 `verified`：
   ```bash
   node "<skill-dir>/scripts/retro-ledger.mjs" mark-followthrough --pattern-key "<slug>" --status "<verified|ineffective|missing>" --scope "<project|global>" --cwd "<workspace>" [--note "<简述>"]
   ```

## 整改介质分流（脚本/Hook 优先于加文字）

提出任何改进前，先判断问题是否属于**条件可机器判定、靠口头提醒仍反复漏跑或误改**的机械约束（例如：特定危险命令拦截、敏感/生成文件误编辑、提交或收尾前忘跑校验、固定格式检查）：

1. **跨宿主通用护栏优先**：优先建议新增或加固仓库内确定性脚本、`package.json` script、构建校验或 Git Hook，而非继续给 `AGENTS.md` / `SKILL.md` 追加提示词；**严禁为 Markdown、Prompt、Skill、`AGENTS.md` 等文本型文件创建模拟对话行为测试或对应单元测试**。
2. **宿主专属 Hook（仅条件匹配时可选）**：仅当确认目标工作环境运行 Claude Code（且项目使用 `.claude/` hooks 或 `hookify`）时，才可补充建议 `PreToolUse` / `PostToolUse` / `Stop` Hook 或 `.claude/hookify.<name>.local.md` 正则防呆规则；不得把单一宿主的 Hook 格式强加为通用前置条件。
3. **判断型规则才进文档四层**：需要结合上下文做语义权衡的准则，按主 `SKILL.md` 第 3 节四层作用域精确落位。

## 目标文件陈旧性与体量核查

向已有规则文件或 Skill 提议修改前，必须核查：

1. **体量与截断**：检查目标文件当前字节数/行数及适用宿主的上下文预算（如 Antigravity 单规则文件上限约 24,000 字节、Skill 正文建议控制在 500 行内或拆分到 `references/`）；接近上限或已显臃肿时，优先提议精简合并旧条文、清理冗余或按作用域拆分，而非继续追加。
2. **涉及区段陈旧性**：核对本次修改所涉区段引用的本地路径、脚本命令和依赖名称是否仍真实存在；若已失效或断链，一并提议清理或修正，不向已废弃结构继续打补丁。
