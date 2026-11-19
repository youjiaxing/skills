import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  version: 1,
  defaultCapTokens: 512000,
  compactTriggerRatio: 0.9,
  variantCaps: [
    { suffix: '-256k', label: '256k', capTokens: 256000 },
  ],
  includeFullVariant: true,
};

export function hashKey(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function defaultT3Home(env = process.env) {
  return env.T3CODE_HOME?.trim() || path.join(os.homedir(), '.t3');
}

export function installDirFromT3Home(t3Home) {
  return path.join(path.resolve(t3Home), 'tools', 'antigravity-proxy');
}

export function launcherFileName(platform = process.platform) {
  return platform === 'win32' ? 'antigravity.cmd' : 'antigravity';
}

export function upstreamFileName(platform = process.platform) {
  return platform === 'win32' ? 'agy.exe' : 'antigravity';
}

export async function writeFileAtomic(filePath, content, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmpPath, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function readJsonSafe(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, missing: true, error };
    }
    return { ok: false, missing: false, error };
  }
}

export async function resolveBoundContext({ explicitInstallDir, explicitT3Home, env = process.env } = {}) {
  if (explicitInstallDir) {
    const installDir = path.resolve(explicitInstallDir);
    const installRecord = await readJsonSafe(path.join(installDir, 'runtime', 'install.json'));
    const t3Home = env.AGY_PROXY_T3_HOME?.trim()
      || explicitT3Home?.trim()
      || (installRecord.ok && typeof installRecord.value?.t3Home === 'string' ? installRecord.value.t3Home : null)
      || defaultT3Home(env);
    return {
      installDir,
      t3Home: path.resolve(t3Home),
      installRecord: installRecord.ok ? installRecord.value : null,
      boundByInstallDir: true,
    };
  }

  const t3Home = path.resolve(env.AGY_PROXY_T3_HOME?.trim() || explicitT3Home?.trim() || defaultT3Home(env));
  const installDir = installDirFromT3Home(t3Home);
  const installRecord = await readJsonSafe(path.join(installDir, 'runtime', 'install.json'));
  return {
    installDir,
    t3Home,
    installRecord: installRecord.ok ? installRecord.value : null,
    boundByInstallDir: false,
  };
}

export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaultCapTokens = Number.isInteger(source.defaultCapTokens) && source.defaultCapTokens > 0
    ? source.defaultCapTokens
    : DEFAULT_CONFIG.defaultCapTokens;
  const compactTriggerRatio = typeof source.compactTriggerRatio === 'number'
    && Number.isFinite(source.compactTriggerRatio)
    && source.compactTriggerRatio > 0
    && source.compactTriggerRatio <= 1
    ? source.compactTriggerRatio
    : DEFAULT_CONFIG.compactTriggerRatio;
  const includeFullVariant = typeof source.includeFullVariant === 'boolean'
    ? source.includeFullVariant
    : DEFAULT_CONFIG.includeFullVariant;
  const variantCaps = Array.isArray(source.variantCaps)
    ? source.variantCaps
        .filter((item) => item
          && typeof item.suffix === 'string'
          && item.suffix.startsWith('-')
          && item.suffix.length > 1
          && Number.isInteger(item.capTokens)
          && item.capTokens > 0)
        .map((item) => ({
          suffix: item.suffix,
          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : item.suffix.slice(1),
          capTokens: item.capTokens,
        }))
    : DEFAULT_CONFIG.variantCaps.map((v) => ({ ...v }));

  return {
    version: 1,
    defaultCapTokens,
    compactTriggerRatio,
    variantCaps,
    includeFullVariant,
  };
}

export async function loadConfig(installDir, env = process.env) {
  const configPath = env.AGY_PROXY_CONFIG?.trim() || path.join(installDir, 'config.json');
  const parsed = await readJsonSafe(configPath);
  const cfg = normalizeConfig(parsed.ok ? parsed.value : DEFAULT_CONFIG);

  if (env.AGY_PROXY_DEFAULT_CAP) {
    const overrideCap = Number(env.AGY_PROXY_DEFAULT_CAP);
    if (Number.isInteger(overrideCap) && overrideCap > 0) {
      cfg.defaultCapTokens = overrideCap;
    }
  }
  if (env.AGY_PROXY_COMPACT_RATIO) {
    const overrideRatio = Number(env.AGY_PROXY_COMPACT_RATIO);
    if (Number.isFinite(overrideRatio) && overrideRatio > 0 && overrideRatio <= 1) {
      cfg.compactTriggerRatio = overrideRatio;
    }
  }
  return { config: cfg, configPath, exists: parsed.ok };
}

