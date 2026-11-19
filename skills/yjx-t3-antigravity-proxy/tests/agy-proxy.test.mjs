import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  renderPosixLauncher,
  renderWindowsLauncher,
  runRestore,
  runSetup,
  runStatus,
} from '../scripts/agy-proxy.mjs';
import { createAcpProxySession, createLineParser } from '../scripts/lib/acp-proxy.mjs';
import {
  DEFAULT_CONFIG,
  hashKey,
  publishVariantAlias,
  readModelWindow,
  readSessionSelection,
  writeFileAtomic,
  writeModelWindow,
} from '../scripts/lib/store.mjs';

const execFileAsync = promisify(execFile);
const tempDirs = [];

async function makeTempDir(prefix = 'agy-proxy-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function createConversationDb(geminiHome, sessionId, stepTypes) {
  const convDir = path.join(geminiHome, 'antigravity-acp', 'conversations');
  await mkdir(convDir, { recursive: true });
  const dbPath = path.join(convDir, `${sessionId}.db`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL)');
    const insert = db.prepare('INSERT INTO steps (idx, step_type) VALUES (?, ?)');
    stepTypes.forEach((stepType, idx) => {
      insert.run(idx, stepType);
    });
  } finally {
    db.close();
  }
  return dbPath;
}

function appendStepsToDb(dbPath, stepTypes) {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps').get();
    let nextIdx = (row?.maxIdx ?? -1) + 1;
    const insert = db.prepare('INSERT INTO steps (idx, step_type) VALUES (?, ?)');
    for (const stepType of stepTypes) {
      insert.run(nextIdx, stepType);
      nextIdx += 1;
    }
  } finally {
    db.close();
  }
}

