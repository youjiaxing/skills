import test from 'node:test';
import assert from 'node:assert/strict';
import { registeredDesktopCodex, resolveDesktopCodex } from '../scripts/desktop-codex.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

const before = 'OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0';
const after = 'OpenAI.Codex_26.1026.4000.0_x64__2p2nqsd0c76g0';
const root = name => `C:\\Program Files\\WindowsApps\\${name}`;

function registry(names, accessible = async () => {}) {
  return { platform: 'win32', accessible, query: async args => {
    if (args.length === 2) return names.map(name => `${args[1]}\\${name}`).join('\r\n');
    const name = args[1].split('\\').at(-1);
    return `    PackageRootFolder    REG_SZ    ${root(name)}\r\n`;
  } };
}

test('Desktop mode discovers an updated registration on the next request, without retaining the old hash or PATH', async () => {
  const options = registry([before]);
  assert.equal(await registeredDesktopCodex(options), `${root(before)}\\app\\resources\\codex.exe`);
  options.query = registry([after]).query;
  assert.equal(await registeredDesktopCodex(options), `${root(after)}\\app\\resources\\codex.exe`);
});

test('Desktop mode does not select unrelated packages or guess between multiple installed versions', async () => {
  assert.equal(await registeredDesktopCodex(registry([before, 'Another.Codex_1.2.3.4_x64__other'])),
    `${root(before)}\\app\\resources\\codex.exe`);
  await assert.rejects(registeredDesktopCodex(registry([before, after])), { code: 'CODEX_NOT_FOUND' });
});

test('missing registration, inaccessible binary, malformed package path and unsupported platforms block safely', async () => {
  await assert.rejects(registeredDesktopCodex(registry([])), { code: 'CODEX_NOT_FOUND' });
  for (const code of ['ENOENT', 'EACCES']) {
    await assert.rejects(registeredDesktopCodex(registry([before], async () => { throw Object.assign(new Error('private'), { code }); })),
      { code: 'CODEX_NOT_FOUND' });
  }
  const options = registry([before]);
  const query = options.query;
  options.query = async args => args.length === 2 ? query(args) : 'PackageRootFolder REG_SZ C:\\unrelated';
  await assert.rejects(registeredDesktopCodex(options), { code: 'CODEX_NOT_FOUND' });
  await assert.rejects(registeredDesktopCodex({ platform: 'linux' }), { code: 'CODEX_NOT_FOUND' });
});

test('export selection follows registered content across upgrades and rejects newer-looking mismatches', async () => {
  let revision = 'old';
  let hashed = 0;
  const copies = ['1111111111111111', '2222222222222222'];
  const options = { directory: 'fixture-exports', registered: async () => `${revision}-source`, list: async () => copies,
    inspect: async () => '100:1:1', hash: async file => {
      hashed += 1;
      if (file.endsWith('source')) return revision;
      return file.includes(copies[0]) ? 'old' : 'new';
    } };
  assert.equal(await resolveDesktopCodex(options), path.join('fixture-exports', copies[0], 'codex.exe'));
  const priorHashes = hashed;
  await resolveDesktopCodex(options);
  assert.equal(hashed, priorHashes, 'unchanged verified content is not rehashed per message');
  revision = 'new';
  assert.equal(await resolveDesktopCodex(options), path.join('fixture-exports', copies[1], 'codex.exe'));
  revision = 'missing';
  await assert.rejects(resolveDesktopCodex(options), { code: 'CODEX_NOT_FOUND' });
});

test('real file hashes select the matching export and invalidate cached content after installation changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yjx-desktop-exports-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'registered.exe');
  const old = path.join(directory, 'aaaaaaaaaaaaaaaa', 'codex.exe');
  const updated = path.join(directory, 'bbbbbbbbbbbbbbbb', 'codex.exe');
  await mkdir(path.dirname(old)); await mkdir(path.dirname(updated));
  await writeFile(source, 'old-executable'); await writeFile(old, 'old-executable');
  await writeFile(updated, 'wrong-content!');
  const options = { registered: async () => source, directory };
  assert.equal(await resolveDesktopCodex(options), old);
  await writeFile(source, 'new-executable-with-more-bytes');
  await assert.rejects(resolveDesktopCodex(options), { code: 'CODEX_NOT_FOUND' });
  await writeFile(updated, 'new-executable-with-more-bytes');
  assert.equal(await resolveDesktopCodex(options), updated);
  await rm(updated);
  await assert.rejects(resolveDesktopCodex(options), { code: 'CODEX_NOT_FOUND' });
});
