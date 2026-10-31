# 已验证 App 配置

这些配置记录实际设备页面；读取成功只代表取得观察。

| App | Bundle ID | 已验证入口与限制 |
| --- | --- | --- |
| 小红书 | `com.xingin.discover` | XS Max / iOS 18.7.10 曾完成恢复、搜索和读取结果。首页搜索图标无文本；搜索输入框为 TextView，提交为 `recommend_search_button`。xiaohongshu-search 已完成 3 屏真实采集及切换查询词回归；无唯一帖子 ID 时保留独立卡片观察。 |
| 大众点评 | `com.dianping.dpscope` | 首页“搜索按钮”、搜索容器 `search_keyword_edit`、原生清空控件 `search_clear_button` 和键盘 `Search` 已验证。容器无 value，不能用 WebDriver clear 证明已清空，输入规则见查询契约。结果 WebView 可能只暴露空 rootView，使用本机 Vision OCR。原生 swipe 已取得沙茶面、瑞幸咖啡的真实跨屏结果；五兰详情与商户二维码链接也已实测，二维码只读用前后 App 状态及本机像素解码。 |

大众点评使用 `dianping-search --query <词> --max-pages 3 --extract-output <新路径>`，状态、字段来源与停止规则以[查询契约](query-contract.md)为准。主结果和推荐结果分开；后续屏未观察到分区边界时记 unknown。重复候选保留，截断名字不用作去重身份。

2026-10-26 用户手动通过大众点评验证并登录。协议只曾在用户明确授权后处理一次；后续出现登录、协议、验证或权限提示均停止，不沿用一次同意作为全部授权。

发布日期、活动适用日期、分店身份、价格和推荐结论交由 `yjx-life-query` 核查。
