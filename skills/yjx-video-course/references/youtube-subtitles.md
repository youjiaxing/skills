# YouTube 字幕取证

仅处理当前指定的视频；先确认视频 ID、最终 URL、标题、频道、时长、播放列表位置与原声语言。字幕必须属于同一视频与选定轨道；章节只能导航，不能替代讲解证据。访问、登录与反机器人门禁以主 skill 的“访问门禁与登录态判定”为准。

## 选择获取路线

有宿主内置浏览器时，优先用 `browser-adapters.mjs` 的 `inspectYouTubeTab(tab)` 检查页面。确认 `access.status` 为 `confirmed` 后，在宿主支持 `tab.content.exportYouTubeTranscript` 时调用 `exportYouTubeTranscript(tab)`，保存实际导出文件。接口不存在表示宿主缺少导出能力；接口存在但本次调用失败表示一次执行失败，不能混为“没有字幕”。

没有浏览器、缺少导出接口，或浏览器导出经复查仍不可用但未触发访问门禁时，可复用已有 yt-dlp。缺少工具时按主 skill 和本地转写文档处理依赖授权，不为使用这条路线自动安装 Agent-Reach、OpenCLI、浏览器扩展或整套工具链。已确认的登录/验证门禁不进入换工具重试链。

## yt-dlp 的单视频路线

先读取本机 `yt-dlp --version` 与 `--help`，核对以下参数是否受该版本支持。下列命令中的 `COURSE_URL` 是已解析的具体视频 URL，`COURSE_META` 是本集输出目录中尚未使用的元数据文件，`COURSE_SUB_DIR` 是本次尝试的独立字幕目录；先设置为实际值再执行，重试使用新的目录。已有产物先判断能否复用，不因旧文件存在就报告本次下载成功。

示例使用 POSIX shell；PowerShell 按其变量和续行语法传递同一组参数，不照搬反斜杠续行。

### 1. 确认身份与可用轨道

```sh
yt-dlp --ignore-config --no-playlist --skip-download --dump-single-json \
  --socket-timeout 20 --retries 0 --extractor-retries 0 -- "$COURSE_URL" > "$COURSE_META"
```

`--ignore-config` 避免继承全局 Cookie、代理、输出路径或额外下载行为；本任务需要的已授权网络参数在当前进程显式传入。元数据可能含短时签名媒体 URL，只保存到本集证据目录，不整份输出到公开日志或课程正文。

读取并比对 `id`、`webpage_url`、`title`、`channel`/`uploader`、`duration`；返回播放列表或视频 ID 不符时停止这条路线，不挑选其中第一项冒充目标。读取 `subtitles` 和 `automatic_captions`，需要人类可读列表时可用同样的单视频边界执行 `--list-subs`。

按实际内容语言和学习目标选择一个已观察到的轨道。相同语言、质量足够时优先人工字幕，不能仅因存在人工译文就覆盖原声自动字幕。记录语言代码、人工/自动/翻译类型、格式和轨道名；不要把所有 `automatic_captions` 条目都当成原语言自动识别，它也可能包含自动翻译。原声、字幕与配音语言分别记录。

完整 YouTube 提取可能需要 JavaScript runtime 和匹配的 EJS 组件。以当前版本帮助/官方文档为准检查可执行性与是否实际启用：仅装 Node 不代表 yt-dlp 已启用它。若使用本机 Node 且版本支持，可在本次命令追加 `--no-js-runtimes --js-runtimes node`；不修改全局配置，也不自动开启远程组件下载。缺少组件时报告具体依赖，不据此判断目标无字幕。

### 2. 下载选定字幕

`COURSE_SUB_LANG` 必须是刚确认的语言代码。以下为人工字幕；只下载字幕，不下载视频：

```sh
yt-dlp --ignore-config --no-playlist --skip-download \
  --write-subs --no-write-auto-subs --sub-langs "$COURSE_SUB_LANG" --sub-format "vtt/srt" \
  --socket-timeout 20 --retries 0 --extractor-retries 0 --fragment-retries 0 \
  -o "$COURSE_SUB_DIR/%(id)s.%(ext)s" -- "$COURSE_URL"
```

自动字幕使用同一命令，将 `--write-subs --no-write-auto-subs` 换为 `--no-write-subs --write-auto-subs`。`--sub-langs` 支持正则匹配；若选定代码含正则元字符，先按当前参数契约转义或使用可精确选轨的方法，并回读实际文件语言和轨道。不要批量下载无关语言、直播聊天或整个列表。

检查本次实际生成的字幕文件、非空正文、视频 ID 和轨道一致性；退出码为零或有轨道菜单都不等于取得了内容。VTT/SRT 不足以单独携带所有轨道属性，必须与本次元数据和选择记录一起保存。

## 归一化与证据

保留原始 VTT/SRT 和获取记录；归一化输出是派生产物。相对于已加载的 skill 目录解析脚本，不假设固定安装路径：

```sh
node "<skill目录>/scripts/normalize-transcript.mjs" \
  --input "<本次实际字幕文件>" --output "<新归一化文件.json>" \
  --language "<已确认语言代码>" --captions manual
```

自动字幕将 `--captions` 设为 `automatic`；仅在观察到滚动窗口重复时另加 `--dedupe-rolling`。翻译轨道用 `translated`，不因底层自动生成而把译文标为原声。脚本支持自动识别 VTT/SRT 与 `[mm:ss]` 文本，不直接解析任意字幕 JSON。

