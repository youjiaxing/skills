import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {classifyWdaHealth, collectSourceText, createAppiumClient, dianpingSearch, elementAction, extractForegroundBundle, isDianpingConsentSource, isDianpingVerificationSource, isLockScreenSource, parseDeviceLine, probeSessionHealth, recover, requiresCredential, waitForForeground, withFileLock} from '../scripts/iphone-app-ops.mjs'

test('health classification separates Appium, tunnel, WDA, expired session, lockscreen and AX failures', () => {
  assert.equal(classifyWdaHealth({appium: false}), 'appium-unavailable')
  assert.equal(classifyWdaHealth({appium: true, tunnel: false, wda: false}), 'wda-and-remote-xpc-unavailable')
  assert.equal(classifyWdaHealth({appium: true, tunnel: true, wda: false}), 'wda-endpoint-unavailable')
  assert.equal(classifyWdaHealth({appium: true, tunnel: false, wda: true, session: true, source: true}), 'session-source-readable')
  assert.equal(classifyWdaHealth({appium: true, tunnel: true, wda: true, session: false}), 'session-missing-or-expired')
  assert.equal(classifyWdaHealth({appium: true, tunnel: true, wda: true, session: true, source: true, locked: true}), 'lock-screen-readable')
  assert.equal(classifyWdaHealth({appium: true, tunnel: true, wda: true, session: true, active: true}), 'wda-reachable-ax-snapshot-unresponsive')
  assert.equal(classifyWdaHealth({appium: true, tunnel: true, wda: true, session: true, commandUnknown: true}), 'appium-command-outcome-unknown')
})

test('health probe reports readable lock screen and keeps WDA/tunnel evidence separate', async () => {
  let activeCalls = 0
  const client = {status: async () => ({ready: true}), wdaStatus: async () => ({ready: true, sessionId: 'wda-1'}),
    source: async () => '<XCUIElementTypeApplication bundleId="com.apple.springboard"><XCUIElementTypeWindow name="SBCoverSheetWindow"/></XCUIElementTypeApplication>',
    execute: async () => { activeCalls++; return null }}
  const fetchImpl = async (url) => ({ok: true, json: async () => url.includes('42314') ? {status: 'OK'} : {value: {ready: true}}})
  const result = await probeSessionHealth(client, 'appium-session', {fetchImpl, udid: 'device', sessionFile: path.join(os.tmpdir(), 'missing-iphone-state.json')})
  assert.equal(result.status, 'lock-screen-readable')
  assert.equal(result.tunnel, true)
  assert.equal(result.wda, true)
  assert.equal(activeCalls, 0)
})

test('health probe reports a first command timeout without a pre-existing marker', async () => {
  const client = {
    status: async () => ({ready: true}),
    wdaStatus: async () => ({ready: true}),
    source: async () => { throw Object.assign(new Error('deadline'), {code: 'ETIMEDOUT', outcome: 'unknown', transportPending: true}) },
  }
  const fetchImpl = async () => ({ok: true, json: async () => ({status: 'OK'})})
  const result = await probeSessionHealth(client, 'session', {
    fetchImpl,
    udid: 'device',
    sessionFile: path.join(os.tmpdir(), 'missing-first-timeout-state.json'),
  })
  assert.equal(result.status, 'appium-command-outcome-unknown')
  assert.equal(result.checks.session.command, 'source')
})

test('health probe reports an activeAppInfo timeout after a completed source error', async () => {
  const client = {
    status: async () => ({ready: true}),
    wdaStatus: async () => ({ready: true}),
    source: async () => { throw Object.assign(new Error('webdriver error'), {code: 'protocol-error', transportPending: false}) },
    execute: async () => { throw Object.assign(new Error('deadline'), {code: 'ETIMEDOUT', transportPending: true}) },
  }
  const fetchImpl = async () => ({ok: true, json: async () => ({status: 'OK'})})
  const result = await probeSessionHealth(client, 'session', {
    fetchImpl,
    udid: 'device',
    sessionFile: path.join(os.tmpdir(), 'missing-active-timeout-state.json'),
  })
  assert.equal(result.status, 'appium-command-outcome-unknown')
  assert.equal(result.checks.session.command, 'activeAppInfo')
})

