import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION_DIR = /_v[0-9]+$/;

/**
 * Platform-specific candidate roots for the DingTalk client data directory. An
 * explicit override wins outright: when it is set, discovery uses only that root
 * so a wrong value reports a failure instead of silently falling back.
 */
export function candidateDataRoots(env = process.env, platform = process.platform) {
  const roots = [];
  const push = (value) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  const override = env.YJX_DINGTALK_DATA_ROOT;
  if (override !== undefined && override !== null && String(override).trim() !== '') {
    push(String(override).trim());
    return roots;
  }
  if (platform === 'win32') {
    push(env.APPDATA && path.join(env.APPDATA, 'DingTalk'));
    push(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'DingTalk'));
    push(env.USERPROFILE && path.join(env.USERPROFILE, 'DingTalk'));
    push(env.APPDATA && path.join(env.APPDATA, 'DingTalkAppData', 'DingTalk'));
    push(env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'DingTalkAppData', 'DingTalk'));
    push('D:/DingTalkAppData/DingTalk');
    push('C:/DingTalkAppData/DingTalk');
  } else if (platform === 'darwin') {
    const home = os.homedir();
    push(path.join(home, 'Library', 'Application Support', 'DingTalk'));
    push(path.join(home, 'Library', 'Containers', 'com.alibaba.dingtalk', 'Data', 'Library', 'Application Support', 'DingTalk'));
  } else {
    const home = os.homedir();
    push(env.XDG_DATA_HOME && path.join(env.XDG_DATA_HOME, 'DingTalk'));
    push(path.join(home, '.local', 'share', 'DingTalk'));
    push(path.join(home, '.config', 'DingTalk'));
  }
  return roots;
}

/**
 * Account directories are the immediate children of a data root that carry a
 * version suffix (_v2, _v3, ...). A directory without the suffix is not treated
 * as an account, so it is reported as unsupported rather than guessed at.
 */
export function discoverAccounts(roots = candidateDataRoots()) {
  const accounts = [];
  const searched = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      searched.push({ root, status: error.code === 'ENOENT' ? 'absent' : 'unreadable' });
      continue;
    }
    searched.push({ root, status: 'present' });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!VERSION_DIR.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      const version = entry.name.slice(entry.name.lastIndexOf('_v') + 2);
      const dbPath = path.join(dir, 'DBFiles', 'dingtalk.db');
      const configPath = path.join(dir, 'user_config');
      accounts.push({
        id: entry.name,
        version,
        dir,
        dbPath,
        configPath,
        dbPresent: fs.existsSync(dbPath),
        configPresent: fs.existsSync(configPath),
      });
    }
  }
  return { accounts, searched };
}

export function describeDiscovery(discovery) {
  const lines = ['searched roots: ' + discovery.searched.length];
  for (const item of discovery.searched) lines.push('  [' + item.status + '] ' + item.root);
  lines.push('accounts: ' + discovery.accounts.length);
  for (const account of discovery.accounts) {
    lines.push('  ' + account.id + ' v' + account.version +
      ' db=' + (account.dbPresent ? 'yes' : 'no') +
      ' config=' + (account.configPresent ? 'yes' : 'no'));
  }
  return lines.join('\n');
}
