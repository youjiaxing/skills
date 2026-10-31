# 大众点评采集契约

## 调用和范围

从本 Skill 目录执行；输出路径的父目录须存在，使用本轮新的文件名：

```bash
node scripts/iphone-app-ops.mjs dianping-search \
  --query '厦门 咖啡' --max-pages 3 \
  --extract-output /tmp/dianping-new-run.json
```

默认最多 3 屏，允许 1–5 屏。没有分页接口，总量指实际滚动观察的屏幕。当前解析器适配竖屏、单列、含评价数或人均的门店卡片；双列瀑布流、图文帖子、广告及无数字卡片可能无法形成记录。空记录表示抽取不足，不能推出没有门店。

原生 JSON 能组成门店记录时直接使用；否则截图字节仅在内存中交给本机 Apple Vision。图片不自动传给模型。OCR 保留逐行原始置信度；accessibility 的置信度为 null，表示不适用。格式匹配不提高识别分数。

默认只发布 JSON。需诊断时指定 --source-output 和 --screenshot-output。第二屏起的文件加 .p2、.p3 等后缀。命令在操作前检查路径冲突，拒绝覆盖已有文件或符号链接；发布成功的产物记录 SHA-256。逐文件原子发布，不是整轮事务：后续发布失败时保留本轮已发布的诊断产物，CLI artifacts 列出其路径；不删除已有文件。XML 与截图是先后读取的不同观察，不能声称是原子快照。

## schemaVersion 2

- 顶层：documentType=place-search-v2、runId、platform、bundleId、query、readAt、finishedAt、method、factStatus、status。
- coverage：capturedScreens、maxPages、scrollAttempts、stopReason、partial=true、exhaustive=false。
- pages：pageIndex、readAt、method、viewport、observations、businesses、artifacts。
- observations：id、text、confidence、x、y、width、height；坐标为屏幕左上原点的归一化值。
- businesses：名称、评分、评价数、人均、距离、区域；每个字段带原文与 observationIds。
- 合并记录：sightings 保留逐屏业务记录与观察时间；possibleDuplicateOf 表示身份或字段存在冲突，须人工复核。

factStatus 始终是 unverified。识别置信度不表示事实真实性。needsReview 同时考虑缺字段、低识别分数、截断店名和相互矛盾的字段；visualReviewRequired 汇总门店复核需求。先回查对应页的文字框，必要时才使用局部图片，避免整图重复传入模型。

跨屏只有完整名称、区域相同、数字字段一致且至少一个关键数字匹配时才合并；同屏卡片始终保留独立候选。区域不同、截断名称、字段冲突均保留为独立候选，不能因近似店名直接合并。推荐区标记在后续屏幕中延续，直到本轮查询结束。

## 停止和部分结果

正常停止原因：max-pages、page-unchanged、two-pages-without-new-businesses。它们只表示本轮停止，不证明全站结果耗尽。

异常停止：unexpected-overlay、screen-not-readable、query-input-unverified、search-page-unverified、blocked-verification、blocked-login、blocked-credential、blocked-permission、needs-user-consent、protocol-timeout、capture-failed、insufficient-result-evidence、query-or-result-scope-unverified。已有成功页面时发布 status=partial 与 failure（状态、阶段、结果是否未知、最后通过阶段）；下游可以使用已捕获候选，但须保留停止原因，停止后不得继续点击或滚动。

导航阶段遇到未知画面返回 coordinate-target-unverified，不猜坐标。已验证的坐标补充入口仅适用于当前 414×896 竖屏布局。语义 locator 先从当前页面树验证目标，再检查 active bundle 与 `queryAppState=4` 后点击；避免在定位元素后为同一按钮再取一次昂贵的全页面树。坐标动作点击前后仍检查页面与前台；同画面不重复点击。输入前确认专属输入框与键盘搜索按钮，按下述规则核对完整查询词。滚动用 mobile: swipe，避免长按触发反馈菜单。超时动作的 outcome=unknown，先观察状态，不自动重放输入、点击或滚动。

当前点评搜索框是没有 value 的 `Other` 容器：WebDriver clear 会返回成功但不删除文字。CLI 在已验证编辑页上使用 `search_clear_button` 语义控件，点击后仍需确认同一编辑页、键盘 Search 存在且清空按钮已消失；空框可显示动态占位词，不把占位词当用户输入。复用已定位且边界已确认的容器 UUID，不在清空后反复 native find。控件未消失、UUID 失效或页面不符即停止，不自动重放输入。

提交前以实际输入容器 rect 限定本机 OCR 的文字范围，按阅读顺序组合；NFKC、空白和大小写归一后须与完整查询词相等。结果首屏也在同一区域核完整查询词。旧词追加、截断或框外同词均不能通过“包含查询词”的方式放行；无法确认时返回 query-input-unverified 或 query-or-result-scope-unverified。

本机 XCUITest driver 会把原生 find 的代理错误转成 no such element。CLI 对达到固定 30 秒 WDA 代理期限才返回的查找 miss 保守标为“查找结果未确认”，输出 protocol-timeout 并保存带 `lookup-result-unconfirmed` 原因的 reset-required 标记，禁止继续 UI 回退。该分类不是根因确证；快 miss 与成功响应保持原语义。下一次命令只按现有恢复流程处理匹配 session，不自动重试整轮查询。

## 下游消费

使用 yjx-life-query 的 scripts/dianping-observations.mjs 读取 JSON。适配器接受 v2；旧 v1 作为单屏、证据未校验的候选导入，并强制要求复核。消费端重算完整候选集合，并校验 status、failure、stopReason、分区及歧义标记一致性；早期输出若与当前解析器不兼容，重新采集，不静默沿用旧分区结论。下游保留覆盖范围、failure、字段证据引用与原始识别分数，并从 observations 重新解析核对字段和复核标记；这检查转换一致性，不认证源 JSON 的真实性。另行核门店身份、地址、营业时间和产品权益。
