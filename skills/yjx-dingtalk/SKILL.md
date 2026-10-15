---
name: yjx-dingtalk
description: 只读解析本机钉钉缓存：会话查找、按时间范围读取、关键词搜索、按消息展开上下文，并尽力复用已有的图片 OCR 文字。不改钉钉数据，不重启客户端。
argument-hint: "[会话/关键词/时间范围] [--json] [--refresh] [--task <id>]"
disable-model-invocation: true
---

# yjx-dingtalk

读取本机钉钉客户端已经缓存的数据，用于查找会话、读取消息和搜索关键词。数据源是本地缓存，不是云端完整历史。

## 何时使用

仅当用户明确要求查询钉钉（某会话、某时间段、某关键词、某条消息的上下文）时使用。其他开发、排障任务不读取钉钉。

## 前提与边界

- 只读：以共享只读方式打开原数据库与 WAL，不关闭或重启钉钉，不注入、不读进程内存。
- 不修改仓库、不改钉钉数据、不发消息。
- 需要 Node.js 22.13 及以上（使用 `node:sqlite`）。不自动安装或升级运行时。
- 会话或账号无法唯一确定时，列出候选让用户指定，不跨账号合并。
- 撤回的消息只返回标识、时间和状态，不返回正文、原结构、OCR、引用或卡片文字。
- 图片文字只尽力复用消息里已有的识别结果（`attachments[].extension.photo_content_ocr`）；没取到不等于图片没有文字。

## 运行

本文件所在目录记为 `<skill-dir>`；脚本只用 Node 标准库，无第三方依赖。

```bash
node <skill-dir>/scripts/dingtalk.mjs discover
node <skill-dir>/scripts/dingtalk.mjs conversations --query <文本> --limit 10
node <skill-dir>/scripts/dingtalk.mjs messages --account <id> --conversation <cid> --since <ms> --limit 50
node <skill-dir>/scripts/dingtalk.mjs search --keyword <文本> --limit 20
node <skill-dir>/scripts/dingtalk.mjs context --account <id> --conversation <cid> --message <mid> --before 5 --after 5
node <skill-dir>/scripts/dingtalk.mjs clean
```

通用选项：`--json` 机器可读输出；`--refresh` 忽略副本重新采集；`--task <id>` 指定任务缓存标识；`--full` 文本输出不截断正文。`messages` 的结果包含采集时间与副本路径，引用时一并给出。

## 副本、刷新与清理

副本默认生成在 `~/.yjx-dingtalk/`，可用绝对路径的 `YJX_DINGTALK_HOME` 覆盖；相对路径、UNC 或网络共享、符号链接一律拒绝。既没有可写家目录又没设置该变量时，拒绝写入，不回退到工作目录或临时目录。POSIX 下目录为 0700、副本及附属文件为 0600；Windows 依赖用户配置目录的默认 ACL，只校验非共享路径。

同一任务同一账号复用有效副本；需要最新数据时加 `--refresh`，校验通过后再替换旧副本，刷新失败时保留旧副本并报告旧数据时间。

`clean` 只删除缓存清单登记的文件，不跟随符号链接，也不删除被标记保留的副本；清单缺失或损坏时不做目录级批量删除。闲置时间按查询活动计算，默认 24 小时过期。

## 数据来源与已知限制

- 目前真实验证只在 Windows（钉钉 9.0.1）上完成；macOS 与 Linux 的路径、日志字段与账号布局尚未实机验证。
- V3 账号用账号目录的 `user_config` 盐值与客户端日志中的 uid 现场推导密钥，密钥不落盘；缺少密钥材料或遇到未识别格式时明确报错，不用别的路径或账号顶替。
- 采集是尽力而为：能确认源文件在读取期间没有变化，但不承诺原子同一时点的完整快照。

## 完成实质任务后的提醒

用完副本后提醒用户：本地存在明文副本，位置与清理方式是 `node <skill-dir>/scripts/dingtalk.mjs clean`（或直接删除 `~/.yjx-dingtalk/`）。是否保留由用户决定，不强制删除。任务结束时的清理只覆盖中间产物，被标记保留的副本不会被自动删除。

## 测试

```bash
node --test skills/yjx-dingtalk/tests/*.test.mjs
```