function spawnLauncher(launcherPath, args, options = {}) {
  if (process.platform !== 'win32') return spawn(launcherPath, args, options);
  const quoteWindowsArg = (value) => {
    const text = String(value);
    if (!/[\s"&()<>^|]/u.test(text)) return text;
    return `"${text.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
  };
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [quoteWindowsArg(launcherPath), ...args.map(quoteWindowsArg)].join(' ')], options);
}

function createHarness(options = {}) {
  const clientMessages = [];
  const upstreamMessages = [];
  const retiredReasons = [];
  let proxy;

  function makeResponder(fn) {
    return (msg) => {
      upstreamMessages.push(msg);
      if (fn) fn(msg, proxy);
    };
  }

  proxy = createAcpProxySession({
    installDir: options.installDir,
    config: options.config || structuredClone(DEFAULT_CONFIG),
    geminiHome: options.geminiHome || null,
    compactCancelTimeoutMs: options.compactCancelTimeoutMs ?? 5000,
    sendToClient: (msg) => {
      clientMessages.push(typeof msg === 'string' ? JSON.parse(msg) : msg);
    },
    sendToUpstream: makeResponder(options.onUpstreamMessage),
    logError: () => {},
    onRetireUpstream: async (reason) => {
      retiredReasons.push(reason);
    },
  });

  async function sendFromClient(msg) {
    await proxy.handleClientMessage(JSON.stringify(msg));
  }

  async function sendFromUpstream(msg) {
    await proxy.handleUpstreamMessage(JSON.stringify(msg));
  }

  async function waitForClientMessage(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = clientMessages.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for client message. Seen: ${JSON.stringify(clientMessages)}`);
  }

  return {
    proxy,
    clientMessages,
    upstreamMessages,
    retiredReasons,
    sendFromClient,
    sendFromUpstream,
    waitForClientMessage,
  };
}

describe('acp-proxy protocol gating and variant management', () => {
  it('enters passthrough when protocolVersion !== 1 and still translates historical synthetic IDs', async () => {
    const installDir = await makeTempDir();
    await publishVariantAlias(installDir, {
      variantId: 'gemini-4-hydrogen-256k',
      baseId: 'gemini-4-hydrogen',
      capTokens: 256000,
      isNativeMax: false,
    });

    const h = createHarness({
      installDir,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: 2 },
          }));
        } else if (msg.method === 'session/new') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 's-v2',
              configOptions: [{
                id: 'model',
                type: 'select',
                currentValue: 'gemini-4-hydrogen',
                options: [{ value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }],
              }],
            },
          }));
        }
      },
    });

    await h.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 2 } });
    const initResp = await h.waitForClientMessage((m) => m.id === 1);
    assert.equal(initResp.result.protocolVersion, 2);
    assert.equal(h.proxy.getState().protocolState, 'passthrough');

    await h.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    const newResp = await h.waitForClientMessage((m) => m.id === 2);
    assert.equal(newResp.result.configOptions[0].options.length, 1);

    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_model',
      params: { sessionId: 's-v2', modelId: 'gemini-4-hydrogen-256k' },
    });
    const setModelMsg = h.upstreamMessages.find((m) => m.id === 3);
    assert.equal(setModelMsg.params.modelId, 'gemini-4-hydrogen');
  });

  it('dynamically expands all models, avoids reserved upstream collisions, and hides >native tiers once observed', async () => {
    const installDir = await makeTempDir();
    const h = createHarness({
      installDir,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/new') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: `s-${msg.id}`,
              configOptions: [{
                id: 'model',
                type: 'select',
                currentValue: 'alpha',
                options: [
                  { value: 'alpha', name: 'Alpha' },
                  { value: 'alpha-full', name: 'Alpha Native Full' },
                  { value: 'claude-sonnet', name: 'Claude Sonnet' },
                ],
              }],
            },
          }));
        } else if (msg.method === 'session/set_model') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        } else if (msg.method === 'session/prompt') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: msg.params.sessionId,
              update: { sessionUpdate: 'usage_update', used: 50000, size: 1000000 },
            },
          }));
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn' },
          }));
        }
      },
    });

    await h.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await h.waitForClientMessage((m) => m.id === 1);

    await h.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    const firstNew = await h.waitForClientMessage((m) => m.id === 2);
    const firstValues = firstNew.result.configOptions[0].options.map((o) => o.value);
    assert.deepEqual(firstValues, ['alpha', 'alpha-full', 'claude-sonnet']);
    const firstClaude = firstNew.result.configOptions[0].options.find((o) => o.value === 'claude-sonnet');
    assert.equal(firstClaude.name, 'Claude Sonnet', 'must not label unobserved model with (500k)');

    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_model',
      params: { sessionId: 's-2', modelId: 'claude-sonnet' },
    });
    await h.waitForClientMessage((m) => m.id === 3);

    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId: 's-2', prompt: [{ type: 'text', text: 'hello' }] },
    });
    await h.waitForClientMessage((m) => m.id === 4);
    assert.equal(await readModelWindow(installDir, 'claude-sonnet'), 1000000);

    await h.sendFromClient({ jsonrpc: '2.0', id: 5, method: 'session/new', params: {} });
    const secondNew = await h.waitForClientMessage((m) => m.id === 5);
    const claudeOpts = secondNew.result.configOptions[0].options.filter((o) => o.value.startsWith('claude-sonnet'));
    assert.deepEqual(claudeOpts.map((o) => o.value), [
      'claude-sonnet',
      'claude-sonnet-256k',
      'claude-sonnet-full',
    ]);
    assert.equal(claudeOpts[0].name, 'Claude Sonnet (500k)');
  });

  it('refuses overwriting existing variant records in publishVariantAlias', async () => {
    const installDir = await makeTempDir();
    const first = await publishVariantAlias(installDir, {
      variantId: 'm1-256k',
      baseId: 'm1',
      capTokens: 256000,
      isNativeMax: false,
    });
    assert.equal(first.status, 'ok');

    const conflict = await publishVariantAlias(installDir, {
      variantId: 'm1-256k',
      baseId: 'm2',
      capTokens: 256000,
      isNativeMax: false,
    });
    assert.equal(conflict.status, 'collision');

    const corruptPath = path.join(installDir, 'cache', 'variants', `${hashKey('corrupt-256k')}.json`);
    await writeFileAtomic(corruptPath, '{bad json', 0o644);
    const corruptCollision = await publishVariantAlias(installDir, {
      variantId: 'corrupt-256k',
      baseId: 'corrupt',
      capTokens: 256000,
      isNativeMax: false,
    });
    assert.equal(corruptCollision.status, 'collision');
  });

  it('restores persisted session variant on resume and rejects with -32000 if upstream later claims that ID', async () => {
    const installDir = await makeTempDir();
    await publishVariantAlias(installDir, {
      variantId: 'gemini-4-hydrogen-256k',
      baseId: 'gemini-4-hydrogen',
      capTokens: 256000,
      isNativeMax: false,
    });
    const h1 = createHarness({
      installDir,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/new') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 'sess-resume',
              configOptions: [{
                id: 'model',
                type: 'select',
                currentValue: 'gemini-4-hydrogen',
                options: [{ value: 'gemini-4-hydrogen', name: 'Gemini 4' }],
              }],
            },
          }));
        } else if (msg.method === 'session/set_model') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        }
      },
    });

    await h1.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await h1.waitForClientMessage((m) => m.id === 1);
    await h1.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    await h1.waitForClientMessage((m) => m.id === 2);
    await h1.sendFromClient({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_model',
      params: { sessionId: 'sess-resume', modelId: 'gemini-4-hydrogen-256k' },
    });
    await h1.waitForClientMessage((m) => m.id === 3);

    const saved = await readSessionSelection(installDir, 'sess-resume');
    assert.equal(saved.variantId, 'gemini-4-hydrogen-256k');
    assert.equal(saved.capTokens, 256000);

    // Restart proxy: session/resume restores persisted variantId
    const h2 = createHarness({
      installDir,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/resume') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              configOptions: [{
                id: 'model',
                type: 'select',
                currentValue: 'gemini-4-hydrogen',
                options: [{ value: 'gemini-4-hydrogen', name: 'Gemini 4' }],
              }],
            },
          }));
        }
      },
    });
    await h2.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await h2.waitForClientMessage((m) => m.id === 1);
    await h2.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'sess-resume' } });
    const resumeResp = await h2.waitForClientMessage((m) => m.id === 2);
    assert.equal(resumeResp.result.configOptions[0].currentValue, 'gemini-4-hydrogen-256k');

    // Restart proxy where upstream now natively has 'gemini-4-hydrogen-256k' -> conflict -32000
    const h3 = createHarness({
      installDir,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/resume') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              configOptions: [{
                id: 'model',
                type: 'select',
                currentValue: 'gemini-4-hydrogen',
                options: [
                  { value: 'gemini-4-hydrogen', name: 'Gemini 4' },
                  { value: 'gemini-4-hydrogen-256k', name: 'Upstream 256k' },
                ],
              }],
            },
          }));
        }
      },
    });
    await h3.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await h3.waitForClientMessage((m) => m.id === 1);
    await h3.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/resume', params: { sessionId: 'sess-resume' } });
    const conflictResp = await h3.waitForClientMessage((m) => m.id === 2);
    assert.equal(conflictResp.error.code, -32000);
  });
});

