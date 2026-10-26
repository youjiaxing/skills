import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createAppiumClient, dianpingSearch, elementAction, extractForegroundBundle, isDianpingConsentSource, isDianpingVerificationSource, isLockScreenSource, parseDeviceLine, recover, requiresCredential, withFileLock} from '../scripts/iphone-app-ops.mjs'

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

test('device parser selects only the configured UDID', () => {
  const line = 'iPhone XS Max                00008020-000B25990204002E (UDID)   available            iPhone11,6'
  assert.deepEqual(parseDeviceLine(line), {raw: line, state: 'available'})
  assert.equal(parseDeviceLine('other device 123'), null)
})

test('recovery wakes, unlocks, swipes only when needed, launches and verifies foreground', async (t) => {
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
  assert.deepEqual(result.steps.find((step) => step.name === 'wda-unlock-attempt'), {
    name: 'wda-unlock-attempt', ok: false, outcome: 'unknown', error: 'unlock state notification timed out',
  })
  assert.deepEqual(commands.slice(0, 6), [
    'mobile: pressButton',
    'mobile: unlock',
    'mobile: dragFromToForDuration',
    'mobile: launchApp',
    'mobile: activeAppInfo',
    'mobile: queryAppState',
  ])
  assert.ok(commands.length >= 6)
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
  assert.deepEqual(calls, ['mobile: pressButton', 'mobile: unlock', 'mobile: launchApp', 'mobile: activeAppInfo', 'mobile: queryAppState'])
})

