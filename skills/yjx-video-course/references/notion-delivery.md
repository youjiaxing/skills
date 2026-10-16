# Notion 交付

用户要求保存到 Notion 时读取。本文件只处理写入、回读与恢复；证据门槛、自动审核和本地三方一致性以主 skill 与 [证据记录与自动审核](evidence-audit.md) 为准。只有本地草稿已推进到 `draft_audited` 才能进入本文件流程。

用户要求保存到 Notion 时，使用 `notion:notion-knowledge-capture` skill 的连接和写入能力；当前环境缺少连接时先报告阻塞，不假装保存成功。文件上传、页面创建、页面更新和回读都只能通过已连接的 Notion 工具完成；不得用 `curl`、脚本、手工 HTTP 请求、命令行参数或环境变量传递 Notion 令牌：

1. 先读取目标页面或数据库，确认真实父级、数据源、属性名称和现有页面，避免凭名称猜位置。
2. 目标库不存在时，在用户指定的父页面下创建；目标已存在时复用，不新建重复数据库。
3. 已有页面要先 fetch 当前内容，按来源身份检查是否重复；只修改本次获授权的目标。数据库属性只写已确认字段，观看日期、评级、实践状态和个人优先级留空，不从相邻集复制用户信息。
4. **本地全量审核与校验通过后才写这一集**：不先批量创建再筛选。写入前严格运行 `node scripts/validate-course-artifacts.mjs <evidence.json> <course.md> <证据目录>` 和 `node scripts/validate-delivery.mjs <delivery.json> <输出目录>`，确保课程正文、证据索引、磁盘聚焦图和交付 manifest 全部一致后才允许发起外部写入。
5. **并发图片上传与一步到位建页（极速写入闭环）**：
   - **图片并发上传**：先确认 Notion 连接器具备本地文件提交动作后，**并发调用**（如并行执行全部图片的上传会话创建与本地文件提交）为本次所需图片完成上传，一次性收集全部 `file-upload://` 引用；禁止单张图片串行等待。不支持时走文字/时间锚点降级，并在交付记录中说明图片未同步；
   - **一步到位创建**：因本地正文与三方一致性已在前序步骤通过严格校验，创建页面时**直接将目标属性（如“状态: 已整理”）一步写入**，正文中同时嵌入已获取的 `file-upload://` 图片块；禁止人为拆解成“草稿创建 -> 回读正文 -> 更新为已整理 -> 再次回读状态”的双阶段多轮往返；
   - **Notion 原生块与 Callout 规范**：Notion 原生不支持 GitHub 专属的 `> [!WARNING]` / `> [!NOTE]` 等 Alert 语法，且普通引用 `>` 中间带空行会被 Notion 错误拆散为多个断裂的 Quote 块并产生多余的“空白引用”占位符。针对警告、重点避坑或提示类内容，正文必须统一使用 Notion 原生的 `<callout icon="⚠️" color="orange_bg">` 标注块，保障在 Notion 页面中渲染为一体化的高亮卡片；
6. **单次最终回读核验（Single Verification Fetch）**：
   - 页面创建后，执行 **1 次且仅 1 次** 全量 fetch，一次性核验三个维度：
     1. **页面身份与正文完整性**：标题、父级正确，正文完整无截断；
     2. **原生图片块就绪**：图片已成功解析为 `notion-file-block://` 原生图片块，数量与文件名和本地 `visual_coverage.embedded_files` 严格一致，无临时上传 notice；
     3. **页面状态就绪**：属性“状态”已成功确认为“已整理”或目标库对应的完成选项；
   - 三项核验全部通过后，立即落盘 `notion-readback.json` 并将 `delivery.json` 流转至 `readback_verified` 和 `completed`；
   - 只有单次回读发现截断、丢块、图片失败或属性未生效时，才进入下述恢复流程；
