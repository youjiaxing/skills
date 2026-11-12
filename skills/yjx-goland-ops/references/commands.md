# 命令与结果

统一入口是本 Skill 安装目录中的 `scripts/goland-ops.mjs`。以下示例中的 `<entry>`、`<project>`、`<profile>`、`<launcher>` 均替换成当前机器实际值。所有命令输出 JSON；0 表示已确认成功，1 失败，2 受阻，3 未决或未知。

```sh
node <entry> project list --ide <launcher> --profile <profile>
node <entry> project ensure --ide <launcher> --profile <profile> --project <project>
node <entry> doctor --ide <launcher> --profile <profile> --project <project>
```

默认发现常见安装目录和 PATH；Toolbox、自定义安装、多个 profile 或符号链接配置不明确时显式传参。Windows 使用官方 `goland64.exe`，不用 shell 执行 `.bat`。macOS 可指定 `GoLand.app/Contents/MacOS/goland`；Linux 可指定官方 `bin/goland.sh`。独立配置实例需要 `--properties <原idea.properties> --vm-options <原vmoptions>`，保留实际 config/system/plugins/log 路由。

`--data-dir` 可选择独立私有运行目录；默认按平台使用 LOCALAPPDATA、Application Support 或 XDG_STATE_HOME。`--timeout-ms` 默认30000，最大300000。启动器退出码不等于 IDE 动作结果。

## 配置与运行

只查询明确项目的运行状态时，一条命令即可；启动器和 profile 可复用现有唯一候选发现，无需固定先执行 `doctor` 或 `project list`：

```sh
node <entry> run status --project <project>
```

成功结果中的 `ide.pid` 是实际 GoLand 进程 PID，`ide.profile` 是其配置目录，`project.path` 是匹配项目的规范路径，`project.name` 是 IDE 项目名。这些身份由 IDE 核验后返回；核对目标再使用 `sessions` 中的会话标识，IDE PID 不代表服务 PID。需要显式选择实例时补上 `--ide`、`--profile`。

```sh
node <entry> config list --project <project> ...
node <entry> config show --config "My Server" --project <project> ...
node <entry> config check --config "My Server" --project <project> ...
node <entry> run start --config "My Server" --project <project> ...
node <entry> run status --project <project> ...
node <entry> logs --session <session> --tail 100 --filter ERROR --project <project> ...
node <entry> logs --session <session> --cursor <previous-cursor> --project <project> ...
node <entry> run restart --session <session> --project <project> ...
node <entry> run stop --session <session> --project <project> ...
node <entry> attempt show --request <request-id> --project <project> ...
```

示例的 `...` 表示重复提供已选定的 launcher/profile 参数，不是实际传入的参数。配置选择器接受完整精确名称或返回的 ID，session 标识绑定 IDE 实例与运行句柄。会话已终止时日志仍可能可读，但只限 IDE 尚保留的控制台缓冲；游标绑定实例、会话与已读内容指纹，缓冲缩短、替换或换会话会报告 gap。输出受行数及字符数限制。

configuration.validation 表示配置检查结果；无法检查或检查失败不等于通过。SDK、模块、启动前任务用于诊断，不随 config update 改动。start 返回的 processReadyOnly 提醒调用方另行验证业务就绪。

写请求返回 requestId。结果不明时查询同一请求；`--request-id` 可以重用已存在的请求编号以观察原记录，传入不同操作也不会重放它。不要通过换新 request ID 绕过未决占用。异常退出后的 bootstrap.lock 先核对其 owner PID 和目标实例，不能按文件年龄直接删除。

## 复制与修改

```sh
node <entry> config clone --config "My Server" --name "My Test Server" --patch <patch.json> --project <project> ...
node <entry> config update --config "My Test Server" --revision <current-revision> --patch <patch.json> --project <project> ...
```

patch 是私有 JSON 文件，避免将凭据写入 argv、Shell 历史或对话。字段缺省表示不修改；字符串空值清空对应字段，文件列表空数组清空，删除环境变量使用 removeEnvironment。

```json
{
  "programArguments": "--server-id 123",
  "goToolArguments": "",
  "workingDirectory": "/absolute/project/server",
  "kind": "FILE",
  "files": ["/absolute/project/server/main.go"],
  "environment": {"MODE": "test"},
  "removeEnvironment": ["OLD_SETTING"],
  "inheritEnvironment": true
}
```

