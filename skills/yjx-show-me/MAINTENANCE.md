# Maintenance: yjx-show-me

评审、修改或重新设计本 skill 时读取。运行时规则由 [SKILL.md](SKILL.md) 负责；本文件记录来源、取舍和更新依据。

## 上游与准确基线

| 项目 | 记录 |
| --- | --- |
| 来源 | [Matt Pocock / skills](https://github.com/mattpocock/skills) 的 `show-me` |
| 上游路径 | `skills/engineering/show-me/`（本机已安装只读副本 `C:\Users\Administrator\.agents\skills\show-me\SKILL.md`） |
| 基线文件指纹 | `SKILL.md` git blob `f0ccd047c136d7b702b385e0ecad775ccb773eae` |
| 关系 | 在上游 `show-me` 基础上独立维护的个人中文增强版；不修改第三方开源 `show-me` 原文件 |
| 许可 | 上游 MIT；保留 [LICENSE](LICENSE) 中的原版权和许可 |

## 能力承接与本地取舍

| 上游能力或做法 | 本地处理及理由 |
| --- | --- |
| 伪代码、调用树、组件树、浅层文件树、Mermaid、微型 `diff`、完整代码块、单文件 HTML | 完整保留全部最小可视化视口。 |
| `disable-model-invocation: true`（仅手动调用） | 改为模型可自动调用（移除 `disable-model-invocation: true`，`agents/openai.yaml` 设 `allow_implicit_invocation: true`），以便在项目 `AGENTS.md` 约定及代码解释场景下由模型自主触发。 |
| 逻辑统一用抽象伪代码或 Mermaid 展示 | 针对复盘证据（解释仓库既有代码实现时仅画 Mermaid/抽象伪代码导致脱离源码签名与分支细节），新增首要规则：解释或走读仓库既有代码实现机制时，优先采用“顶层精简调用树 + 保留真实函数签名、核心分支条件与状态读写的缩写代码块”并配一两句说明。 |
| 固定 `Bash(open ...)` 打开 HTML | 改为平台中立的在当前平台默认浏览器打开表述，适配 Windows 与跨平台环境。 |

## 更新核查与吸收记录

| 日期 | 核查范围与版本 | 实际吸收/保留差异 | 验证及剩余限制 |
| --- | --- | --- | --- |
| 2026-11-02 | 读取本机 `show-me/SKILL.md`（blob `f0ccd047c136d7b702b385e0ecad775ccb773eae`）全文 | 建立首版 `yjx-show-me`，改为模型可调用并补充既有源码走读的“顶层精简调用树 + 真实代码缩写块”规则 | 静态审阅与 `make link` 链接验证 |

## 静态维护检查

- `SKILL.md` 不设 `disable-model-invocation: true`，与 `agents/openai.yaml` 的 `allow_implicit_invocation: true` 一致。
- 解释仓库既有代码实现机制时，“顶层精简调用树 + 关键真实代码缩写块”规则位于视口列表首位，与纯算法伪代码边界清晰。
- 第三方 `C:\Users\Administrator\.agents\skills\show-me\SKILL.md` 保持未修改。

遵循仓库 [Skill Verification](../../AGENTS.md#skill-verification)：静态文档审阅、一致性、包装和链接检查，不创建或运行模拟会话行为测试。
