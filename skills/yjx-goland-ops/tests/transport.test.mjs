import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge, atomicJSON, safeFieldExpression, validateIdentifier, resolveTarget, observeRequest } from '../scripts/lib/host.mjs';
import { main } from '../scripts/goland-ops.mjs';

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'goland-ops-protocol-'));
  try {
    const profile = path.join(root, 'profile');
    await mkdir(profile);
    await writeFile(path.join(profile, '.lock'), String(process.pid));
    const targetDir = path.join(root, 'target');
    await mkdir(targetDir);
    await fn({ root, profile, targetDir, id: 'test', env: process.env, project: root, launcher: 'unused' });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('concurrent identical request IDs dispatch exactly once and never replay uncertain writes', async () => fixture(async target => {
  let dispatched = 0;
  const spawnLauncher = (ignored, argv) => { if (path.basename(argv[1]) === 'command.groovy') dispatched++; return {}; };
  const bridge = new Bridge(target, { timeout: 30, spawnLauncher });
  const id = randomUUID();
  const responses = await Promise.all([
    bridge.send('config.update', { config: 'A' }, { id }),
    bridge.send('config.update', { config: 'A' }, { id }),
  ]);
  assert.equal(dispatched, 1);
  assert.ok(responses.every(r => r.outcome === 'unknown'));
  const later = await bridge.send('run.start', { config: 'B' }, { id });
  assert.equal(later.code, 'EXISTING_REQUEST');
  assert.equal(dispatched, 1);
}));

test('late acknowledgement is recovered by request identity without starting a second action', async () => fixture(async target => {
  let dispatched = 0;
  const id = randomUUID();
  const bridge = new Bridge(target, { timeout: 25, spawnLauncher: (ignored, argv) => { if (path.basename(argv[1]) === 'command.groovy') dispatched++; return {}; } });
  assert.equal((await bridge.send('run.start', {}, { id })).outcome, 'unknown');
  await atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'ok', session: 'one-real-session' });
  const result = await bridge.send('run.start', {}, { id });
  assert.equal(result.session, 'one-real-session');
  assert.equal(dispatched, 1);
}));

test('offline read and stop do not invoke the IDE launcher', async () => fixture(async target => {
  await rm(path.join(target.profile, '.lock'));
  let called = false;
  const bridge = new Bridge(target, { spawnLauncher: () => { called = true; return {}; } });
  await assert.rejects(bridge.send('run.stop'), error => error.code === 'IDE_OFFLINE');
  assert.equal(called, false);
}));

test('an acknowledgement for another request cannot be accepted', async () => fixture(async target => {
  const id = randomUUID();
  const bridge = new Bridge(target, { timeout: 1000, spawnLauncher: () => {
    atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: randomUUID(), outcome: 'ok' }).catch(() => {});
    return {};
  } });
  await assert.rejects(bridge.send('config.update', {}, { id }), error => error.code === 'PROTOCOL_ID_MISMATCH');
}));

test('private input travels in JSON, not command arguments, and terminal completion removes it', async () => fixture(async target => {
  const id = randomUUID();
  let argv;
  let payload;
  const bridge = new Bridge(target, { timeout: 1000, spawnLauncher: (ignored, args) => {
    argv = args;
    (async () => {
      payload = JSON.parse(await readFile(path.join(target.root, 'requests', id, 'request.json'), 'utf8'));
      await atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'ok' });
    })().catch(() => {});
    return {};
  } });
  await bridge.send('config.update', { patch: { environment: { TOKEN: 'secret-test-value' } } }, { id });
  assert.equal(payload.args.patch.environment.TOKEN, 'secret-test-value');
  assert.ok(!argv.join(' ').includes('secret-test-value'));
  await assert.rejects(readFile(path.join(target.root, 'requests', id, 'request.json')), { code: 'ENOENT' });
}));

test('restricted evaluator and request identifiers reject execution and directory traversal', () => {
  assert.ok(safeFieldExpression('order.Customer.ID'));
  for (const value of ['call()', 'x = 1', 'x[call()]', 'x; panic(1)', 'x\n.y', '/*x*/ y', '1', 'x[0]'])
    assert.equal(safeFieldExpression(value), false, value);
  for (const value of ['../other', 'a/../../', '', 'x'.repeat(36)])
    assert.throws(() => validateIdentifier(value), error => error.code === 'INVALID_REQUEST_ID');
});

