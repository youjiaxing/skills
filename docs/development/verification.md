# 验证开发链接 CLI

只使用仓库内 `.verify/` 作为目标目录，禁止触碰真实 Agent 全局 skill 目录。

1. 执行 `npm run status -- --no-config --target <隔离目录>`，确认只显示计划且不创建目录。
2. 执行 `npm run link -- --no-config --target <隔离目录>`，确认创建链接；重复执行确认显示“已正确链接”。
3. 临时添加一个包含 `SKILL.md` 的测试 skill，并在一个隔离目标创建同名普通目录；执行 `link`，确认全部目标都未修改。
4. 执行带 `--force` 的链接命令，确认冲突目录被替换。
5. 删除临时源 skill，执行带 `--prune` 的链接命令，确认只清理当前仓库管理的陈旧链接。
6. 删除全部验证文件。

Windows 链接使用 junction；macOS 链接使用目录 symlink。
