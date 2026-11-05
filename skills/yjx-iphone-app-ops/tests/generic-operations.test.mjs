import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createOperations, annotateTarget, failureResult} from '../scripts/app-operations.mjs'
import {assertSessionReady} from '../scripts/local-config.mjs'
import {serviceAction, wdaAction} from '../scripts/iphone-environment.mjs'
import {doctor} from '../scripts/iphone-app-ops.mjs'

const bundleId = 'org.example.notes'
const xml = `<XCUIElementTypeApplication bundleId="${bundleId}" width="400" height="800"/>`
const match = {'element-6066-11e4-a52e-4f735466cecf': 'button'}
function fixture(overrides = {}, deps = {}) {
  const calls = []
  let input = '', pending = false
  const client = {
    getContext: async () => 'NATIVE_APP', setContext: async () => {},
    findElements: async () => [match], elementDisplayed: async () => true, elementEnabled: async () => true,
    elementAttribute: async (_, __, name) => name === 'value' ? input : null,
    elementText: async () => 'Saved', clearElement: async () => { calls.push('clear'); input = '' },
    setElementValue: async (_, __, text) => { calls.push('input'); input = text },
    clickElement: async () => { calls.push('click') }, screenshot: async () => { calls.push('pixels'); return Buffer.from('pixels').toString('base64') },
    execute: async (_, script) => {
      if (script === 'mobile: getContexts') return [{id: 'NATIVE_APP'}, {id: 'WEBVIEW_1', bundleId}]
      return {children: [{type: 'XCUIElementTypeButton', label: 'Saved', isVisible: true, rect: {x: 1, y: 2, width: 3, height: 4}}]}
    },
    performActions: async () => calls.push('gesture'), ...overrides,
  }
  const ops = createOperations(client, 'session', {bundleId, guardApp: async () => xml,
    checkReady: async () => { if (pending) throw Object.assign(new Error('in-flight'), {transportPending: true}) },
    ocr: async () => ({observations: [{text: 'OCR'}]}), ...deps})
  return {ops, calls, setInput: (s) => { input = s }, setPending: () => { pending = true }}
}
const loc = {using: 'accessibility-id', selector: 'save'}
async function directory(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'iphone-ops-test-'))
  t.after(() => rm(folder, {recursive: true, force: true}))
  return folder
}

test('sent click timeout never replays or sends evidence/context cleanup commands', async (t) => {
  const dir = await directory(t)
  let f
  f = fixture({clickElement: async () => { f.calls.push('click'); f.setPending(); throw Object.assign(new Error('deadline'), {transportPending: true, outcome: 'unknown'}) }})
  const result = await f.ops.element('click', loc)
  await f.ops.captureFailure(result, {screenshotPath: path.join(dir, 'failure.png')})
  assert.equal(result.operation.outcome, 'unknown')
  assert.equal(result.verification.status, 'unknown')
  assert.deepEqual(f.calls, ['click'])
  assert.match(result.error, /deadline/)
  assert.ok(result.evidenceFailure)
})

test('duplicate semantic targets stop before writing', async () => {
  const f = fixture({findElements: async () => [match, match]})
  const result = await f.ops.element('click', loc)
  assert.equal(result.status, 'target-not-unique')
  assert.equal(result.operation.outcome, 'not-sent')
  assert.equal(f.calls.length, 0)
})

test('no-op clear prevents typing and unobservable values are not empty inputs', async () => {
  const f = fixture({clearElement: async () => f.calls.push('clear')})
  f.setInput('old')
  const result = await f.ops.element('set-value', loc, async () => 'new')
  assert.equal(result.status, 'input-clear-unverified')
  assert.equal(result.verification.status, 'failed')
  assert.deepEqual(f.calls, ['clear'])
  const absent = fixture({elementAttribute: async () => null})
  assert.equal((await absent.ops.element('set-value', loc, async () => 'new')).status, 'input-value-unobservable')
  assert.deepEqual(absent.calls, [])
})

test('input verifies actual full value and reports mismatch rather than success', async () => {
  const f = fixture()
  f.setInput('old')
  const result = await f.ops.element('set-value', loc, async () => 'new')
  assert.equal(result.verification.status, 'passed')
  assert.deepEqual(f.calls, ['clear', 'input'])
  const truncated = fixture({setElementValue: async () => {}})
  assert.equal((await truncated.ops.element('set-value', loc, async () => 'new')).verification.status, 'failed')
})

