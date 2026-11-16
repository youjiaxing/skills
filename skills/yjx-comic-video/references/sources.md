# 来源与适用边界

外部方法的记录截至2026-11-16。这里固定来源与采用边界；项目自己的选择、实测片段和验证文件保存在所属私有项目，不复制到公开 Skill。

## 引入方法前的核查

先读 Skill 正文、决定性参考、实际样例；涉及工具行为再下探相关源码、默认参数与副作用。目录简介、安装量和 Star 只帮助发现候选，不能代替这些证据。推荐时说明已读范围，以及是否真正运行或看过成片。

区分三种来源：外部候选方法、项目已有实测经验、用户审美选择。它们不是统一的成熟度排名；一项技术实测也不能自动证明用户喜欢其效果。候选只有经过适用项目的授权验证后，才可成为该项目默认；验证结果和覆盖限制一起记录。

## HyperFrames

- 固定提交：[9f85cf0](https://github.com/heygen-com/hyperframes/tree/9f85cf0a252b25dcf70b08c3c0bbbaebb4cbff92/skills)。本地工具实现另按 CLI 0.9.53 核查，不能将 GitHub main 的文件自动当作本机行为。
- 已读 `hyperframes`、`hyperframes-cli`、`hyperframes-registry`、`media-use` 正文，以及分镜、角色表演、motion、captions、review、format、runtimes、CLI检查、资产复用和组件挂载/质量参考。
- 决定性源码：本地 snapshot 的场景推导、media-use 的 candidates/cache/manifest/media-home；固定提交下注册表的 [camera-shake](https://github.com/heygen-com/hyperframes/blob/9f85cf0a252b25dcf70b08c3c0bbbaebb4cbff92/registry/components/camera-shake/camera-shake.html)、[beat-freeze-cut](https://github.com/heygen-com/hyperframes/blob/9f85cf0a252b25dcf70b08c3c0bbbaebb4cbff92/registry/blocks/beat-freeze-cut/beat-freeze-cut.html)、[caption-editorial-emphasis](https://github.com/heygen-com/hyperframes/blob/9f85cf0a252b25dcf70b08c3c0bbbaebb4cbff92/registry/components/caption-editorial-emphasis/caption-editorial-emphasis.html)。三者仅源码核查，未挂载实测。
- 借鉴：明确镜头与阅读窗口、确定性时间轴、组件边界、切点/小屏审片、局部返修、可追溯资产。具体使用边界见 [HyperFrames工作方法](hyperframes-workflow.md)。
- 不直接采用：固定宣传片节奏、英文逐词字幕配方、表情永不硬切、轮廓抖动；账号/Pro模板、生成服务、遥测及不主动披露费用的供应商规则不由本 Skill 继承。
- 旧技能退役依据：[skillsManifest.ts](https://github.com/heygen-com/hyperframes/blob/9f85cf0a252b25dcf70b08c3c0bbbaebb4cbff92/packages/cli/src/utils/skillsManifest.ts#L147)。旧 animation/creative/keyframes/studio 和多个工作流整合进综合参考；audio 指向 media-use mixing。安装目录可能仍保留历史名称，不能据此要求逐个补装。
- [根许可证 Apache-2.0](https://github.com/heygen-com/hyperframes/blob/9f85cf0a252b25dcf70b08c3c0bbbaebb4cbff92/LICENSE)；[CREDITS](https://github.com/heygen-com/hyperframes/blob/9f85cf0a252b25dcf70b08c3c0bbbaebb4cbff92/CREDITS.md)另列依赖、字体和素材来源。具体素材、第三方代码及服务模板分别核查，不将根许可扩大到整个生态。

## short-drama-storyboard

- 固定提交：[37232f6](https://github.com/zenstory-ai/drama-skills/tree/37232f6d22e174c36e321d2e3a1a3ae871e7d602)。已读[主文件](https://github.com/zenstory-ai/drama-skills/blob/37232f6d22e174c36e321d2e3a1a3ae871e7d602/skills/short-drama-storyboard/SKILL.md)、同目录 `references/shot-craft.md`、`blocking-playbooks.md`、`keyframe-craft.md`、`stage-contract.md`，并核对公开分镜样例与评估说明。
- 借鉴：镜头目的、起点与终点、听者接招、视线轴、持物连戏、镜号修订关系，写入[分镜与连戏](shot-continuity.md)。与已有经验重合的方法合并维护，不因多一个来源重复加规则。
- 不引入：竖屏默认构图、视频模型时长下限、全套跨文档格式及生成工作流。评估说明中剧本质量与流程回归不证明分镜成片质量；未做同条件制作成本试验。
- [MIT许可证](https://github.com/zenstory-ai/drama-skills/blob/37232f6d22e174c36e321d2e3a1a3ae871e7d602/LICENSE)。

## animation-principles

- 固定提交：[8359713](https://github.com/dylantarre/animation-principles/tree/83597134ba8ff59838270f94d7ac7282ffa3b54d)。已读 `filmmaker`、[anticipation-payoff](https://github.com/dylantarre/animation-principles/blob/83597134ba8ff59838270f94d7ac7282ffa3b54d/skills/02-by-thinking-style/anticipation-payoff/SKILL.md)、`rhythm-pacing`、`staging-mastery` 及相关 timing/GSAP 方法。
- 借鉴：准备姿势、动作顶点、结果姿势，节拍与静止保持，主次动作错时。按候选方法写入[喜剧表演](comedy-performance.md)，未作为项目成片效果或省工保证。
- 不采用：每个动作都反向准备的绝对化要求、统一时长比例、套用UI循环动效、为流畅而排除硬切。原文未提供项目所需的完整配音/绘稿/渲染实现。
- [MIT许可证](https://github.com/dylantarre/animation-principles/blob/83597134ba8ff59838270f94d7ac7282ffa3b54d/LICENSE)。

## 复用与维护

本文与相邻参考为针对本流程重述的方法总结，没有复制整个上游 Skill 或组件源码。以后复制/改编实质文档、代码或素材时，在副本保留对应版权、许可证和必要 NOTICE，并标记修改；字体、第三方依赖与服务内容按各自条款处理。

更换上游版本时只重查影响当前方法的部分，先验证再更新来源记录。实际发生的错误和用户反馈写回负责该行为的一处文档或组件，链接其他使用处；保留未验证事项，不以增加文档数量作为完成标准。