describe('acp-proxy replay isolation, native-max bypass, pre-turn /compact, and cancel', () => {
  it('ignores replay and post-switch stale usage_update and never compacts on -full', async () => {
    const installDir = await makeTempDir();
    const geminiHome = await makeTempDir();
    await createConversationDb(geminiHome, 's-iso', [1, 2]);
    await writeModelWindow(installDir, 'g4', 1000000);
    await writeModelWindow(installDir, 'other', 1000000);

    const h = createHarness({
      installDir,
      geminiHome,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/load') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's-iso',
              update: { sessionUpdate: 'usage_update', used: 999999, size: 1000000 },
            },
          }));
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              configOptions: [{
                id: 'model',
                type: 'select',
                currentValue: 'g4',
                options: [
                  { value: 'g4', name: 'G4' },
                  { value: 'other', name: 'Other' },
                ],
              }],
            },
          }));
        } else if (msg.method === 'session/set_model') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        } else if (msg.method === 'session/prompt') {
          // Stale replay notification during live turn
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's-iso',
              _meta: { isReplay: true },
              update: { sessionUpdate: 'usage_update', used: 999999, size: 1000000 },
            },
          }));
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn' },
          }));
        }
      },
    });

    await h.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await h.waitForClientMessage((m) => m.id === 1);
    await h.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's-iso' } });
    await h.waitForClientMessage((m) => m.id === 2);

    const session = h.proxy.getState().sessions.get('s-iso');
    assert.equal(session.lastUsedTokens, null);
    assert.equal(session.pendingCompact, false);

    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 's-iso', prompt: [{ type: 'text', text: 'turn 1' }] },
    });
    await h.waitForClientMessage((m) => m.id === 3);
    assert.equal(session.lastUsedTokens, null);
    assert.equal(session.pendingCompact, false);

    // Switch to -full and emit high usage -> never sets pendingCompact
    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/set_model',
      params: { sessionId: 's-iso', modelId: 'g4-full' },
    });
    await h.waitForClientMessage((m) => m.id === 4);
    assert.equal(session.isNativeMax, true);
    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: 's-iso', prompt: [{ type: 'text', text: 'turn 2' }] },
    });
    await h.waitForClientMessage((m) => m.id === 5);
    assert.equal(session.pendingCompact, false);

    // Cross-model switch clears state and marks awaitingPromptForModel
    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 6,
      method: 'session/set_model',
      params: { sessionId: 's-iso', modelId: 'other-256k' },
    });
    await h.waitForClientMessage((m) => m.id === 6);
    assert.equal(session.awaitingPromptForModel, true);
    assert.equal(session.pendingCompact, false);
  });

  it('executes Pre-Next-Turn pure /compact, verifies SQLite steps, and forwards Turn N+1 only on success', async () => {
    const installDir = await makeTempDir();
    const geminiHome = await makeTempDir();
    const dbPath = await createConversationDb(geminiHome, 's-cmp', [1, 2]);
    await writeModelWindow(installDir, 'g4', 1000000);
    let promptCount = 0;

    const h = createHarness({
      installDir,
      geminiHome,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/new') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 's-cmp',
              configOptions: [{
                id: 'model',
                type: 'select',
                currentValue: 'g4',
                options: [{ value: 'g4', name: 'G4' }],
              }],
            },
          }));
        } else if (msg.method === 'session/set_model') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        } else if (msg.method === 'session/prompt') {
          promptCount += 1;
          const text = msg.params.prompt[0].text;
          if (text === '/compact') {
            // Emit internal compact text that MUST be suppressed from client
            proxy.handleUpstreamMessage(JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 's-cmp',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'internal compact summary' } },
              },
            }));
            appendStepsToDb(dbPath, [5]);
            proxy.handleUpstreamMessage(JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 's-cmp',
                update: { sessionUpdate: 'usage_update', used: 40000, size: 1000000 },
              },
            }));
            proxy.handleUpstreamMessage(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn' },
            }));
            return;
          }
          // Turn 1 hits 235000 >= 0.9 * 256000 (230400)
          const used = promptCount === 1 ? 235000 : 45000;
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's-cmp',
              update: { sessionUpdate: 'usage_update', used, size: 1000000 },
            },
          }));
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { stopReason: 'end_turn' },
          }));
        }
      },
    });

    await h.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await h.waitForClientMessage((m) => m.id === 1);
    await h.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    await h.waitForClientMessage((m) => m.id === 2);
    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/set_model',
      params: { sessionId: 's-cmp', modelId: 'g4-256k' },
    });
    await h.waitForClientMessage((m) => m.id === 3);

    // Turn 1
    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId: 's-cmp', prompt: [{ type: 'text', text: 'turn 1' }] },
    });
    const turn1Resp = await h.waitForClientMessage((m) => m.id === 4);
    assert.equal(turn1Resp.result.stopReason, 'end_turn');
    assert.equal(h.proxy.getState().sessions.get('s-cmp').pendingCompact, true);

    const clampedUsage = h.clientMessages.find((m) => m.params?.update?.sessionUpdate === 'usage_update');
    assert.equal(clampedUsage.params.update.size, 256000);

    // Turn 2 -> must trigger pure "/compact" first, then turn 2
    await h.sendFromClient({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/prompt',
      params: { sessionId: 's-cmp', prompt: [{ type: 'text', text: 'turn 2' }] },
    });
    const turn2Resp = await h.waitForClientMessage((m) => m.id === 5);
    assert.equal(turn2Resp.result.stopReason, 'end_turn');

    const sentPrompts = h.upstreamMessages
      .filter((m) => m.method === 'session/prompt')
      .map((m) => m.params.prompt[0].text);
    assert.deepEqual(sentPrompts, ['turn 1', '/compact', 'turn 2']);

    const chunks = h.clientMessages
      .filter((m) => m.params?.update?.sessionUpdate === 'agent_message_chunk')
      .map((m) => m.params.update.content.text);
    assert.ok(!chunks.includes('internal compact summary'));
    assert.ok(chunks.some((t) => t.includes('自动压缩')));
  });

  it('aborts Turn N+1 with -32000 when SQLite verification detects ERROR_STEP_TYPE 17 or missing/symlink DB', async () => {
    // Subcase A: step_type === 17
    const installA = await makeTempDir();
    const geminiA = await makeTempDir();
    const dbPathA = await createConversationDb(geminiA, 's-fail', [1]);

    const hA = createHarness({
      installDir: installA,
      geminiHome: geminiA,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/new') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 's-fail',
              configOptions: [{ id: 'model', type: 'select', currentValue: 'g4', options: [{ value: 'g4', name: 'G4' }] }],
            },
          }));
        } else if (msg.method === 'session/prompt') {
          if (msg.params.prompt[0].text === '/compact') {
            appendStepsToDb(dbPathA, [17]);
            proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
            return;
          }
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 's-fail', update: { sessionUpdate: 'usage_update', used: 490000, size: 1000000 } },
          }));
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
        }
      },
    });
    await hA.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await hA.waitForClientMessage((m) => m.id === 1);
    await hA.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    await hA.waitForClientMessage((m) => m.id === 2);
    await hA.sendFromClient({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's-fail', prompt: [{ type: 'text', text: 't1' }] } });
    await hA.waitForClientMessage((m) => m.id === 3);

    await hA.sendFromClient({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 's-fail', prompt: [{ type: 'text', text: 't2-should-not-run' }] } });
    const failResp = await hA.waitForClientMessage((m) => m.id === 4);
    assert.equal(failResp.error.code, -32000);
    assert.ok(!hA.upstreamMessages.some((m) => m.method === 'session/prompt' && m.params.prompt[0].text === 't2-should-not-run'));

    // Subcase B: symlink DB -> status unknown -> aborts without even sending /compact
    const installB = await makeTempDir();
    const geminiB = await makeTempDir();
    const realTarget = await createConversationDb(geminiB, 'real-target', [1]);
    const convDirB = path.join(geminiB, 'antigravity-acp', 'conversations');
    await symlink(realTarget, path.join(convDirB, 's-sym.db'));

    const hB = createHarness({
      installDir: installB,
      geminiHome: geminiB,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/new') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 's-sym',
              configOptions: [{ id: 'model', type: 'select', currentValue: 'g4', options: [{ value: 'g4', name: 'G4' }] }],
            },
          }));
        } else if (msg.method === 'session/prompt') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 's-sym', update: { sessionUpdate: 'usage_update', used: 490000, size: 1000000 } },
          }));
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
        }
      },
    });
    await hB.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await hB.waitForClientMessage((m) => m.id === 1);
    await hB.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    await hB.waitForClientMessage((m) => m.id === 2);
    await hB.sendFromClient({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's-sym', prompt: [{ type: 'text', text: 't1' }] } });
    await hB.waitForClientMessage((m) => m.id === 3);

    await hB.sendFromClient({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 's-sym', prompt: [{ type: 'text', text: 't2' }] } });
    const symResp = await hB.waitForClientMessage((m) => m.id === 4);
    assert.equal(symResp.error.code, -32000);
    assert.ok(!hB.upstreamMessages.some((m) => m.method === 'session/prompt' && m.params.prompt[0].text === '/compact'));
  });

  it('handles session/cancel during /compact cleanly and retires upstream on timeout', async () => {
    // Subcase 1: prompt cancel settles cleanly before timeout
    const install1 = await makeTempDir();
    const gemini1 = await makeTempDir();
    await createConversationDb(gemini1, 's-c1', [1]);
    let compactId1 = null;
    const h1 = createHarness({
      installDir: install1,
      geminiHome: gemini1,
      compactCancelTimeoutMs: 200,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/new') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 's-c1',
              configOptions: [{ id: 'model', type: 'select', currentValue: 'g4', options: [{ value: 'g4', name: 'G4' }] }],
            },
          }));
        } else if (msg.method === 'session/prompt') {
          if (msg.params.prompt[0].text === '/compact') {
            compactId1 = msg.id;
            return;
          }
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 's-c1', update: { sessionUpdate: 'usage_update', used: 490000, size: 1000000 } },
          }));
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
        } else if (msg.method === 'session/cancel' && compactId1) {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: compactId1, result: { stopReason: 'cancelled' } }));
        }
      },
    });
    await h1.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await h1.waitForClientMessage((m) => m.id === 1);
    await h1.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    await h1.waitForClientMessage((m) => m.id === 2);
    await h1.sendFromClient({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's-c1', prompt: [{ type: 'text', text: 't1' }] } });
    await h1.waitForClientMessage((m) => m.id === 3);

    const p2 = h1.sendFromClient({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 's-c1', prompt: [{ type: 'text', text: 't2' }] } });
    await new Promise((r) => setTimeout(r, 20));
    await h1.sendFromClient({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's-c1' } });
    await p2;
    const c1Resp = await h1.waitForClientMessage((m) => m.id === 4);
    assert.equal(c1Resp.result.stopReason, 'cancelled');
    assert.deepEqual(h1.retiredReasons, []);

    // Subcase 2: hung /compact triggers onRetireUpstream after compactCancelTimeoutMs
    const install2 = await makeTempDir();
    const gemini2 = await makeTempDir();
    await createConversationDb(gemini2, 's-c2', [1]);
    const h2 = createHarness({
      installDir: install2,
      geminiHome: gemini2,
      compactCancelTimeoutMs: 50,
      onUpstreamMessage: (msg, proxy) => {
        if (msg.method === 'initialize') {
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
        } else if (msg.method === 'session/new') {
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 's-c2',
              configOptions: [{ id: 'model', type: 'select', currentValue: 'g4', options: [{ value: 'g4', name: 'G4' }] }],
            },
          }));
        } else if (msg.method === 'session/prompt') {
          if (msg.params.prompt[0].text === '/compact') {
            return; // hang intentionally
          }
          proxy.handleUpstreamMessage(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 's-c2', update: { sessionUpdate: 'usage_update', used: 490000, size: 1000000 } },
          }));
          proxy.handleUpstreamMessage(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
        }
      },
    });
    await h2.sendFromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await h2.waitForClientMessage((m) => m.id === 1);
    await h2.sendFromClient({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    await h2.waitForClientMessage((m) => m.id === 2);
    await h2.sendFromClient({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's-c2', prompt: [{ type: 'text', text: 't1' }] } });
    await h2.waitForClientMessage((m) => m.id === 3);

    const p2Hang = h2.sendFromClient({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 's-c2', prompt: [{ type: 'text', text: 't2' }] } });
    await new Promise((r) => setTimeout(r, 20));
    await h2.sendFromClient({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's-c2' } });
    await p2Hang;
    const c2Resp = await h2.waitForClientMessage((m) => m.id === 4);
    assert.equal(c2Resp.result.stopReason, 'cancelled');
    await new Promise((r) => setTimeout(r, 70));
    assert.deepEqual(h2.retiredReasons, ['compact_cancel_timeout']);
  });
});