export async function ensureDefaultConfig(installDir) {
  const configPath = path.join(installDir, 'config.json');
  if (existsSync(configPath)) {
    return { configPath, created: false };
  }
  await writeFileAtomic(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 0o644);
  return { configPath, created: true };
}

export async function readModelWindow(installDir, baseId) {
  const filePath = path.join(installDir, 'cache', 'models', `${hashKey(baseId)}.json`);
  const parsed = await readJsonSafe(filePath);
  if (!parsed.ok) return null;
  const data = parsed.value;
  if (!data || data.baseId !== baseId || !Number.isInteger(data.nativeSize) || data.nativeSize <= 0) {
    return null;
  }
  return data.nativeSize;
}

export async function writeModelWindow(installDir, baseId, nativeSize) {
  if (!Number.isInteger(nativeSize) || nativeSize <= 0) return false;
  const filePath = path.join(installDir, 'cache', 'models', `${hashKey(baseId)}.json`);
  const existing = await readModelWindow(installDir, baseId);
  if (existing === nativeSize) return false;
  await writeFileAtomic(
    filePath,
    `${JSON.stringify({ baseId, nativeSize, observedAt: new Date().toISOString() }, null, 2)}\n`,
    0o644,
  );
  return true;
}

export async function readSessionSelection(installDir, sessionId) {
  const filePath = path.join(installDir, 'cache', 'sessions', `${hashKey(sessionId)}.json`);
  const parsed = await readJsonSafe(filePath);
  if (!parsed.ok) return null;
  const data = parsed.value;
  if (!data || data.sessionId !== sessionId || typeof data.variantId !== 'string' || typeof data.baseId !== 'string') {
    return null;
  }
  return {
    sessionId: data.sessionId,
    variantId: data.variantId,
    baseId: data.baseId,
    capTokens: data.capTokens === null ? null : (Number.isInteger(data.capTokens) ? data.capTokens : null),
    isNativeMax: Boolean(data.isNativeMax),
  };
}