test('wait polls only reads and distinguishes mismatch, absence and transport errors', async () => {
  let clock = 0, lookups = 0
  const f = fixture({findElements: async () => ++lookups < 2 ? [] : [match]}, {now: () => clock, sleep: async (ms) => { clock += ms }})
  assert.equal((await f.ops.verify({...loc, condition: 'visible', timeoutMs: 1000})).verification.status, 'passed')
  assert.deepEqual(f.calls, [])
  assert.equal((await f.ops.verify({...loc, condition: 'text-equals', expected: 'different'})).verification.status, 'failed')
  const unavailable = fixture({findElements: async () => { throw Object.assign(new Error('timeout'), {transportPending: true}) }})
  await assert.rejects(unavailable.ops.verify({...loc, condition: 'absent', timeoutMs: 1000}), /timeout/)
})

test('WebView ownership is checked independently of its name', async () => {
  const f = fixture({execute: async () => [{id: 'WEBVIEW_1', bundleId: 'wrong.app'}], setContext: async () => f.calls.push('context')})
  const result = await f.ops.element('click', {...loc, using: 'css', context: 'WEBVIEW_1'})
  assert.equal(result.status, 'context-owner-unverified')
  assert.deepEqual(f.calls, [])
})

test('cross-App discovery returns only verified owners and rejects missing ownership before switching', async () => {
  const switches = []
  const available = [{id: 'NATIVE_APP'}, {id: 'WEBVIEW_owned', bundleId},
    {id: 'WEBVIEW_foreign', bundleId: 'org.example.other'}, {id: 'WEBVIEW_unknown'}]
  const f = fixture({execute: async () => available, setContext: async (_, next) => switches.push(next)})
  assert.deepEqual((await f.ops.contexts()).contexts, available.slice(0, 2))
  for (const context of ['WEBVIEW_foreign', 'WEBVIEW_unknown']) {
    const result = await f.ops.element('click', {using: 'css', selector: 'button', context})
    assert.equal(result.status, 'context-owner-unverified')
    assert.equal(result.operation.outcome, 'not-sent')
  }
  assert.deepEqual(switches, [])
  assert.deepEqual(f.calls, [])
})

test('DOM observation preserves the primary error when context cleanup also fails', async () => {
  let current = 'NATIVE_APP', failed = false
  const f = fixture({getContext: async () => current, setContext: async (_, next) => {
    if (failed) throw new Error('cleanup failed')
    current = next
  }, execute: async (_, script) => {
    if (script === 'mobile: getContexts') return [{id: 'WEBVIEW_1', bundleId}]
    failed = true
    throw new Error('primary DOM failure')
  }})
  await assert.rejects(f.ops.observe({method: 'dom', context: 'WEBVIEW_1'}), (error) =>
    error.message === 'primary DOM failure' && error.contextCleanupFailure === 'cleanup failed')
})

test('DOM observation reads custom-element text and generic div text without exposing passwords', async () => {
  const node = (tagName, text, extra = {}) => ({
    tagName, childNodes: [{nodeType: 3, textContent: text}], innerText: text,
    getBoundingClientRect: () => ({x: 0, y: 0, width: 100, height: 20}),
    getAttribute: () => null,
    matches: selector => selector.split(',').includes(tagName.toLowerCase()), ...extra,
  })
  const nodes = [node('CUSTOM-TEXT', 'About'), node('DIV', 'Visible plain text'),
    node('INPUT', '', {type: 'password', value: 'secret'}),
    node('CUSTOM-TEXT', 'Hidden', {hidden: true})]
  const document = {querySelectorAll: selector => selector === '*' ? nodes : nodes.filter(n => n.matches(selector))}
  const f = fixture({execute: async (_, script) => {
    if (script === 'mobile: getContexts') return [{id: 'WEBVIEW_1', bundleId}]
    return new Function('document', 'getComputedStyle', script)(document,
      e => ({visibility: e.hidden ? 'hidden' : 'visible'}))
  }})
  const result = await f.ops.observe({method: 'dom', context: 'WEBVIEW_1'})
  assert.deepEqual(result.observations.map(row => row.text), ['About', 'Visible plain text', '[secure]'])
  assert.equal(result.method, 'dom')
  assert.ok(!JSON.stringify(result).includes('secret'))
  nodes.splice(0, nodes.length, ...Array.from({length: 1001}, (_, i) => node('CUSTOM-TEXT', String(i))))
  const capped = await f.ops.observe({method: 'dom', context: 'WEBVIEW_1', limit: 500, contains: '1000'})
  assert.equal(capped.partial, true, 'source truncation remains visible even if the requested text is beyond the cap')
  assert.deepEqual(capped.observations, [])
})

