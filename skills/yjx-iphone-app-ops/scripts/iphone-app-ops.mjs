#!/usr/bin/env node

import {execFileSync} from 'node:child_process'
import {mkdir, open, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const config = {
  appiumUrl: process.env.APPIUM_URL || 'http://127.0.0.1:4723',
  udid: process.env.IOS_DEVICE_UDID || '00008020-000B25990204002E',
  deviceName: process.env.IOS_DEVICE_NAME || 'iPhone XS Max',
  platformVersion: process.env.IOS_PLATFORM_VERSION || '18.7',
  wdaBundleId: process.env.IOS_WDA_BUNDLE_ID || 'com.youjiaxing.familyhealth.WebDriverAgentRunner',
  sessionFile: process.env.IPHONE_OPS_SESSION_FILE || path.join(os.tmpdir(), `yjx-iphone-app-ops-${process.env.IOS_DEVICE_UDID || 'xsmax'}.json`),
}

const timeoutMs = Number(process.env.IPHONE_OPS_TIMEOUT_MS || 20000)

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

export function createAppiumClient({baseUrl = config.appiumUrl, fetchImpl = fetch, requestTimeoutMs = timeoutMs} = {}) {
  const endpoint = new URL(baseUrl)
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname)) {
    throw new Error('Appium must be bound to a loopback address')
  }

  async function request(endpoint, options = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || requestTimeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl}${endpoint}`, {...options, signal: controller.signal})
      const body = await response.json()
      if (!response.ok || body.value?.error) throw new Error(body.value?.message || `Appium HTTP ${response.status}`)
      return body.value
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    status: () => request('/status', {timeoutMs: 5000}),
    createSession: () => request('/session', {
      method: 'POST',
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
        'appium:newCommandTimeout': 600,
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
    return execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n')
    throw new Error(`${command} failed: ${detail}`)
  }
}

function sessionLockPath() {
  return `${config.sessionFile}.lock`
}

export async function withFileLock(lockPath, action) {
  await mkdir(path.dirname(lockPath), {recursive: true})
  let handle
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({pid: process.pid, at: Date.now()}))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch {}
      let alive = true
      if (owner?.pid && Date.now() - Number(owner.at || 0) < 300000) {
        try { process.kill(owner.pid, 0) } catch (probeError) { alive = probeError.code === 'EPERM' }
      } else {
        try { alive = Date.now() - (await stat(lockPath)).mtimeMs < 30000 } catch { alive = false }
      }
      if (!alive) {
        await rm(lockPath, {force: true})
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  if (!handle) throw new Error('another iPhone operation is still active')
  try {
    return await action()
  } finally {
    await handle.close()
    await rm(lockPath, {force: true})
  }
}

async function withDeviceLock(action) {
  return withFileLock(sessionLockPath(), action)
}

async function saveSession(sessionId) {
  const temporaryPath = `${config.sessionFile}.${process.pid}.tmp`
  await writeFile(temporaryPath, JSON.stringify({sessionId, udid: config.udid, createdAt: new Date().toISOString()}), {mode: 0o600})
  await rename(temporaryPath, config.sessionFile)
}

async function loadSession() {
  try {
    const state = JSON.parse(await readFile(config.sessionFile, 'utf8'))
    if (state.udid === config.udid && typeof state.sessionId === 'string') return state
  } catch {}
  return null
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
    const tunnel = await fetch(`http://127.0.0.1:42314/remotexpc/tunnels/${config.udid}?waitMs=1000`)
    const body = await tunnel.json()
    tunnelReady = body.status === 'OK'
  } catch {}
  return {ok: Boolean(device && tunnel && tunnelReady && wdaInstalled && appiumLoopbackOnly), appium: {ready: true, loopbackOnly: appiumLoopbackOnly, version: appium.build?.version}, device, wdaInstalled, deviceAppsError, tunnel, tunnelReady, udid: config.udid}
}