test('health probe avoids overlapping session commands after a client timeout', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-health-unknown-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const sessionFile = path.join(directory, 'state.json')
  await writeFile(sessionFile + '.unknown', JSON.stringify({sessionId: 'session', at: Date.now(), command: 'source'}))
  let activeCalls = 0
  const client = {status: async () => ({ready: true}), wdaStatus: async () => ({ready: true}),
    source: async () => { throw Object.assign(new Error('client deadline'), {code: 'ETIMEDOUT', outcome: 'unknown', transportPending: true}) },
    execute: async () => { activeCalls++; return {} }}
  const fetchImpl = async () => ({ok: true, json: async () => ({status: 'OK'})})
  const result = await probeSessionHealth(client, 'session', {fetchImpl, sessionFile})
  assert.equal(result.status, 'appium-command-outcome-unknown')
  assert.match(result.checks.session.skipped, /avoid overlapping/)
  assert.equal(activeCalls, 0)
})

test('unknown request marker survives CLI exit and blocks overlapping session reads', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-unknown-request-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  await writeFile(stateFile, JSON.stringify({sessionId: 'session-1', udid: '00008020-000B25990204002E'}))
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.closeAllConnections())
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 25, sessionFile: stateFile})
  await assert.rejects(client.source('session-1'), (error) => error.code === 'ETIMEDOUT' && error.outcome === 'unknown')
  const options = {env: {...process.env, APPIUM_URL: `http://127.0.0.1:${server.address().port}`, IPHONE_OPS_SESSION_FILE: stateFile}}
  const script = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).pathname
  const {stdout} = await promisify(execFile)(process.execPath, [script, 'wda-health'], options)
  const health = JSON.parse(stdout)
  assert.equal(health.checks.session.outcome, 'unknown')
  assert.equal(health.checks.activeAppInfo, undefined)
  assert.ok(JSON.parse(await readFile(stateFile + '.unknown', 'utf8')).sessionId === 'session-1')
})

test('client timeout treats GET failures as unknown because Appium may still be executing them', async (t) => {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.closeAllConnections())
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 30})
  await assert.rejects(client.source('session'), (error) => error.code === 'ETIMEDOUT' && error.outcome === 'unknown')
})

test('client timeout on DELETE preserves an unknown close outcome', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-delete-unknown-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.closeAllConnections())
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 30, sessionFile: stateFile})
  await assert.rejects(client.deleteSession('session'), (error) => error.code === 'ETIMEDOUT' && error.outcome === 'unknown')
  assert.equal(JSON.parse(await readFile(stateFile + '.unknown', 'utf8')).sessionId, 'session')
})

test('received WebDriver errors do not create an in-flight marker', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-response-error-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  const server = createServer((_req, res) => {
    res.writeHead(404, {'content-type': 'application/json'})
    res.end(JSON.stringify({value: {error: 'invalid session id', message: 'session expired'}}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 150, sessionFile: stateFile})
  await assert.rejects(client.source('stale'), (error) => error.code === 'invalid session id' && error.transportPending === false)
  await assert.rejects(readFile(stateFile + '.unknown'), {code: 'ENOENT'})
})

test('received WDA proxy timeout on DELETE requires session replacement', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-delete-reset-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  const server = createServer((_req, res) => {
    res.writeHead(500, {'content-type': 'application/json'})
    res.end(JSON.stringify({value: {error: 'unknown error', message: 'Could not proxy command to the remote server'}}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 150, sessionFile: stateFile})
  await assert.rejects(client.deleteSession('session'), /Could not proxy command/)
  assert.equal(JSON.parse(await readFile(stateFile + '.reset-required', 'utf8')).sessionId, 'session')
  await assert.rejects(readFile(stateFile + '.unknown'), {code: 'ENOENT'})
})

test('source waits through a 30-second-style proxy delay when configured deadline is longer', async (t) => {
  const server = createServer((_req, res) => setTimeout(() => {
    res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({value: 'page'}))
  }, 50))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 150})
  assert.equal(await client.source('session'), 'page')
})