test('information reads avoid screenshots; visual reads require pixels despite a complete tree', async (t) => {
  const dir = await directory(t)
  const f = fixture()
  assert.equal((await f.ops.observe()).method, 'accessibility')
  assert.deepEqual(f.calls, [])
  const image = path.join(dir, 'screen.png')
  const result = await f.ops.observe({purpose: 'visual', screenshotPath: image})
  assert.equal(result.method, 'pixels')
  assert.deepEqual(f.calls, ['pixels'])
  assert.equal((await readFile(image)).toString(), 'pixels')
  await assert.rejects(f.ops.observe({purpose: 'visual', screenshotPath: image}), /exists/)
})

test('stale or changed screenshot proof cannot dispatch a gesture', async (t) => {
  const dir = await directory(t)
  const proof = path.join(dir, 'observation.json')
  const f = fixture()
  const observation = {documentType: 'app-observation-v1', bundleId, readAt: new Date().toISOString(),
    imageSha256: createHash('sha256').update('other').digest('hex'), viewport: {width: 400, height: 800}}
  observation.targets = [{label: 'Save', rect: {x: .2, y: .2, width: .6, height: .6}, imageSha256: observation.imageSha256}]
  await writeFile(proof, JSON.stringify(observation))
  await assert.rejects(f.ops.gesture({observationPath: proof, target: 'Save', x: .5, y: .5}), /screen-changed/)
  assert.deepEqual(f.calls, ['pixels'])
  observation.readAt = new Date(Date.now() - 60000).toISOString()
  await writeFile(proof, JSON.stringify(observation))
  await assert.rejects(f.ops.gesture({observationPath: proof, target: 'Save', x: .5, y: .5}), /stale/)
})

test('visual annotation binds one region to the viewed image; gestures outside it cannot dispatch', async (t) => {
  const dir = await directory(t), image = path.join(dir, 'image.png'), source = path.join(dir, 'source.json'), target = path.join(dir, 'target.json')
  await writeFile(image, 'pixels')
  await writeFile(source, JSON.stringify({documentType: 'app-observation-v1', bundleId, readAt: new Date().toISOString(),
    viewport: {width: 400, height: 800}, imageSha256: createHash('sha256').update('pixels').digest('hex'), evidence: [{kind: 'screenshot', path: image}]}))
  await annotateTarget(source, {label: 'Save', rect: {x: .2, y: .2, width: .2, height: .2}, outputPath: target})
  const f = fixture()
  await assert.rejects(f.ops.gesture({observationPath: target, target: 'Save', x: .8, y: .8}), /outside-target/)
  assert.deepEqual(f.calls, [])
  await assert.rejects(f.ops.gesture({observationPath: target, target: 'Other', x: .3, y: .3}), /target-unverified/)
  assert.equal((await f.ops.gesture({observationPath: target, target: 'Save', x: .3, y: .3})).operation.outcome, 'sent')
  assert.deepEqual(f.calls, ['pixels', 'gesture'])
})

test('credential page observation reports a redacted barrier; unrelated navigation remains operable', async () => {
  const f = fixture({}, {guardApp: async () => xml.replace('/>', '><XCUIElementTypeSecureTextField value="private"/></XCUIElementTypeApplication>')})
  const observation = await f.ops.observe()
  assert.equal(observation.verification.status, 'blocked')
  assert.ok(!JSON.stringify(observation).includes('private'))
  assert.deepEqual(f.calls, [])
  assert.equal((await f.ops.element('click', loc)).ok, true)
  const secret = fixture({elementAttribute: async (_, __, key) => key === 'type' ? 'XCUIElementTypeSecureTextField' : 'private'})
  assert.equal((await secret.ops.element('read', loc)).status, 'blocked-credential')
})

