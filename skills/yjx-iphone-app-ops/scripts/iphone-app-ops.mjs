#!/usr/bin/env node

import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdir, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {queryOptions, preflightArtifacts, publishArtifact, runDianpingQuery} from './dianping-query.mjs'
import {normalizeObservations, groupBusinesses} from './dianping-results.mjs'
import {runDianpingDetail} from './dianping-detail.mjs'
import {runDianpingShare} from './dianping-share.mjs'
import {runXiaohongshuQuery} from './xiaohongshu-query.mjs'
import {isProxyTimeout} from './app-pages.mjs'

const config = {
  appiumUrl: process.env.APPIUM_URL || 'http://127.0.0.1:4723',
  udid: process.env.IOS_DEVICE_UDID || '00008020-000B25990204002E',
  deviceName: process.env.IOS_DEVICE_NAME || 'iPhone XS Max',
  platformVersion: process.env.IOS_PLATFORM_VERSION || '18.7',
  wdaBundleId: process.env.IOS_WDA_BUNDLE_ID || 'com.youjiaxing.familyhealth.WebDriverAgentRunner',
  sessionFile: process.env.IPHONE_OPS_SESSION_FILE || path.join(os.tmpdir(), `yjx-iphone-app-ops-${process.env.IOS_DEVICE_UDID || 'xsmax'}.json`),
}

const timeoutMs = Number(process.env.IPHONE_OPS_TIMEOUT_MS || 45000)
const newCommandTimeoutSeconds = Number(process.env.IPHONE_OPS_NEW_COMMAND_TIMEOUT_SEC ?? 0)
if (!Number.isFinite(timeoutMs) || timeoutMs < 35000) {
  throw new Error('IPHONE_OPS_TIMEOUT_MS must be at least 35000 to exceed the XCUITest WDA proxy timeout')
}

export function extractForegroundBundle(source) {
  return source.match(/<XCUIApplication\b[^>]*\bbundleId="([^"]+)"/)?.[1]
    || source.match(/<XCUIElementTypeApplication\b[^>]*\bbundleId="([^"]+)"/)?.[1]
    || null
}

export function isLockScreenSource(source) {
  return /SBCoverSheetWindow|lockscreen-date-view/.test(source)
}

export function requiresCredential(source) {
  return isLockScreenSource(source) && /XCUIElementTypeSecureTextField|Enter Passcode|输入密码|输入锁屏密码/i.test(source)
}

export function parseDeviceLine(output, udid = config.udid) {
  const line = output.split('\n').find((entry) => entry.includes(udid))
  if (!line) return null
  const columns = line.trim().split(/\s{2,}/)
  return {raw: line.trim(), state: columns.find((value) => /connected|available|unavailable|offline/i.test(value)) || 'unknown'}
}

