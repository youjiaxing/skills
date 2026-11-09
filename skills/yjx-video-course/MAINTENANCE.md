# 维护：yjx-video-course

运行规则以 [SKILL.md](SKILL.md) 及其条件参考为准。本文件记录启发来源、运行时依赖和实际上游评估；评估不等于采用。

## 来源与版本

- **概念与获取路线参考：** [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach)，历史引用为提交 `94f06c1969dfc1834001269d79d3ad0972d9dee6` 的 `agent_reach/skill/references/video.md`，本地落点为 [YouTube 字幕取证](references/youtube-subtitles.md)。该引用是可复现的参考内容，不证明整份 skill 派生自 Agent-Reach，也不确定最初参考日期。
- **运行时技能依赖：** `bangtutorial/bang-motion`，仅用于用户启用的动画导览；安装基线 `c1aa65e921c970d858705fcb4a53a8294d1a4131`。依赖权限与实际加载要求见 [动画导览](references/animated-preview.md)，不将依赖安装视为上游行为吸收。
- yt-dlp、whisper.cpp、FFmpeg 等为获取或处理工具；普通官方用法链接不自动构成派生 skill 关系。

## 2026-11-09 上游评估

固定 Agent-Reach 默认分支目标 `c70ae6da5d39bc90e09ad2ae0575ccc89f31e284`，比较历史引用 `94f06c1969dfc1834001269d79d3ad0972d9dee6`。轻量扫描该区间的路径清单、skill 文档变化和相关视频提交；精读原视频指南、当前入口与能力边界，以及下列视频实现差异，未审计整套渠道或浏览器实现。

- 旧视频参考已在 [6289733](https://github.com/Panniantong/Agent-Reach/commit/628973399e660d6c855fa4bb25cc379ac47a32d4) 删除；当前能力位于 [统一 skill](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/skill/SKILL.md)、`references/capabilities.md` 与 `channels/youtube.py` 等。保留本地历史固定链接，不因上游删文删除本地字幕能力。
- **已有覆盖：** [e2d80f0](https://github.com/Panniantong/Agent-Reach/commit/e2d80f000419f24762293f722b713c79d3c9194b) 按 cue 识别字幕正文、保留数字/特殊词开头的对白并排除 NOTE/STYLE/REGION 元数据；本地 `scripts/normalize-transcript.mjs` 已按 cue 解析、保留真实时间和 cue 映射并跳过元数据块。仅静态对照，未因此新增或运行测试。
- **保留本地取舍：** 当前上游统一命令、专用浏览器、会话复制与云端转写策略不直接移植。本地已有原生工具优先、浏览器登录态独立判定、访问门禁和默认本地转写规则；来源工具已安装或网络可达不等于取得指定视频的字幕正文。
- **已采用 V1（2026-11-09）：证书错误的条件化恢复。** [375eb3e](https://github.com/Panniantong/Agent-Reach/commit/375eb3e1be5d9e03bd42fed0e14560f65f683c54) 在设置 `SSL_CERT_FILE` / `SSL_CERT_DIR` 时为字幕与音频下载传 `--compat-options no-certifi`。yt-dlp [固定官方说明](https://github.com/yt-dlp/yt-dlp/blob/412e7f0a4b0588fe884a02b344ac66a06538475b/README.md#L2338) 确认此参数用于系统证书，落地时再次核对该说明。经独立方案审查与用户明确实施指令，诊断规则已集中写入 [本地转写的条件依赖](references/local-transcription.md#证书验证失败)，[YouTube 失败恢复](references/youtube-subtitles.md#失败与恢复) 引用该处。收益是减少代理/企业网络下的误诊；成本是少量文档调整，无需新增工具。评估时 PATH 未找到 yt-dlp，未验证本机参数或真实证书环境；条件化运行边界与此限制保留在正文，不默认对所有下载追加参数。

固定 bang-motion 默认分支目标仍为 `c1aa65e921c970d858705fcb4a53a8294d1a4131`，与记录的安装基线相同。相关入口、`references/anti-ppt.md`、`references/explainer.md` 及 starters 没有提交增量；未执行安装或动画体验验证，也不将本次记为其全部能力的首次评估。

首次评估后 V1 已落地文档；验证限于静态审阅、官方说明及链接核对，未运行真实下载/证书恢复或模型行为测试，也未安装依赖或更新外部技能。后续比较以上固定目标之后的变化，V1 不再作为待采用项；当前已评估范围之外仍保持未知。