export async function writeSessionSelection(installDir, selection) {
  const filePath = path.join(installDir, 'cache', 'sessions', `${hashKey(selection.sessionId)}.json`);
  const payload = {
    sessionId: selection.sessionId,
    variantId: selection.variantId,
    baseId: selection.baseId,
    capTokens: selection.capTokens ?? null,
    isNativeMax: Boolean(selection.isNativeMax),
    updatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`, 0o644);
}

function isValidVariantRecord(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.variantId === 'string'
    && value.variantId.length > 0
    && typeof value.baseId === 'string'
    && value.baseId.length > 0
    && (value.capTokens === null || (Number.isInteger(value.capTokens) && value.capTokens > 0))
    && typeof value.isNativeMax === 'boolean',
  );
}

function variantMatches(a, b) {
  return a.variantId === b.variantId
    && a.baseId === b.baseId
    && (a.capTokens ?? null) === (b.capTokens ?? null)
    && Boolean(a.isNativeMax) === Boolean(b.isNativeMax);
}

export async function loadAllVariantAliases(installDir) {
  const dir = path.join(installDir, 'cache', 'variants');
  const byVariantId = new Map();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return byVariantId;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = await readJsonSafe(path.join(dir, entry.name));
    if (parsed.ok && isValidVariantRecord(parsed.value)) {
      byVariantId.set(parsed.value.variantId, parsed.value);
    }
  }
  return byVariantId;
}

async function acquireLockDir(lockDir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > 30000) {
          await rmdir(lockDir).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring variant lock: ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

export async function publishVariantAlias(installDir, candidate) {
  const variantsDir = path.join(installDir, 'cache', 'variants');
  await mkdir(variantsDir, { recursive: true });
  const finalPath = path.join(variantsDir, `${hashKey(candidate.variantId)}.json`);
  const payload = {
    variantId: candidate.variantId,
    baseId: candidate.baseId,
    capTokens: candidate.capTokens ?? null,
    isNativeMax: Boolean(candidate.isNativeMax),
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const tmpPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmpPath, 'wx', 0o644);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  const inspectExisting = async () => {
    const existing = await readJsonSafe(finalPath);
    if (existing.ok && isValidVariantRecord(existing.value) && variantMatches(existing.value, payload)) {
      return { status: 'ok', record: existing.value };
    }
    return { status: 'collision' };
  };

  try {
    await link(tmpPath, finalPath);
    return { status: 'ok', record: payload };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return await inspectExisting();
    }
    if (error?.code === 'ENOTSUP' || error?.code === 'EPERM' || error?.code === 'EXDEV') {
      const lockDir = path.join(variantsDir, '.lock');
      await acquireLockDir(lockDir);
      try {
        if (existsSync(finalPath)) {
          return await inspectExisting();
        }
        await rename(tmpPath, finalPath);
        return { status: 'ok', record: payload };
      } finally {
        await rmdir(lockDir).catch(() => {});
      }
    }
    throw error;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export async function resolveUpstreamBinary(opts = {}) {
  const {
    t3Home,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    forbiddenPaths = [],
  } = opts;
  const override = env.AGY_PROXY_UPSTREAM_BIN?.trim();
  let resolvedPath;
  let source;
  let releaseId = null;

  if (override) {
    resolvedPath = path.resolve(override);
    source = 'env:AGY_PROXY_UPSTREAM_BIN';
  } else {
    const runtimeDir = path.join(t3Home, 'tools', 'antigravity-acp', `${platform}-${arch}`);
    const activeJsonPath = path.join(runtimeDir, 'active.json');
    const active = await readJsonSafe(activeJsonPath);
    if (!active.ok || typeof active.value?.releaseId !== 'string' || !active.value.releaseId.trim()) {
      throw new Error(`Missing or invalid active.json at ${activeJsonPath}`);
    }
    releaseId = active.value.releaseId.trim();
    resolvedPath = path.join(runtimeDir, 'versions', releaseId, upstreamFileName(platform));
    source = activeJsonPath;
  }

  let info;
  try {
    info = await stat(resolvedPath);
  } catch {
    throw new Error(`Upstream antigravity binary not found: ${resolvedPath}`);
  }
  if (!info.isFile()) {
    throw new Error(`Upstream antigravity path is not a regular file: ${resolvedPath}`);
  }

  const realUpstream = realpathSync(resolvedPath);
  for (const forbidden of forbiddenPaths) {
    if (!forbidden) continue;
    try {
      if (realpathSync(forbidden) === realUpstream) {
        throw new Error(`Refusing recursive proxy invocation targeting ${realUpstream}`);
      }
    } catch (error) {
      if (error.message.startsWith('Refusing recursive')) throw error;
    }
  }

  return { binaryPath: resolvedPath, realPath: realUpstream, releaseId, source };
}

export function settingsFilePath(t3Home) {
  return path.join(path.resolve(t3Home), 'userdata', 'settings.json');
}

export async function updateT3SettingsBinaryPath({ t3Home, installDir, launcherPath }) {
  const filePath = settingsFilePath(t3Home);
  const backupMetaPath = path.join(installDir, 'runtime', 'settings-backup.json');
  let settings = {};
  let existed = false;

  if (existsSync(filePath)) {
    existed = true;
    const parsed = await readJsonSafe(filePath);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      throw new Error(`Cannot parse existing T3 Code settings.json at ${filePath}`);
    }
    settings = parsed.value;
  }

  const currentBinaryPath = settings?.providers?.antigravity?.binaryPath;
  const alreadyPointing = typeof currentBinaryPath === 'string'
    && path.resolve(currentBinaryPath) === path.resolve(launcherPath);

  let backupFile = null;
  if (!alreadyPointing && !existsSync(backupMetaPath)) {
    if (existed) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupFile = `${filePath}.backup-agy-proxy-${stamp}`;
      await copyFile(filePath, backupFile);
    }
    const backupMeta = {
      version: 1,
      settingsPath: filePath,
      settingsExisted: existed,
      hadProviders: Object.prototype.hasOwnProperty.call(settings, 'providers'),
      hadAntigravity: Boolean(settings.providers && Object.prototype.hasOwnProperty.call(settings.providers, 'antigravity')),
      hadBinaryPath: Boolean(settings.providers?.antigravity && Object.prototype.hasOwnProperty.call(settings.providers.antigravity, 'binaryPath')),
      previousBinaryPath: currentBinaryPath ?? null,
      backupFile,
      savedAt: new Date().toISOString(),
    };
    await writeFileAtomic(backupMetaPath, `${JSON.stringify(backupMeta, null, 2)}\n`, 0o600);
  }

  if (!alreadyPointing) {
    const nextSettings = {
      ...settings,
      providers: {
        ...(settings.providers && typeof settings.providers === 'object' ? settings.providers : {}),
        antigravity: {
          ...(settings.providers?.antigravity && typeof settings.providers.antigravity === 'object'
            ? settings.providers.antigravity
            : {}),
          binaryPath: launcherPath,
        },
      },
    };
    await writeFileAtomic(filePath, `${JSON.stringify(nextSettings, null, 2)}\n`, 0o644);
  }

  return {
    settingsPath: filePath,
    changed: !alreadyPointing,
    previousBinaryPath: currentBinaryPath ?? null,
    launcherPath,
  };
}

export async function restoreT3SettingsBinaryPath({ t3Home, installDir, launcherPath }) {
  const filePath = settingsFilePath(t3Home);
  const backupMetaPath = path.join(installDir, 'runtime', 'settings-backup.json');
  const parsed = await readJsonSafe(filePath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { settingsPath: filePath, changed: false, reason: 'settings_missing_or_unreadable' };
  }
  const settings = parsed.value;
  const backup = await readJsonSafe(backupMetaPath);
  const current = settings?.providers?.antigravity?.binaryPath;

  if (backup.ok && backup.value) {
    const meta = backup.value;
    if (meta.hadBinaryPath && typeof meta.previousBinaryPath === 'string') {
      settings.providers = settings.providers || {};
      settings.providers.antigravity = settings.providers.antigravity || {};
      settings.providers.antigravity.binaryPath = meta.previousBinaryPath;
    } else if (settings.providers?.antigravity) {
      delete settings.providers.antigravity.binaryPath;
      if (!meta.hadAntigravity && Object.keys(settings.providers.antigravity).length === 0) {
        delete settings.providers.antigravity;
      }
      if (!meta.hadProviders && Object.keys(settings.providers).length === 0) {
        delete settings.providers;
      }
    }
    await writeFileAtomic(filePath, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
    return {
      settingsPath: filePath,
      changed: true,
      restoredTo: meta.hadBinaryPath ? meta.previousBinaryPath : null,
    };
  }

  if (typeof current === 'string' && (!launcherPath || path.resolve(current) === path.resolve(launcherPath))) {
    delete settings.providers.antigravity.binaryPath;
    if (Object.keys(settings.providers.antigravity).length === 0) {
      delete settings.providers.antigravity;
    }
    if (Object.keys(settings.providers).length === 0) {
      delete settings.providers;
    }
    await writeFileAtomic(filePath, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
    return { settingsPath: filePath, changed: true, restoredTo: null };
  }

  return { settingsPath: filePath, changed: false, reason: 'not_managed_by_proxy' };
}

export async function readConversationStepStatus(geminiHome, sessionId, fn) {
  if (!geminiHome || !sessionId || !/^[a-zA-Z0-9._-]+$/.test(sessionId)) {
    return { status: 'unknown', reason: 'invalid_gemini_home_or_session_id' };
  }
  const dbPath = path.join(geminiHome, 'antigravity-acp', 'conversations', `${sessionId}.db`);
  let info;
  try {
    info = await lstat(dbPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'missing', dbPath };
    }
    return { status: 'unknown', reason: 'lstat_failed', error };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { status: 'unknown', reason: 'not_regular_file', dbPath };
  }

  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    return { status: 'unknown', reason: 'sqlite_unavailable', error };
  }

  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return await fn(db, dbPath);
  } catch (error) {
    return { status: 'unknown', reason: 'sqlite_read_failed', error };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors on readonly handle
    }
  }
}