export function createAppiumClient({baseUrl = config.appiumUrl, fetchImpl = fetch, requestTimeoutMs = timeoutMs, sessionFile = null} = {}) {
  const endpoint = new URL(baseUrl)
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname)) {
    throw new Error('Appium must be bound to a loopback address')
  }

  async function request(endpoint, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || requestTimeoutMs)
    let responseReceived = false
    try {
      const response = await fetchImpl(`${baseUrl}${endpoint}`, {...options, signal: controller.signal})
      responseReceived = true
      const body = await response.json()
      if (!response.ok || body.value?.error) {
        const error = new Error(body.value?.message || 'Appium HTTP ' + response.status)
        error.code = body.value?.error || 'protocol-error'
        error.phase = endpoint
        error.outcome = 'unknown'
        error.transportPending = false
        if (sessionFile && isProxyTimeout(error)) await markSessionResetRequired(sessionFile, endpoint).catch(() => {})
        throw error
      }
      return body.value
    } catch (error) {
      if (controller.signal.aborted) {
        if (sessionFile) await markSessionCommandUnknown(sessionFile, endpoint).catch(() => {})
        const timeout = new Error('Appium request timed out: ' + endpoint)
        timeout.code = 'ETIMEDOUT'
        timeout.phase = endpoint
        timeout.outcome = 'unknown'
        timeout.transportPending = true
        throw timeout
      }
      if (!responseReceived && error.code !== 'invalid session id') {
        error.phase ||= endpoint
        error.outcome = 'unknown'
        error.transportPending = true
        if (sessionFile) await markSessionCommandUnknown(sessionFile, endpoint).catch(() => {})
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    status: () => request('/status', {timeoutMs: 5000}),
    wdaStatus: async () => {
      const port = process.env.IOS_WDA_LOCAL_PORT || '8100'
      const response = await fetchImpl(`http://127.0.0.1:${port}/status`, {signal: AbortSignal.timeout(5000)})
      const body = await response.json()
      if (!response.ok || body.value?.ready !== true) throw new Error('WDA status is not ready')
      return body
    },
    createSession: () => request('/session', {
      method: 'POST',
      timeoutMs: 120000,
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({capabilities: {alwaysMatch: {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:udid': config.udid,
        'appium:deviceName': config.deviceName,
        'appium:platformVersion': config.platformVersion,
        'appium:usePreinstalledWDA': true,
        'appium:updatedWDABundleId': config.wdaBundleId,
        'appium:autoLaunch': false,
        // Keep the shared WDA session alive; the CLI owns explicit recovery.
        'appium:newCommandTimeout': newCommandTimeoutSeconds,
        'appium:wdaLaunchTimeout': 60000,
        'appium:wdaConnectionTimeout': 30000,
      }, firstMatch: [{}]}}),
    }),
    source: (sessionId) => request(`/session/${sessionId}/source`),
    findElement: (sessionId, using, value) => request(`/session/${sessionId}/element`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({using, value}),
    }),
    elementText: (sessionId, elementId) => request(`/session/${sessionId}/element/${encodeURIComponent(elementId)}/text`),
    elementAttribute: (sessionId, elementId, attribute) => request(`/session/${sessionId}/element/${encodeURIComponent(elementId)}/attribute/${encodeURIComponent(attribute)}`),
    elementRect: (sessionId, elementId) => request(`/session/${sessionId}/element/${encodeURIComponent(elementId)}/rect`),
    clickElement: (sessionId, elementId) => request(`/session/${sessionId}/element/${encodeURIComponent(elementId)}/click`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}),
    setElementValue: (sessionId, elementId, value) => request(`/session/${sessionId}/element/${encodeURIComponent(elementId)}/value`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: Array.from(value)}),
    }),
    clearElement: (sessionId, elementId) => request(`/session/${sessionId}/element/${encodeURIComponent(elementId)}/clear`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}),
    execute: (sessionId, script, args = []) => request(`/session/${sessionId}/execute/sync`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({script, args}),
    }),
    screenshot: (sessionId) => request(`/session/${sessionId}/screenshot`),
    tap: (sessionId, x, y) => request(`/session/${sessionId}/actions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({actions: [{type: 'pointer', id: 'finger1', parameters: {pointerType: 'touch'}, actions: [
        {type: 'pointerMove', duration: 0, x, y},
        {type: 'pointerDown', button: 0},
        {type: 'pause', duration: 100},
        {type: 'pointerUp', button: 0},
      ]}]}),
    }),
    deleteSession: (sessionId) => request(`/session/${sessionId}`, {method: 'DELETE'}),
  }
}

function run(command, args) {
  try {
    return execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000})
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n')
    throw new Error(`${command} failed: ${detail}`)
  }
}

function sessionLockPath() {
  return `${config.sessionFile}.lock`
}

function unknownRequestPath(sessionFile = config.sessionFile) {
  return `${sessionFile}.unknown`
}

function resetRequiredPath(sessionFile = config.sessionFile) {
  return `${sessionFile}.reset-required`
}

async function markSessionCommandUnknown(sessionFile, endpoint) {
  const match = endpoint.match(/^\/session\/([^/]+)(?:\/|$)/)
  if (!match) return
  const marker = {sessionId: match[1], at: Date.now(), command: endpoint.split('/').slice(3, 5).join('/') || 'session-command'}
  const destination = unknownRequestPath(sessionFile)
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(marker), {flag: 'wx', mode: 0o600})
    await rename(temporary, destination)
  } finally {
    await rm(temporary, {force: true})
  }
}

async function markSessionResetRequired(sessionFile, endpoint) {
  const match = endpoint.match(/^\/session\/([^/]+)(?:\/|$)/)
  if (!match) return
  const marker = {sessionId: match[1], at: Date.now(), command: endpoint.split('/').slice(3, 5).join('/') || 'session-command'}
  const destination = resetRequiredPath(sessionFile)
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(marker), {flag: 'wx', mode: 0o600})
    await rename(temporary, destination)
  } finally {
    await rm(temporary, {force: true})
  }
}

async function loadUnknownRequest(sessionFile = config.sessionFile) {
  try { return JSON.parse(await readFile(unknownRequestPath(sessionFile), 'utf8')) }
  catch { return null }
}

async function loadResetRequired(sessionFile = config.sessionFile) {
  try { return JSON.parse(await readFile(resetRequiredPath(sessionFile), 'utf8')) }
  catch { return null }
}

export async function withFileLock(lockPath, action) {
  await mkdir(path.dirname(lockPath), {recursive: true})
  let handle
  const nonce = randomUUID()
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({pid: process.pid, at: Date.now(), nonce}))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch {}
      let alive = true
      if (owner?.pid && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0) } catch (probeError) { alive = probeError.code === 'EPERM' }
      } else {
        try { alive = Date.now() - (await stat(lockPath)).mtimeMs < 30000 } catch { alive = false }
      }
      if (!alive) {
        throw new Error('stale device lock; verify no owner is using the phone before removing ' + lockPath)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  if (!handle) throw new Error('another iPhone operation is still active')
  try {
    return await action()
  } finally {
    await handle.close()
    let owner
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch {}
    if (owner?.nonce === nonce) await rm(lockPath, {force: true})
  }
}

async function withDeviceLock(action) {
  return withFileLock(sessionLockPath(), action)
}

async function saveSession(sessionId) {
  const temporaryPath = `${config.sessionFile}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify({sessionId, udid: config.udid, createdAt: new Date().toISOString()}), {mode: 0o600})
    await rename(temporaryPath, config.sessionFile)
  } finally {
    await rm(temporaryPath, {force: true})
  }
}

