# 来源适配与能力协商

本文件只处理“如何确认视频身份并取得证据”。课程结构、证据字段、主张映射、审核和交付规则以主 skill 与 [证据记录与自动审核](evidence-audit.md) 为准。

固定工具位于 `scripts/`：

- `source-tools.mjs`：只做 URL 和视频/分集身份解析，不声称页面已访问。
- `browser-adapters.mjs`：接收当前浏览器标签，统一检查 YouTube/Bilibili 页面、播放器、访问门禁和字幕控件；YouTube 字幕通过浏览器导出能力取得。
- `browser-adapters.mjs` 的 `captureBilibiliSubtitle(tab)`：监听当前页面实际请求的 `/x/v2/subtitle/web/view`，读取字幕元数据；若元数据是非空二进制，则激活实际字幕轨道并读取 `aisubtitle.hdslb.com` 的 JSON 正文，最终区分成功文本、空响应和未解析格式。不会把页面描述当作字幕。
- `normalize-transcript.mjs`：把带 `[mm:ss]` 时间文本转换为统一的 `body` 结构。
- `validate-evidence.mjs`：校验时间范围、知识段和主张引用，替代临时 Shell/Node 检查。

浏览器适配器不能绕过登录、反机器人验证或平台权限；它只能把页面状态转成固定字段。遇到 `login_or_verification_required`，以及一切登录态、画质门禁与“浏览器”定义，统一按主 skill 的“访问门禁与登录态判定”执行，本文件不重复规则。

- `capture-bilibili-frames.mjs`：匿名下载指定档位并截取解码帧；先探测截帧工具（优先 ffmpeg/ffprobe，其次 OpenCV），都没有时在下载前返回 `frame_tools_missing`（退出码 4）。
- `extract-hard-subtitles.mjs`：macOS Swift Vision 硬字幕 OCR；非 macOS 或缺少 `swiftc`/`python3` 时输出结构化 `ocr_unavailable`（退出码 3），不抛堆栈。

## 统一能力记录

每个来源先建立能力记录，按本集实际观察填写：

| 能力 | 需要确认的结果 |
| --- | --- |
| `identity` | 最终 URL、平台内容 ID、视频/分集/版本、标题、发布者和时长是否一致 |
| `subtitle_tracks` | 是否存在人工、自动、翻译或多语言轨道 |
| `subtitle_text` | 是否取得完整、可检索、带原视频时间的文本 |
| `chapters` | 是否存在章节；章节只能辅助分段，不能替代字幕或语音证据 |
| `audio` | 是否通过获授权路径取得完整目标音轨 |
| `frames` | 是否能取得清晰画面，或通过内置浏览器观察关键状态 |
| `frame_quality` | 当前实际可用画质档位与帧率；软件演示优先 1080P 高帧率，720P 只能作为 1080P 明确不可达时的回退，记录需要登录或付费才能达到的档位 |
| `time_navigation` | 播放器时间、章节或深链接是否实际验证可回到对应片段 |
| `access` | 是否需要登录、地区权限、年龄限制、付费权限或用户提供的本地文件 |
| `embedding` | 截图或媒体证据是否允许以目标输出要求的方式嵌入 |

状态使用“已确认”“当前未取得”“不适用”或“尚未确认”，不要把接口成功、菜单显示或单个加载结果直接当成内容证据。

画面能力必须按**最终产出分辨率**确认，而不是只写“能截图”。对软件演示，至少记录：

| 字段 | 要求 |
| --- | --- |
| `capture_surface` | 截的是播放器元素本身、视频解码帧，还是整页截图 |
| `selected_quality` | 播放器或源文件实际采用的清晰度档位（例如 1080P、720P） |
| `selected_frame_rate` | 实际采用帧率；高帧率版本存在时不得无声丢掉 |
| `decoded_frame_size` | `video.videoWidth × video.videoHeight` |
| `rendered_player_size` | 视频元素实际渲染的 CSS 像素尺寸 |
| `device_pixel_ratio` | 当前页面 DPR |
| `final_image_size` | 最终要嵌入课程的图片宽高 |

若 `rendered_player_size` 明显小于 `decoded_frame_size`，整页或播放器截图会把桌面界面缩到几百像素宽，终端文字随即变成不可读的模糊块。此时的截图即使“没有播放器外壳”，也不满足课程画面门槛。

软件演示优先请求 1080P 高帧率。只有当 1080P 已确认不可达，才允许退到 720P，且必须同时保留可用帧率并记录回退依据。若 1080P 被登录或权限门槛挡住，立即停止截图并请求用户完成登录，确认后重试 1080P；不得静默降级到 720P 及以下。匿名访问、低画质试验请求和放大插值都不能作为“清晰截图”的证据。

以 Bilibili 为例，画质代码 `80/64/32/16` 分别对应 1080P/720P/480P/360P。匿名播放请求即使返回包含 1080P/720P 的 `accept_quality`，也可能只实际下发 480P/360P 的 DASH 流；必须核对响应中真正可用的 `dash.video` 尺寸、帧率和播放器实际 `videoWidth × videoHeight`，不能只看菜单文案。画质结论的登录态依据见主 skill。

