# 21001 接入排查记录

核查日期：2026-10-16（北京时间）。以下故障对照针对原豆包身份应用，未联系飞书客服。排查时未修改应用权限、凭证、发布状态或代理设置；用户随后自行更换账号、创建新应用并更新本地凭证，验证结果见文末。

## 结论与边界

原豆包身份应用获取消息权限令牌时，被飞书平台的数据安全策略拒绝。已在旧接口、官方新版 OAuth 接口以及仅申请已开通消息权限的请求中复现；不是仅凭旧接口的模糊错误推测。下文故障表保留当时结果，不表示更换应用后诊断命令仍返回失败。

现有证据有力排除普通 Secret 输错、未开消息发送权限，以及“模板其他权限太多”作为本次消息权限拒绝的充分解释。现有证据不支持将修改客户端鉴权实现或切换 SDK 版本作为优先修复方向。

应用属于“豆包账号”身份，且多个同类账号报告同期故障，因此账号/租户准入限制是优先怀疑对象。**尚未确认具体命中的内部规则，也没有官方文档证明所有豆包账号或所有个人账号均不能使用 API。** 仍不能排除平台基于真实出口 IP、应用、账号风险状态等维度执行策略。普通飞书团队应用对照可进一步检验身份/租户相关假设，但新应用同时改变应用与租户等变量，不能单凭成功结果确认具体限制维度。

## 官方文档核对