describe('CLI --setup, --status, --restore, launcher generation, and stdio end-to-end', () => {
  it('renders POSIX and Windows launchers with explicit install-dir and node fallback', () => {
    const posix = renderPosixLauncher({
      nodePath: "/usr/local/bin/node's",
      runtimeEntry: '/tmp/t3/tools/antigravity-proxy/runtime/agy-proxy.mjs',
      installDir: '/tmp/t3/tools/antigravity-proxy',
    });
    assert.match(posix, /--install-dir '\/tmp\/t3\/tools\/antigravity-proxy'/);
    assert.match(posix, /command -v node/);

    const win = renderWindowsLauncher({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      runtimeEntry: 'C:\\Users\\test\\.t3\\tools\\antigravity-proxy\\runtime\\agy-proxy.mjs',
      installDir: 'C:\\Users\\test\\.t3\\tools\\antigravity-proxy',
    });
    assert.match(win, /set "NODE_BIN=C:\\Program Files\\nodejs\\node\.exe"/);
    assert.match(win, /where node/);
    assert.match(win, /--install-dir "C:\\Users\\test\\\.t3\\tools\\antigravity-proxy" %\*/);
  });

  it('installs to isolated t3Home, preserves idempotent backup, runs stdio ACP + passthrough, and restores cleanly', async () => {
    const t3Home = await makeTempDir('t3-home-');
    const geminiHome = await makeTempDir('gemini-home-');
    const releaseId = 'test-release-1.0';
    const upstreamDir = path.join(t3Home, 'tools', 'antigravity-acp', `${process.platform}-${process.arch}`);
    const versionDir = path.join(upstreamDir, 'versions', releaseId);
    await mkdir(versionDir, { recursive: true });
    await writeFileAtomic(path.join(upstreamDir, 'active.json'), JSON.stringify({ releaseId }), 0o644);

    const fakeUpstreamPath = path.join(versionDir, process.platform === 'win32' ? 'agy.cmd' : 'antigravity');
    const fakeUpstreamScriptPath = path.join(versionDir, 'fake-upstream.mjs');
    const fakeUpstreamScript = `#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args[0] !== 'acp') {
  console.log('FAKE_UPSTREAM_CLI:' + args.join(' '));
  process.exit(args.includes('--exit-7') ? 7 : 0);
}

const gIdx = args.indexOf('--gemini-dir');
const geminiDir = gIdx >= 0 ? args[gIdx + 1] : process.env.GEMINI_HOME;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }));
  } else if (msg.method === 'session/new') {
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'e2e-sess',
        configOptions: [{
          id: 'model',
          type: 'select',
          currentValue: 'gemini-4-hydrogen',
          options: [{ value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' }],
        }],
      },
    }));
  } else if (msg.method === 'session/set_model') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
  } else if (msg.method === 'session/prompt') {
    const txt = msg.params.prompt[0].text;
    const dbPath = path.join(geminiDir, 'antigravity-acp', 'conversations', 'e2e-sess.db');
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps').get();
    db.prepare('INSERT INTO steps (idx, step_type) VALUES (?, ?)').run(row.maxIdx + 1, 5);
    db.close();
    if (txt === '/compact') {
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'e2e-sess', update: { sessionUpdate: 'usage_update', used: 30000, size: 1000000 } },
      }));
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
      return;
    }
    const used = txt === 'turn-1' ? 240000 : 35000;
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'e2e-sess', update: { sessionUpdate: 'usage_update', used, size: 1000000 } },
    }));
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }));
  }
});
`;
    if (process.platform === 'win32') {
      await writeFile(fakeUpstreamScriptPath, fakeUpstreamScript, 'utf8');
      await writeFile(
        fakeUpstreamPath,
        `@echo off\r\n"${process.execPath}" "%~dp0fake-upstream.mjs" %*\r\nexit /b %errorlevel%\r\n`,
        'utf8',
      );
    } else {
      await writeFile(fakeUpstreamPath, fakeUpstreamScript, 'utf8');
      await chmod(fakeUpstreamPath, 0o755);
    }
    const testEnv = { ...process.env, AGY_PROXY_UPSTREAM_BIN: fakeUpstreamPath };

    const settingsPath = path.join(t3Home, 'userdata', 'settings.json');
    await writeFileAtomic(settingsPath, JSON.stringify({
      theme: 'dark',
      providerInstances: {
        antigravity: {
          driver: 'antigravity',
          enabled: true,
          config: { existingSetting: 'preserve-me' },
        },
      },
    }, null, 2), 0o644);

    await createConversationDb(geminiHome, 'e2e-sess', [1]);

    const setupRes = await runSetup({ explicitT3Home: t3Home, env: testEnv });
    assert.equal(setupRes.ok, true);
    await writeModelWindow(setupRes.installDir, 'gemini-4-hydrogen', 1000000);
    assert.equal(setupRes.settings.changed, true);

    // Second setup is idempotent and does not overwrite original backup metadata
    const setupRes2 = await runSetup({ explicitT3Home: t3Home, env: testEnv });
    assert.equal(setupRes2.settings.changed, false);

    const statusRes = await runStatus({ explicitT3Home: t3Home, env: testEnv });
    assert.equal(statusRes.installed, true);
    assert.equal(statusRes.settingsPointingToProxy, true);
    assert.equal(statusRes.nodeCheck.ok, true);

    // Non-ACP passthrough preserves stdout and exit code
    const passthroughRun = await new Promise((resolve) => {
      const child = spawnLauncher(setupRes.launcherPath, ['--version', '--exit-7'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: testEnv,
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c.toString(); });
      child.on('exit', (code) => resolve({ code, out }));
    });
    assert.equal(passthroughRun.code, 7);
    assert.match(passthroughRun.out, /FAKE_UPSTREAM_CLI:--version --exit-7/);

    // End-to-end stdio ACP session via installed launcher
    const acpChild = spawnLauncher(setupRes.launcherPath, ['acp', '--gemini-dir', geminiHome], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: testEnv,
    });
    const received = [];
    const parser = createLineParser((line) => received.push(JSON.parse(line)));
    acpChild.stdout.on('data', (chunk) => parser.push(chunk));

    async function waitMsg(pred) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const hit = received.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Timed out waiting for stdio ACP message: ${JSON.stringify(received)}`);
    }

    const sendRpc = (obj) => acpChild.stdin.write(`${JSON.stringify(obj)}\n`);
    sendRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await waitMsg((m) => m.id === 1);

    sendRpc({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} });
    const sNew = await waitMsg((m) => m.id === 2);
    assert.ok(sNew.result.configOptions[0].options.some((o) => o.value === 'gemini-4-hydrogen-256k'));

    sendRpc({ jsonrpc: '2.0', id: 3, method: 'session/set_model', params: { sessionId: 'e2e-sess', modelId: 'gemini-4-hydrogen-256k' } });
    await waitMsg((m) => m.id === 3);

    sendRpc({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'e2e-sess', prompt: [{ type: 'text', text: 'turn-1' }] } });
    await waitMsg((m) => m.id === 4);

    sendRpc({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: 'e2e-sess', prompt: [{ type: 'text', text: 'turn-2' }] } });
    await waitMsg((m) => m.id === 5);

    assert.ok(received.some((m) => m.params?.update?.sessionUpdate === 'agent_message_chunk' && m.params.update.content.text.includes('自动压缩')));
    assert.ok(received.some((m) => m.params?.update?.sessionUpdate === 'usage_update' && m.params.update.size === 256000));

    acpChild.stdin.end();
    await new Promise((resolve) => acpChild.on('close', resolve));

    const restoreRes = await runRestore({ explicitT3Home: t3Home, env: testEnv });
    assert.equal(restoreRes.changed, true);
    assert.equal(restoreRes.restoredTo, null);
    const restoredSettings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(restoredSettings.providerInstances.antigravity.config, { existingSetting: 'preserve-me' });
    assert.equal(restoredSettings.theme, 'dark');
  });
});
