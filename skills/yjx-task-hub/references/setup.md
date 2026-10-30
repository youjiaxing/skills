# 接入与数据结构

## 私有绑定

默认根目录 `~/.yjx-task-hub/`，可用本地绝对路径 `YJX_TASK_HUB_HOME` 覆盖。机器参数来自环境，公开源码与样例使用虚构数据；真实库 ID、用户 ID、单号、姓名、任务正文和工具响应只保存在用户的私有目录或当次工具上下文。

脚本校验真实路径（含 Windows junction）并拒绝相对配置、网络共享、目录穿越、文件链接/硬链接及落入 Git 工作树的私有目录。POSIX 新目录 0700、文件 0600；Windows 依赖用户主目录的 ACL，未实现独立 ACL 加固。链接挂载的 skill 源码与私有数据目录各自定位。

首次接入：

1. 确认用户指定的 Notion 数据库；fetch 数据库和其 `collection://...` 数据源，核对目标与字段。目标已存在则复用；没有建库授权时只给出所需结构。
2. 用 TB `GetUsersMe` 核实当前身份，仅提取身份核对所需的 `userId` 与姓名，不保存响应中的 accessCode 等认证信息。后续同步核对当前身份与配置一致，账号不符时停止，重新绑定属于迁移。
3. 若用户授权补齐字段，使用 Notion 当前 `update_data_source` schema，只添加缺失字段。MCP 的文本 DDL 类型是 `RICH_TEXT`，不是返回 SQLite 定义中的 `TEXT`。已有字段类型/选项异常时报告，不自动删改重建。
4. 将以下结构的实际绑定通过 `--file <json-path>` 或 stdin 传给 `node <skill-dir>/scripts/hub.mjs init`。初始化拒绝覆盖既有 config/state；中途失败保留文件并核对后修复，不删除旧状态重来。

```json
{
  "version": 1,
  "notionDatabaseId": "11111111-1111-4111-8111-111111111111",
  "notionDataSourceId": "collection://22222222-2222-4222-8222-222222222222",
  "tbUserId": "aaaaaaaaaaaaaaaaaaaaaaaa",
  "activeWindowDays": 90,
  "watchedTasks": [],
  "ignoredTaskIds": []
}
```

凭据由宿主连接器管理，config 不存 token。`state.json` 含 version、数据源 binding、按 `TB:<taskId>`/`MANUAL:<id>` 建索引的 entries；脚本维护 pageId、trackingMode、lastKnownExecutorId、autoCompletedByReassign 和 pendingOp。备份/换机时 config 与 state 成对保留在私人位置；状态丢失后从当前事实保守建基线，不能恢复“过去是否因转派自动完成”的归属。该情况下只提示用户核对，不伪造历史后自动重开。修改数据源/账号不沿用旧基线；先核对未决与对应页面，再单独迁移。

## Notion 字段

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| 任务 | title | 一条个人工作事项 |
| 来源链接 | url | 原任务或消息入口；无链接留空 |
| 个人状态 | status | 待安排（默认）、进行中、等待他人、暂停、已完成 |
| 截止时间 | date | 未知留空 |
| 个人顺序 | number | 数字越小越优先；未确认留空 |
| 下一步动作 | text | 下一步；中断时保存进度与恢复点 |
| 来源标识 | text | TB 固定 `TB:<canonical taskId>`；人工事项留空 |
| 来源状态 | text | TB 状态、负责人及可用短 ID 的快照 |
| 迭代 | text | TB 任务所属迭代名称；明确无迭代时留空 |

Notion 创建/修改页工具的 `properties` 按当前工具 schema 使用字段名；date 常展开为 `date:截止时间:start`、`:end`、`:is_datetime`，以 fetch 返回结构为准。DDL 补字段后回读验证字段，不为验证写测试任务。

## 字段所有权

- TB 同步更新 `来源状态`、`来源链接`和已核实的 `迭代`；`来源标识` 创建后保持绑定，不改绑另一任务。去重冲突时保留页面，报告冲突。
- TB 标题、截止时间仅在首次入库初始化，后续差异在对话中提示，保留 Notion 当前值。`个人顺序`、`下一步动作` 只按用户指令写。
- `个人状态` 的两种同步自动转换由 [TB 生命周期](sync.md#状态转换) 定义；其余转换属于用户安排。
- 新人工事项先比较清单已有标题、链接和上下文；能唯一定位则复用，不确定先澄清。人工来源无稳定外部标识，脚本无法自动证明两句描述是同一事项，未决创建也适用恢复阻断。