async function loadSession() {
  try {
    const state = JSON.parse(await readFile(config.sessionFile, 'utf8'))
    if (state.udid === config.udid && typeof state.sessionId === 'string') return state
  } catch {}
  return null
}

async function discardKnownSession(client, sessionId) {
  try { await client.deleteSession(sessionId) }
  catch (error) { if (error.code !== 'invalid session id') throw error }
  await rm(config.sessionFile, {force: true})
  await rm(unknownRequestPath(), {force: true})
  await rm(resetRequiredPath(), {force: true})
  await rm(`${config.sessionFile}.creating`, {force: true})
}

async function recoverWithKnownProxyReset(client, sessionId, bundleId) {
  try { return await recover(client, sessionId, bundleId) }
  catch (error) {
    if (!isProxyTimeout(error) || error.transportPending) throw error
    await discardKnownSession(client, sessionId)
    const renewed = await ensureSession(client)
    return {...await recover(client, renewed.sessionId, bundleId),
      sessionId: renewed.sessionId, sessionRecovery: 'recreated-after-completed-wda-proxy-timeout'}
  }
}

export async function doctor(client = createAppiumClient()) {
  const appium = await client.status()
  const devices = run('xcrun', ['devicectl', 'list', 'devices'])
  const device = parseDeviceLine(devices)
  let wdaInstalled = null
  let deviceAppsError = null
  try {
    const installedApps = run('xcrun', ['devicectl', 'device', 'info', 'apps', '--device', config.udid])
    wdaInstalled = installedApps.includes(`${config.wdaBundleId}.xctrunner`)
  } catch (error) {
    deviceAppsError = error.message
  }
  const appiumPort = new URL(config.appiumUrl).port || '4723'
  const listeners = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
  const appiumListeners = listeners.split('\n').filter((line) => line.includes(`:${appiumPort}`))
  const appiumLoopbackOnly = appiumListeners.length > 0 && appiumListeners.every((line) => /127\.0\.0\.1|\[::1\]/.test(line))
  let tunnel = false
  try {
    run('pgrep', ['-f', 'tunnel-creation'])
    tunnel = true
  } catch {}
  let tunnelReady = false
  try {
    const tunnel = await fetch(`http://127.0.0.1:42314/remotexpc/tunnels/${config.udid}?waitMs=1000`, {signal: AbortSignal.timeout(5000)})
    const body = await tunnel.json()
    tunnelReady = body.status === 'OK'
  } catch {}
  return {ok: Boolean(device && tunnel && tunnelReady && wdaInstalled && appiumLoopbackOnly), appium: {ready: true, loopbackOnly: appiumLoopbackOnly, version: appium.build?.version}, device, wdaInstalled, deviceAppsError, tunnel, tunnelReady, udid: config.udid}
}

