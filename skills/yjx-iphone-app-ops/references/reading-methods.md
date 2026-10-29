# 页面读取方式

排查原生树空白、评估 OCR 或 WebView 替代路径时读取。

1. 原生 accessibility tree 是当前默认。Appium mobile: source 经 WDA 的 accessibility snapshot 返回文字、可见性、位置和层级；精确控件优先 predicate/class chain。它不能读取 App 没暴露的自绘文字，也不保证包含未滚动的列表。
2. 已确认可检查的 WebView 可直接读 DOM。第三方发布版 WKWebView 可能没有开启 isInspectable，不能把发现 WebView 与可访问 DOM 混为一谈。当前大众点评页面树有时仅为空 rootView，已用本机 OCR 兜底。
3. Apple Vision 在 Mac 上读取截图字节，返回文字框、原始识别分数和二维码内容。默认不保存截图、不交给图像模型；必要人工复核才读取相关局部画面。识别分数不代表事实正确概率。
4. 列表逐屏读取并保留观察来源。没有稳定商户/帖子 ID 时只做保守聚合，不能用近似名称或图片 UUID 代替身份。截图、XML 与其他状态请求是顺序观察，不是同一原子快照。

这些路径都受当前 App 页面与授权限制；不通过私有网络接口、抓包或迁移 Cookie 扩展查询。

实现依据：

- [Appium source 实现](https://github.com/appium/appium-xcuitest-driver/blob/77dfb1390ed33914555bfeb37ace8c9ab2f57b28/lib/commands/source.ts) 与 [WDA source 路由](https://github.com/appium/WebDriverAgent/blob/3d6a4e03cdd673e540289c610f7e189f8ffea434/WebDriverAgentLib/Commands/FBDebugCommands.m)。
- [WebKit 对可检查 WebView 的要求](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/)。
- [Apple Vision 文字识别](https://developer.apple.com/documentation/vision/recognizing-text-in-images) 与 [二维码检测](https://developer.apple.com/documentation/vision/vndetectbarcodesrequest)。

来源对应调查时的版本；驱动或 WDA 升级后重新核对。当前设备是否可用仍以实际 session、前台和页面证据判断。
