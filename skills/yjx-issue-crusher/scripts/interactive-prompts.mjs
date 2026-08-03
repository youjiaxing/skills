/**
 * Interactive prompts for feature / runtime selection (shared understanding).
 * Injectable `ask` for tests: async (question) => string
 */

import path from 'node:path';

import { DEFAULT_RUNTIME, normalizeRuntime } from './mode-config.mjs';

const kanbanModuleUrl = new URL('../../yjx-local-kanban/scripts/issue-board.mjs', import.meta.url);

async function loadKanban() {
  try {
    return await import(kanbanModuleUrl.href);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        '需要同目录安装 yjx-local-kanban，才能扫描 feature',
      );
    }
    throw error;
  }
}

/**
 * @param {string} projectRoot
 * @returns {Promise<string[]>} feature slugs
 */
export async function listFeatureSlugs(projectRoot) {
  const kanban = await loadKanban();
  const root = path.resolve(projectRoot);
  const config = await kanban.loadConfig(root);
  const dirs = await kanban.discoverFeatureDirs(root, config);
  return dirs.map((dir) => path.basename(dir));
}

/**
 * @param {{
 *   feature?: string|null,
 *   projectRoot: string,
 *   ask?: (q: string) => Promise<string>,
 *   nonInteractive?: boolean,
 *   listFeatures?: () => Promise<string[]>,
 *   output?: { write: (s: string) => void },
 * }} options
 */
export async function resolveFeatureOrPrompt({
  feature = null,
  projectRoot,
  ask = null,
  nonInteractive = false,
  listFeatures = null,
  output = process.stdout,
} = {}) {
  if (feature && String(feature).trim()) return String(feature).trim();

  const list = listFeatures
    ? await listFeatures()
    : await listFeatureSlugs(projectRoot);

  if (list.length === 0) {
    throw new Error(
      `在 ${projectRoot} 下未找到含 issues 的 feature（检查 trackerRoot / .scratch）`,
    );
  }
  if (list.length === 1) return list[0];

  if (nonInteractive || typeof ask !== 'function') {
    throw new Error(
      `找到多个 feature，请指定一个: ${list.join(', ')}（或交互运行 ic）`,
    );
  }

  output.write('请选择 feature:\n');
  list.forEach((slug, index) => {
    output.write(`  ${index + 1}) ${slug}\n`);
  });
  const answer = String(await ask('输入序号或名称: ')).trim();
  const asNum = Number.parseInt(answer, 10);
  if (Number.isFinite(asNum) && asNum >= 1 && asNum <= list.length) {
    return list[asNum - 1];
  }
  if (list.includes(answer)) return answer;
  throw new Error(`无效选择: ${answer}`);
}

/**
 * Runtime: flag → repo → (fake: default) → interactive ask → never silent grok for real chain.
 * @param {{
 *   flagRuntime?: string|null,
 *   repoRuntime?: string|null,
 *   fakeLauncher?: boolean,
 *   ask?: (q: string) => Promise<string>,
 *   nonInteractive?: boolean,
 *   output?: { write: (s: string) => void },
 * }} options
 * @returns {Promise<'grok'|'claude'>}
 */
export async function resolveRuntimeOrPrompt({
  flagRuntime = null,
  repoRuntime = null,
  fakeLauncher = false,
  ask = null,
  nonInteractive = false,
  output = process.stdout,
} = {}) {
  const fromFlag = normalizeRuntime(flagRuntime);
  if (fromFlag) return fromFlag;
  const fromRepo = normalizeRuntime(repoRuntime);
  if (fromRepo) return fromRepo;
  if (fakeLauncher) return DEFAULT_RUNTIME;

  if (nonInteractive || typeof ask !== 'function') {
    throw new Error(
      '未指定 runtime：请加 --runtime grok|claude，或在 .issue-crusher/config.json 写 "runtime"，或交互运行 ic',
    );
  }

  output.write('请选择 Worker 运行时:\n');
  output.write('  1) grok    (Grok Build)\n');
  output.write('  2) claude  (Claude Code)\n');
  const answer = String(await ask('输入 1/2 或 grok/claude: ')).trim().toLowerCase();
  if (answer === '1' || answer === 'grok') return 'grok';
  if (answer === '2' || answer === 'claude') return 'claude';
  throw new Error(`无效 runtime: ${answer}`);
}