export function classifyWdaHealth({appium = false, tunnel = false, wda = false, session = false, source = false,
  active = false, locked = null, commandUnknown = false} = {}) {
  if (!appium) return 'appium-unavailable'
  if (session && source && locked === true) return 'lock-screen-readable'
  if (session && source) return 'session-source-readable'
  if (commandUnknown) return 'appium-command-outcome-unknown'
  if (!wda && !tunnel) return 'wda-and-remote-xpc-unavailable'
  if (!wda) return 'wda-endpoint-unavailable'
  if (!tunnel) return 'remote-xpc-registry-unavailable-wda-reachable'
  if (!session) return 'session-missing-or-expired'
  if (active) return 'wda-reachable-ax-snapshot-unresponsive'
  return 'wda-command-channel-unresponsive'
}

export async function probeSessionHealth(client, sessionId, {fetchImpl = fetch, udid = config.udid, sessionFile = config.sessionFile} = {}) {
  const result = {appium: false, tunnel: false, wda: false, session: Boolean(sessionId),
    source: false, active: false, locked: null, checks: {}}
  const checks = await Promise.allSettled([
    client.status(),
    fetchImpl(`http://127.0.0.1:42314/remotexpc/tunnels/${udid}?waitMs=0`, {signal: AbortSignal.timeout(5000)})
      .then(async (response) => ({response, body: await response.json()})),
    client.wdaStatus(),
  ])
  const [appium, tunnel, wda] = checks
  result.appium = appium.status === 'fulfilled' && appium.value?.ready === true
  result.tunnel = tunnel.status === 'fulfilled' && tunnel.value.response.ok && tunnel.value.body.status === 'OK'
  result.wda = wda.status === 'fulfilled'
  result.checks.appium = result.appium ? {ok: true} : {ok: false, error: appium.reason?.code || appium.reason?.message}
  result.checks.tunnel = result.tunnel ? {ok: true} : {ok: false,
    error: tunnel.reason?.code || tunnel.reason?.message || tunnel.value?.body?.status || 'not-ready'}
  result.checks.wda = result.wda ? {ok: true, port: process.env.IOS_WDA_LOCAL_PORT || 8100}
    : {ok: false, error: wda.reason?.code || wda.reason?.message}
  const storedUnknown = await loadUnknownRequest(sessionFile)
  let unknown = storedUnknown && (!sessionId || storedUnknown.sessionId === sessionId) ? storedUnknown : null
  const reset = await loadResetRequired(sessionFile)
  result.commandUnknown = Boolean(unknown && (!sessionId || unknown.sessionId === sessionId))
  result.resetRequired = Boolean(reset && (!sessionId || reset.sessionId === sessionId))
  if (result.appium && sessionId && !result.commandUnknown && !result.resetRequired) {
    try {
      const page = await client.source(sessionId)
      result.source = true
      result.locked = isLockScreenSource(page)
      result.checks.source = {ok: true}
    } catch (error) {
      result.checks.source = {ok: false, code: error.code || 'protocol-error', phase: error.phase || null,
        outcome: error.outcome || 'unknown'}
      if (error.code === 'invalid session id') result.session = false
      else if (error.transportPending === true || error.code === 'ETIMEDOUT') {
        result.commandUnknown = true
        unknown ||= {sessionId, at: Date.now(), command: 'source'}
      }
      else {
        try { await client.execute(sessionId, 'mobile: activeAppInfo'); result.active = true }
        catch (activeError) {
          result.checks.activeAppInfo = {ok: false, code: activeError.code || 'protocol-error'}
          if (activeError.transportPending === true || activeError.code === 'ETIMEDOUT') {
            result.commandUnknown = true
            unknown ||= {sessionId, at: Date.now(), command: 'activeAppInfo'}
          }
        }
      }
    }
  }
  if (result.commandUnknown) {
    const marker = unknown || {sessionId, at: Date.now(), command: 'session-command'}
    result.checks.session = {ok: false, outcome: 'unknown', command: marker.command,
    ageSeconds: Math.max(0, Math.round((Date.now() - marker.at) / 1000)),
    skipped: 'session commands are withheld to avoid overlapping until the proxy deadline has elapsed'}
  }
  if (result.resetRequired) result.checks.session = {ok: false, outcome: 'proxy-timeout-response-received',
    command: reset.command, skipped: 'replace this completed-failure session before another page command'}
  return {...result, status: classifyWdaHealth(result)}
}

