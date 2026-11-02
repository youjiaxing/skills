# 通用操作与验证

从 `<skill-dir>` 运行 `node scripts/iphone-app-ops.mjs …`。先满足运行契约、目标授权和前台确认；通用命令结果与专用查询的事实核验结论分开。

## 观察

```bash
node scripts/iphone-app-ops.mjs observe --bundle-id <bundle> --contains '评分'
node scripts/iphone-app-ops.mjs observe --bundle-id <bundle> --purpose visual --screenshot-output /tmp/new-screen.png --output /tmp/new-observation.json
```

信息任务默认原生文字，文字不足才用本机 OCR；`--method native|ocr|dom` 可明确路径，DOM 配合 `--context`。默认最多 80 项，可用 `--limit`（1–500）和 `--contains` 限定，`partial` 表示输出截断。需要更多内容时滚动或调整观察范围，不将截断输出当完整页面。

视觉任务使用 `--purpose visual` 和新的 `--screenshot-output`，随后必须通过宿主图像工具实际查看该图片。输出一张截图不算视觉评审完成。布局、颜色、间距、遮挡、图表等由模型据实际图像判断，原生文字完整也不能省略截图。混合任务按目标组合路径。

`--source-output` 显式保留 XML，`--output` 保存结构化观察。输出文件拒绝覆盖，截图、XML、文字包含各自观察阶段，不是原子快照。截图默认不落盘，视觉核验使用本轮新路径；保留与目标相关的范围，不保存或传递凭据。

## 元素操作

```bash
node scripts/iphone-app-ops.mjs element read --bundle-id <bundle> --using accessibility-id --selector '<id>'
node scripts/iphone-app-ops.mjs element click --bundle-id <bundle> --using predicate --selector '<predicate>'
printf '%s' '<text>' | node scripts/iphone-app-ops.mjs element set-value --bundle-id <bundle> --using accessibility-id --selector '<id>'
```

原生支持 `accessibility-id`、`predicate`、`class-chain`；目标必须唯一，写动作前需可见且启用。`set-value` 核对真实 value，必要时清空、确认空值、输入一次并回读；value 缺失则停止，不能把 clear 成功当空框。此类控件用可验证的 App 清空入口与限定区域视觉/OCR适配处理，核验完成前不继续输入或提交。

元素滚动使用 `swipe-up|swipe-down|swipe-left|swipe-right`。`app activate|launch|terminate --bundle-id <bundle>` 提供生命周期操作；终止可能丢失未保存状态，只在任务需要且状态处理明确时执行。

## 等待与断言

```bash
node scripts/iphone-app-ops.mjs element wait --bundle-id <bundle> --using accessibility-id --selector '<id>' --condition visible --timeout-ms 15000
node scripts/iphone-app-ops.mjs element assert --bundle-id <bundle> --using accessibility-id --selector '<id>' --condition text-equals --expected '<text>'
```

条件：`present|absent|visible|hidden|enabled|text-equals|text-contains|value-equals`。`wait` 默认 15 秒，`assert` 默认一次观察，`--timeout-ms` 最大 120 秒。预算到期不发新轮询，单条在途命令仍受传输 deadline 约束。只有明确 no-such-element/空集合能作为缺失；传输超时和不可读状态不是元素缺失。

`operation.outcome=not-sent|sent|unknown` 表达操作发送情况；`verification.status=passed|failed|blocked|unknown` 表达目标判断。`passed` 只证明指定可观察条件；`failed` 表示有效观察下条件不满足；`blocked` 表示前提不足；`unknown` 表示效果或协议状态不能确认。旧 `ok/action/outcome` 字段不升级为业务通过。未通过时 CLI 非零退出，供调用方 runner 组合。

点击后按目标继续等待/断言，发送和付款等核对相应的记录/订单及关键字段。调用方可以用这些原语组织固定回归，业务用例和运行器由项目维护。

失败时指定 `--screenshot-output` / `--source-output` 可补证据。取证错误附加在原失败上；存在 unknown/reset-required 时不发送截图、上下文切换或页面读取，先按恢复契约处理，再重新观察。

## WebView

```bash
node scripts/iphone-app-ops.mjs context list --bundle-id <bundle>
node scripts/iphone-app-ops.mjs element assert --bundle-id <bundle> --context '<context-id>' --using css --selector '[data-testid="target"]' --condition visible
```

使用 `mobile: getContexts` 返回的完整对象，以 `bundleId` 确认归属，不能用 `WEBVIEW_` 名字推断。原生元素是默认路径；DOM 操作显式指定 context。第三方发布版可能不可检查，无法取得 owner 的 context 不操作；可以回到原生/视觉观察，或明确报告阻塞。操作后恢复原生 context，未决请求时跳过恢复命令。

DOM 观察采集语义元素及带直接文本的普通/自定义元素，并返回可用的 `id` / `className` 供定位参考；不依赖某个框架的标签名。传输最多 1000 项，源截断也会设置 `partial=true`；即使筛选后为空，也不能据此断言整个页面没有目标。文字不覆盖 Canvas 像素或布局效果，仍按任务选择截图。CSS 目标须通过当前内容确认身份和唯一性。

仅返回 `NATIVE_APP` 只证明本次未发现可用页面，根因仍待诊断。先确认目标 App 在前台，再核查 iPhone“设置 → App → Safari 浏览器 → 高级 → 网页检查器”（旧系统位于设置中的 Safari）。开关关闭时，说明其调试作用后按环境维护授权开启并回读状态；不以“远程自动化”开关替代它。然后核对目标 WebView 的 `isInspectable`、原始 context 结果与 Appium 日志：完全未收到 App 报告、收到目标 App 却未匹配其 bundle、发现页面但 owner 不明是不同阶段。只有已取得证据的原因才能定论。

本 skill 的共享 session 不绑定业务 App，以 `additionalWebviewBundleIds=['*']` 发现候选，再由上述 owner 门禁限制实际操作。旧 session 不会随代码更新获得新 capability；确认本轮独占且无未知/在途请求后，可显式 `close`、`session`、`recover` 一次应用新配置，保留共享服务。多个同属目标 App 的页面仍须结合当前原生页面、标题/URL 和 DOM 内容确认实际目标，不能默认选择第一个 context。[Appium 混合页面要求](https://appium.github.io/appium-xcuitest-driver/latest/guides/hybrid/)和[WebKit 检查开关说明](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/)提供前置条件依据；业务 App 的修改、构建与安装仍由项目侧负责。

## 视觉手势

先生成并查看视觉观察及 JSON，在图像中唯一确认目标后，标注其归一化区域，再使用该目标：

```bash
node scripts/iphone-app-ops.mjs target --observation /tmp/new-observation.json --label '<目标>' --rect 0.4,0.3,0.2,0.2 --output /tmp/target-observation.json
node scripts/iphone-app-ops.mjs gesture tap --bundle-id <bundle> --observation /tmp/target-observation.json --target '<目标>' --x 0.5 --y 0.4
```

`tap|swipe|drag` 使用归一化坐标；后两者加 `--to-x/--to-y`，可指定 `--duration-ms`。标注绑定源截图指纹，目标标签必须唯一，起点须在标注区域内。观察须来自同一 App、30 秒内且当前像素未变；不匹配时重新观察并确认目标，不自动点击。Agent 还须确认目标身份和操作作用属于授权范围；参数中的文字不代替该确认。手势发送后按目标再次验证。

凭据/安全验证页面只返回脱敏的受阻观察，不输出输入内容或截图；非敏感导航可继续，安全输入控件的读取/写入由用户处理。
