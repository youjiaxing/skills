---
name: yjx-goland-ops
description: 通过 GoLand 官方脚本入口管理项目、运行配置和服务，查询启动失败与日志，并进行本地 Go 断点调试。用于在 GoLand 中启停/重启服务、维护启动参数、读取运行会话，或让 Agent 设置断点、读取变量与调用栈、单步定位问题。
---

# GoLand 运行与调试

使用本 Skill 的 `scripts/goland-ops.mjs`，通过官方 `ideScript` 操作 IDE。需要 Node.js 20+ 和带 Groovy 脚本引擎的 GoLand；安装与已验范围见[兼容性](references/compatibility.md)。无需注册 MCP、安装额外插件或向 IDE 注入网络服务。

## 选择目标

1. 从宿主发现本 Skill 的真实安装目录，不假定当前目录或用户级固定路径。命令的完整参数由 `node <skill-dir>/scripts/goland-ops.mjs --help` 提供；配置与调试的专用用法按需读[命令与结果](references/commands.md)。
2. 取得目标项目的完整路径，使用 `--project` 定位；启动器和配置目录可由唯一候选自动发现。存在多个候选时依据任务消歧，使用 `--ide`、`--profile` 显式选择。自定义独立实例同时提供原 `--properties` 和 `--vm-options`。结果中的实际实例、项目和会话身份必须对应任务。
3. 查询明确项目的运行状态时直接 `run status --project <path>`，核对返回的 `ide` 和 `project.path`；其他操作按需使用 `doctor` 或 `project list`，错误分流见[命令与结果](references/commands.md#实例与失败状态)。已获启动服务授权且目标离线或未打开时，执行 `project ensure`，然后检查项目初始化、SDK 与运行配置。查询或停止任务不为了查找目标而启动新实例。信任、许可、引导对话框及无法识别的 profile 报告具体阻塞；不代替用户接受条款或更改共享信任与 SDK 设置。

## 运行与配置

- 用 `config list/show/check` 选出配置并核对入口、工作目录、参数和启动前任务。凭据默认遮蔽；不要直接输出配置 XML、请求原文或用户环境。
- `run start` 启动本地 Go 配置；已在运行或仍有构建/启动请求时先查原状态。`run status` 返回会话标识，停止和重新运行使用该标识，不按名称或端口批量结束进程。Debug 会话使用 Debug 命令。
- 启动请求失败或结果不明时，用 `attempt show --request <id>` 读取原请求的阶段、错误与有界输出。超时不代表动作未执行，不重放写请求。构建未产生运行句柄时返回未决状态，首版不强行取消构建。
- `logs` 读取指定会话的必要片段，可过滤或沿游标增量读取。`gap/truncated` 表示证据不完整，不能当作完整日志或“未发生”的证明。会话正在运行只证明进程状态；业务就绪需调用任务自己的协议或健康证据。
- `config clone` 默认产生个人配置；`config update` 要求当前 revision，仅修改明确字段，随后回读。共享来源保持共享；SDK、模块和启动前任务只检查。IDE 正常保存可能同时落盘其他待保存项目设置；部分失败先核实实际变化，不承诺事务回滚、不擅自重复修改或重启服务。

## 本地调试

1. 明确需要 Debug 的配置或已有会话。通过 `debug list/status` 取得 session，不能使用窗口焦点或“当前调试器”代替目标身份。普通 Run 不自动转为 Debug。
2. 行断点属于项目，可能影响多个调试会话。新增、启停或移除前检查影响范围；`--allow-other-sessions` 仅在当前任务已授权该范围时使用，不能为了消除冲突自行扩大授权。默认复用用户既有断点并保留状态；明确要求修改它时使用 `--allow-user-breakpoint`，不将它认领为临时断点。临时断点登记 `--task` 归属。
3. `debug start` 后用 `debug wait --state paused` 等待实际暂停。断点设置成功不等于命中；确认实际源文件、行号及 pause。用 `debug stack` 返回的 frame 查询 `variables` 或 `eval`。默认帧是该暂停的顶层帧，不随用户在 UI 中选择帧而改变。
4. `eval` 首批只允许变量名和字段链，例如 `order.ID`，不执行函数、赋值或任意 Go 代码。值的展示可截断，按返回的 valueHandle 有界展开子项，不把展示摘要当作完整对象。
5. `step-over/continue` 必须携带刚观察到的 pause。执行后核实新暂停、恢复或终止事件；旧 pause/frame/value 失效。动作未决时查询原请求；可用 pause/stop 收束未决单步，不并发发送继续和单步。
6. 任务收尾保留用户既有会话及暂停状态。明确结束自己的临时断点任务时执行 `breakpoint cleanup --task <id>`；清理校验归属与内容，IDE 重开后缺证据或用户已修改则保留并报告。请求超时不等于任务结束。与人工或其他控制器的操作不保证事务隔离。

## 完成与交付

按任务返回目标、实际动作、最终状态、关键日志或调试证据及未验证部分。只有后置状态被确认才报告完成；`pending/unknown` 保留 request ID 和最小恢复动作。首版不控制远程/复合运行、附加进程、条件/日志断点、goroutine 切换或单步进入/跳出。

本 Skill 不修改宿主 MCP 配置，不自动全局挂载、不提交项目文件。运行数据位于用户级私有目录，与 Skill 安装目录分离。