export async function recover(client, sessionId, bundleId) {
  let page = await client.source(sessionId)
  const steps = [{name: 'read-source', ok: true, lockScreen: isLockScreenSource(page)}]
  if (requiresCredential(page)) {
    return {ok: false, status: 'blocked-needs-user', reason: 'credential-required', sessionId, bundleId, steps}
  }
  if (isLockScreenSource(page)) {
    await client.execute(sessionId, 'mobile: pressButton', [{name: 'home'}])
    steps.push({name: 'wake-home', ok: true})
    page = await client.source(sessionId)
    if (requiresCredential(page)) {
      return {ok: false, status: 'blocked-needs-user', reason: 'credential-required', sessionId, bundleId, steps}
    }
    if (isLockScreenSource(page)) {
      await client.execute(sessionId, 'mobile: dragFromToForDuration', [{duration: 0.1, fromX: 207, fromY: 850, toX: 207, toY: 120}])
      steps.push({name: 'swipe-lock-screen', ok: true})
      page = await client.source(sessionId)
      if (requiresCredential(page)) {
        return {ok: false, status: 'blocked-needs-user', reason: 'credential-required', sessionId, bundleId, steps}
      }
    }
  }
  await client.execute(sessionId, 'mobile: launchApp', [{bundleId}])
  const ready = await waitForForeground(client, sessionId, bundleId)
  page = ready.page
  const foregroundBundle = ready.foregroundBundle
  const activeBundle = ready.activeAppInfo?.bundleId || null
  const appState = ready.appState
  const appReady = foregroundBundle === bundleId && activeBundle === bundleId && appState === 4
  return {ok: appReady, sessionId, bundleId, foregroundBundle, activeBundle, appState, steps, appReady, lockScreenAfter: isLockScreenSource(page)}
}

export async function waitForForeground(client, sessionId, bundleId, timeout = 8000) {
  const deadline = Date.now() + timeout
  let state = {page: '', activeAppInfo: null, appState: null, foregroundBundle: null}
  while (Date.now() < deadline) {
    state.page = await client.source(sessionId)
    state.foregroundBundle = extractForegroundBundle(state.page)
    if (Date.now() >= deadline) break
    if (state.foregroundBundle === bundleId) {
      state.activeAppInfo = await client.execute(sessionId, 'mobile: activeAppInfo')
      if (Date.now() >= deadline) break
      state.appState = await client.execute(sessionId, 'mobile: queryAppState', [{bundleId}])
    }
    if (state.foregroundBundle === bundleId && state.activeAppInfo?.bundleId === bundleId && state.appState === 4) return state
    const remaining = deadline - Date.now()
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(400, remaining)))
  }
  return state
}

async function requireForeground(client, sessionId, bundleId, existingPage) {
  const page = existingPage ?? await client.source(sessionId)
  if (isLockScreenSource(page) || requiresCredential(page)) throw new Error('device is locked; no element action was sent')
  const activeAppInfo = await client.execute(sessionId, 'mobile: activeAppInfo')
  const appState = await client.execute(sessionId, 'mobile: queryAppState', [{bundleId}])
  const rootBundle = extractForegroundBundle(page)
  if (rootBundle !== bundleId || activeAppInfo?.bundleId !== bundleId || appState !== 4) {
    throw new Error(`target app is not verified in foreground: root=${rootBundle || 'unknown'}, active=${activeAppInfo?.bundleId || 'unknown'}, state=${appState}`)
  }
}

function elementId(response) {
  const id = response?.['element-6066-11e4-a52e-4f735466cecf'] || response?.ELEMENT
  if (!id) throw new Error('Appium did not return an element identifier')
  return id
}