1. [旧版自建应用 tenant_access_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal) 于核查时标记为历史版本，推荐新版。旧版仍使用 `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`，JSON 字段为 `app_id`、`app_secret`，权限要求为“无”。
2. [新版自建应用 tenant_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token) 使用 `POST https://accounts.feishu.cn/oauth/v3/token`，`grant_type=client_credentials`，认证参数为 `client_id`、`client_secret`；推荐 form-urlencoded。返回 `access_token`、`expires_in`，不能继续按旧字段取 Token。未传 `scope` 时默认使用应用已开通的应用身份权限；显式 `scope` 只能使用已开通权限。权限要求仍为“无”。
3. 同页区分 `20002`（应用凭证无效）、`20068`（申请未允许的权限）、`20069`（应用未启用）。这几种文档错误与实测的 `21001` 不同。
4. [登录和退出登录账号](https://www.feishu.cn/hc/zh-CN/articles/303520488692-%E7%99%BB%E5%BD%95%E5%92%8C%E9%80%80%E5%87%BA%E7%99%BB%E5%BD%95%E8%B4%A6%E5%8F%B7) 明确豆包登录身份没有企业管理后台，账号管理转由豆包处理；并提供“头像 → 登录更多账号”的官方操作路径。该页未明确声明 API 一概不可用。
5. [注册账号](https://www.feishu.cn/hc/zh-CN/articles/360045688853-%E6%B3%A8%E5%86%8C%E8%B4%A6%E5%8F%B7) 说明手机号注册飞书即创建企业，个人也可自行注册使用；这与豆包账号登录是不同身份路径。

## 本机对照结果

所有真实 Secret 均直接从仓库外配置读入进程内存，只发到官方鉴权接口；未输出 Token 或 Secret。下表没有保留真实凭证或原始请求对象。

| 对照 | 唯一主要变化 | 结果 | 能说明什么 |
|---|---|---|---|
| 原接入命令 `node skills/yjx-feishu-agent/scripts/feishu.mjs diagnose` | 基线：旧接口、已保存凭证 | HTTP 200，`21001`，无令牌 | 故障可独立于群和 Codex 稳定复现 |
| 完全虚构 App ID 和 Secret | 旧接口，不使用真实应用 | HTTP 200，`10003 / invalid param` | 请求链路能返回普通凭证参数错误，并非所有请求统一被网络层改写为 21001 |
| 官方新版 OAuth，默认权限 | 官方推荐协议与字段 | HTTP 400，`21001 / invalid_scope` | 迁移新版接口仍被拒；描述明确为数据安全/平台策略 |
| 官方新版 OAuth，仅 `im:message:send_as_bot` | 缩小为一项后台已确认“已开通”的消息发送权限 | HTTP 400，同样 `21001 / invalid_scope` | 即便仅请求本任务需要的消息发送权限，也被平台策略拒绝；不能归因于模板其他权限 |
| 同一 App ID、新版接口、同一消息权限，仅 Secret 改为一次故意错误值 | 凭证单变量对照 | HTTP 400，`20002 / invalid_client` | 有力支持已保存的 Secret 能通过应用认证，失败在后续权限策略检查；无依据继续轮换 Secret |

新版错误描述分别指出请求权限被数据安全策略阻止，以及平台策略拒绝访问。没有得到对应的策略标识或可在后台自行解除的设置。

后台只读核查：应用已启用、当前修改已发布；`im:message:send_as_bot` 已开通；安全设置未见 IP 白名单条目。模板中其他权限未修改。

网络只读核查：存在 Mihomo TUN，DNS 使用虚拟地址，因此“没有 HTTP_PROXY 环境变量”不能单独证明直连。进一步通过本机代理控制器观测同一 Node 进程对 `open.feishu.cn`、`accounts.feishu.cn` 公共 HTTPS 请求的连接路径，两者均为 DIRECT。没有改变路由、代理节点或系统设置。本机控制器观测未显示这两类请求经 Mihomo 代理节点转发；无法据此排除上游网络因素，也不能排除飞书基于真实出口 IP 等信息进行策略判断。

## 开源实现对照

核对官方 CLI commit `017b19a793ad71794a02887ede04757f3d82e10d`：

- [tat_fetch.go](https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/internal/credential/tat_fetch.go#L167-L188) 使用相同的官方 OAuth v3、form-urlencoded、`client_credentials`、`client_id` 和 `client_secret`；默认不传 `scope`。我们的新版默认权限对照与其核心鉴权字段相同；CLI 还支持可选 DPoP proof，并非所有请求头完全相同。
- [types.go](https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/internal/core/types.go#L115-L119) 明确新统一端点替代旧 Token 端点。
- [codemeta.go](https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/internal/errclass/codemeta.go#L70-L72) 将 `21001` 归类为 `Policy / AccessDenied`；[default_provider.go](https://github.com/larksuite/cli/blob/017b19a793ad71794a02887ede04757f3d82e10d/internal/credential/default_provider.go#L24-L62) 将 `invalid_client` 单独归类为应用配置问题。这与本机差分结果相符。

另核对 2026-10-16 的官方仓库源码：

- [Node SDK token-manager.ts](https://github.com/larksuite/node-sdk/blob/main/client/token-manager.ts#L123-L152)：普通 App Secret 的自建应用 TAT 默认仍走旧接口；ClientAssertion 分支另有 OAuth v3 支持。因此不能说 SDK 完全不支持新版，也不能假设普通 Secret TAT 已自动迁移。
- [官方 OpenClaw 插件 lark-client.ts](https://github.com/larksuite/openclaw-lark/blob/main/src/core/lark-client.ts#L254-L262)：同样构造 `Lark.Client`，使用 App ID、App Secret、SelfBuild。未发现为豆包账号采用另一套机器人鉴权的实现。
- [CLI issue #2815](https://github.com/larksuite/cli/issues/2815) 汇集 2026-10-14 起的多位豆包账号用户报告，包含相同令牌接口和 21001，也有换用企业身份后可用的用户反馈。这是故障关联证据，不是官方对内部管控规则的确认。

## 下一步可自助验证的路径

按官方“登录更多账号”流程，使用手机号登录用户自己管理的飞书原生身份，在自己的普通团队中准备一个独立测试应用，用同一台电脑、同一网络和同一新版最小鉴权请求做对照。不要选择未经授权管理的公司团队。

若该应用能取得令牌，则“当前豆包身份/租户相关限制”的判断明显加强，可将群桥接部署在可用的团队中；如果仍被策略拒绝，需要继续比较该团队的安全策略和应用状态。只有完成对照，才能确认这条迁移路径在用户环境中有效。现有应用保持原状，当前没有证据支持通过补权限、重复发布、重置 Secret 或重装 SDK 修复本问题。

## 更换账号与应用后的验证

2026-10-16 15:36–15:40（北京时间），用户自行更换账号和应用、更新本地 App ID 与 Secret 后，在同一台电脑上验证：

| 操作 | 新应用结果 |
|---|---|
| 旧版 `tenant_access_token/internal` | HTTP 200，`code=0`，取得令牌 |
| 新版 OAuth v3 `client_credentials`，默认权限 | HTTP 200，`code=0`，取得令牌 |
| 官方 SDK 查询机器人身份、所在群列表 | 成功，群列表当时为空 |

控制台只读确认新应用显示“正式应用@飞书个人版”，已启用、当前修改已发布，并已配置长连接及 `im.message.receive_v1` 事件。因此原有鉴权阻塞在新账号/应用组合下已经解除。这个结果进一步支持故障与原账号/租户/应用组合有关；由于这些变量一起变化，仍不据此确认某一条未公开的内部规则。

同日 15:54–15:55，用户将新机器人加入测试群并发送 @ 文本后，已完成飞书 → 已有 Codex 聊天 → 飞书的实际往返。历史标记回答正确，Codex 日志为 `completed`，飞书投递日志为 `replied`。详见 [实群往返验收](feishu.md#实群往返验收)。