**有浏览器时优先浏览器路径：** 页面所在的内置浏览器通常已经登录 Bilibili。正式取证先通过浏览器标签执行：

```js
const { captureBilibiliFramesFromBrowser } = await import(
  '<skill 目录>/scripts/bilibili-browser-frames.mjs'
);
const result = await captureBilibiliFramesFromBrowser(tab, {
  times: [60, 390, 640],
  outputDir: '<集证据目录>',
  requestedQuality: 80,
});
```

该脚本在页面内使用同源 `fetch` 调 `playurl`，因此自然带上浏览器登录态；它不读取或导出 Cookie。返回 `status: captured` 时才继续；其他返回码的含义与下一步见主 skill 的“访问门禁与登录态判定”。

**匿名路径：** 直接命令行检索 `playurl` 不带登录态，结果属于 `anonymous_request`，不能用来决定“是否要登录”。有浏览器时它只作诊断；没有浏览器时它是下文降级路线的正式取帧路径：

```bash
node scripts/capture-bilibili-frames.mjs \
  --bvid BV... --cid CID --quality 80 \
  --times 60,390,640 --output-dir <集证据目录>
```

脚本优先读取 `fnval=4048` 的 DASH 变体，按“目标高度 → 帧率 → 码率”选择实际流，直接下载该视频变体并用 ffprobe（或 OpenCV 回退）探测宽高与帧率。`--quality 64` 在 DASH 无 720P 变体时回退到 progressive MP4，并核对实际返回档位。默认 `--quality 80` 对应 1080P；只有实际变体达到 1920×1080 且帧率不低于 30 才继续。它返回的 `anonymous_quality_unavailable` 只是“匿名请求没有拿到目标档位”的诊断，不是“用户未登录”的证据；是否要请用户登录只能由浏览器路径的 `login_required_for_quality` 决定。

本集实际回归结果：匿名 `playurl` 返回 `accept_quality: [80, 64, 32, 16]`，但 DASH `video` 只有 480P/360P 两个变体；这不是内置浏览器登录态的结论。浏览器路径必须单独跑一次；如果内置浏览器已经登录并仍返回 `quality_unavailable_for_logged_in_user`，才可以记录“当前账号没有 1080P”并按证据回退到 720P。

证据产物和界面状态分开记录：已经导出的字幕文件属于已取得证据；播放器一次刷新、跳转或渲染异常只属于当前界面观察。遇到临时异常时，先复查同一来源和时间段，或读取已保存产物，再决定是否阻塞；不把一次界面异常改写为“视频没有字幕”。

## 访问门禁

见主 skill 的“访问门禁与登录态判定”。

## 无浏览器 / 非 macOS 降级路线

宿主没有内置浏览器、或不是 macOS 时使用。目标是在不绕过门禁、不降低证据门槛的前提下取得可用证据；每一步记录实际结果。

1. **身份**：`node scripts/source-tools.mjs --resolve-cid <链接>`。它用公开 view 接口解析 CID、分集标题与时长；HTTP 412 时先访问首页取得匿名 `buvid3`/`b_nut` 设备 Cookie 再重试一次。只保留匿名设备标识，不携带、读取或导出任何登录 Cookie。结果记为 `anonymous_request`。
2. **字幕**：匿名 `player/wbi/v2` 等接口返回空字幕时，记录为“当前未取得（anonymous_request）”，不写“本集没有字幕”。浏览器字幕路线记为“未执行：宿主无浏览器”。
3. **硬字幕**：运行 `extract-hard-subtitles.mjs`；返回 `ocr_unavailable` 时记录 `reason`，不要硬编替代 OCR 结果。可以对关键时间点的解码帧做针对性视觉核对，作为画面证据记录。
4. **音频与转写**：用匿名 720P progressive MP4（含音轨）或其他获授权媒体，按 [本地转写与依赖配置](local-transcription.md) 本地转写；允许等价 ASR（见该文件）。
5. **画面**：`capture-bilibili-frames.mjs --quality 80` 先确认 1080P 是否匿名可达；不可达（`anonymous_quality_unavailable`）且用户没有明确要求 1080P 时，用 `--quality 64` 取 720P，并在能力记录中写明“1080P 匿名不可达，登录态未验证，按 720P 交付”。720P 是最低门槛，低于 720P 不得作为最终课程图。
6. **记录方式**：
   - 登录态：`browser_session_unverified`；所有匿名结果：`anonymous_request`。不请求用户登录。
   - 字幕：`subtitle_text` 记“当前未取得”及原因；`hard_subtitle_ocr` 记 `ocr_unavailable: <reason>`。
   - 画面：`capture_surface` 记 `video_decoded_frame`，`rendered_player_size` / `device_pixel_ratio` 记 `n/a（无浏览器播放器）`，并记 `frame_backend`。
   - `delivery.json` 的 `events` 追加 `capability_gap` 事件；能力缺口不阻塞状态推进，只要证据门槛与审核通过即可进入 `draft_audited` 和 `completed`。课程“取证说明”中如实写出未取得的能力和采用的替代路径。