export async function elementAction(client, sessionId, method, bundleId, using, selector, {readInput = readStdin} = {}) {
  const locatorStrategies = {
    'accessibility-id': 'accessibility id',
    predicate: '-ios predicate string',
    'class-chain': '-ios class chain',
  }
  const strategy = locatorStrategies[using]
  if (!strategy || !selector || selector.length > 512) throw new Error('use a supported locator and a non-empty selector up to 512 characters')
  await requireForeground(client, sessionId, bundleId)
  const found = await client.findElement(sessionId, strategy, selector)
  const id = elementId(found)
  let result
  if (method === 'read') {
    result = {text: await client.elementText(sessionId, id), label: await client.elementAttribute(sessionId, id, 'label'), value: await client.elementAttribute(sessionId, id, 'value')}
  } else if (method === 'click') {
    await client.clickElement(sessionId, id)
    result = {action: 'click-sent', outcome: 'inspect-current-state-before-any-retry'}
  } else if (method === 'set-value') {
    const text = await readInput()
    await client.clearElement(sessionId, id)
    await client.setElementValue(sessionId, id, text)
    result = {action: 'set-value-sent', characters: Array.from(text).length, outcome: 'inspect-current-state-before-any-retry'}
  } else {
    throw new Error(`unsupported element action: ${method}`)
  }
  const page = await client.source(sessionId)
  return {ok: true, bundleId, foregroundBundle: extractForegroundBundle(page), pageBytes: Buffer.byteLength(page), ...result}
}

export function isDianpingConsentSource(source) {
  return /大众点评隐私政策协议/.test(source) && /(?:name|label)="同意"/.test(source)
}

export function isDianpingVerificationSource(source) {
  return /身份核实|请依次点击下图图标|验证码|安全验证/.test(source)
}

export function collectSourceText(tree, rows = []) {
  if (!tree || typeof tree !== 'object') return rows
  const visible = tree.isVisible === '1' || tree.isVisible === true || tree.visible === true
  const values = [tree.label, tree.value, tree.name]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
  if (visible) {
    for (const text of values) {
      if (!['rootView', '大众点评'].includes(text) && !rows.some((row) => row.text === text && row.rect?.x === tree.rect?.x && row.rect?.y === tree.rect?.y)) {
        rows.push({text, rect: tree.rect || null, type: tree.type || null})
      }
    }
  }
  for (const child of tree.children || []) collectSourceText(child, rows)
  return rows
}

export function groupDianpingBusinesses(ocr) {
  return groupBusinesses(normalizeObservations(ocr.observations || [], 'vision-ocr')).businesses
}

export function runVisionOcr(image) {
  const helper = fileURLToPath(new URL('./vision-ocr.swift', import.meta.url))
  const output = execFileSync('/usr/bin/swift', [helper, Buffer.isBuffer(image) ? '--stdin' : image], {
    encoding: 'utf8', input: Buffer.isBuffer(image) ? image : undefined,
    timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  })
  return JSON.parse(output)
}