- VTT/SRT 使用每条原始 cue 的真实起止时间（输出为秒，保留毫秒）；不以视频总时长覆盖末条，也不填平空白或强行消除重叠。
- `[mm:ss]` 文本缺少显式结束时间，仍按下一行起点和可选 `--duration` 推断；输出标记 `normalization.timing: inferred`，不能描述为精确 cue 时长。
- 滚动去重只对显式启用的自动字幕执行。重叠 cue 可清理前后缀重复；时间相接的 VTT 则必须同时满足“前条末行带行内时间 → 10ms 无标签同文快照 → 后条为无标签旧行＋带行内时间的新行”，才删除中间快照与后条旧行。新行即使与旧行同文也保留，仍使用当前 cue 时间，不提前到前一条。未满足该结构的相接或分离重复及句内重复保留；重叠前后缀仍属启发式，重要疑点对照原音/原字幕复核。SRT 若已丢失行内时间标记，不套用该 VTT 相接模式。
- `normalization.cue_map` 将源 cue 顺序号映射到输出条目（均从 1 开始），记录删去的前缀；完全重复的源 cue 对应 `entry: null`。先检查未去重结果或直接回看原始文件，再判断差异是否合理，不把删去的内容当作来源缺失。
- `coverage.from/to` 是原始 cue 最早/最晚时间的包络（滚动去重不缩短它），不证明中间连续覆盖；`entries` 是归一化后的文本条目数。检查首尾、空白、重叠与核心内容覆盖，按主 skill 完成重要内容复核和证据审核。

## 失败与恢复

每次记录同一视频、轨道、尝试路径、结果和产物。区分以下情况：

- **短时 URL 失效或临时空响应**：最多追加两次取证尝试；重新获取同一视频的轨道元数据并取得新地址，不重放已过期 URL。新地址仍为空或无进展时结束该字幕路线，记录“当前未取得”，转向适用的本地音频转写。
- **工具/格式能力缺口**：版本不支持参数、缺 JS runtime/EJS、文件格式不受支持时，报告具体缺口；在已授权范围内修复后再试，不无限重复相同命令。
- **明确访问门禁**：不自动换 OpenCLI、另一个 Chrome 会话或 Cookie 导出来继续；执行主 skill 门禁。命令行匿名请求的失败仍只能记录为 `anonymous_request`，不能判断内置浏览器是否登录。
- **无浏览器且匿名路径要求验证**：不能通过换工具规避；记录访问能力缺口，按主 skill 交付边界停止，不要求用户在不存在的浏览器中登录。

字幕路径不足时，读取 [本地转写与依赖配置](local-transcription.md) 获取获授权的目标音轨并使用本地 ASR；本路线不自动转向云端。成功保存的字幕不因后续播放器暂时异常而失效。

## 依据与适用限制

- [yt-dlp 参数说明](https://github.com/yt-dlp/yt-dlp#usage-and-options)：字幕枚举、语言/格式、单视频限制及 JS runtime；运行时核对安装版本。
- [WebVTT 格式](https://www.w3.org/TR/webvtt1/)：cue 时间、标识、样式与文本结构。
- [Agent-Reach 视频参考（94f06c1）](https://github.com/Panniantong/Agent-Reach/blob/94f06c1969dfc1834001269d79d3ad0972d9dee6/agent_reach/skill/references/video.md)：借鉴可选获取路径与自动字幕重复提醒，不依赖其安装器或将其平台可用性声明当作本集事实。

这些说明与本地脚本检查不代表已验证所有 YouTube 视频、账号或网络环境；最终以本次目标的实际字幕和时间证据验收。

## 已验证范围（2026-10-19）

macOS arm64，yt-dlp 官方独立版 `2026.08.19`（核对发布 SHA256）、Node `22.18.0`；命令行显式启用 Node，不读取浏览器 Cookie，不修改全局配置。以下为真实下载与解析结果，不是 Agent 模拟会话测试：

- [QqhyqMvdx5Q](https://www.youtube.com/watch?v=QqhyqMvdx5Q)：人工 `zh-TW` VTT 共 280 个 cue，归一化后逐条文字及毫秒起止一致，覆盖 `0–642.239` 秒。以 ffmpeg 转成 SRT 后再解析，280 条结果完全一致。内置浏览器的页面适配与字幕导出也成功；导出的时间文本因整秒化与合并同秒条目为 279 条，忽略空白后全文一致，仍按 `timing: inferred` 处理，不冒充精确 VTT 时间。
- [BsJGo1wFTvQ](https://www.youtube.com/watch?v=BsJGo1wFTvQ)：确认 `en-orig` 为原声 ASR（无翻译参数），取得 799 个时间相接的 VTT cue。显式滚动清理后为 400 个新文字段，399 个 10ms 快照删除，原始 cue 映射、每个新行文字和起止时间经独立逐条核对，覆盖仍为 `0–873.839` 秒。

这次真实文件暴露并修复了 VTT 单空格显示行被误作分隔符的问题，且验证了上述 10ms 相接模式；不推断所有自动字幕都使用该结构。未触发登录/验证门禁、短时 URL 失效或网络重试，因此这些恢复分支仍只有静态审阅与脚本功能边界检查的依据，不能声称已在线验证。