7. **`INVALID_ARGUMENT` 强制恢复流程**：
   - 先重新 fetch 目标页面，确认页面仍存在、父级和当前正文未被部分修改；记录失败命令、参数形态和回读结果。
   - 重新为本次页面需要的全部图片创建短时 File Upload 会话，创建后立即通过连接器的本地文件上传动作提交；逐个确认 `status: uploaded` 和文件名。上传会话、授权头和签名 URL 都视为不透明凭据，不手工转录、拼接、写入 shell 命令、日志或环境变量。连接器没有可执行的本地文件上传动作时，改用已授权的 Notion 页面编辑界面或报告连接器能力缺口；不得自行实现裸 HTTP 上传。
   - 先用单个图片块做一次最小更新测试；若当前块是回读得到的 `notion-file-block://` 原生图片块，或最小更新返回 `INVALID_ARGUMENT`，不得继续重复同一搜索替换或只改图片语法。重新 fetch 后用完整正文重建，使用上传工具返回的 `file-upload://` 源，并保留页面属性、父级、子页面/数据库标签和未授权修改的正文内容。
   - 完整正文重建后立即 fetch；必须确认旧的 `notion-file-block://` 图片已不再出现、每个新图片的文件名和数量都正确。仍失败时再检查当前连接是否提供原生 block/image 更新能力；有则改用该能力，仍须回读图片文件名或图片源确认替换。
   - 若 API/MCP 明确不支持既有原生图片块替换，优先切换到已授权的 Notion 页面编辑界面完成替换；浏览器不可用时，才建立“同一父级、同一属性、同一标题”的替代页面，并将旧页面明确标记为待清理，禁止默默创建重复页面或继续声称原页面已同步。
   - 替代页面创建后必须 fetch 新页面，确认正文、图片、父级和状态；旧页面只能在用户已明确授权删除/移入回收站时处理，不能擅自删除。
8. **交付闭环与真实回读存证（Notion 回读契约规范）**：
   图片降级交付只能记录为内容已回读、图片未同步，不得声称 Notion 完整交付；只有正文、状态、图片数量和文件名全部在单次回读中一致时才进入 `completed`。没有适用状态字段时，记录“内容已回读，未设置完成状态”，不虚构选项。`notion-readback.json` 必须使用本次写入后的实际回读时间、页面 ID、父级、状态、正文图片数量和文件名，不得复制上一轮的旧回读记录。记录本次创建或更新的页面 ID，重试前据此读取实际状态，防止重复页和覆盖用户后续修改。

   `scripts/validate-delivery.mjs` 对 `delivery.json` 中的 `notion` 块有严格的代码级契约校验，写入与流转时必须显式包含以下规范字段，禁止漏填或格式不匹配：
   - `notion.requested`: 布尔值，当请求写入 Notion 时设为 `true`；
   - `notion.page_id`: 目标页面 ID 字符串（当状态推进至 `external_write` 及之后为必填项）；
   - `notion.content_readback`: 布尔值，正文完整回读无截断且包含真实正文结构时设为 `true`；
   - `notion.status_readback`: 布尔值，数据库属性（如“状态: 已整理”）已在回读中确认生效时设为 `true`；
   - `notion.status`: 字符串，目标页面在 Notion 数据库中的最终状态属性值（例如 `"已整理"`，当状态流转至 `completed` 时为必填项）；
   - `notion.pending_image_notices`: 数值，必须为 `0`（表示无任何临时未就绪的上传占位符）；
   - `notion.expected_image_filenames`: 预期嵌入的正文图片文件名数组（顺序须与 `evidence.json` 的 `visual_coverage.embedded_files` 严格一致）；
   - `notion.actual_image_filenames`: 单次全量 fetch 回读中实际解析出的原生图片块文件名数组（必须与 `expected_image_filenames` 逐项完全相等）。

   ```json
   {
     "state": "completed",
     "state_history": [
       { "state": "source_verified", "at": "2026-10-13T10:00:00.000Z" },
       { "state": "evidence_ready", "at": "2026-10-13T10:02:00.000Z" },
       { "state": "draft_audited", "at": "2026-10-13T10:05:00.000Z" },
       { "state": "external_write", "at": "2026-10-13T10:08:00.000Z" },
       { "state": "readback_verified", "at": "2026-10-13T10:09:00.000Z" },
       { "state": "completed", "at": "2026-10-13T10:10:00.000Z" }
     ],
     "notion": {
       "requested": true,
       "page_id": "28e21a20-22c6-81cf-9a99-f24fa93f619b",
       "status": "已整理",
       "content_readback": true,
       "status_readback": true,
       "pending_image_notices": 0,
       "expected_image_filenames": ["fig-01-speaker.png", "fig-02-architecture.png"],
       "actual_image_filenames": ["fig-01-speaker.png", "fig-02-architecture.png"]
     }
   }
   ```

**外部写操作的成功以后置状态为准**：执行前核对工具正式能力、参数和权限；首次操作即回读，确认目标字段、内容或回收站状态真的改变后才能报告成功并继续。核验失败则报告“未完成/状态未确认”，暂停扩大操作范围，不猜参数、盲目重试或换工具执行同一副作用。删除、归档和其他补救操作需要用户明确授权；工具返回 `completed` 或搜索不到页面本身不能证明删除成功。

连接器若只提供短时文件上传会话而没有当前宿主可执行的本地文件提交动作，不能把“上传会话已创建”当作图片已同步；应停止图片写入或走文字与时间锚点降级路径，并在 `delivery.json` 和回读记录中写明图片未同步。只有连接器支持的文件提交动作返回已上传且页面回读得到真实文件名时，图片才算完成同步。

