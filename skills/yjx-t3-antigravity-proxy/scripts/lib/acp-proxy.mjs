import { execFile as cpExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loadAllVariantAliases,
  publishVariantAlias,
  readConversationStepStatus,
  readModelWindow,
  readSessionSelection,
  writeModelWindow,
  writeSessionSelection,
} from './store.mjs';

const execFileAsync = promisify(cpExecFile);
export const ERROR_STEP_TYPE = 17;
export const DEFAULT_COMPACT_CANCEL_TIMEOUT_MS = 5000;

export function createLineParser(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/u);
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line.length > 0) onLine(line);
      }
    },
    flush() {
      if (buffer.length > 0) {
        const tail = buffer;
        buffer = '';
        onLine(tail);
      }
    },
  };
}

export function formatTokenCountLabel(tokens) {
  if (tokens >= 1000000 && tokens % 1000000 === 0) return `${tokens / 1000000}M`;
  if (tokens % 1024 === 0) return `${tokens / 1024}k`;
  if (tokens >= 1000 && tokens % 1000 === 0) return `${tokens / 1000}k`;
  return `${tokens}`;
}

export function parseGeminiDirFromArgs(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--gemini-dir' && i + 1 < args.length) {
      return args[i + 1];
    }
    if (typeof args[i] === 'string' && args[i].startsWith('--gemini-dir=')) {
      return args[i].slice('--gemini-dir='.length);
    }
  }
  return null;
}

export function isCompactSlashCommand(promptBlocks) {
  if (!Array.isArray(promptBlocks) || promptBlocks.length === 0) return false;
  const textParts = [];
  for (const block of promptBlocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type !== 'text') {
      return false;
    }
  }
  return /^\/compact(?:\s|$)/u.test(textParts.join('').trim());
}

export async function terminateProcessTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { ok: true, alreadyExited: true };
  }
  const pid = child.pid;
  if (!pid) return { ok: false, reason: 'missing_pid' };

  if (platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
      return { ok: true, method: 'taskkill' };
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { ok: true, alreadyExited: true };
      }
      throw new Error(`taskkill failed for PID ${pid}: ${error?.message || error}`);
    }
  }

  let groupKilled = false;
  try {
    process.kill(-pid, 'SIGKILL');
    groupKilled = true;
  } catch {
    // Process might not be group leader; fall back to direct child kill.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore if already gone
  }
  return { ok: true, method: groupKilled ? 'process_group_sigkill' : 'child_sigkill' };
}

