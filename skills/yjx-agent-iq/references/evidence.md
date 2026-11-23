# 内部证据接口

仅供考官整理已取得的真实记录或执行已明确授权的本地 CLI。用户不用记忆以下命令。此接口不创建 T3 会话，派发由宿主工具完成。

## 准备与采集

从安装目录运行 `node scripts/run.mjs prepare --question candy --output <绝对路径/prompt.txt>`（或 pelican），取得固定提示和 SHA-256。将文件内容原样传给被测方；保存实际 task 文本，宿主自动包装另行留在原始记录中，不手工添加评分清单。

每个被测运行只用一个新鲜上下文。取得宿主的完整 `activity`、终态、run ID、模型设置和子会话链接。补齐所有页、截断正文及工具事件后，再把记录按原有 position 升序保存为 `capture.json`：

```json
{
  "provider": "t3",
  "actualProvider": "<宿主返回的 Provider ID>",
  "sourceLink": "<宿主返回的完整子会话 Markdown 链接>",
  "run": { "id": "<本次 run ID>", "status": "completed" },
  "coverage": { "complete": true, "hasMore": false, "totalItems": 4 },
  "items": [
    { "position": 0, "runId": "<本次 run ID>", "type": "user_message", "text": "<宿主原文>", "textTruncated": false },
    { "position": 1, "runId": "<本次 run ID>", "type": "reasoning", "text": "<宿主原文>", "textTruncated": false },
    { "position": 2, "runId": "<本次 run ID>", "type": "assistant_message", "text": "<完整最终作答>", "textTruncated": false },
    { "position": 3, "runId": "<本次 run ID>", "type": "checkpoint", "text": "<宿主原文>", "textTruncated": false }
  ]
}
```

上例只说明宿主数据的承载结构，不是待生成的对话、工具夹具或固定条目数。实际条目逐条保留，包括所有工具调用；`totalItems` 取实际线程条目总数，不能从已读条目数反推“完整”。分支单次运行，不拼接多个线程；`runId`、覆盖声明和终态必须来自宿主证据，不能由考官猜测。未知事件、分页未补齐、条目缺口或原文截断都会阻止审计标为完整。

将 prompt 文件保存为实际发送文本；脚本同时核对宿主 user_message 中的实际输入，仅识别明确的 T3 test-subagent 固定前缀，未知包装不自动剥离。文件与实际输入不一致或哈希与固定版本不同的运行保留为样例，不计入严格原题通过。上下文隔离元数据另存 `context-evidence.json`，工具审计只证明已覆盖事件中的实际调用情况。

## 考官评估

先离线导入一次，获得最终作答、其 SHA-256 和初始待评估结果。后续有评估时导入到**新的评估目录**，保留先前记录，不覆盖它。糖果评估文件：

```json
{
  "answerSha256": "<answer.txt 的 SHA-256>",
  "finalNumber": { "value": 21, "quote": "<原文中表达最终答案的引用>" },
  "criteria": [
    { "id": "shape-choice", "status": "pass", "quote": "<原文>", "reason": "<判断理由>" },
    { "id": "guarantee-21", "status": "pass", "quote": "<原文>", "reason": "<判断理由>" },
    { "id": "lower-bound-20", "status": "review", "quote": "<原文>", "reason": "<缺口>" }
  ]
}
```

字段只承载考官已作出的判断。脚本校验引用与哈希并比较数字，不从关键词代替考官解读。不要把此文件发给被测方。

鹈鹕评估 `criteria` 使用 `runtime、identity、bicycle、pose、motion`，每项包含 `status、reason、evidence`（证据根目录内的非空文件路径数组）。`visual` 包含：

- `originalHtmlSha256`：从作答提取的原始 HTML 哈希；`originalRuntime:true` 仅在实际运行原文后填写。
- `observer:{link,freshContext:true}`：隔离视觉观察的宿主标识与确认依据。
- `frames:[{file,timeSeconds}]`：已实际查看的帧及相对同一动画基准的秒数。
- `primaryPeriodSeconds`：实际核实的主要周期；脚本至少校验四个四分之一相位的证据存在，其他周期关系和帧间接触仍由观察者核实。
- 原文运行、网络与控制台证据文件必须列入 runtime 项；副本说明和差异另存，不代替原文证据。

缺文件、路径越出证据目录、未验证哈希、缺隔离观察或关键相位时，相关项保持待复核。保存评估时同时保存证据根目录，以及每个实际引用文件的解析后绝对路径和 SHA-256 清单，供后续核对来源与变更。文件存在不是语义判断已正确的保证；脚本不验证图片内容或证明人体/机械动作合理。成绩仍需考官引用和用户体验确认。

## 导入与报告

```text
node scripts/run.mjs import --capture <capture.json> --prompt <prompt.txt> --question candy --model <模型> --agent <Provider ID> --source-link <宿主链接> --review <review.json> --evidence-root <证据目录> --output <本轮父目录>
```

`--review`、`--source-link` 可在初次导入时省略（链接也可来自 capture）。每次生成新评估子目录，保存原始证据、最终作答、审计、评分和报告。鹈鹕保存 HTML 并生成 gallery，缺评估时不会自动通过。批量时考官用 `recordAttempt` 逐次保存，`writeRunReport(root,records,{planned})` 汇总；planned 来自事先确认的计划，不得只统计成功结果。不可用/未开始的运行也须如实记录为未完成或缺记录。

诊断投影使用 `safeMetadata` / `safeFailure`，只输出白名单元数据和错误分类；原始错误/网络响应不进入终端。查看私有原始记录时仍先定点提取必要字段，不打印凭据。

## 明确授权的本地 CLI

仅在用户明确选择本地进程后使用 `once/compare --allow-local-cli`，必须指定题目和 Agent。可由考官传入本轮临时配置或直接模型；无需用户维护配置。`--executable`（原生可执行文件）与 `--entrypoint`（可选的 Node 入口）必须对应明确选定的 CLI，Windows 下不经 shell 执行 .cmd/.ps1。配置不可用时停止，不推测模型前缀或读取全局配置全文。原有 Provider 认证配置可以由选定 CLI 读取，但继承的系统配置是否完全隔离标为未知；不自动移除用户 Provider 配置以换取所谓干净运行。

该路径每个模型内串行运行预定次数，不自动重试；不同模型可并行。子进程失败/超时、协议不识别、限流和审计状态分别保存，不能把错误文本当作模型答案。工具硬禁能力仅按实证登记；Codex 的 read-only、Gemini 的 plan 模式不等于工具关闭。