test('session capability disables the idle expiry for unattended use', async (t) => {
  let capabilities
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    capabilities = JSON.parse(body).capabilities.alwaysMatch
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({value: {sessionId: 'new-session', capabilities}}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 150})
  await client.createSession()
  assert.equal(capabilities['appium:newCommandTimeout'], 0)
})

test('expired Appium session is replaced once and the new WDA session is validated', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-session-expiry-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  let creates = 0
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify({value})) }
    if (req.method === 'POST' && req.url === '/session') {
      creates++
      for await (const _ of req) {}
      return send(200, {sessionId: 'renewed', capabilities: {}})
    }
    if (req.url === '/session/stale/source') return send(404, {error: 'invalid session id', message: 'session expired'})
    if (req.url === '/session/renewed/source') return send(200, '<XCUIElementTypeApplication bundleId="com.apple.springboard"/>')
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.closeAllConnections())
  t.after(() => server.close())
  const stateFile = path.join(directory, 'state.json')
  await writeFile(stateFile, JSON.stringify({sessionId: 'stale', udid: '00008020-000B25990204002E'}))
  const options = {env: {...process.env, APPIUM_URL: `http://127.0.0.1:${server.address().port}`, IPHONE_OPS_SESSION_FILE: stateFile}}
  const script = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).pathname
  const {stdout} = await promisify(execFile)(process.execPath, [script, 'session'], options)
  assert.equal(JSON.parse(stdout).reused, false)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).sessionId, 'renewed')
  assert.equal(creates, 1)
})

test('confirmed invalid session cleanup removes the creation marker', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-creating-invalid-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  let creates = 0
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify({value})) }
    if (req.method === 'POST' && req.url === '/session') {
      creates++
      for await (const _ of req) {}
      return send(200, {sessionId: creates === 1 ? 'stale' : 'renewed', capabilities: {}})
    }
    if (req.method === 'GET' && req.url === '/session/stale/source') return send(404, {error: 'invalid session id', message: 'session expired'})
    if (req.method === 'DELETE' && req.url === '/session/stale') return send(404, {error: 'invalid session id', message: 'session already closed'})
    if (req.method === 'GET' && req.url === '/session/renewed/source') return send(200, '<XCUIElementTypeApplication bundleId="com.apple.springboard"/>')
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.closeAllConnections())
  t.after(() => server.close())
  const options = {env: {...process.env, APPIUM_URL: `http://127.0.0.1:${server.address().port}`, IPHONE_OPS_SESSION_FILE: stateFile}}
  const script = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).pathname
  const first = await promisify(execFile)(process.execPath, [script, 'session'], options).then(() => null, (error) => error)
  assert.match(JSON.parse(first.stdout).error, /session expired/)
  await assert.rejects(readFile(stateFile + '.creating'), {code: 'ENOENT'})
  const {stdout} = await promisify(execFile)(process.execPath, [script, 'session'], options)
  assert.equal(JSON.parse(stdout).sessionId, 'renewed')
  assert.equal(creates, 2)
})

test('completed proxy timeout marker replaces only its matching cached session', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-reset-required-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  const requests = []
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`)
    const send = (status, value) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify({value})) }
    if (req.method === 'DELETE' && req.url === '/session/stale') return send(200, null)
    if (req.method === 'POST' && req.url === '/session') {
      for await (const _ of req) {}
      return send(200, {sessionId: 'renewed', capabilities: {}})
    }
    if (req.method === 'GET' && req.url === '/session/renewed/source') return send(200, '<XCUIElementTypeApplication bundleId="com.apple.springboard"/>')
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.closeAllConnections())
  t.after(() => server.close())
  await writeFile(stateFile, JSON.stringify({sessionId: 'stale', udid: '00008020-000B25990204002E'}))
  await writeFile(stateFile + '.reset-required', JSON.stringify({sessionId: 'stale', command: 'source'}))
  const options = {env: {...process.env, APPIUM_URL: `http://127.0.0.1:${server.address().port}`, IPHONE_OPS_SESSION_FILE: stateFile}}
  const script = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).pathname
  const {stdout} = await promisify(execFile)(process.execPath, [script, 'session'], options)
  assert.equal(JSON.parse(stdout).sessionId, 'renewed')
  assert.equal(JSON.parse(stdout).reused, false)
  assert.deepEqual(requests, ['DELETE /session/stale', 'POST /session', 'GET /session/renewed/source'])
  await assert.rejects(readFile(stateFile + '.reset-required'), {code: 'ENOENT'})
})