export function createAcpProxySession(opts) {
  const {
    installDir,
    config,
    geminiHome = null,
    sendToClient,
    sendToUpstream,
    logError = (msg) => process.stderr.write(`[agy-proxy] ${msg}\n`),
    onRetireUpstream = async () => {},
    compactCancelTimeoutMs = DEFAULT_COMPACT_CANCEL_TIMEOUT_MS,
  } = opts;

  let protocolState = 'uninitialized';
  let internalSeq = 0;

  const pendingClientInit = new Set();
  const pendingClientMethods = new Map();
  const pendingInternal = new Map();

  const historicalVariants = new Map();
  const reservedUpstreamIds = new Set();
  const conflictedVariantIds = new Set();
  const modelWindowCache = new Map();
  const sessions = new Map();

  let initLoadPromise = null;
  function ensureHistoricalLoaded() {
    if (!initLoadPromise) {
      initLoadPromise = loadAllVariantAliases(installDir).then((loaded) => {
        for (const [id, rec] of loaded.entries()) {
          historicalVariants.set(id, rec);
        }
      });
    }
    return initLoadPromise;
  }

  let upstreamSerialQueue = Promise.resolve();
  function enqueueUpstream(task) {
    const run = upstreamSerialQueue.then(task, task);
    upstreamSerialQueue = run.catch(() => {});
    return run;
  }
  let clientDispatchQueue = Promise.resolve();
  function enqueueClientDispatch(task) {
    const run = clientDispatchQueue.then(task, task);
    clientDispatchQueue = run.catch(() => {});
    return run;
  }

  async function getModelNativeSize(baseId) {
    if (!baseId) return null;
    if (modelWindowCache.has(baseId)) {
      return modelWindowCache.get(baseId);
    }
    const disk = await readModelWindow(installDir, baseId);
    if (disk !== null) {
      modelWindowCache.set(baseId, disk);
    }
    return disk;
  }

  async function recordModelNativeSize(baseId, nativeSize) {
    if (!baseId || !Number.isInteger(nativeSize) || nativeSize <= 0) return;
    const prev = modelWindowCache.get(baseId);
    modelWindowCache.set(baseId, nativeSize);
    if (prev !== nativeSize) {
      try {
        await writeModelWindow(installDir, baseId, nativeSize);
      } catch (err) {
        logError(`Failed saving model window for ${baseId}: ${err?.message || err}`);
      }
    }
  }

  function getOrCreateSession(sessionId) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        variantId: null,
        baseId: null,
        capTokens: config.defaultCapTokens,
        isNativeMax: false,
        conflictedVariantId: null,
        lastUsedTokens: null,
        lastNativeSize: null,
        inReplay: false,
        inModelSwitch: false,
        awaitingPromptForModel: false,
        activePromptInFlight: false,
        pendingCompact: false,
        activeCompact: null,
        activeTurnCancel: null,
        queue: Promise.resolve(),
      };
      sessions.set(sessionId, session);
    }
    return session;
  }

  function enqueueSession(session, task) {
    const run = session.queue.then(task, task);
    session.queue = run.catch((err) => {
      logError(`Session ${session.sessionId} task failed: ${err?.message || err}`);
    });
    return run;
  }

  function sendInternalRequest(method, params) {
    const id = `agy-proxy-internal:${++internalSeq}`;
    return new Promise((resolve, reject) => {
      pendingInternal.set(id, { resolve, reject });
      sendToUpstream({ jsonrpc: '2.0', id, method, params });
    });
  }

  function resolveVariantLookup(variantId, { allowConflicted = false } = {}) {
    if (!allowConflicted && conflictedVariantIds.has(variantId)) {
      return { conflict: true, record: historicalVariants.get(variantId) };
    }
    if (reservedUpstreamIds.has(variantId)) {
      return {
        conflict: false,
        record: {
          variantId,
          baseId: variantId,
          capTokens: config.defaultCapTokens,
          isNativeMax: false,
          isUpstreamBase: true,
        },
      };
    }
    const hist = historicalVariants.get(variantId);
    if (hist) {
      return { conflict: false, record: { ...hist, isUpstreamBase: false } };
    }
    return { conflict: false, record: null };
  }

  function findExistingVariant(baseId, capTokens, isNativeMax) {
    for (const rec of historicalVariants.values()) {
      if (
        rec.baseId === baseId
        && (rec.capTokens ?? null) === (capTokens ?? null)
        && Boolean(rec.isNativeMax) === Boolean(isNativeMax)
        && rec.variantId !== baseId
        && !reservedUpstreamIds.has(rec.variantId)
      ) {
        return rec;
      }
    }
    return null;
  }

  async function allocateVariant(baseId, suffix, capTokens, isNativeMax, allocatedInPass) {
    const reused = findExistingVariant(baseId, capTokens, isNativeMax);
    if (reused && !allocatedInPass.has(reused.variantId)) {
      allocatedInPass.add(reused.variantId);
      return reused;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidateId = attempt === 0
        ? `${baseId}${suffix}`
        : attempt === 1
          ? `${baseId}-proxy${suffix}`
          : `${baseId}-proxy${suffix}-${attempt}`;
      if (reservedUpstreamIds.has(candidateId) || allocatedInPass.has(candidateId)) continue;
      const existing = historicalVariants.get(candidateId);
      if (
        existing
        && (existing.baseId !== baseId
          || (existing.capTokens ?? null) !== (capTokens ?? null)
          || Boolean(existing.isNativeMax) !== Boolean(isNativeMax))
      ) {
        continue;
      }
      const published = await publishVariantAlias(installDir, {
        variantId: candidateId,
        baseId,
        capTokens,
        isNativeMax,
      });
      if (published.status === 'ok') {
        historicalVariants.set(candidateId, published.record);
        allocatedInPass.add(candidateId);
        return published.record;
      }
    }
    throw new Error(`Unable to allocate non-colliding variant ID for ${baseId}${suffix}`);
  }

  function registerUpstreamIdsFromSetup(setup) {
    const modelConfig = setup?.configOptions?.find((opt) => opt && (opt.id === 'model' || opt.category === 'model'));
    const rawEntries = modelConfig?.type === 'select' && Array.isArray(modelConfig.options)
      ? modelConfig.options.flatMap((entry) => ('value' in entry ? [entry] : (Array.isArray(entry.options) ? entry.options : [])))
      : Array.isArray(setup?.models?.availableModels)
        ? setup.models.availableModels.map((m) => ({ value: m.modelId, name: m.name }))
        : [];

    for (const entry of rawEntries) {
      if (entry && typeof entry.value === 'string' && entry.value.trim()) {
        reservedUpstreamIds.add(entry.value);
      }
    }
    for (const [variantId, rec] of historicalVariants.entries()) {
      if (reservedUpstreamIds.has(variantId) && variantId !== rec.baseId) {
        if (!conflictedVariantIds.has(variantId)) {
          conflictedVariantIds.add(variantId);
          logError(`Conflict: historical synthetic variant "${variantId}" (mapped to "${rec.baseId}") collides with upstream native model ID.`);
        }
      }
    }
    return { modelConfig, rawEntries };
  }

  async function buildVariantEntries(rawEntries, persistedSelection = null, activeSessionVariantId = null) {
    const allocatedInPass = new Set();
    const out = [];

    for (const entry of rawEntries) {
      if (!entry || typeof entry.value !== 'string' || !entry.value.trim()) continue;
      const baseId = entry.value;
      const baseName = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : baseId;
      const nativeSize = await getModelNativeSize(baseId);
      const defaultIsTighter = nativeSize === null || nativeSize > config.defaultCapTokens;

      out.push({
        ...entry,
        value: baseId,
        name: defaultIsTighter ? `${baseName} (${formatTokenCountLabel(config.defaultCapTokens)})` : baseName,
      });

      for (const tier of config.variantCaps) {
        if (tier.capTokens === config.defaultCapTokens) continue;
        const rec = await allocateVariant(baseId, tier.suffix, tier.capTokens, false, allocatedInPass);
        const isVisible = nativeSize === null || nativeSize > tier.capTokens;
        const isRequiredForSession = activeSessionVariantId === rec.variantId
          || persistedSelection?.variantId === rec.variantId;
        if (isVisible || isRequiredForSession) {
          out.push({
            ...entry,
            value: rec.variantId,
            name: `${baseName} (${tier.label})`,
          });
        }
      }

      if (config.includeFullVariant) {
        const rec = await allocateVariant(baseId, '-full', null, true, allocatedInPass);
        const isVisible = nativeSize === null || nativeSize > config.defaultCapTokens;
        const isRequiredForSession = activeSessionVariantId === rec.variantId
          || persistedSelection?.variantId === rec.variantId;
        if (isVisible || isRequiredForSession) {
          out.push({
            ...entry,
            value: rec.variantId,
            name: `${baseName} (Full)`,
          });
        }
      }
    }

    const ensureVariantId = persistedSelection?.variantId || activeSessionVariantId;
    if (ensureVariantId && !conflictedVariantIds.has(ensureVariantId) && !out.some((item) => item.value === ensureVariantId)) {
      const rec = historicalVariants.get(ensureVariantId);
      const baseItem = rec ? out.find((item) => item.value === rec.baseId) : null;
      if (rec && baseItem) {
        const suffixLabel = rec.isNativeMax ? 'Full' : formatTokenCountLabel(rec.capTokens);
        out.push({
          ...baseItem,
          value: rec.variantId,
          name: `${baseItem.name.replace(/\s+\([^)]+\)$/u, '')} (${suffixLabel})`,
        });
      }
    }
    return out;
  }

  async function rewriteSetupObject(setup, session, persistedSelection = null) {
    if (!setup || typeof setup !== 'object') return setup;
    const { modelConfig, rawEntries } = registerUpstreamIdsFromSetup(setup);
    if (rawEntries.length === 0) return setup;

    const expanded = await buildVariantEntries(rawEntries, persistedSelection, session?.variantId ?? null);
    const clone = { ...setup };
    const desiredCurrent = session?.variantId
      || persistedSelection?.variantId
      || null;

    if (Array.isArray(setup.configOptions) && modelConfig) {
      clone.configOptions = setup.configOptions.map((opt) => {
        if (opt !== modelConfig) return opt;
        const upstreamCurrent = opt.currentValue;
        let nextCurrent = upstreamCurrent;
        if (desiredCurrent && expanded.some((item) => item.value === desiredCurrent)) {
          const lookup = resolveVariantLookup(desiredCurrent, { allowConflicted: true }).record;
          if (!lookup || lookup.baseId === upstreamCurrent) {
            nextCurrent = desiredCurrent;
          }
        }
        return {
          ...opt,
          currentValue: nextCurrent,
          options: expanded,
        };
      });
    }

    if (setup.models && Array.isArray(setup.models.availableModels)) {
      const upstreamCurrentId = setup.models.currentModelId;
      let nextCurrentId = upstreamCurrentId;
      if (desiredCurrent && expanded.some((item) => item.value === desiredCurrent)) {
        const lookup = resolveVariantLookup(desiredCurrent, { allowConflicted: true }).record;
        if (!lookup || lookup.baseId === upstreamCurrentId) {
          nextCurrentId = desiredCurrent;
        }
      }
      clone.models = {
        ...setup.models,
        currentModelId: nextCurrentId,
        availableModels: expanded.map((item) => ({
          modelId: item.value,
          name: item.name,
          ...(item.description !== undefined ? { description: item.description } : {}),
        })),
      };
    }

    return clone;
  }

  function computeHasLowerCap(session, nativeSize) {
    if (!session || session.isNativeMax || session.capTokens === null) return false;
    if (!Number.isInteger(nativeSize) || nativeSize <= 0) return false;
    return nativeSize > session.capTokens;
  }

  async function readBeforeCompactIndex(sessionId) {
    return await readConversationStepStatus(geminiHome, sessionId, (db) => {
      const row = db.prepare('SELECT max(idx) AS idx FROM steps').get();
      return { status: 'ok', index: typeof row?.idx === 'number' ? row.idx : -1 };
    });
  }

  async function verifyCompactOutcome(sessionId, beforeRes, rpcResponse) {
    if (rpcResponse?.error) {
      return {
        status: 'failed',
        reason: rpcResponse.error.message || 'compact_rpc_error',
      };
    }
    if (rpcResponse?.result?.stopReason !== 'end_turn') {
      return {
        status: 'failed',
        reason: `compact_stop_reason_${rpcResponse?.result?.stopReason ?? 'missing'}`,
      };
    }
    if (beforeRes.status === 'unknown') {
      return { status: 'unknown', reason: beforeRes.reason };
    }
    const beforeIdx = beforeRes.status === 'ok' ? beforeRes.index : -1;
    return await readConversationStepStatus(geminiHome, sessionId, (db) => {
      const row = db
        .prepare('SELECT step_type AS type FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1')
        .get(beforeIdx);
      if (!row || typeof row.type !== 'number') {
        return { status: 'unknown', reason: 'no_new_steps_after_compact' };
      }
      if (row.type === ERROR_STEP_TYPE) {
        return { status: 'failed', reason: 'error_step_17' };
      }
      return { status: 'succeeded', lastStepType: row.type };
    });
  }

  async function runPreTurnCompact(session, clientMsg, turnCancel) {
    const beforeRes = await readBeforeCompactIndex(session.sessionId);
    if (turnCancel.cancelled) {
      return { status: 'cancelled' };
    }
    if (beforeRes.status === 'unknown') {
      return {
        status: 'unknown',
        reason: `Pre-turn compaction verification unavailable (${beforeRes.reason}).`,
      };
    }

    let settleResolve;
    const settlePromise = new Promise((resolve) => {
      settleResolve = resolve;
    });
    const compactState = {
      cancelled: turnCancel.cancelled,
      settled: false,
      settlePromise,
      resolveClientCancelled: turnCancel.resolve,
    };
    session.activeCompact = compactState;
    session.activePromptInFlight = true;

    let rpcResp;
    try {
      rpcResp = await sendInternalRequest('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      });
    } catch (error) {
      rpcResp = { error: { code: -32000, message: error?.message || 'Internal /compact failed' } };
    } finally {
      compactState.settled = true;
      session.activePromptInFlight = false;
      settleResolve();
      if (session.activeCompact === compactState) {
        session.activeCompact = null;
      }
    }

    if (compactState.cancelled) {
      return { status: 'cancelled' };
    }

    const verified = await verifyCompactOutcome(session.sessionId, beforeRes, rpcResp);
    if (verified.status === 'succeeded') {
      session.pendingCompact = false;
      sendToClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '[agy-proxy] 上下文已达到阈值并自动压缩，继续执行本轮请求。\n\n' },
          },
        },
      });
      return { status: 'succeeded' };
    }

    return {
      status: verified.status,
      reason: verified.reason || `Pre-turn compaction ${verified.status} for request ${clientMsg.id}.`,
    };
  }

  function forwardClientRequest(msg) {
    return new Promise((resolve) => {
      pendingClientMethods.set(msg.id, {
        method: msg.method,
        sessionId: msg.params?.sessionId ?? null,
        resolveUpstreamResponse: resolve,
      });
      sendToUpstream(msg);
    });
  }

  function handleClientMessage(rawLine) {
    let msg;
    try {
      msg = JSON.parse(rawLine);
    } catch {
      sendToUpstream(rawLine);
      return Promise.resolve();
    }

    if (msg.method === 'session/cancel' && msg.params?.sessionId) {
      const session = sessions.get(msg.params.sessionId);
      sendToUpstream(msg);
      if (session?.activeTurnCancel) {
        session.activeTurnCancel.cancelled = true;
        if (!session.activeCompact) {
          session.activeTurnCancel.resolve({ status: 'cancelled' });
        }
      }
      if (session?.activeCompact && !session.activeCompact.cancelled) {
        const compactState = session.activeCompact;
        compactState.cancelled = true;
        const timer = setTimeout(async () => {
          if (!compactState.settled) {
            compactState.resolveClientCancelled?.({ status: 'cancelled', timedOut: true });
            await onRetireUpstream('compact_cancel_timeout');
          }
        }, compactCancelTimeoutMs);
        compactState.settlePromise.then(() => {
          clearTimeout(timer);
          compactState.resolveClientCancelled?.({ status: 'cancelled', timedOut: false });
        });
      }
      return Promise.resolve();
    }

    return enqueueClientDispatch(async () => {
      await ensureHistoricalLoaded();

      if (msg.id !== undefined && msg.method === 'initialize') {
        pendingClientInit.add(msg.id);
        sendToUpstream(msg);
        return;
      }

      if (protocolState === 'passthrough') {
        if (msg.id !== undefined && (msg.method === 'session/set_model' || msg.method === 'session/set_config_option')) {
          const requestedId = msg.method === 'session/set_model'
            ? msg.params?.modelId
            : (msg.params?.configId === 'model' ? msg.params?.value : null);
          if (typeof requestedId === 'string') {
            const hist = historicalVariants.get(requestedId);
            if (hist && !reservedUpstreamIds.has(requestedId)) {
              const rewritten = {
                ...msg,
                params: msg.method === 'session/set_model'
                  ? { ...msg.params, modelId: hist.baseId }
                  : { ...msg.params, value: hist.baseId },
              };
              sendToUpstream(rewritten);
              return;
            }
          }
        }
        sendToUpstream(msg);
        return;
      }

    if (msg.method === 'session/close' && msg.params?.sessionId) {
      sessions.delete(msg.params.sessionId);
      sendToUpstream(msg);
      return;
    }

    if (msg.id === undefined) {
      sendToUpstream(msg);
      return;
    }

    if (msg.method === 'session/new') {
      forwardClientRequest(msg).then(async (resp) => {
        if (resp.error || !resp.result?.sessionId) {
          sendToClient(resp);
          return;
        }
        const session = getOrCreateSession(resp.result.sessionId);
        const rewritten = await rewriteSetupObject(resp.result, session, null);
        const modelOpt = rewritten.configOptions?.find((o) => o && (o.id === 'model' || o.category === 'model'));
        const currentModelId = modelOpt?.currentValue ?? rewritten.models?.currentModelId ?? null;
        if (currentModelId) {
          const lookup = resolveVariantLookup(currentModelId, { allowConflicted: true }).record;
          session.variantId = currentModelId;
          session.baseId = lookup?.baseId ?? currentModelId;
          session.capTokens = lookup ? lookup.capTokens : config.defaultCapTokens;
          session.isNativeMax = lookup ? lookup.isNativeMax : false;
          session.lastNativeSize = await getModelNativeSize(session.baseId);
          await writeSessionSelection(installDir, {
            sessionId: session.sessionId,
            variantId: session.variantId,
            baseId: session.baseId,
            capTokens: session.capTokens,
            isNativeMax: session.isNativeMax,
          });
        }
        sendToClient({ ...resp, result: rewritten });
      });
      return;
    }

    if ((msg.method === 'session/load' || msg.method === 'session/resume') && msg.params?.sessionId) {
      const session = getOrCreateSession(msg.params.sessionId);
      enqueueSession(session, async () => {
        const persisted = await readSessionSelection(installDir, session.sessionId);
        if (persisted && persisted.variantId !== persisted.baseId && conflictedVariantIds.has(persisted.variantId)) {
          sendToClient({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32000,
              message: `Persisted synthetic model variant "${persisted.variantId}" (previously mapped to "${persisted.baseId}") collides with an upstream native model ID. Start a new session or select a current model.`,
            },
          });
          return;
        }

        session.inReplay = true;
        let resp;
        try {
          resp = await forwardClientRequest(msg);
        } finally {
          session.inReplay = false;
        }

        if (resp.error || !resp.result) {
          sendToClient(resp);
          return;
        }

        registerUpstreamIdsFromSetup(resp.result);
        if (persisted && persisted.variantId !== persisted.baseId && conflictedVariantIds.has(persisted.variantId)) {
          session.conflictedVariantId = persisted.variantId;
          sendToClient({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32000,
              message: `Persisted synthetic model variant "${persisted.variantId}" (previously mapped to "${persisted.baseId}") collides with a newly added upstream native model ID. Start a new session or select a current model.`,
            },
          });
          return;
        }

        const rewritten = await rewriteSetupObject(resp.result, session, persisted);
        if (persisted) {
          session.variantId = persisted.variantId;
          session.baseId = persisted.baseId;
          session.capTokens = persisted.capTokens;
          session.isNativeMax = persisted.isNativeMax;
        } else {
          const modelOpt = rewritten.configOptions?.find((o) => o && (o.id === 'model' || o.category === 'model'));
          const currentModelId = modelOpt?.currentValue ?? rewritten.models?.currentModelId ?? null;
          if (currentModelId) {
            session.variantId = currentModelId;
            session.baseId = currentModelId;
            session.capTokens = config.defaultCapTokens;
            session.isNativeMax = false;
          }
        }
        session.lastNativeSize = session.baseId ? await getModelNativeSize(session.baseId) : null;
        sendToClient({ ...resp, result: rewritten });
      });
      return;
    }

    if (
      (msg.method === 'session/set_model' || (msg.method === 'session/set_config_option' && msg.params?.configId === 'model'))
      && msg.params?.sessionId
    ) {
      const session = getOrCreateSession(msg.params.sessionId);
      enqueueSession(session, async () => {
        const requestedVariantId = msg.method === 'session/set_model' ? msg.params.modelId : msg.params.value;
        if (session.conflictedVariantId && requestedVariantId === session.conflictedVariantId) {
          sendToClient({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32000,
              message: `Model variant "${requestedVariantId}" conflicts between historical synthetic alias and upstream native model in this resumed session.`,
            },
          });
          return;
        }

        const lookup = resolveVariantLookup(requestedVariantId);
        if (lookup.conflict) {
          sendToClient({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32000,
              message: `Model variant "${requestedVariantId}" conflicts with upstream native model ID.`,
            },
          });
          return;
        }

        const target = lookup.record ?? {
          variantId: requestedVariantId,
          baseId: requestedVariantId,
          capTokens: config.defaultCapTokens,
          isNativeMax: false,
        };

        const upstreamMsg = {
          ...msg,
          params: msg.method === 'session/set_model'
            ? { ...msg.params, modelId: target.baseId }
            : { ...msg.params, value: target.baseId },
        };

        session.inModelSwitch = true;
        let resp;
        try {
          resp = await forwardClientRequest(upstreamMsg);
        } finally {
          session.inModelSwitch = false;
        }

        if (resp.error) {
          sendToClient(resp);
          return;
        }

        const sameBase = session.baseId === target.baseId;
        session.variantId = target.variantId;
        session.baseId = target.baseId;
        session.capTokens = target.capTokens;
        session.isNativeMax = Boolean(target.isNativeMax);
        session.conflictedVariantId = null;
        await writeSessionSelection(installDir, {
          sessionId: session.sessionId,
          variantId: session.variantId,
          baseId: session.baseId,
          capTokens: session.capTokens,
          isNativeMax: session.isNativeMax,
        });

        const nativeSize = await getModelNativeSize(session.baseId);
        session.lastNativeSize = nativeSize;

        if (!sameBase) {
          session.lastUsedTokens = null;
          session.pendingCompact = false;
          session.awaitingPromptForModel = true;
        } else {
          if (!computeHasLowerCap(session, nativeSize)) {
            session.pendingCompact = false;
          } else if (session.lastUsedTokens !== null && session.lastUsedTokens >= Math.floor(session.capTokens * config.compactTriggerRatio)) {
            session.pendingCompact = true;
          }
          if (session.lastUsedTokens !== null && nativeSize > 0) {
            const effectiveSize = computeHasLowerCap(session, nativeSize) ? session.capTokens : nativeSize;
            sendToClient({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: session.sessionId,
                update: {
                  sessionUpdate: 'usage_update',
                  used: session.lastUsedTokens,
                  size: effectiveSize,
                },
              },
            });
          }
        }

        if (resp.result && Array.isArray(resp.result.configOptions)) {
          const rewritten = await rewriteSetupObject(resp.result, session, null);
          sendToClient({ ...resp, result: rewritten });
        } else {
          sendToClient(resp);
        }
      });
      return;
    }

    if (msg.method === 'session/prompt' && msg.params?.sessionId) {
      const session = getOrCreateSession(msg.params.sessionId);
      enqueueSession(session, async () => {
        const userIsCompact = isCompactSlashCommand(msg.params.prompt);
        const nativeSize = await getModelNativeSize(session.baseId);
        const hasLowerCap = computeHasLowerCap(session, nativeSize);

        if (session.pendingCompact) {
          if (!hasLowerCap || userIsCompact) {
            session.pendingCompact = false;
          } else {
            let cancelResolve;
            const cancelPromise = new Promise((resolve) => {
              cancelResolve = resolve;
            });
            const turnCancel = { cancelled: false, resolve: cancelResolve };
            session.activeTurnCancel = turnCancel;
            let compactResult;
            try {
              compactResult = await Promise.race([
                runPreTurnCompact(session, msg, turnCancel),
                cancelPromise,
              ]);
            } finally {
              session.activeTurnCancel = null;
            }
            if (compactResult.status === 'cancelled') {
              sendToClient({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } });
              return;
            }
            if (compactResult.status !== 'succeeded') {
              sendToClient({
                jsonrpc: '2.0',
                id: msg.id,
                error: {
                  code: -32000,
                  message: `Pre-turn compaction failed (${compactResult.status}): ${compactResult.reason}`,
                },
              });
              return;
            }
          }
        }

        session.awaitingPromptForModel = false;
        session.activePromptInFlight = true;
        let resp;
        try {
          resp = await forwardClientRequest(msg);
        } finally {
          session.activePromptInFlight = false;
        }

        if (!resp.error && resp.result?.stopReason !== 'cancelled' && !userIsCompact) {
          const latestNativeSize = await getModelNativeSize(session.baseId);
          const activeHasLowerCap = computeHasLowerCap(session, latestNativeSize);
          if (
            activeHasLowerCap
            && session.lastUsedTokens !== null
            && session.lastUsedTokens >= Math.floor(session.capTokens * config.compactTriggerRatio)
          ) {
            session.pendingCompact = true;
          }
        }
        sendToClient(resp);
      });
      return;
    }

    sendToUpstream(msg);
    });
  }

  function handleUpstreamMessage(rawLine) {
    return enqueueUpstream(async () => {
      let msg;
      try {
        msg = JSON.parse(rawLine);
      } catch {
        sendToClient(rawLine);
        return;
      }

      await ensureHistoricalLoaded();

      if (msg.id !== undefined && pendingInternal.has(msg.id)) {
        const entry = pendingInternal.get(msg.id);
        pendingInternal.delete(msg.id);
        entry.resolve(msg);
        return;
      }

      if (msg.id !== undefined && pendingClientInit.has(msg.id)) {
        pendingClientInit.delete(msg.id);
        if (!msg.error && msg.result?.protocolVersion === 1) {
          protocolState = 'v1';
        } else {
          protocolState = 'passthrough';
          if (!msg.error && msg.result?.protocolVersion !== 1) {
            logError(`ACP protocolVersion=${msg.result?.protocolVersion ?? 'missing'}; entering transparent passthrough mode.`);
          }
        }
        sendToClient(msg);
        return;
      }

      if (msg.id !== undefined && pendingClientMethods.has(msg.id)) {
        const pending = pendingClientMethods.get(msg.id);
        pendingClientMethods.delete(msg.id);
        pending.resolveUpstreamResponse(msg);
        return;
      }

      if (protocolState === 'passthrough') {
        sendToClient(msg);
        return;
      }

      if (msg.method === 'session/update' && msg.params?.sessionId && msg.params?.update) {
        const sessionId = msg.params.sessionId;
        const session = sessions.get(sessionId);
        const update = msg.params.update;
        const isReplay = msg.params?._meta?.isReplay === true;

        if (session?.activeCompact) {
          if (
            update.sessionUpdate === 'agent_message_chunk'
            || update.sessionUpdate === 'agent_thought_chunk'
            || update.sessionUpdate === 'agent_message'
            || update.sessionUpdate === 'agent_thought'
          ) {
            return;
          }
        }

        if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
          const persisted = await readSessionSelection(installDir, sessionId);
          const rewritten = await rewriteSetupObject({ configOptions: update.configOptions }, session, persisted);
          sendToClient({
            ...msg,
            params: {
              ...msg.params,
              update: {
                ...update,
                configOptions: rewritten.configOptions,
              },
            },
          });
          return;
        }

        if (update.sessionUpdate === 'usage_update') {
          const reliableLive = Boolean(
            session
            && !isReplay
            && !session.inReplay
            && !session.inModelSwitch
            && !session.awaitingPromptForModel
            && session.activePromptInFlight
            && session.baseId,
          );
          if (!reliableLive) {
            sendToClient(msg);
            return;
          }

          const upstreamSize = update.size;
          if (Number.isInteger(upstreamSize) && upstreamSize > 0) {
            await recordModelNativeSize(session.baseId, upstreamSize);
            session.lastNativeSize = upstreamSize;
          }
          if (Number.isInteger(update.used) && update.used >= 0) {
            session.lastUsedTokens = update.used;
          }
          const effectiveNative = Number.isInteger(upstreamSize) && upstreamSize > 0 ? upstreamSize : session.lastNativeSize;
          const hasLowerCap = computeHasLowerCap(session, effectiveNative);
          const nextSize = hasLowerCap ? session.capTokens : upstreamSize;
          sendToClient({
            ...msg,
            params: {
              ...msg.params,
              update: {
                ...update,
                size: nextSize,
              },
            },
          });
          return;
        }
      }

      sendToClient(msg);
    });
  }

  function failAllPending(reason) {
    for (const [id, entry] of pendingInternal.entries()) {
      pendingInternal.delete(id);
      entry.reject(new Error(reason));
    }
    for (const [id, entry] of pendingClientMethods.entries()) {
      pendingClientMethods.delete(id);
      entry.resolveUpstreamResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: reason },
      });
    }
  }

  return {
    ensureHistoricalLoaded,
    handleClientMessage,
    handleUpstreamMessage,
    failAllPending,
    getState() {
      return {
        protocolState,
        sessions,
        reservedUpstreamIds,
        conflictedVariantIds,
      };
    },
  };
}