test('request recovery refuses cached success from another project or profile', async () => fixture(async target => {
  const id = randomUUID();
  const bridge = new Bridge(target, { timeout: 10, spawnLauncher: () => ({}) });
  await bridge.send('run.start', {}, { id });
  await atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'ok', session: 'A' });
  await assert.rejects(observeRequest({ ...target, project: path.join(target.root, 'other-project') }, id), error => error.code === 'REQUEST_TARGET_MISMATCH');
  await assert.rejects(new Bridge({ ...target, profile: path.join(target.root, 'other-profile') }).send('run.start', {}, { id }), error => error.code === 'REQUEST_TARGET_MISMATCH');
}));

test('an unresolved project-open request remains occupied and is only observed on subsequent calls', async () => fixture(async target => {
  let dispatched = 0;
  let probes = 0;
  const bridge = new Bridge(target, { timeout: 10, spawnLauncher: () => { dispatched++; return {}; } });
  bridge.send = async () => ++probes === 1
    ? { outcome: 'failed', code: 'PROJECT_NOT_OPEN' }
    : { outcome: 'unknown', code: 'RESULT_TIMEOUT' };
  await bridge.ensureProject();
  const second = await bridge.ensureProject();
  assert.equal(dispatched, 1);
  assert.ok(second.observingBootstrap);
}));

test('successful observation closes the prior bootstrap without blocking a later different project', async () => fixture(async target => {
  let launches = 0;
  const bridge = new Bridge(target, { timeout: 10, spawnLauncher: () => { launches++; return {}; } });
  let state = 'not-open';
  bridge.send = async () => {
    if (state === 'not-open') { state = 'pending'; return { outcome: 'failed', code: 'PROJECT_NOT_OPEN' }; }
    if (state === 'ready') return { outcome: 'ok', project: { initialized: true } };
    return { outcome: 'unknown', code: 'RESULT_TIMEOUT' };
  };
  await bridge.ensureProject();
  state = 'ready';
  assert.equal((await bridge.ensureProject()).outcome, 'ok');
  const other = new Bridge({ ...target, project: path.join(target.root, 'second-project') }, { timeout: 10, spawnLauncher: () => { launches++; return {}; } });
  other.send = async () => ({ outcome: 'ok', project: { initialized: true } });
  assert.equal((await other.ensureProject()).outcome, 'ok');
  assert.equal(launches, 1);
}));

test('a direct successful project probe also settles the matching original bootstrap', async () => fixture(async target => {
  const id = randomUUID();
  await atomicJSON(path.join(target.targetDir, 'bootstrap.lock'), { id: randomUUID(), project: target.project, pid: process.pid });
  const bridge = new Bridge(target, { timeout: 1000, spawnLauncher: () => {
    atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'ok', project: { initialized: true, path: target.project } }).catch(() => {});
    return {};
  } });
  assert.equal((await bridge.send('project.probe', {}, { id })).outcome, 'ok');
  await assert.rejects(readFile(path.join(target.targetDir, 'bootstrap.lock')), { code: 'ENOENT' });
}));

test('a late probe cannot remove a newer bootstrap even for the same project', async () => fixture(async target => {
  const id = randomUUID();
  const lock = path.join(target.targetDir, 'bootstrap.lock');
  const oldBootstrap = randomUUID();
  const nextBootstrap = randomUUID();
  await atomicJSON(lock, { id: oldBootstrap, project: target.project, pid: process.pid });
  const bridge = new Bridge(target, { timeout: 1000, spawnLauncher: () => {
    (async () => {
      await atomicJSON(lock, { id: nextBootstrap, project: target.project, pid: process.pid });
      await atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'ok', project: { initialized: true, path: target.project } });
    })().catch(() => {});
    return {};
  } });
  assert.equal((await bridge.send('project.probe', {}, { id })).outcome, 'ok');
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).id, nextBootstrap);
}));