test('unknown and corrupt session markers block before any operation', async (t) => {
  const dir = await directory(t), state = path.join(dir, 'state.json')
  await writeFile(state + '.unknown', '{broken')
  let calls = 0
  const f = fixture({getContext: async () => { calls++; return 'NATIVE_APP' }}, {checkReady: () => assertSessionReady(state)})
  await assert.rejects(f.ops.verify({...loc, condition: 'absent'}), /marker/)
  assert.equal(calls, 0)
})

test('doctor still inspects device/listeners when Appium is unavailable', async () => {
  const inspected = []
  const report = await doctor({status: async () => { throw new Error('offline') }}, {
    runCmd: async (cmd, args) => { inspected.push([cmd, args]); return '' }, fetchImpl: async () => ({ok: true, json: async () => ({status: 'OK'})}),
  })
  assert.equal(report.ok, false)
  assert.equal(report.checks.appium.ok, false)
  assert.ok(inspected.some(([cmd]) => cmd === 'xcrun'))
  assert.ok(inspected.some(([cmd]) => cmd === 'lsof'))
})

test('unowned service configuration cannot be overwritten or stopped', async (t) => {
  const dir = await directory(t), target = path.join(dir, 'service.plist')
  await writeFile(target, 'unowned')
  const config = {sessionFile: path.join(dir, 'session'), configPath: path.join(dir, 'config'), managedServices: {}}
  const definition = {target, content: 'new', label: 'test-service', domain: 'gui/1', root: false}
  const calls = []
  await assert.rejects(serviceAction(config, 'install', 'appium', {exclusive: true, definition, execute: (...args) => calls.push(args)}), /ownership/)
  assert.equal(await readFile(target, 'utf8'), 'unowned')
  assert.deepEqual(calls, [])
})

test('service maintenance refuses an unknown command marker', async (t) => {
  const dir = await directory(t), state = path.join(dir, 'session')
  await writeFile(state + '.unknown', '{}')
  await assert.rejects(serviceAction({sessionFile: state}, 'restart', 'appium', {exclusive: true}), /marker/)
})

test('service restart waits for launchd to finish unloading before bootstrap', async (t) => {
  const dir = await directory(t), target = path.join(dir, 'service.plist'), raw = 'previous'
  await writeFile(target, raw)
  const config = {sessionFile: path.join(dir, 'session'), configPath: path.join(dir, 'config'),
    managedServices: {appium: {path: target, sha256: createHash('sha256').update(raw).digest('hex')}}}
  const definition = {target, content: 'new', label: 'test-service', domain: 'gui/1', root: false}
  const calls = []
  let remaining = 2
  const execute = (cmd, args) => {
    calls.push(args[0])
    if (args[0] === 'print' && --remaining < 0) {
      throw Object.assign(new Error('missing'), {status: 113, stderr: 'Could not find service "test-service" in domain for gui/1'})
    }
    if (args[0] === 'bootstrap' && remaining >= 0) throw new Error('Operation already in progress')
    return 'state = running'
  }
  await serviceAction(config, 'restart', 'appium', {exclusive: true, definition, execute})
  assert.deepEqual(calls, ['bootout', 'print', 'print', 'print', 'bootstrap'])
})

test('unload verification stops on unrelated print failures and preserves timeout uncertainty', async () => {
  const {waitForServiceUnload} = await import('../scripts/iphone-environment.mjs')
  let tick = 0
  await assert.rejects(waitForServiceUnload({domain: 'system', label: 'test-service',
    execute: () => { throw Object.assign(new Error('denied'), {status: 1, stderr: 'Operation not permitted'}) }}), /denied/)
  await assert.rejects(waitForServiceUnload({domain: 'system', label: 'test-service', timeoutMs: 200,
    now: () => tick, sleep: async (ms) => { tick += ms }, execute: () => 'state = running'}),
  (error) => error.phase === 'service-unload' && error.outcome === 'unknown')
})

