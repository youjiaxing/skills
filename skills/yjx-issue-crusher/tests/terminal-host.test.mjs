/**
 * Narrow Launcher seam: cross-platform prefer-tab terminal host launch.
 * Fake detectors only — no real WT / Terminal.app / iTerm required.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOST_IDS,
  buildDefaultHostChain,
  createTerminalHostLauncher,
  normalizeTerminalHostId,
} from '../scripts/terminal-host.mjs';
import { createRealLauncher } from '../scripts/real-launcher.mjs';
import { buildLaunchContract } from '../scripts/build-launch-contract.mjs';

function fakeHost({
  id,
  available = true,
  openTab = null,
  openCalls = null,
} = {}) {
  const calls = openCalls || [];
  return {
    id,
    isAvailable: () => available,
    openTab(command, args, options) {
      calls.push({ command, args, options });
      if (typeof openTab === 'function') {
        return openTab(command, args, options);
      }
      return { pid: 5000 + calls.length };
    },
    calls,
  };
}

test('normalizeTerminalHostId: known ids and null for junk', () => {
  assert.equal(normalizeTerminalHostId('windows-terminal'), HOST_IDS.WINDOWS_TERMINAL);
  assert.equal(normalizeTerminalHostId('macos-terminal'), HOST_IDS.MACOS_TERMINAL);
  assert.equal(normalizeTerminalHostId('iterm2'), HOST_IDS.ITERM2);
  assert.equal(normalizeTerminalHostId('fallback-window'), HOST_IDS.FALLBACK_WINDOW);
  assert.equal(normalizeTerminalHostId('Windows Terminal'), null);
  assert.equal(normalizeTerminalHostId(''), null);
  assert.equal(normalizeTerminalHostId(null), null);
});

test('buildDefaultHostChain: Windows includes windows-terminal; macOS includes iterm2 + Terminal.app', () => {
  const win = buildDefaultHostChain({ platform: 'win32' });
  assert.ok(win.some((h) => h.id === HOST_IDS.WINDOWS_TERMINAL));
  assert.equal(win.some((h) => h.id === HOST_IDS.MACOS_TERMINAL), false);

  const mac = buildDefaultHostChain({ platform: 'darwin' });
  assert.ok(mac.some((h) => h.id === HOST_IDS.ITERM2));
  assert.ok(mac.some((h) => h.id === HOST_IDS.MACOS_TERMINAL));
  assert.equal(mac.some((h) => h.id === HOST_IDS.WINDOWS_TERMINAL), false);

  const linux = buildDefaultHostChain({ platform: 'linux' });
  assert.deepEqual(linux, []);
});

test('prefer tab: first available host openTab wins over fallback window', () => {
  const fallbackCalls = [];
  const hosts = [
    fakeHost({ id: 'a', available: false }),
    fakeHost({ id: 'b', available: true }),
  ];
  const launcher = createTerminalHostLauncher({
    hosts,
    openFallbackWindow(command, args, options) {
      fallbackCalls.push({ command, args, options });
      return { pid: 1 };
    },
  });

  const result = launcher.open('grok', ['--cwd', 'D:/proj'], { cwd: 'D:/proj' });
  assert.equal(result.mode, 'tab');
  assert.equal(result.hostId, 'b');
  assert.equal(result.pid, 5001);
  assert.equal(fallbackCalls.length, 0);
  assert.equal(hosts[1].calls.length, 1);
  assert.equal(hosts[1].calls[0].command, 'grok');
});

test('fallback window when no host is available', () => {
  const launcher = createTerminalHostLauncher({
    hosts: [fakeHost({ id: 'gone', available: false })],
    openFallbackWindow() {
      return { pid: 42 };
    },
  });
  const result = launcher.open('claude', ['-n', 'x'], { cwd: '/tmp' });
  assert.equal(result.mode, 'window');
  assert.equal(result.hostId, HOST_IDS.FALLBACK_WINDOW);
  assert.equal(result.pid, 42);
});

test('fallback window when openTab throws (launch must not hard-fail)', () => {
  const launcher = createTerminalHostLauncher({
    hosts: [
      fakeHost({
        id: 'broken',
        available: true,
        openTab() {
          throw new Error('wt missing profile');
        },
      }),
    ],
    openFallbackWindow() {
      return { pid: 99 };
    },
  });
  const result = launcher.open('grok', [], { cwd: 'D:/p' });
  assert.equal(result.mode, 'window');
  assert.equal(result.hostId, HOST_IDS.FALLBACK_WINDOW);
  assert.equal(result.pid, 99);
});

test('explicit preferredHost overrides detection order', () => {
  const hosts = [
    fakeHost({ id: HOST_IDS.WINDOWS_TERMINAL, available: true }),
    fakeHost({ id: 'other-host', available: true }),
  ];
  const launcher = createTerminalHostLauncher({
    preferredHost: 'other-host',
    hosts,
    openFallbackWindow() {
      return { pid: 1 };
    },
  });
  const result = launcher.open('grok', [], {});
  assert.equal(result.hostId, 'other-host');
  assert.equal(result.mode, 'tab');
  assert.equal(hosts[0].calls.length, 0);
  assert.equal(hosts[1].calls.length, 1);
});

test('explicit preferredHost=fallback-window skips tab hosts', () => {
  const hosts = [fakeHost({ id: HOST_IDS.WINDOWS_TERMINAL, available: true })];
  const launcher = createTerminalHostLauncher({
    preferredHost: HOST_IDS.FALLBACK_WINDOW,
    hosts,
    openFallbackWindow() {
      return { pid: 7 };
    },
  });
  const result = launcher.open('grok', [], {});
  assert.equal(result.mode, 'window');
  assert.equal(result.hostId, HOST_IDS.FALLBACK_WINDOW);
  assert.equal(hosts[0].calls.length, 0);
});

test('explicit preferred host openTab failure still falls back to window', () => {
  const launcher = createTerminalHostLauncher({
    preferredHost: 'sticky',
    hosts: [
      fakeHost({
        id: 'sticky',
        available: true,
        openTab() {
          throw new Error('broken sticky host');
        },
      }),
    ],
    openFallbackWindow() {
      return { pid: 11 };
    },
  });
  const result = launcher.open('grok', [], {});
  assert.equal(result.mode, 'window');
  assert.equal(result.pid, 11);
});

test('process memory cache: second open prefers successful host first', () => {
  let availableCalls = 0;
  const openCalls = [];
  const host = {
    id: 'cached-host',
    isAvailable() {
      availableCalls += 1;
      return true;
    },
    openTab(command, args, options) {
      openCalls.push({ command, args, options });
      return { pid: 6000 + openCalls.length };
    },
  };
  const launcher = createTerminalHostLauncher({
    hosts: [host],
    openFallbackWindow() {
      return { pid: 1 };
    },
  });

  const first = launcher.open('grok', ['a'], {});
  const second = launcher.open('grok', ['b'], {});
  assert.equal(first.hostId, 'cached-host');
  assert.equal(second.hostId, 'cached-host');
  // Availability is re-checked each open; success id is process-local only.
  assert.ok(availableCalls >= 2);
  assert.equal(openCalls.length, 2);
  assert.equal(launcher.getCachedHostId(), 'cached-host');
});

test('cache can be disabled so successful host id is not sticky', () => {
  const order = [];
  const hosts = [
    {
      id: 'first',
      isAvailable: () => true,
      openTab() {
        order.push('first');
        return { pid: 1 };
      },
    },
    {
      id: 'second',
      isAvailable: () => true,
      openTab() {
        order.push('second');
        return { pid: 2 };
      },
    },
  ];
  const launcher = createTerminalHostLauncher({
    hosts,
    cache: false,
    openFallbackWindow() {
      return { pid: 9 };
    },
  });
  launcher.open('grok', [], {});
  launcher.open('grok', [], {});
  assert.deepEqual(order, ['first', 'first']);
  assert.equal(launcher.getCachedHostId(), null);
});

test('failed openTab tries next host before independent window', () => {
  const opens = [];
  const launcher = createTerminalHostLauncher({
    hosts: [
      fakeHost({
        id: 'broken',
        available: true,
        openTab() {
          opens.push('broken');
          throw new Error('tab boom');
        },
      }),
      fakeHost({
        id: 'good',
        available: true,
        openTab() {
          opens.push('good');
          return { pid: 55 };
        },
      }),
    ],
    openFallbackWindow() {
      opens.push('window');
      return { pid: 1 };
    },
  });
  const result = launcher.open('grok', [], {});
  assert.equal(result.hostId, 'good');
  assert.equal(result.mode, 'tab');
  assert.deepEqual(opens, ['broken', 'good']);
});

test('open success is process-local only (no write API on launcher)', () => {
  const launcher = createTerminalHostLauncher({
    hosts: [fakeHost({ id: 'ephemeral', available: true })],
    openFallbackWindow() {
      return { pid: 1 };
    },
  });
  launcher.open('grok', [], {});
  assert.equal(launcher.getCachedHostId(), 'ephemeral');
  // Launcher has no persist/writeDetectedHost port — config writes are out of band.
  assert.equal(typeof launcher.persistDetectedHost, 'undefined');
  assert.equal(typeof launcher.writeDetectedHost, 'undefined');
});

test('createRealLauncher interactive path uses terminal-host prefer-tab when spawnWorker not injected', async () => {
  const tabOpens = [];
  const windowOpens = [];
  const hosts = [
    {
      id: 'test-wt',
      isAvailable: () => true,
      openTab(command, args, options) {
        tabOpens.push({ command, args, options });
        return { pid: 3210 };
      },
    },
  ];
  const terminalHost = createTerminalHostLauncher({
    hosts,
    openFallbackWindow(command, args, options) {
      windowOpens.push({ command, args, options });
      return { pid: 1 };
    },
  });
  const launcher = createRealLauncher({
    generateSessionId: () => '11111111-1111-4111-8111-111111111111',
    terminalHostLauncher: terminalHost,
    applyGrokTitle: false,
  });

  const contract = buildLaunchContract({
    runtime: 'grok',
    feature: 'demo',
    cwd: 'D:/proj',
    issue: { id: '04.md', path: '.scratch/demo/issues/04.md', number: '04' },
    mode: 'review',
  });
  const result = await launcher.launch(contract);
  assert.equal(result.pid, 3210);
  assert.equal(result.morph, 'interactive');
  assert.equal(tabOpens.length, 1);
  assert.equal(tabOpens[0].command, 'grok');
  assert.equal(windowOpens.length, 0);
});

test('createRealLauncher falls back to window when terminal-host tab fails', async () => {
  const terminalHost = createTerminalHostLauncher({
    hosts: [
      {
        id: 'fail-tab',
        isAvailable: () => true,
        openTab() {
          throw new Error('no tab');
        },
      },
    ],
    openFallbackWindow() {
      return { pid: 777 };
    },
  });
  const launcher = createRealLauncher({
    generateSessionId: () => '11111111-1111-4111-8111-111111111111',
    terminalHostLauncher: terminalHost,
    applyGrokTitle: false,
  });
  const result = await launcher.launch(
    buildLaunchContract({
      runtime: 'claude',
      feature: 'demo',
      cwd: 'D:/proj',
      issue: { id: '04.md', path: '.scratch/demo/issues/04.md', number: '04' },
    }),
  );
  assert.equal(result.pid, 777);
});
