import {createHash, randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {publishArtifact, preflightArtifacts} from './dianping-query.mjs'

const elementKey = 'element-6066-11e4-a52e-4f735466cecf'
const idOf = (value) => value?.[elementKey] || value?.ELEMENT
const hash = (value) => createHash('sha256').update(value).digest('hex')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stop = (status, message = status) => Object.assign(new Error(message), {status})
const strategies = {'accessibility-id': 'accessibility id', predicate: '-ios predicate string', 'class-chain': '-ios class chain', css: 'css selector'}

export function failureResult(error, operation = {outcome: 'not-sent'}) {
  const unknown = error.transportPending || error.outcome === 'unknown' || error.code === 'ETIMEDOUT' || (operation.outcome === 'sent' && !error.verificationStatus)
  return {ok: false, status: error.status || error.code || 'command-failed',
    operation: {...operation, ...(unknown && operation.outcome === 'sent' ? {outcome: 'unknown'} : {})},
    verification: {status: unknown ? 'unknown' : error.verificationStatus || 'blocked', reason: error.message,
      ...(error.observed !== undefined ? {expected: error.expected, observed: error.observed} : {})},
    error: error.message, phase: error.phase || null, retryable: false}
}

function validRegion(rect) {
  return rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])) &&
    rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1 && rect.y + rect.height <= 1
}

export async function annotateTarget(observationPath, {label, rect, outputPath}) {
  const observation = JSON.parse(await readFile(observationPath, 'utf8'))
  if (!label || !validRegion(rect) || !outputPath || observation.documentType !== 'app-observation-v1' || !observation.imageSha256) throw stop('invalid-visual-target')
  if (observation.targets?.some((target) => target.label === label)) throw stop('target-not-unique')
  const image = observation.evidence?.find((entry) => entry.kind === 'screenshot')
  if (!image || hash(await readFile(image.path)) !== observation.imageSha256) throw stop('observation-image-unverified')
  const result = {...observation, targets: [...observation.targets || [], {id: randomUUID(), label, rect,
    source: 'agent-visual-annotation', imageSha256: observation.imageSha256}]}
  await publishArtifact(outputPath, JSON.stringify(result, null, 2))
  return {ok: true, output: outputPath, target: result.targets.at(-1)}
}

function nativeRows(tree, rows = []) {
  if (!tree || typeof tree !== 'object' || /SecureTextField/.test(tree.type || '')) return rows
  if (Array.isArray(tree)) { for (const item of tree) nativeRows(item, rows); return rows }
  const visible = tree.isVisible === true || tree.isVisible === '1' || tree.visible === true || tree.visible === 'true'
  if (visible) {
    const text = [...new Set([tree.label, tree.value, tree.name].filter((v) => typeof v === 'string' && v.trim()))].join(' | ')
    if (text || /Button|TextField|Switch|Slider/.test(tree.type || '')) rows.push({
      type: tree.type, name: tree.name ?? null, label: tree.label ?? null, value: tree.value ?? null,
      text, rect: tree.rect || null, enabled: tree.isEnabled ?? tree.enabled ?? null,
    })
  }
  for (const child of tree.children || []) nativeRows(child, rows)
  return rows
}