test('failed owned service installation restores its previous configuration', async (t) => {
  const dir = await directory(t), target = path.join(dir, 'service.plist')
  const raw = 'previous', configPath = path.join(dir, 'config.json')
  await writeFile(target, raw)
  const config = {sessionFile: path.join(dir, 'session'), configPath,
    managedServices: {appium: {path: target, sha256: createHash('sha256').update(raw).digest('hex')}}}
  await writeFile(configPath, JSON.stringify(config))
  const definition = {target, content: 'new', label: 'test-service', domain: 'gui/1', root: false}
  let installs = 0
  const execute = (cmd, args) => {
    if (cmd !== '/usr/bin/install') return
    writeFileSync(args.at(-1), readFileSync(args.at(-2)))
    if (++installs === 1) throw new Error('install failed after replacing the file')
  }
  const error = await serviceAction(config, 'install', 'appium', {exclusive: true, definition, execute}).catch((e) => e)
  assert.equal(error.rollback, 'previous-configuration-restored')
  assert.equal(installs, 2)
  assert.equal(await readFile(target, 'utf8'), raw)
})

test('WDA installer rejects a business App before invoking an install command', async (t) => {
  const dir = await directory(t), appPath = path.join(dir, 'business.app')
  await mkdir(appPath)
  await writeFile(path.join(appPath, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>business.app</string></dict></plist>')
  const calls = []
  await assert.rejects(wdaAction({udid: 'device', wdaBundleId: 'control.WDA', sessionFile: path.join(dir, 'session'), configPath: path.join(dir, 'config')},
    'install', {exclusive: true, appPath, execute: (...args) => calls.push(args)}), /Only the configured WebDriverAgent/)
  assert.deepEqual(calls, [])
})

test('pixel observation avoids full trees but checks foreground and sensitive controls before publishing', async (t) => {
  const dir = await directory(t)
  let guards = 0
  const f = fixture({
    findElements: async () => [],
    execute: async (_, script) => script === 'mobile: activeAppInfo' ? {bundleId} : 4,
  }, {guardApp: async () => { guards++; throw new Error('full tree unavailable') }})
  const result = await f.ops.observe({method: 'pixels', screenshotPath: path.join(dir, 'safe.png')})
  assert.equal(result.ok, true)
  assert.equal(result.method, 'vision-ocr')
  assert.equal(result.viewport, null)
  assert.equal(guards, 0)
  const blocked = fixture({findElements: async () => [match], execute: async (_, s) => s === 'mobile: activeAppInfo' ? {bundleId} : 4})
  await assert.rejects(blocked.ops.observe({method: 'pixels', screenshotPath: path.join(dir, 'blocked.png')}), /user-input-required/)
  assert.deepEqual(blocked.calls, [])
  await assert.rejects(readFile(path.join(dir, 'blocked.png')), {code: 'ENOENT'})
})

test('pixel evidence is withheld on post-capture identity change or an unreadable safety check', async (t) => {
  const dir = await directory(t)
  let active = 0
  const f = fixture({findElements: async () => [], execute: async (_, s) => s === 'mobile: activeAppInfo' ? {bundleId: ++active === 1 ? bundleId : 'org.example.other'} : 4})
  await assert.rejects(f.ops.observe({method: 'pixels', screenshotPath: path.join(dir, 'changed.png')}), /foreground-unverified/)
  await assert.rejects(readFile(path.join(dir, 'changed.png')), {code: 'ENOENT'})
  const unsafe = fixture({findElements: async () => { throw new Error('safety unavailable') }, execute: async (_, s) => s === 'mobile: activeAppInfo' ? {bundleId} : 4})
  await assert.rejects(unsafe.ops.observe({method: 'pixels'}), /safety unavailable/)
  assert.deepEqual(unsafe.calls, [])
})

test('one observation shares a single retry allowance and never retries unknown requests', async () => {
  let reads = 0
  const f = fixture({execute: async () => { reads++; throw Object.assign(new Error('stale'), {code: 'stale element reference', transportPending: false}) }}, {sleep: async () => {}})
  await assert.rejects(f.ops.observe(), error => {
    const failure = failureResult(error)
    assert.equal(failure.recovery.next, 'reassess-observation')
    assert.equal(failure.recovery.readBudgetExhausted, true)
    return /stale/.test(error.message)
  })
  assert.equal(reads, 2)
  let attempts = 0
  const pending = fixture({execute: async () => { attempts++; throw Object.assign(new Error('pending'), {transportPending: true}) }})
  await assert.rejects(pending.ops.observe(), /pending/)
  assert.equal(attempts, 1)
})

test('reconciliation only reads a postcondition and never proves that an action was not executed', async () => {
  const f = fixture()
  const passed = await f.ops.reconcile({...loc, condition: 'text-equals', expected: 'Saved'})
  assert.equal(passed.reconciliation.status, 'satisfied')
  assert.equal(passed.reconciliation.replayAllowed, false)
  const failed = await f.ops.reconcile({...loc, condition: 'text-equals', expected: 'Other'})
  assert.equal(failed.reconciliation.status, 'unsatisfied')
  assert.equal(failed.reconciliation.replayAllowed, false)
  f.setPending()
  const unknown = await f.ops.reconcile({...loc, condition: 'visible'})
  assert.equal(unknown.reconciliation.status, 'unknown')
  assert.equal(unknown.failure.category, 'result-unknown')
  assert.deepEqual(f.calls, [])
})

test('OCR safety barriers and unknown markers withhold all pixel output and follow-up capture', async (t) => {
  const dir = await directory(t)
  const f = fixture({findElements: async () => [], execute: async (_, s) => s === 'mobile: activeAppInfo' ? {bundleId} : 4},
    {ocr: async () => ({observations: [{text: '验证码 123456'}]})})
  let failure
  try { await f.ops.observe({method: 'pixels', screenshotPath: path.join(dir, 'sensitive.png')}) }
  catch (error) { failure = failureResult(error) }
  assert.equal(failure.failure.category, 'identity-or-safety-unconfirmed')
  await f.ops.captureFailure(failure, {screenshotPath: path.join(dir, 'sensitive.png')})
  assert.deepEqual(f.calls, ['pixels'])
  assert.ok(!JSON.stringify(failure).includes('123456'))
  await assert.rejects(readFile(path.join(dir, 'sensitive.png')), {code: 'ENOENT'})
  f.setPending()
  await assert.rejects(f.ops.observe({method: 'pixels'}), /in-flight/)
  assert.deepEqual(f.calls, ['pixels'])
})

test('recovered reads record their retry and share the allowance across acquisition and guards', async () => {
  let reads = 0, guards = 0
  const stale = () => Object.assign(new Error('stale'), {code: 'stale element reference', transportPending: false})
  const f = fixture({execute: async () => { if (++reads === 1) throw stale(); return {children: []} }},
    {guardApp: async () => { if (++guards === 3) throw stale(); return xml }, sleep: async () => {}})
  await assert.rejects(f.ops.observe({method: 'native'}), /stale/)
  assert.equal(reads, 2)
  assert.equal(guards, 3)
  let attempts = 0
  const recovered = fixture({execute: async () => { if (++attempts === 1) throw stale(); return {children: []} }}, {sleep: async () => {}})
  assert.equal((await recovered.ops.observe({method: 'native'})).recovery.readRetries, 1)
})

test('pixel failure evidence preserves the selected mode and never acquires rejected XML', async (t) => {
  const dir = await directory(t)
  let trees = 0
  const f = fixture({}, {guardApp: async () => { trees++; return xml }})
  const options = {method: 'pixels', sourcePath: path.join(dir, 'rejected.xml')}
  let failure
  try { await f.ops.observe(options) } catch (error) { failure = failureResult(error) }
  await f.ops.captureFailure(failure, options)
  assert.equal(trees, 0)
  assert.deepEqual(f.calls, [])
  await assert.rejects(readFile(options.sourcePath), {code: 'ENOENT'})
})

test('lightweight lockscreen lookup blocks before capture even when active signals look ready', async () => {
  let queried = false
  const f = fixture({execute: async (_, s) => s === 'mobile: activeAppInfo' ? {bundleId} : 4,
    findElements: async (_, using, predicate) => {
      // Model WDA matching either of its known lockscreen identifiers.
      queried = true
      assert.equal(using, '-ios predicate string')
      return predicate.includes('SBCoverSheetWindow') && predicate.includes('lockscreen-date-view') ? [match] : []
    }})
  await assert.rejects(f.ops.observe({method: 'pixels'}), /user-input-required/)
  assert.equal(queried, true)
  assert.deepEqual(f.calls, [])
})