7. 降级路线仍不能取得核心证据时，按主 skill 的交付边界交付证据不足报告。

## 通用取证顺序

1. 解析原始链接并确认最终页面身份，保留原始链接和解析结果。
2. 使用当前可用且获授权的浏览器或连接器检查播放器、字幕菜单、章节和权限状态。
3. 取得带时间字幕；记录轨道类型、语言、覆盖范围、空白和明显截断。成功保存字幕后，后续播放器暂时不渲染字幕不覆盖该证据。
4. 字幕尚未取得或质量不足时，检查来源支持的字幕导出或实际响应读取能力；已经取得且质量足够时，不因没有独立音频转写而阻塞。
5. 仍不足时，按 [本地转写与依赖配置](local-transcription.md) 评估获授权音频和本地转写。
6. 仅为补充操作、代码、图表、公式或状态变化分析画面。

画面数量不按视频时长、固定秒数或预设上限决定。先按知识段判断视觉主张是否无法由字幕/音频完整表达，再按操作前后状态、文字可读性、结构理解和复现必要性选择画面；关键视觉主张全部覆盖且新增图片不再提供信息后立即停止。纯演讲可以不取图，短视频也可以因多个独立状态变化取多张。

每一步完成后记录实际产物或失败原因。来源差异只改变“可走哪些路线”，不降低核心主张必须绑定本集时间证据的门槛。

## YouTube

- 页面检查调用 `browser-adapters.mjs` 的 `inspectYouTubeTab(tab)`；确认 `access.status` 为 `confirmed` 后，调用 `exportYouTubeTranscript(tab)`。
- 导出成功后保存返回路径，并用 `normalize-transcript.mjs` 生成统一字幕 JSON；导出文件优先于后续一次性的字幕渲染状态。
- 核对视频 ID、最终 URL、标题、频道、时长、播放列表位置和当前语言轨道；播放列表上下文不能替代当前视频身份。
- 分开记录人工字幕、自动生成字幕、翻译字幕和配音语言。翻译字幕可以辅助导航，但不能默认等同于原声证据。
- 字幕菜单可见不等于完整字幕可读取；需要核对实际文本、时间范围和是否存在首尾缺失。
- 章节可以帮助定位知识段，但不能支撑字幕未覆盖的核心结论。
- 遇到私有、未列出、年龄限制、地区限制或登录页面时，按权限阻塞处理；不读取 Cookie，也不把第三方转载当作等价来源。
- 时间参数只有在实际打开后落在对应段落附近时才标记为可跳转；否则保留普通链接和 `mm:ss` 文本。

## Bilibili

- 页面检查调用 `browser-adapters.mjs` 的 `inspectBilibiliTab(tab)`；它只确认页面、播放器、章节和字幕控件状态，不把页面描述中的“人工校对”当作字幕文本。
- 字幕读取调用 `captureBilibiliSubtitle(tab)`；`subtitle_exported` 且返回 JSON `body` 数组才表示获得可用字幕文本，`subtitle_empty_response` 表示字幕接口实际返回空响应，`subtitle_response_unparsed` 表示已获得响应但还需要对应格式解析。
- 已用真实 Bilibili 视频 `BV1xztt6tEtu` 第 58 集回归：登录和页面身份确认通过，选择“中文”轨道后实际读取 `aisubtitle.hdslb.com` JSON，得到 154 条带 `from/to/content` 的字幕文本。
- `subtitle_empty_response` 是一次已完成的接口核验结果，不是“适配器还没做完”。记录接口、HTTP 状态、响应字节数和当前分集后，若页面没有实际暴露其他字幕轨道，就结束本次 Bilibili 字幕路线；不盲猜 `preferred_language` 或反复重放同一请求。
- 只有当页面实际暴露了不同语言或字幕轨道，或响应参数明确给出可选轨道时，才按已观察到的候选逐个复查。候选仍为空时，终态仍是 `subtitle_empty_response`，而不是“字幕存在但工具失败”。
- 核对最终页面、BV 号、分集 `p`、CID、标题和时长；当前 `p` 是课程身份的一部分。
- 分开记录人工字幕、自动字幕、配音和原声轨道；“暂无字幕”只表示当前观察，不能直接推出本集不存在字幕。
- 通过浏览器支持的能力读取播放器实际请求的字幕响应时，核对分集、CID、轨道语言、时间范围和文本。
- 短链接或分享链接重定向后，先重新确认分集身份，再决定是否复用证据。

## 其他网页视频或本地文件

- 先记录页面 URL、播放器或文件身份、页面标题、发布者、时长和权限状态；页面说明、搜索摘要或相邻课程不能替代视频证据。
- 只有画面没有可用字幕时，可以建立带时间场景记录；只有在场景证据足以支持主要学习结果时才生成课程。
- 用户提供的本地视频或音频应保留文件名、时长、音轨和时间基准；没有可验证的来源页面时，明确标记“本地文件来源”。
- 受版权、权限或工具能力限制而无法嵌入截图时，保留时间文本和观察事实，说明降级范围。
