# 已验证 App 配置

这些配置描述 bundle 身份和当前已验证的原生入口，不把一次页面读取当作平台内容已核实。

| App | Bundle ID | 当前验证 | 查询入口约定 |
| --- | --- | --- | --- |
| 小红书 | `com.xingin.discover` | XS Max / iOS 18.7.10 可恢复、搜索并读取结果；首页搜索图标无文本，搜索页输入框为 `XCUIElementTypeTextView`，提交按钮为 `recommend_search_button` | 先进入首页搜索页，清空输入框后输入查询词，再点击 `recommend_search_button` |
| 大众点评 | `com.dianping.dpscope` | XS Max / iOS 18.7.10 可启动并报告前台；首次启动可能出现“大众点评隐私政策协议”，本轮已在用户明确授权后点击“同意”；首页“搜索按钮”可定位。2026-10-26 用户手动通过身份核实并登录后，完成 `blcoffee厦门` 查询；结果页截图可读，曾显示 BL Coffee（航空古地石·灵感店）及 BL Coffee&Bakery（五缘湾店）。结果页内嵌内容有时只向 WDA 暴露空 `rootView`。2026-10-25 曾遇到“身份核实 / 请依次点击下图图标” | 优先使用 CLI `dianping-search --query <词> --screenshot-output <路径> [--source-output <路径>]`；检查返回状态，`screenshot-captured` 后视觉读取截图。CLI 会进入搜索、清空 `search_keyword_edit`、输入查询词并点键盘 `Search`。若页面出现隐私协议或图标验证码/身份核实，命令返回相应阻断状态并交用户处理；不自动同意、不识别或代点验证码，也不盲目重试。不能仅凭空 `rootView` 判定失败 |

## 查询边界

原生 App 只提供当时页面可读内容。发布日期、活动适用日期、门店身份、价格和推荐结论仍按 `yjx-life-query` 的来源核验规则处理。App 页面出现登录、验证码、风控或权限提示时停止自动操作。