// Every public operation uses the same foreground and pending-command gates.
// Authorization and the business meaning of a target belong to the invoking Agent.
export function createOperations(client, sid, {bundleId, checkReady = async () => {}, guardApp, ocr,
  now = Date.now, sleep = pause} = {}) {
  if (!bundleId) throw stop('missing-bundle-id')
  const call = async (name, ...args) => { await checkReady(); return client[name](sid, ...args) }
  const native = async () => {
    const current = await call('getContext')
    if (current !== 'NATIVE_APP') await call('setContext', 'NATIVE_APP')
    await checkReady()
    return guardApp(client, sid, bundleId)
  }
  const enter = async (context) => {
    if (!context || context === 'NATIVE_APP') return
    const available = await call('execute', 'mobile: getContexts', [{waitForWebviewMs: 1000}])
    if (!available.some((item) => item.id === context && item.bundleId === bundleId)) {
      throw stop('context-owner-unverified', 'WebView is unavailable or its bundleId does not match the target App')
    }
    await call('setContext', context)
  }
  const locate = async ({using, selector, context}, write = false) => {
    const strategy = strategies[using]
    if (!strategy || typeof selector !== 'string' || !selector || selector.length > 4096) throw stop('invalid-selector')
    if ((using === 'css') !== Boolean(context && context !== 'NATIVE_APP')) throw stop('selector-context-mismatch')
    const xml = await native()
    if (write && /验证码|安全验证|请依次点击下图图标/.test(xml)) throw stop('blocked-verification')
    await enter(context)
    const matches = await call('findElements', strategy, selector)
    if (matches.length > 1) throw stop('target-not-unique')
    const id = matches.length ? idOf(matches[0]) : null
    if (id) {
      const type = await call('elementAttribute', id, 'type')
      if (/SecureTextField|^password$/i.test(type || '')) throw stop('blocked-credential')
    }
    return id
  }
  const value = async (id, context) => {
    // Null is an unobservable value, never proof of an empty input.
    if (context && context !== 'NATIVE_APP') {
      const type = await call('elementAttribute', id, 'type')
      if (String(type).toLowerCase() === 'password') throw stop('blocked-credential')
    }
    const actual = await call('elementAttribute', id, 'value')
    if (actual === null || actual === undefined) throw stop('input-value-unobservable', 'Use an App-specific clear control and bounded visual/OCR verification for this input')
    return String(actual)
  }
  const restore = async () => {
    // A finally block must not issue context commands after a timeout.
    await checkReady()
    const current = await call('getContext')
    if (current !== 'NATIVE_APP') await call('setContext', 'NATIVE_APP')
  }

  async function observe({purpose = 'information', method = 'auto', context, contains, limit = 80,
    screenshotPath, sourcePath, outputPath} = {}) {
    if (!['information', 'visual'].includes(purpose) || !['auto', 'native', 'ocr', 'dom'].includes(method)) throw stop('invalid-observation-mode')
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw stop('invalid-observation-limit')
    if (purpose === 'visual' && !screenshotPath) throw stop('visual-output-required', 'Provide --screenshot-output, then let the Agent view the image')
    await preflightArtifacts({maxPages: 1, extractionPath: outputPath, screenshotPath, sourcePath})
    const xml = await native()
    const readAt = new Date(now()).toISOString()
    if (/XCUIElementTypeSecureTextField|验证码|安全验证|请依次点击下图图标/.test(xml)) {
      // Report a readable barrier without persisting or returning credential values.
      return {ok: false, bundleId, readAt, status: 'user-input-required', operation: {outcome: 'not-sent'},
        verification: {status: 'blocked', reason: 'credential-or-security-page'},
        observations: [{type: 'page-barrier', text: 'Credential/security controls are present; user handling is required'}],
        evidence: [], next: 'User completes the credential/verification step, then observe again'}
    }
    let observations = [], selected = method, viewport = null, pixels = null
    const root = xml.match(/<XCUIElementTypeApplication\b[^>]*>/)?.[0] || ''
    const width = Number(root.match(/\bwidth="([\d.]+)"/)?.[1])
    const height = Number(root.match(/\bheight="([\d.]+)"/)?.[1])
    if (width > 0 && height > 0) viewport = {width, height}
    if (purpose === 'visual') selected = 'pixels'
    else if (method === 'dom') {
      if (!context) throw stop('webview-context-required')
      await enter(context)
      let originalError
      try {
        observations = await call('execute', `return Array.from(document.querySelectorAll('button,input,textarea,select,a,[role],h1,h2,h3,p,li,label')).filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height).slice(0,1000).map(e => ({type:e.tagName, name:e.getAttribute('aria-label'),text:e.type==='password'?'[secure]':(e.innerText||e.value||''),rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}));`, [])
      } catch (error) { originalError = error; throw error }
      finally {
        try { await restore() }
        catch (error) {
          if (!originalError) throw error
          originalError.contextCleanupFailure = error.message
        }
      }
      selected = 'dom'
    } else if (method !== 'ocr') {
      observations = nativeRows(await call('execute', 'mobile: source', [{format: 'json'}]))
      selected = 'accessibility'
    }
    if (selected === 'pixels' || method === 'ocr' || (method === 'auto' && observations.length === 0) || screenshotPath) {
      await native()
      pixels = Buffer.from(await call('screenshot'), 'base64')
      if (purpose !== 'visual' && (method === 'ocr' || observations.length === 0)) {
        const raw = await ocr(pixels)
        observations = raw.observations || []
        selected = 'vision-ocr'
      }
    }
    await native()
    const filtered = contains ? observations.filter((row) => String(row.text).includes(contains)) : observations
    const result = {schemaVersion: 1, documentType: 'app-observation-v1', runId: randomUUID(), bundleId, readAt,
      finishedAt: new Date(now()).toISOString(), purpose, method: selected, viewport,
      observations: filtered.slice(0, limit), partial: filtered.length > limit,
      observationCount: filtered.length, evidence: [],
      targets: [],
      snapshotNote: 'Sequential observations; image and accessibility data are not an atomic snapshot',
      operation: {outcome: 'not-sent'}, verification: {status: 'unknown', reason: 'observation-only'}}
    if (screenshotPath && pixels) {
      result.evidence.push({...await publishArtifact(screenshotPath, pixels), kind: 'screenshot'})
      result.imageSha256 = hash(pixels)
    }
    if (sourcePath) result.evidence.push({...await publishArtifact(sourcePath, xml), kind: 'page-source'})
    if (outputPath) await publishArtifact(outputPath, JSON.stringify(result, null, 2))
    return {ok: true, ...result}
  }

  async function verify(options) {
    const {condition, expected, context} = options
    if (!['present', 'absent', 'visible', 'hidden', 'enabled', 'text-equals', 'text-contains', 'value-equals'].includes(condition)) throw stop('invalid-condition')
    if (condition.includes('equals') || condition === 'text-contains') {
      if (typeof expected !== 'string') throw stop('expected-value-required')
    }
    const timeout = options.timeoutMs ?? 0
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120000) throw stop('invalid-wait-budget')
    const deadline = now() + timeout
    let observed, matches, attempts = 0
    do {
      await checkReady()
      attempts++
      const id = await locate(options)
      observed = {present: Boolean(id)}
      if (!id) matches = condition === 'absent' || condition === 'hidden'
      else {
        if (condition === 'present') matches = true
        else if (condition === 'absent') matches = false
        else if (condition === 'visible' || condition === 'hidden') {
          observed.visible = await call('elementDisplayed', id)
          matches = condition === 'visible' ? observed.visible : !observed.visible
        } else if (condition === 'enabled') { observed.enabled = await call('elementEnabled', id); matches = observed.enabled }
        else if (condition === 'value-equals') { observed.value = await value(id, context); matches = observed.value === expected }
        else {
          observed.text = await call('elementText', id)
          matches = condition === 'text-equals' ? observed.text === expected : observed.text.includes(expected)
        }
      }
      await native()
      if (matches || now() >= deadline) break
      await sleep(Math.min(400, deadline - now()))
    } while (now() < deadline)
    return {ok: matches, bundleId, operation: {outcome: 'not-sent'}, verification: {
      status: matches ? 'passed' : 'failed', condition, expected: expected ?? null, observed, attempts,
      checkedAt: new Date(now()).toISOString(), scope: 'specified observable condition',
    }}
  }

  async function element(method, options, readInput) {
    const operation = {outcome: 'not-sent', method}
    try {
      const id = await locate(options, method !== 'read')
      if (!id) throw stop('target-not-found')
      let result
      if (method === 'read') result = {text: await call('elementText', id), label: await call('elementAttribute', id, 'label'), value: await call('elementAttribute', id, 'value')}
      else {
        if (!await call('elementDisplayed', id) || !await call('elementEnabled', id)) throw stop('target-not-interactable')
        if (method === 'set-value') {
          const text = await readInput()
          const before = await value(id, options.context)
          if (before !== '') {
            operation.outcome = 'sent'
            await call('clearElement', id)
            const cleared = await value(id, options.context)
            if (cleared !== '') throw Object.assign(stop('input-clear-unverified'), {verificationStatus: 'failed', expected: '', observed: cleared})
          }
          operation.outcome = 'sent'
          await call('setElementValue', id, text)
          const actual = await value(id, options.context)
          result = {action: 'set-value-sent', characters: Array.from(text).length,
            verification: {status: actual === text ? 'passed' : 'failed', condition: 'value-equals', expected: text, observed: actual}}
        } else if (method === 'click') {
          operation.outcome = 'sent'
          await call('clickElement', id)
          result = {action: 'click-sent'}
        } else if (/^swipe-(up|down|left|right)$/.test(method) && !options.context) {
          operation.outcome = 'sent'
          await call('execute', 'mobile: swipe', [{direction: method.slice(6), elementId: id}])
          result = {action: method + '-sent'}
        } else throw stop('unsupported-element-action')
      }
      const xml = await native()
      return {ok: result.verification?.status !== 'failed', bundleId, foregroundBundle: bundleId,
        pageBytes: Buffer.byteLength(xml), ...result, operation,
        ...(method !== 'read' ? {outcome: 'inspect-current-state-before-any-retry'} : {})}
    } catch (error) { return failureResult(error, operation) }
  }

  async function contexts(context) {
    await native()
    const available = await call('execute', 'mobile: getContexts', [{waitForWebviewMs: 1000}])
    const owned = available.filter((item) => item.id === 'NATIVE_APP' || item.bundleId === bundleId)
    if (context && context !== 'NATIVE_APP') await enter(context)
    return {ok: true, bundleId, contexts: owned, current: await call('getContext')}
  }

  async function gesture({observationPath, action = 'tap', target, x, y, toX, toY, durationMs = 300}) {
    if (!target || !observationPath) throw stop('gesture-observation-required')
    const observation = JSON.parse(await readFile(observationPath, 'utf8'))
    const age = now() - Date.parse(observation.readAt)
    if (observation.documentType !== 'app-observation-v1' || observation.bundleId !== bundleId ||
      !observation.imageSha256 || age < 0 || age > 30000 || !observation.viewport) throw stop('gesture-observation-stale')
    const targets = (observation.targets || []).filter((entry) => entry.id === target || entry.label === target)
    if (targets.length !== 1 || !validRegion(targets[0].rect) || targets[0].imageSha256 !== observation.imageSha256) throw stop('gesture-target-unverified')
    const region = targets[0].rect
    if (!(x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height)) throw stop('gesture-outside-target')
    if (!['tap', 'swipe', 'drag'].includes(action) || ![x, y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
      (action !== 'tap' && ![toX, toY].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) ||
      !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 2000) throw stop('invalid-gesture')
    const xml = await native()
    if (/XCUIElementTypeSecureTextField|验证码|安全验证|请依次点击下图图标/.test(xml)) throw stop('blocked-credential')
    if (hash(Buffer.from(await call('screenshot'), 'base64')) !== observation.imageSha256) throw stop('gesture-screen-changed')
    await native()
    const {width, height} = observation.viewport
    const actions = [{type: 'pointerMove', duration: 0, x: Math.round(x * (width - 1)), y: Math.round(y * (height - 1))}, {type: 'pointerDown', button: 0},
      ...(action === 'tap' ? [{type: 'pause', duration: 50}] : [
        ...(action === 'drag' ? [{type: 'pause', duration: 500}] : []),
        {type: 'pointerMove', duration: durationMs, x: Math.round(toX * (width - 1)), y: Math.round(toY * (height - 1))}]), {type: 'pointerUp', button: 0}]
    const operation = {outcome: 'sent', method: action, target}
    try {
      await call('performActions', [{type: 'pointer', id: 'finger', parameters: {pointerType: 'touch'}, actions}])
      await native()
      return {ok: true, bundleId, operation, verification: {status: 'unknown', reason: 'verify the task postcondition before declaring completion'}}
    } catch (error) { return failureResult(error, operation) }
  }

  async function app(action) {
    if (!['activate', 'launch', 'terminate'].includes(action)) throw stop('invalid-app-action')
    await checkReady()
    if (action === 'terminate') await native()
    const operation = {outcome: 'sent', method: action}
    try {
      await call('execute', `mobile: ${action === 'activate' ? 'activateApp' : action === 'launch' ? 'launchApp' : 'terminateApp'}`, [{bundleId}])
      const appState = await call('execute', 'mobile: queryAppState', [{bundleId}])
      if (action !== 'terminate') await native()
      const passed = action === 'terminate' ? appState <= 1 : appState === 4
      return {ok: passed, bundleId, operation, verification: {status: passed ? 'passed' : 'unknown', appState}}
    } catch (error) { return failureResult(error, operation) }
  }

  async function captureFailure(result, options = {}) {
    if (!options.screenshotPath && !options.sourcePath) return result
    try {
      const evidence = await observe({...options, purpose: options.screenshotPath ? 'visual' : 'information', screenshotPath: options.screenshotPath})
      result.evidence = evidence.evidence
      if (!evidence.ok) result.evidenceFailure = {reason: evidence.verification?.reason || evidence.status}
    } catch (error) { result.evidenceFailure = {reason: error.message, status: error.status || error.code || 'capture-failed'} }
    return result
  }
  return {observe, verify, element, contexts, gesture, app, captureFailure}
}