test('profile/property conflict and conflicting VM route are rejected before launch', async () => fixture(async target => {
  const ide = path.join(target.root, 'goland64.exe');
  await writeFile(ide, '');
  const properties = path.join(target.root, 'idea.properties');
  await writeFile(properties, 'idea.config.path=' + target.root.replaceAll('\\', '/') + '\n');
  await assert.rejects(resolveTarget({ ide, profile: target.profile, properties, dataDir: path.join(target.root, 'state') }),
    error => error.code === 'PROFILE_PROPERTIES_CONFLICT');
  const vmOptions = path.join(target.root, 'test.vmoptions');
  await writeFile(vmOptions, '-Didea.config.path=' + target.root.replaceAll('\\', '/') + '\n');
  await assert.rejects(resolveTarget({ ide, profile: target.profile, vmOptions, dataDir: path.join(target.root, 'state') }),
    error => error.code === 'PROFILE_VM_CONFLICT');
}));

test('parallel target resolution never exposes truncated launcher properties', async () => fixture(async target => {
  const ide = path.join(target.root, 'goland64.exe');
  await writeFile(ide, '');
  const options = { ide, profile: target.profile, dataDir: path.join(target.root, 'state') };
  const resolved = await Promise.all(Array.from({ length: 12 }, () => resolveTarget(options)));
  for (const value of resolved) {
    const text = await readFile(value.env.GOLAND_PROPERTIES, 'utf8');
    assert.match(text, /idea\.config\.path=.+/);
    assert.ok(text.endsWith('\n'));
  }
}));

test('malformed private patch never puts parser input snippets in CLI output', async () => fixture(async target => {
  const file = path.join(target.root, 'patch.json');
  await writeFile(file, '{"PASSWORD":"must-not-leak",broken}');
  const messages = [];
  const originalLog = console.log;
  try {
    console.log = value => messages.push(value);
    assert.equal(await main(['config', 'update', '--patch', file]), 1);
  } finally { console.log = originalLog; }
  assert.ok(!messages.join('').includes('must-not-leak'));
  assert.match(messages.join(''), /INVALID_PATCH_JSON/);
}));

test('pending receipts are observed with a fixed read/advance script instead of replaying the write', async () => fixture(async target => {
  const id = randomUUID();
  let actions = 0;
  let observations = 0;
  const bridge = new Bridge(target, { timeout: 1500, spawnLauncher: (ignored, argv) => {
    if (path.basename(argv[1]) === 'command.groovy') {
      actions++;
      atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'pending' }).catch(() => {});
    } else {
      observations++;
      atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'ok', state: 'stopped' }).catch(() => {});
    }
    return {};
  } });
  assert.equal((await bridge.send('run.stop', {}, { id })).state, 'stopped');
  assert.equal(actions, 1);
  assert.ok(observations >= 1);
}));

test('an instance disappearing after dispatch is not cold-launched by observation polling', async () => fixture(async target => {
  const id = randomUUID();
  let calls = 0;
  const bridge = new Bridge(target, { timeout: 150, spawnLauncher: () => {
    calls++;
    rmSync(path.join(target.profile, '.lock'), { force: true });
    (async () => {
      await atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'pending' });
    })().catch(() => {});
    return {};
  } });
  assert.equal((await bridge.send('run.stop', {}, { id })).outcome, 'unknown');
  assert.equal(calls, 1);
}));

test('a missing first receipt is recovered through observation without replaying the accepted action', async () => fixture(async target => {
  const id = randomUUID();
  let actions = 0;
  let observations = 0;
  const bridge = new Bridge(target, { timeout: 1500, spawnLauncher: (ignored, argv) => {
    if (path.basename(argv[1]) === 'command.groovy') actions++;
    else {
      observations++;
      atomicJSON(path.join(target.root, 'requests', id, 'result.json'), { requestId: id, outcome: 'ok', saved: true }).catch(() => {});
    }
    return {};
  } });
  assert.equal((await bridge.send('config.update', {}, { id })).saved, true);
  assert.equal(actions, 1);
  assert.ok(observations >= 1);
}));

test('the CLI executes through an installed skill junction or symlink', async () => fixture(async target => {
  const source = fileURLToPath(new URL('../scripts/', import.meta.url));
  const mounted = path.join(target.root, 'installed-scripts');
  await symlink(source, mounted, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const child = spawnSync(process.execPath, [path.join(mounted, 'goland-ops.mjs'), '--help'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /GoLand operations via official ideScript/);
  } finally {
    // Remove the link itself before deleting the fixture; never recurse into the source.
    await unlink(mounted);
  }
}));