export async function dianpingSearch(client, sessionId, query, screenshotPath, sourcePath, extractionPath, maxPages = 3) {
  return runDianpingQuery(client, sessionId, {query, screenshotPath, sourcePath, extractionPath, maxPages}, {
    recover, requireForeground, sourceText: collectSourceText, ocr: runVisionOcr,
  })
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function ensureSession(client, {lightweight = false} = {}) {
  const validate = (sid) => lightweight ? client.execute(sid, 'mobile: activeAppInfo') : client.source(sid)
  let previous = await loadSession()
  const pendingPath = config.sessionFile + '.creating'
  const unknown = await loadUnknownRequest(config.sessionFile)
  const reset = await loadResetRequired(config.sessionFile)
  if (unknown && !previous) throw new Error('a previous session command has an unknown outcome; inspect wda-health and preserve the current Appium session before creating another')
  if (unknown && previous && unknown.sessionId !== previous.sessionId) {
    throw new Error('the unknown-command marker belongs to a different session; inspect Appium session ownership before continuing')
  }
  if (reset && !previous) throw new Error('a session requires replacement but its cached ID is missing; inspect Appium session ownership before creating another')
  if (reset && previous && reset.sessionId !== previous.sessionId) {
    throw new Error('the reset-required marker belongs to a different session; inspect Appium session ownership before continuing')
  }
  if (unknown && reset) throw new Error('session has both unknown-request and reset-required markers; inspect Appium session ownership before continuing')
  if (reset && previous) {
    await discardKnownSession(client, previous.sessionId)
    previous = null
  }
  if (previous) {
    if (unknown?.sessionId === previous.sessionId) {
      const remainingMs = 35000 - (Date.now() - unknown.at)
      if (remainingMs > 0) throw new Error(`previous session command outcome is unknown; wait ${Math.ceil(remainingMs / 1000)} seconds before read-only revalidation`)
      const health = await probeSessionHealth(client, null)
      if (!health.appium || !health.wda || !health.tunnel) {
        throw new Error('previous session command outcome is unknown and transport health is degraded; no session command was sent')
      }
    }
    try {
      await validate(previous.sessionId)
      if (unknown?.sessionId === previous.sessionId) await rm(unknownRequestPath(), {force: true})
      await rm(pendingPath, {force: true})
      return {sessionId: previous.sessionId, reused: true}
    } catch (error) {
      if (error.code !== 'invalid session id' && !isProxyTimeout(error)) throw error
      if (error.transportPending) throw error
      if (error.code === 'invalid session id') {
        await rm(config.sessionFile, {force: true})
        await rm(unknownRequestPath(), {force: true})
        await rm(pendingPath, {force: true})
      } else {
        await discardKnownSession(client, previous.sessionId)
      }
    }
  }
  try {
    await writeFile(pendingPath, JSON.stringify({at: new Date().toISOString(), udid: config.udid}), {flag: 'wx', mode: 0o600})
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('previous session creation has an unknown outcome; inspect Appium before clearing ' + pendingPath)
    throw error
  }
  let created
  try {
    created = await client.createSession()
  } catch (error) {
    // POST failure does not prove that the server created no session.
    throw error
  }
  try {
    await validate(created.sessionId)
  } catch (error) {
    if (error.transportPending) throw error
    let cleanupConfirmed = false
    try {
      await client.deleteSession(created.sessionId)
      cleanupConfirmed = true
    } catch (cleanupError) {
      cleanupConfirmed = cleanupError.code === 'invalid session id'
    }
    if (cleanupConfirmed) {
      await rm(pendingPath, {force: true})
      await rm(unknownRequestPath(), {force: true})
      await rm(resetRequiredPath(), {force: true})
    }
    throw error
  }
  await saveSession(created.sessionId)
  await rm(pendingPath, {force: true})
  return {sessionId: created.sessionId, reused: false}
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const client = createAppiumClient({sessionFile: config.sessionFile})
  if (command === 'doctor') return print(await doctor(client))
  if (command === 'wda-health') {
    return print(await withDeviceLock(async () => {
      const state = await loadSession()
      return probeSessionHealth(client, state?.sessionId, {sessionFile: config.sessionFile})
    }))
  }
  if (command === 'session') {
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client)
      return {ok: true, ...session, udid: config.udid}
    }))
  }
  if (command === 'recover') {
    const bundleFlag = args.indexOf('--bundle-id')
    const bundleId = (bundleFlag >= 0 && args[bundleFlag + 1]) || process.env.IOS_APP_BUNDLE_ID
    if (!bundleId) throw new Error('recover requires --bundle-id or IOS_APP_BUNDLE_ID')
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client)
      return recoverWithKnownProxyReset(client, session.sessionId, bundleId)
    }))
  }
  if (command === 'element') {
    const [method, ...options] = args
    const option = (name) => {
      const index = options.indexOf(name)
      return index >= 0 ? options[index + 1] : null
    }
    const bundleId = option('--bundle-id')
    const using = option('--using')
    const selector = option('--selector')
    if (!bundleId || !using || !selector) throw new Error('element requires --bundle-id, --using and --selector')
    if (!['read', 'click', 'set-value'].includes(method)) throw new Error('element action must be read, click or set-value')
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client)
      return elementAction(client, session.sessionId, method, bundleId, using, selector)
    }))
  }
  if (command === 'dianping-search') {
    const option = (name) => {
      const index = args.indexOf(name)
      return index >= 0 ? args[index + 1] : null
    }
    const query = option('--query')
    const screenshotPath = option('--screenshot-output')
    const sourcePath = option('--source-output')
    const extractionPath = option('--extract-output')
    const maxPages = option('--max-pages') === null ? 3 : Number(option('--max-pages'))
    const options = queryOptions({query, screenshotPath, sourcePath, extractionPath, maxPages})
    await preflightArtifacts(options)
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client)
      return dianpingSearch(
        client,
        session.sessionId,
        query,
        screenshotPath ? path.resolve(screenshotPath) : null,
        sourcePath ? path.resolve(sourcePath) : null,
        extractionPath ? path.resolve(extractionPath) : null,
        maxPages,
      )
    }))
  }
  if (command === 'dianping-detail') {
    const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
    const from = option('--from')
    const candidateId = option('--candidate')
    const output = option('--extract-output')
    if (!from || !candidateId || !output) throw new Error('dianping-detail requires --from, --candidate and --extract-output')
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client)
      return runDianpingDetail(client, session.sessionId, {from: path.resolve(from), candidateId, output: path.resolve(output), current: args.includes('--current')}, {
        requireForeground, sourceText: collectSourceText, ocr: runVisionOcr,
      })
    }))
  }
  if (command === 'xiaohongshu-search') {
    const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
    const query = option('--query')
    const output = option('--extract-output')
    const maxPages = option('--max-pages') === null ? 3 : Number(option('--max-pages'))
    if (!output) throw new Error('xiaohongshu-search requires --extract-output')
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client)
      return runXiaohongshuQuery(client, session.sessionId, {query, output: path.resolve(output), maxPages}, {
        recover, requireForeground, sourceText: collectSourceText, ocr: runVisionOcr,
      })
    }))
  }
  if (command === 'dianping-share') {
    const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
    const from = option('--from-detail')
    const output = option('--extract-output')
    if (!from || !output) throw new Error('dianping-share requires --from-detail and --extract-output')
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client, {lightweight: true})
      return runDianpingShare(client, session.sessionId, {from: path.resolve(from), output: path.resolve(output)}, {
        requireForeground, sourceText: collectSourceText, ocr: runVisionOcr,
      })
    }))
  }
  if (command === 'source' || command === 'screenshot') {
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client)
      if (command === 'source') {
        const page = await client.source(session.sessionId)
        const outputFlag = args.indexOf('--output')
        if (outputFlag < 0) {
          return {sessionId: session.sessionId, foregroundBundle: extractForegroundBundle(page), lockScreen: isLockScreenSource(page), credentialRequired: requiresCredential(page), bytes: Buffer.byteLength(page)}
        }
        const outputPath = args[outputFlag + 1]
        if (!outputPath) throw new Error('source --output requires a path')
        await publishArtifact(path.resolve(outputPath), page)
        return {sessionId: session.sessionId, source: outputPath, bytes: Buffer.byteLength(page)}
      }
      const page = await client.source(session.sessionId)
      if (isLockScreenSource(page)) throw new Error('screenshot withheld while the device is on the lock screen')
      const result = await client.screenshot(session.sessionId)
      const outputFlag = args.indexOf('--output')
      const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : null
      if (!outputPath) throw new Error('screenshot requires --output <path>')
      await publishArtifact(path.resolve(outputPath), Buffer.from(result, 'base64'))
      return {sessionId: session.sessionId, screenshot: outputPath}
    }))
  }
  if (command === 'close') {
    return print(await withDeviceLock(async () => {
      const state = await loadSession()
      if (!state) return {ok: true, closed: false}
      const unknown = await loadUnknownRequest()
      if (unknown) throw new Error('session has an unknown in-flight command; run wda-health and revalidate before closing')
      try { await client.deleteSession(state.sessionId) }
      catch (error) {
        if (error.code !== 'invalid session id') throw error
        await rm(config.sessionFile, {force: true})
        await rm(unknownRequestPath(), {force: true})
        await rm(resetRequiredPath(), {force: true})
        return {ok: true, closed: false, sessionExpired: true}
      }
      await rm(config.sessionFile, {force: true})
      await rm(unknownRequestPath(), {force: true})
      await rm(resetRequiredPath(), {force: true})
      return {ok: true, closed: true}
    }))
  }
  throw new Error('usage: iphone-app-ops.mjs doctor | wda-health | session | recover --bundle-id <id> | element <read|click|set-value> --bundle-id <id> --using <accessibility-id|predicate|class-chain> --selector <value> | dianping-search --query <text> --extract-output <path> [--screenshot-output <path>] [--source-output <path>] [--max-pages 1..5] | dianping-detail --from <search.json> --candidate <id> --extract-output <new.json> | dianping-share --from-detail <detail.json> --extract-output <new.json> | xiaohongshu-search --query <text> --extract-output <new.json> [--max-pages 1..5] | source | screenshot --output <path> | close')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    print({ok: false, status: isProxyTimeout(error) ? 'protocol-timeout' : 'command-failed',
      phase: error.phase || null, outcome: error.outcome || 'unknown', retryable: false, error: error.message})
    process.exitCode = 1
  })
}