test('a live unknown-command marker blocks a new CLI session request', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-unknown-cooldown-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  await writeFile(stateFile, JSON.stringify({sessionId: 'session-1', udid: '00008020-000B25990204002E'}))
  await writeFile(stateFile + '.unknown', JSON.stringify({sessionId: 'session-1', at: Date.now(), command: 'source'}))
  let requests = 0
  const server = createServer((_req, res) => { requests++; res.writeHead(500).end() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const options = {env: {...process.env, APPIUM_URL: `http://127.0.0.1:${server.address().port}`, IPHONE_OPS_SESSION_FILE: stateFile}}
  const script = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).pathname
  const error = await promisify(execFile)(process.execPath, [script, 'session'], options).then(() => null, (caught) => caught)
  assert.match(JSON.parse(error.stdout).error, /outcome is unknown/)
  assert.equal(requests, 0)
  const closeError = await promisify(execFile)(process.execPath, [script, 'close'], options).then(() => null, (caught) => caught)
  assert.match(JSON.parse(closeError.stdout).error, /unknown in-flight command/)
  assert.equal(requests, 0)
})

test('a valid cached session clears an orphaned creation marker', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-creating-recovery-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  await writeFile(stateFile, JSON.stringify({sessionId: 'live-session', udid: '00008020-000B25990204002E'}))
  await writeFile(stateFile + '.creating', JSON.stringify({at: new Date().toISOString(), udid: '00008020-000B25990204002E'}))
  const server = createServer((req, res) => {
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({value: '<XCUIElementTypeApplication bundleId="com.apple.springboard"/>'}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const options = {env: {...process.env, APPIUM_URL: `http://127.0.0.1:${server.address().port}`, IPHONE_OPS_SESSION_FILE: stateFile}}
  const script = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).pathname
  const {stdout} = await promisify(execFile)(process.execPath, [script, 'session'], options)
  assert.equal(JSON.parse(stdout).reused, true)
  await assert.rejects(readFile(stateFile + '.creating'), {code: 'ENOENT'})
})

test('failed close response preserves the cached Appium session', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-close-state-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const stateFile = path.join(directory, 'state.json')
  await writeFile(stateFile, JSON.stringify({sessionId: 'live-session', udid: '00008020-000B25990204002E'}))
  const server = createServer((_req, res) => {
    res.writeHead(500, {'content-type': 'application/json'})
    res.end(JSON.stringify({value: {error: 'unknown error', message: 'delete failed'}}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const options = {env: {...process.env, APPIUM_URL: `http://127.0.0.1:${server.address().port}`, IPHONE_OPS_SESSION_FILE: stateFile}}
  const script = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).pathname
  const error = await promisify(execFile)(process.execPath, [script, 'close'], options).then(() => null, (caught) => caught)
  assert.match(JSON.parse(error.stdout).error, /delete failed/)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).sessionId, 'live-session')
})

test('lock screen detection uses SpringBoard evidence', () => {
  assert.equal(isLockScreenSource('<Window name="SBCoverSheetWindow"/>'), true)
  assert.equal(isLockScreenSource('<XCUIElementTypeApplication bundleId="com.apple.springboard"><XCUIElementTypeWindow name="HomeScreen"/></XCUIElementTypeApplication>'), false)
  assert.equal(isLockScreenSource('<XCUIElementTypeApplication bundleId="com.xingin.discover"/>'), false)
  assert.equal(requiresCredential('<XCUIElementTypeApplication bundleId="com.apple.springboard"><XCUIElementTypeWindow name="SBCoverSheetWindow"><XCUIElementTypeSecureTextField/></XCUIElementTypeWindow></XCUIElementTypeApplication>'), true)
})

test('foreground bundle comes from the application root', () => {
  const source = '<XCUIElementTypeApplication bundleId="com.apple.springboard"><XCUIElementTypeOther bundleId="com.xingin.discover"/></XCUIElementTypeApplication>'
  assert.equal(extractForegroundBundle(source), 'com.apple.springboard')
  assert.equal(extractForegroundBundle('<XCUIElementTypeApplication bundleId="com.xingin.discover"/>'), 'com.xingin.discover')
})

test('recovery wakes and swipes only when needed, launches and verifies foreground', async (t) => {
  const commands = []
  let sourceReads = 0
  const server = createServer(async (req, res) => {
    const send = (value) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({value})) }
    if (req.url.endsWith('/source')) {
      sourceReads++
      return send(sourceReads < 5
        ? '<XCUIElementTypeApplication bundleId="com.apple.springboard"><XCUIElementTypeWindow name="SBCoverSheetWindow"/></XCUIElementTypeApplication>'
        : '<XCUIElementTypeApplication bundleId="com.xingin.discover"/>')
    }
    if (req.url.endsWith('/execute/sync')) {
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      commands.push(request.script)
      if (request.script === 'mobile: unlock') {
        res.writeHead(500, {'content-type': 'application/json'})
        return res.end(JSON.stringify({value: {error: 'unknown error', message: 'unlock state notification timed out'}}))
      }
      if (request.script === 'mobile: activeAppInfo') return send({bundleId: 'com.xingin.discover'})
      if (request.script === 'mobile: queryAppState') return send(4)
      return send(null)
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`})

  const result = await recover(client, 'session-1', 'com.xingin.discover')

  assert.equal(result.ok, true)
  assert.equal(result.foregroundBundle, 'com.xingin.discover')
  assert.equal(result.steps.find((step) => step.name === 'swipe-lock-screen')?.ok, true)
  assert.deepEqual(commands.slice(0, 5), [
    'mobile: pressButton', 'mobile: dragFromToForDuration', 'mobile: launchApp',
    'mobile: activeAppInfo', 'mobile: queryAppState',
  ])
  assert.equal(commands.length, 5)
})

test('foreground polling stops after its budget without starting more WDA commands', async () => {
  const commands = []
  const client = {
    source: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return '<XCUIElementTypeApplication bundleId="com.apple.springboard"/>'
    },
    execute: async (_sessionId, script) => { commands.push(script); return null },
  }
  const result = await waitForForeground(client, 'session', 'com.xingin.discover', 5)
  assert.equal(result.foregroundBundle, 'com.apple.springboard')
  assert.deepEqual(commands, [])
})

test('Appium protocol errors retain their useful message', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(500, {'content-type': 'application/json'})
    res.end(JSON.stringify({value: {error: 'unknown error', message: 'WDA is unavailable'}}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const client = createAppiumClient({baseUrl: `http://127.0.0.1:${server.address().port}`})

  await assert.rejects(client.source('stale'), /WDA is unavailable/)
})

test('credential prompts stop recovery before any device action', async () => {
  const commands = []
  const client = {
    source: async () => '<XCUIElementTypeApplication bundleId="com.apple.springboard"><XCUIElementTypeWindow name="SBCoverSheetWindow"><XCUIElementTypeSecureTextField/></XCUIElementTypeWindow></XCUIElementTypeApplication>',
    execute: async (_sessionId, script) => commands.push(script),
  }
  const result = await recover(client, 'session-1', 'com.xingin.discover')
  assert.equal(result.status, 'blocked-needs-user')
  assert.deepEqual(commands, [])
})

test('same-device file lock serializes separate operations', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-ops-lock-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const lockPath = path.join(directory, 'device.lock')
  const order = []
  const first = withFileLock(lockPath, async () => {
    order.push('first-start')
    await new Promise((resolve) => setTimeout(resolve, 80))
    order.push('first-end')
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = withFileLock(lockPath, async () => order.push('second'))
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second'])
})

test('element actions verify foreground and do not retry a sent click', async () => {
  const calls = []
  const client = {
    source: async () => '<XCUIElementTypeApplication bundleId="com.xingin.discover"/>',
    execute: async (_sessionId, script) => script === 'mobile: activeAppInfo' ? {bundleId: 'com.xingin.discover'} : 4,
    findElement: async (_sessionId, using, value) => { calls.push(['find', using, value]); return {'element-6066-11e4-a52e-4f735466cecf': 'element-1'} },
    clickElement: async () => { calls.push(['click']) },
  }
  const result = await elementAction(client, 'session-1', 'click', 'com.xingin.discover', 'accessibility-id', 'search')
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['find', 'accessibility id', 'search'], ['click']])
})

test('client refuses a non-loopback Appium endpoint', () => {
  assert.throws(() => createAppiumClient({baseUrl: 'http://192.168.1.20:4723'}), /loopback/)
})

test('Dianping gates consent and verification before search actions', async () => {
  const consent = '<XCUIElementTypeApplication bundleId="com.dianping.dpscope"><XCUIElementTypeStaticText name="大众点评隐私政策协议"/><XCUIElementTypeButton name="同意"/></XCUIElementTypeApplication>'
  const verification = '<XCUIElementTypeApplication bundleId="com.dianping.dpscope"><XCUIElementTypeStaticText value="请依次点击下图图标"/></XCUIElementTypeApplication>'
  assert.equal(isDianpingConsentSource(consent), true)
  assert.equal(isDianpingVerificationSource(verification), true)

  const calls = []
  const client = {
    source: async () => consent,
    execute: async (_sessionId, script) => {
      calls.push(script)
      if (script === 'mobile: activeAppInfo') return {bundleId: 'com.dianping.dpscope'}
      if (script === 'mobile: queryAppState') return 4
      return null
    },
    tap: async () => { throw new Error('tap must not run') },
  }
  const result = await dianpingSearch(client, 'session-1', 'blcoffee厦门', '/tmp/unused.png')
  assert.equal(result.status, 'needs-user-consent')
  assert.deepEqual(calls, ['mobile: launchApp', 'mobile: activeAppInfo', 'mobile: queryAppState'])
})


test('lock release preserves a replaced owner and stale locks fail closed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-owner-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const file = path.join(directory, 'lock')
  await withFileLock(file, async () => {
    await writeFile(file, JSON.stringify({pid: process.pid, nonce: 'other-owner'}))
  })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).nonce, 'other-owner')
  await writeFile(file, JSON.stringify({pid: 2147483647, nonce: 'dead-owner'}))
  let called = false
  await assert.rejects(withFileLock(file, async () => { called = true }), /stale device lock/)
  assert.equal(called, false)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).nonce, 'dead-owner')
})

test('an ambiguous session POST failure keeps its marker and prevents a second creation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-create-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  let creates = 0
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') creates++
    res.writeHead(500, {'content-type': 'application/json'})
    res.end(JSON.stringify({value: {error: 'unknown error', message: 'server failed after receiving creation'}}))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const state = path.join(directory, 'state.json')
  const options = {env: {...process.env, APPIUM_URL: `http://127.0.0.1:${server.address().port}`, IPHONE_OPS_SESSION_FILE: state}}
  const script = new URL('../scripts/iphone-app-ops.mjs', import.meta.url).pathname
  for (let i = 0; i < 2; i++) await assert.rejects(promisify(execFile)(process.execPath, [script, 'session'], options))
  assert.equal(creates, 1)
  assert.equal(JSON.parse(await readFile(state + '.creating', 'utf8')).udid, '00008020-000B25990204002E')
})