kind 可为 FILE、PACKAGE、DIRECTORY；package 字段用于包入口，directory 字段用于目录入口。clone 名称冲突拒绝覆盖；update 要求最新 revision。复制保留启动前任务与其他已识别设置，默认落在个人 workspace；修改保留原来的 local/shared 存储。保存后读取实际配置文件，并在副本展开项目宏核对配置和启动前任务；未确认持久化时返回 unknown 并保留占用，查询原请求可重新核实。正常保存可能落盘其他已有未保存设置，不能据此断言没有其他文件变化。环境值默认遮蔽，日志按需读取但不保证识别任意业务秘密。

## Debug

```sh
node <entry> breakpoint set --file src/main.go --line 42 --task issue-123 --project <project> ...
node <entry> debug start --config "My Server" --project <project> ...
node <entry> debug list --project <project> ...
node <entry> debug wait --session <session> --state paused --project <project> ...
node <entry> debug stack --session <session> --pause <pause> --project <project> ...
node <entry> debug variables --session <session> --pause <pause> --frame <frame> --project <project> ...
node <entry> debug variables --session <session> --pause <pause> --frame <frame> --value <valueHandle> --project <project> ...
node <entry> debug eval --session <session> --pause <pause> --frame <frame> --expression order.ID --project <project> ...
node <entry> debug step-over --session <session> --pause <pause> --project <project> ...
node <entry> debug continue --session <session> --pause <new-pause> --project <project> ...
node <entry> debug pause --session <session> --project <project> ...
node <entry> debug stop --session <session> --pause <pause-if-suspended> --project <project> ...
```

行号从1开始。stack 和 variables 默认最多50项，可用 `--limit` 调整到200。变量按 valueHandle 展开下一层，展示摘要最多4096字符，完整取证可能需要进一步专门处理。变量读取绑定具体 pause/frame；继续或单步后旧句柄失效。单步和继续不以方法返回当作完成；暂停或停止可以中断未决单步，原请求报告 interrupted 或终止结果。

breakpoint set 复用同位置既有断点，不改变其条件或启停状态。新断点是工具任务的临时断点，但可能被 IDE 持久化；其 group 标记和用户私有 ledger 共同证明归属。

```sh
node <entry> breakpoint list --project <project> ...
node <entry> breakpoint disable --breakpoint <id> --revision <revision> --task issue-123 --project <project> ...
node <entry> breakpoint enable --breakpoint <id> --revision <revision> --task issue-123 --project <project> ...
node <entry> breakpoint remove --breakpoint <id> --revision <revision> --task issue-123 --project <project> ...
node <entry> breakpoint cleanup --task issue-123 --project <project> ...
```

启停和移除默认要求断点由当前任务独占且 revision 未变。当前任务明确要求修改用户既有断点时，可用 `--allow-user-breakpoint`，仍须指定 task 和当前 revision；此操作不认领用户断点，也不把它加入临时清理。被用户改过的工具临时断点不能重新认领。项目存在其他可能受影响的调试会话时默认冲突；只有任务明确授权该范围后，才用 `--allow-other-sessions`。清理要求任务已明确结束，没有未决控制请求；归属标记不匹配、内容被用户改变或其他任务仍引用时保留。

## 实例与失败状态

`IDE_SELECTION_REQUIRED`、`PROFILE_SELECTION_REQUIRED` 按返回候选及任务目标显式选择启动器或 profile；`PROJECT_NOT_OPEN` 用 `project list` 核实该实例已打开的项目；`IDE_MODAL_DIALOG` 用 `doctor` 检查阻塞。超时或未决结果通过原 request ID 的 `attempt show` 继续观察，不把所有失败都转成重复诊断或重放命令。

查询和停止在目标 profile 离线时直接报 IDE_OFFLINE，不正常打开项目。检查后实例恰好退出时，启动器可能短暂冷启动执行脚本；脚本再次检查 PID/config 及项目，身份不符时拒绝动作并按官方命令流程退出。无法判断路由就要求显式选择，不猜另一个项目。

读取、配置修改和状态改变均只针对任务已授权目标。debug 查询不自动恢复暂停程序，Skill 结束不自动关闭用户 IDE、继续用户会话或移除用户断点。

未决状态由固定观察脚本进入新的官方 ideScript 调用推进，绝不重新执行原命令。CLI 中断后，通过原 request ID 的 attempt show 恢复观察。模型动作已确认但回执暂时无法原子替换时，仅重写原回执，不把文件共享冲突当作重新派发 IDE 动作的理由。
