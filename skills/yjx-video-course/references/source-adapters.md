# 来源适配与能力协商

本文件只处理“如何确认视频身份并取得证据”。课程结构、证据字段、主张映射、审核和交付规则以主 skill 与 [证据记录与自动审核](evidence-audit.md) 为准。

固定工具位于 `scripts/`：

- `source-tools.mjs`：只做 URL 和视频/分集身份解析，不声称页面已访问。
- `browser-adapters.mjs`：接收当前浏览器标签，统一检查 YouTube/Bilibili 页面、播放器、访问门禁和字幕控件；YouTube 字幕通过浏览器导出能力取得。
- `browser-adapters.mjs` 的 `captureBilibiliSubtitle(tab)`：读取与当前分集关联的字幕元数据或实际 AI 字幕文件；身份关联和结果状态见下方 Bilibili 规则，不把页面描述当作字幕。
- `bilibili-identity.mjs`：按当前 BV＋分P选择 CID，不能用残留首P状态覆盖映射；只读 DOM 不暴露初始状态时，使用当前标签页的原生 CDP 请求 B站正常 API，仅返回公开身份字段，不读取或导出登录凭据。
- `normalize-transcript.mjs`：将 VTT/SRT 或 `[mm:ss]` 时间文本转换为 `body: [{from,to,text}]`，时间为秒；VTT/SRT 保留原始起止与毫秒精度，文本格式的结束时间仍为推断。用 `--help` 查看格式、语言和自动字幕滚动去重选项。
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

该脚本在页面内请求站点 `api.bilibili.com` 的 `playurl`，使用当前浏览器正常登录态，不读取或导出 Cookie。只读 DOM 无法取帧时，自动尝试同一绑定标签的原生 CDP 页面执行；两种执行能力均不可用时返回 `frame_capture_capability_unavailable`。已具备原生执行能力但页面报错或执行超时返回 `frame_capture_failed`，不误报为能力缺失。首次使用宿主的 `cdp` 能力前，先读取该能力的工具说明，再调用脚本。返回 `status: captured` 时才继续；其他返回码的含义与下一步见主 skill 的“访问门禁与登录态判定”。

### 内置浏览器截图与原生取帧回退

页面截图可辅助观察播放器状态；软件演示的最终图仍使用解码帧。先保存目标秒数、暂停后的实际 `current_time`，核对截图前后的 BV、分P、CID、标题与时长，再检查落盘图的尺寸、文字及遮挡。截图 API 的输出尺寸不由 DPR 或 `videoWidth` 保证，裁剪也不能恢复已经缩小的文字。

`captureBilibiliFramesFromBrowser` 会在只读 `evaluate` 返回能力缺口或拒绝执行时，使用 `tab.capabilities.get('cdp')` 的 `Runtime.evaluate` 在同一内置浏览器标签内执行相同的取帧逻辑。它导出 `canvas.drawImage(video, …)` 的原始 PNG，保留 `execution_backend`、`capture_surface`、实际时间、暂停状态和图片尺寸；没有切换到外部 Chrome，也不导出 Cookie 或媒体签名 URL。宿主不暴露这项能力时，保留能力缺口，不能凭截图放大宣称高清取帧成功。

批量取帧按目标数量设置原生调用超时，上限60秒；超时返回后先复查页面和暂停状态，再缩小批次，不连续重复失败请求。脚本不重复请求当前档位，并在切换时请求实际选中的变体 ID；通过播放器帧计数检查明显的帧率落差，短采样只容许一个计数帧的边界误差。有效采样不足1秒、没有新增帧或无法测量帧率时返回 `frame_rate_unverified`；未就绪或偏离目标超过0.1秒返回 `frame_not_ready`，均不能记为取帧成功。

`selected_frame_rate` 是所选变体的清单帧率；`measured_frame_rate` 是短窗口播放器计数估计，可能受缓冲与计数边界影响而高于清单值。分别保留两者，不能据此把30fps源声称为更高帧率；需要精确媒体帧率时使用获授权产物的独立媒体探测结果。本次端到端整理中已实际遇到30fps变体出现约40fps短采样估计。

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

宿主没有内置浏览器、或不是 macOS 时使用。目标是在不绕过门禁、不降低证据门槛的前提下取得可用证据；每一步记录实际结果。**下列来源接口与媒体步骤针对 Bilibili**；YouTube 按 [YouTube 字幕取证](youtube-subtitles.md) 的命令行路线执行，其他来源按各自能力选路，不套用 B站 CID 或画质代码。

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

处理 YouTube 时读取 [YouTube 字幕取证](youtube-subtitles.md)：内置浏览器优先；没有浏览器或导出能力不足且未触发访问门禁时，可用已有 yt-dlp 取得目标语言的人工或自动字幕，再解析 VTT/SRT。该文件同时规定短时 URL/空响应的有界恢复和原始字幕映射；时间链接仍按主 skill 验证。

## Bilibili

