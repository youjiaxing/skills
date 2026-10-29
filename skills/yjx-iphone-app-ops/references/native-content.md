# 门店详情、分享入口与小红书

需要搜索结果之外的门牌、营业摘要或原生分享入口时读取。所有页面内容保持 `factStatus=unverified`，调用方按目标日期核查。

各输出用 documentType 分派：place-search-v2 是点评列表，place-detail-v1 是门店详情，qr-share-v1 是二维码入口，note-search-v1 是小红书卡片。schemaVersion 在各文档类型内演进，不能只凭版本号混用列表和详情。

## 大众点评详情

先运行 `dianping-search`，从 JSON 选择完整店名且当前可见的 candidate ID：

```bash
node scripts/iphone-app-ops.mjs dianping-detail \
  --from /tmp/dianping-search-new.json --candidate candidate-2 \
  --extract-output /tmp/dianping-detail-new.json
```

从列表点击时，候选文件限最近 10 分钟，当前列表须仍显示同一查询词与唯一完整店名。命令重新读取文字及位置，检查已知字段是否冲突，再点击本轮文字框中心。不会用旧记录坐标跨屏点击。目标不在当前屏时返回 candidate-not-uniquely-visible；重新做有界查询或回到相应列表屏再选择。

已在详情页时可加 `--current` 只读取当前页面：旧搜索文件只提供期望身份与历史来源，不据其坐标导航，所有详情字段重新读取并使用新的 readAt；当前页店名或语境不符即停止。

详情页同时核完整店名与详情语境。fields.address、businessState、hours 保留原文字行、observationIds 和原始置信度；地址可能需要拼接下一行，低分续行仍需复核。hours 是当前页营业摘要，没有展开完整周规则。优惠券的可用时段与设备状态栏时间不并入营业时间。page 保留观察原文与位置；缺项明确保留。

## 大众点评真实分享入口

```bash
node scripts/iphone-app-ops.mjs dianping-share \
  --from-detail /tmp/dianping-detail-new.json \
  --extract-output /tmp/dianping-share-new.json
```

在最近 10 分钟的详情观察基础上，重新核店名，确认完整分店名或地址及候选来源，再走 food_poi_share → 商户二维码。已在二维码页时直接核完整店名。分享命令的只读观察用前后 activeAppInfo/前台状态与本机像素文字核身份，不再请求二维码页的深度 XML 树；会话复用也使用轻量状态检查。实际打开分享面板和二维码的点击仍走完整页面树门禁。本机 Vision 从当前像素读取二维码，限定为 HTTPS 点评/美团域名，只有唯一链接才输出；不读取剪贴板、不发送给任何联系人、不保存到相册。输出保留 sourceCandidateId、sourceSearchRunId、sourceDetailRunId 和 branchEvidence，依次回查搜索、详情与二维码证据。

输出 documentType=qr-share-v1、status=qr-payload-observed，二维码链接只标记 qr-title-matched-unopened。后置状态确认失败时，已解码的证据发布为 partial 和 qr-observed-state-unconfirmed；不能报告已核验链接。需要可引用入口时，用内置浏览器打开并核落地目标；如果网页要求登录，保留原始链接与实际跳转结果，报告网页核验受阻。不要拼接、替换、猜测商户 URL，也不把二维码中间跳转链接当作永久地址。

## 小红书搜索

```bash
node scripts/iphone-app-ops.mjs xiaohongshu-search \
  --query '厦门 周末 活动' --max-pages 3 \
  --extract-output /tmp/xhs-search-new.json
```

最多 1–5 屏，默认 3 屏。导航复用已验证语义；首页无文本搜索按钮只在当前 414×896、菜单/发现/同城同时存在的布局中按原生 Button 位置约束识别，布局未知停止。输入前确认专属搜索页与输入框位置；从结果页修改查询时先聚焦，再重新定位已转换的编辑框，提交前回读实际输入词，结果页持续确认查询词。

当前提取面向原生双列笔记卡片，不读取 OCR 文字推断卡片归属。记录 cardText（页面暴露的标题/摘要合并文本）、authorObserved、timeObserved、evidence 和 sightings；UUID 图片名不作为 noteId。广告及 AI 汇总不进入候选。无原生卡片时停止，不能把空抽取说成无相关内容。

卡片只是发现线索，url/noteId 可为空；正文、图片、评论、原帖 URL 和活动适用日期须另行进入原帖核查。没有 noteId/URL 时，同文案同作者也保留独立候选，只标 possibleDuplicateOf，不认定为同一笔记。结果保留 partial、stopReason 和 failure，遇登录/验证立即停止。