export async function recover(client, sessionId, bundleId) {
  let page = await client.source(sessionId)
  const steps = [{name: 'read-source', ok: true, lockScreen: isLockScreenSource(page)}]
  if (requiresCredential(page)) {
    return {ok: false, status: 'blocked-needs-user', reason: 'credential-required', sessionId, bundleId, steps}
  }
  await client.execute(sessionId, 'mobile: pressButton', [{name: 'home'}])
  steps.push({name: 'wake-home', ok: true})
  try {
    await client.execute(sessionId, 'mobile: unlock')
    steps.push({name: 'wda-unlock-attempt', ok: true})
  } catch (error) {
    steps.push({name: 'wda-unlock-attempt', ok: false, outcome: 'unknown', error: error.message.slice(0, 300)})
  }
  page = await client.source(sessionId)
  if (requiresCredential(page)) {
    return {ok: false, status: 'blocked-needs-user', reason: 'credential-required', sessionId, bundleId, steps}
  }
  if (isLockScreenSource(page)) {
    try {
      await client.execute(sessionId, 'mobile: dragFromToForDuration', [{duration: 0.6, fromX: 207, fromY: 850, toX: 207, toY: 120}])
      steps.push({name: 'swipe-lock-screen', ok: true})
    } catch (error) {
      steps.push({name: 'swipe-lock-screen', ok: false, outcome: 'unknown', error: error.message.slice(0, 300)})
    }
    page = await client.source(sessionId)
    if (requiresCredential(page)) {
      return {ok: false, status: 'blocked-needs-user', reason: 'credential-required', sessionId, bundleId, steps}
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

async function waitForForeground(client, sessionId, bundleId, timeout = 8000) {
  const deadline = Date.now() + timeout
  let state = {page: '', activeAppInfo: null, appState: null, foregroundBundle: null}
  while (Date.now() < deadline) {
    state.page = await client.source(sessionId)
    state.activeAppInfo = await client.execute(sessionId, 'mobile: activeAppInfo')
    state.appState = await client.execute(sessionId, 'mobile: queryAppState', [{bundleId}])
    state.foregroundBundle = extractForegroundBundle(state.page)
    if (state.foregroundBundle === bundleId && state.activeAppInfo?.bundleId === bundleId && state.appState === 4) return state
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return state
}

async function requireForeground(client, sessionId, bundleId) {
  const page = await client.source(sessionId)
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

function appViewport(source) {
  const application = source.match(/<XCUIElementTypeApplication\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/)
  return application ? {width: Number(application[1]), height: Number(application[2])} : {width: 414, height: 896}
}

async function findElementWithRetry(client, sessionId, using, selector, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const element = await client.findElement(sessionId, using, selector).catch(() => null)
    if (element) return element
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}

export async function dianpingSearch(client, sessionId, query, screenshotPath, sourcePath) {
  const bundleId = 'com.dianping.dpscope'
  if (typeof query !== 'string' || !query.trim() || Array.from(query).length > 120) {
    throw new Error('dianping-search requires a non-empty query up to 120 characters')
  }
  if (!screenshotPath) throw new Error('dianping-search requires --screenshot-output <path>')

  const recovered = await recover(client, sessionId, bundleId)
  if (!recovered.ok) return {ok: false, status: recovered.status || 'app-recovery-failed', recovered}
  let page = await client.source(sessionId)
  if (isDianpingConsentSource(page)) return {ok: false, status: 'needs-user-consent'}
  if (isDianpingVerificationSource(page)) return {ok: false, status: 'blocked-verification'}

  let homeSearchButton = await findElementWithRetry(client, sessionId, 'accessibility id', '搜索按钮', 1500)
  for (let attempt = 0; !homeSearchButton && attempt < 3; attempt++) {
    await client.tap(sessionId, 64, 72)
    await new Promise((resolve) => setTimeout(resolve, 800))
    homeSearchButton = await findElementWithRetry(client, sessionId, 'accessibility id', '搜索按钮', 1500)
  }
  if (!homeSearchButton) return {ok: false, status: 'home-search-unavailable'}
  await client.clickElement(sessionId, elementId(homeSearchButton))

  // The result page's clear icon is outside the native accessibility tree on this device.
  // A relative tap at its stable position opens the accessible keyword editor.
  let editor = await findElementWithRetry(client, sessionId, 'accessibility id', 'search_keyword_edit', 2000)
  if (!editor) editor = await findElementWithRetry(client, sessionId, '-ios predicate string', "type == 'XCUIElementTypeTextField' AND visible == 1", 2000)
  if (!editor) {
    const dimensions = appViewport(page)
    const width = dimensions.width || 414
    const height = dimensions.height || 896
    await client.tap(sessionId, Math.round(width * 0.814), Math.round(height * 0.081))
    page = await client.source(sessionId)
    if (isDianpingConsentSource(page)) return {ok: false, status: 'needs-user-consent'}
    if (isDianpingVerificationSource(page)) return {ok: false, status: 'blocked-verification'}
    if (extractForegroundBundle(page) !== bundleId) return {ok: false, status: 'foreground-lost'}
    editor = await findElementWithRetry(client, sessionId, 'accessibility id', 'search_keyword_edit', 3000)
    if (!editor) editor = await findElementWithRetry(client, sessionId, '-ios predicate string', "type == 'XCUIElementTypeTextField' AND visible == 1", 3000)
  }
  if (!editor) return {ok: false, status: 'search-editor-unavailable'}
  const editorId = elementId(editor)
  await client.clearElement(sessionId, editorId)
  await client.setElementValue(sessionId, editorId, query.trim())
  const submit = await client.findElement(sessionId, 'accessibility id', 'Search').catch(() => null)
  if (!submit) return {ok: false, status: 'search-submit-unavailable'}
  await client.clickElement(sessionId, elementId(submit))
  await new Promise((resolve) => setTimeout(resolve, 1800))
  page = await client.source(sessionId)
  if (isDianpingConsentSource(page)) return {ok: false, status: 'needs-user-consent'}
  if (isDianpingVerificationSource(page)) return {ok: false, status: 'blocked-verification'}
  if (extractForegroundBundle(page) !== bundleId) return {ok: false, status: 'foreground-lost'}

  const image = await client.screenshot(sessionId)
  await writeFile(screenshotPath, Buffer.from(image, 'base64'), {mode: 0o600})
  if (sourcePath) await writeFile(sourcePath, page, {mode: 0o600})
  return {
    ok: true,
    status: 'screenshot-captured',
    query: query.trim(),
    screenshot: screenshotPath,
    source: sourcePath || null,
    sourceBytes: Buffer.byteLength(page),
    visualReviewRequired: true,
  }
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function ensureSession(client) {
  const previous = await loadSession()
  if (previous) {
    try {
      await client.source(previous.sessionId)
      return {sessionId: previous.sessionId, reused: true}
    } catch {
      try { await client.deleteSession(previous.sessionId) } catch {}
      await rm(config.sessionFile, {force: true})
    }
  }
  const created = await client.createSession()
  try {
    await client.source(created.sessionId)
  } catch (error) {
    try { await client.deleteSession(created.sessionId) } catch {}
    throw error
  }
  await saveSession(created.sessionId)
  return {sessionId: created.sessionId, reused: false}
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const client = createAppiumClient()
  if (command === 'doctor') return print(await doctor(client))
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
      return recover(client, session.sessionId, bundleId)
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
    if (!query || !screenshotPath) throw new Error('dianping-search requires --query <text> and --screenshot-output <path>')
    return print(await withDeviceLock(async () => {
      const session = await ensureSession(client)
      return dianpingSearch(client, session.sessionId, query, path.resolve(screenshotPath), sourcePath ? path.resolve(sourcePath) : null)
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
        await writeFile(outputPath, page, {mode: 0o600})
        return {sessionId: session.sessionId, source: outputPath, bytes: Buffer.byteLength(page)}
      }
      const page = await client.source(session.sessionId)
      if (isLockScreenSource(page)) throw new Error('screenshot withheld while the device is on the lock screen')
      const result = await client.screenshot(session.sessionId)
      const outputFlag = args.indexOf('--output')
      const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : null
      if (!outputPath) throw new Error('screenshot requires --output <path>')
      await writeFile(outputPath, Buffer.from(result, 'base64'), {mode: 0o600})
      return {sessionId: session.sessionId, screenshot: outputPath}
    }))
  }
  if (command === 'close') {
    return print(await withDeviceLock(async () => {
      const state = await loadSession()
      if (!state) return {ok: true, closed: false}
      try { await client.deleteSession(state.sessionId) } catch {}
      await rm(config.sessionFile, {force: true})
      return {ok: true, closed: true}
    }))
  }
  throw new Error('usage: iphone-app-ops.mjs doctor | session | recover --bundle-id <id> | element <read|click|set-value> --bundle-id <id> --using <accessibility-id|predicate|class-chain> --selector <value> | dianping-search --query <text> --screenshot-output <path> [--source-output <path>] | source | screenshot --output <path> | close')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    print({ok: false, error: error.message})
    process.exitCode = 1
  })
}