- 页面检查调用 `browser-adapters.mjs` 的 `inspectBilibiliTab(tab)`；它只确认页面、播放器、章节和字幕控件状态，不把页面描述中的“人工校对”当作字幕文本。
- 字幕读取调用 `captureBilibiliSubtitle(tab)`；先核验身份，并用返回的 `source_identity` 核对 BV、分P与 CID；可将已确认身份通过 `expectedIdentity` 锁定。`subtitle_exported` 且返回非空、带合法起止时间的 JSON `body` 数组才表示取得文本；普通 JSON 元数据不能算导出成功。
- 仅接收明确匹配当前 CID 的元数据及其链接，或实际已观察到的 `{aid}{cid}{32位十六进制hash}` AI 字幕路径；不因同属字幕域名就接受，也不选最后一个跨分集响应。未知文件命名且无元数据关联时保留“当前未取得”。读取后重新核验页面，自动跳集则返回 `source_changed`，不返回旧集正文。
- `subtitle_empty_response` 表示已关联目标集的空响应；`subtitle_response_unparsed` 表示响应已关联但格式尚未解析；`subtitle_identity_unverified` 表示身份未核实，不能将其当作“没有字幕”。
- 已用真实 Bilibili 视频 `BV1xztt6tEtu` 第 58 集回归：登录和页面身份确认通过，选择“中文”轨道后实际读取 `aisubtitle.hdslb.com` JSON，得到 154 条带 `from/to/content` 的字幕文本。
- `subtitle_empty_response` 是一次已完成的接口核验结果，不是“适配器还没做完”。记录接口、HTTP 状态、响应字节数和当前分集后，若页面没有实际暴露其他字幕轨道，就结束本次 Bilibili 字幕路线；不盲猜 `preferred_language` 或反复重放同一请求。
- 只有当页面实际暴露了不同语言或字幕轨道，或响应参数明确给出可选轨道时，才按已观察到的候选逐个复查。候选仍为空时，终态仍是 `subtitle_empty_response`，而不是“字幕存在但工具失败”。
- 核对最终页面、BV 号、分集 `p`、CID、标题和时长；当前 `p` 是课程身份的一部分。
- URL 的 `oid` 是依接口上下文而定的对象 ID，不作为 CID 别名。没有明确 `cid` 时，用 BV 与目标 `p` 解析真实 CID；原始 `oid` 留在来源 URL 中，不将它直接用于播放、字幕或音频请求。
- 同一身份核验也适用于音频：下载或转写前确认目标分P的 CID 与音轨时长，不能只凭 BV 号或合集标题选媒体。不得直接用固定首P的 `bili audio` 作为多分P兜底；只有后端能明确选择并回读目标分P/CID，才可接入。现有匿名媒体与浏览器路线继续按上述规则使用。
- 分开记录人工字幕、自动字幕、配音和原声轨道；“暂无字幕”只表示当前观察，不能直接推出本集不存在字幕。
- 通过浏览器支持的能力读取播放器实际请求的字幕响应时，核对分集、CID、轨道语言、时间范围和文本。
- 短链接或分享链接重定向后，先重新确认分集身份，再决定是否复用证据。

### 非首P实测范围（2026-10-19）

使用内置浏览器的已登录会话，BV 为 `BV1xztt6tEtu`；当前标签页 API 解析分P映射，字幕按实际请求文件关联，音轨取自播放器已请求且路径包含同一 CID 的资源，未导出 Cookie：

| 分P | CID | 标称时长 | 字幕 | 完整音轨（ffprobe） |
| --- | --- | --- | --- | --- |
| [58](https://www.bilibili.com/video/BV1xztt6tEtu?p=58) | `41464826279` | 358 秒 | 154 条，末尾 357.42 秒 | AAC，357.44 秒 |
| [59](https://www.bilibili.com/video/BV1xztt6tEtu?p=59) | `41464826731` | 110 秒 | 42 条，末尾 109.24 秒 | AAC，109.269333 秒 |

首P映射为另一 CID `41454275609`，未被上述两集沿用。字幕与音轨时长的亚秒尾差保留为实际结果；本轮验证了来源关联和完整性，未重新做 ASR 或逐字听音核验。只读宿主的初始状态/fetch 缺失及自动跳集均在真实操作中遇到，修正后完成两集复测；首次取帧探测返回 `frame_capture_capability_unavailable`；随后补做的原生回退实测见下文。其他账号、网络、文件命名和权限分支仍需按本次任务实际结果判断。

### 高清取帧回退实测（2026-10-19）

同一内置浏览器确认已登录、实际1080P档位；普通模式的视频区域为732×412，网页全屏截图为1280×720且出现站点播放器遮罩。此结果仅证明可观察页面，未达到本次1080P软件演示的最终图门槛，也没有通过放大截图补足像素。

原生回退脚本随后取得以下 PNG，实际文件尺寸均经独立探测确认为1920×1080，视觉检查未发现站点外壳或播放器控件遮挡：

| 分P / CID | 目标秒数 → 暂停后的实际秒数 | 返回档位 / 清单帧率 |
| --- | --- | --- |
| 58 / `41464826279` | 60 → 60；180 → 180 | 1080P / 30fps |
| 59 / `41464826731` | 30 → 30；75 → 75 | 1080P / 30fps |

短采样的实际帧计数约30fps，结果保留测量值，不把30fps标成高帧率。此验证覆盖绑定标签内的来源核对、指定时刻定位、解码帧导出和落盘尺寸；课程中具体图片仍须按视觉主张与最终嵌入尺寸审核。其他宿主是否允许原生执行、跨域画布是否可导出，以及账号是否具备更高档位，均按实际结果判断。


## 其他网页视频或本地文件

- 先记录页面 URL、播放器或文件身份、页面标题、发布者、时长和权限状态；页面说明、搜索摘要或相邻课程不能替代视频证据。
- 只有画面没有可用字幕时，可以建立带时间场景记录；只有在场景证据足以支持主要学习结果时才生成课程。
- 用户提供的本地视频或音频应保留文件名、时长、音轨和时间基准；没有可验证的来源页面时，明确标记“本地文件来源”。
- 受版权、权限或工具能力限制而无法嵌入截图时，保留时间文本和观察事实，说明降级范围。
