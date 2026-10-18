import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function safeRealpath(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

// 判断模块是否作为 CLI 入口被执行。两边都解析 realpath，
// 以便通过软链接（如 Agent 技能目录链接到仓库）调用时仍能运行 main。
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return safeRealpath(fileURLToPath(importMetaUrl)) === safeRealpath(argv1);
}
