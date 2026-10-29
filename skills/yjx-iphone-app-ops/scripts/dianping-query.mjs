import {access, link, lstat, open, rm} from 'node:fs/promises'
import {constants} from 'node:fs'
import {createHash, randomUUID} from 'node:crypto'
import path from 'node:path'
import {isProxyTimeout} from './app-pages.mjs'
import {groupBusinesses, mergeBusinesses, normalizeObservations, observationStopReason, pageFingerprint} from './dianping-results.mjs'

export const DIANPING_BUNDLE = 'com.dianping.dpscope'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

class QueryStop extends Error {
  constructor(status) { super(status); this.status = status }
}

export function pageArtifactPath(base, pageIndex) {
  if (!base || pageIndex === 1) return base
  const extension = path.extname(base)
  return base.slice(0, base.length - extension.length) + '.p' + pageIndex + extension
}

export function queryOptions({query, extractionPath, screenshotPath, sourcePath, maxPages = 3}) {
  if (typeof query !== 'string' || !query.trim() || Array.from(query).length > 120 || /[\x00-\x1f]/.test(query)) {
    throw new Error('query must be non-empty, up to 120 characters, without control characters')
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error('max-pages must be an integer from 1 to 5')
  if (!extractionPath && !screenshotPath) throw new Error('provide --extract-output or --screenshot-output')
  if (!extractionPath) maxPages = 1
  return {query: query.trim(), extractionPath: extractionPath ? path.resolve(extractionPath) : null,
    screenshotPath: screenshotPath ? path.resolve(screenshotPath) : null,
    sourcePath: sourcePath ? path.resolve(sourcePath) : null, maxPages}
}

export async function preflightArtifacts(options) {
  const paths = [options.extractionPath]
  for (let index = 1; index <= options.maxPages; index++) {
    paths.push(pageArtifactPath(options.sourcePath, index), pageArtifactPath(options.screenshotPath, index))
  }
  const destinations = paths.filter(Boolean)
  if (new Set(destinations).size !== destinations.length) throw new Error('output paths must be distinct')
  for (const destination of destinations) {
    await access(path.dirname(destination), constants.W_OK)
    try {
      await lstat(destination)
      throw new Error('output already exists; choose a new path: ' + destination)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

// Publish a completed file without clobbering an existing file or symlink.
export async function publishArtifact(destination, data) {
  const temporary = destination + '.' + randomUUID() + '.tmp'
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await link(temporary, destination)
    return {path: destination, captured: true, sha256: sha256(data)}
  } finally {
    await handle?.close()
    await rm(temporary, {force: true})
  }
}

function viewport(xml) {
  const application = xml.match(/<XCUIElementTypeApplication\b[^>]*>/)?.[0] || ''
  const width = Number(application.match(/\bwidth="([\d.]+)"/)?.[1])
  const height = Number(application.match(/\bheight="([\d.]+)"/)?.[1])
  if (!(width > 0 && height > 0)) throw new QueryStop('viewport-unavailable')
  return {width, height}
}

function sourceStop(xml) {
  if (/SBCoverSheetWindow|lockscreen-date-view|XCUIElementTypeSecureTextField/.test(xml)) return 'blocked-credential'
  if (/允许.*(?:定位|通讯录|照片)|想要访问您的|Would Like to Access/.test(xml)) return 'blocked-permission'
  return observationStopReason(xml)
}

function id(element) { return element?.['element-6066-11e4-a52e-4f735466cecf'] || element?.ELEMENT }
async function find(client, sid, using, value) {
  try { return await client.findElement(sid, using, value) }
  catch (error) { if (error.code === 'no such element') return null; throw error }
}

export async function capturePages({maxPages, capture, scroll, sleep = pause}) {
  const pages = []
  let stopReason = 'max-pages'
  let section = 'primary'
  let noNew = 0
  let failure = null
  let scrollAttempts = 0
  const fingerprints = new Set()
  for (let index = 1; index <= maxPages; index++) {
    try {
      const page = await capture(index, section)
      const grouped = groupBusinesses(page.observations, {pageIndex: index,
        initialSection: index > 1 && section === 'primary' ? 'unknown' : section})
      section = grouped.sectionAfter
      page.businesses = grouped.businesses
      const fingerprint = pageFingerprint(page.observations)
      const previousCount = mergeBusinesses(pages).length
      const previousPage = pages.at(-1)
      const stationaryCards = previousPage?.businesses.length > 0 && page.businesses.length === previousPage.businesses.length
        && page.businesses.every((business, offset) => {
          const previous = previousPage.businesses[offset]
          const currentRow = page.observations.find((row) => row.id === business.name.observationIds[0])
          const previousRow = previousPage.observations.find((row) => row.id === previous.name.observationIds[0])
          return business.name.value === previous.name.value && Math.abs(currentRow.y - previousRow.y) < 0.008
        })
      pages.push(page)
      noNew = mergeBusinesses(pages).length === previousCount ? noNew + 1 : 0
      if (fingerprints.has(fingerprint) || stationaryCards) { stopReason = 'page-unchanged'; break }
      fingerprints.add(fingerprint)
      if (!page.businesses.length) { stopReason = 'insufficient-result-evidence'; break }
      if (noNew >= 2) { stopReason = 'two-pages-without-new-businesses'; break }
      if (index === maxPages) break
      scrollAttempts++
      await scroll()
      await sleep(1200)
    } catch (error) {
      stopReason = error.status || (isProxyTimeout(error) ? 'protocol-timeout' : 'capture-failed')
      failure = {status: stopReason, message: error.message.slice(0, 500), phase: error.phase || 'capture-or-scroll',
        outcome: error.outcome || 'unknown'}
      break
    }
  }
  if (!failure && !['max-pages', 'page-unchanged', 'two-pages-without-new-businesses'].includes(stopReason)) {
    failure = {status: stopReason, message: 'captured page has insufficient structured result evidence',
      phase: 'parse-results', outcome: 'observed'}
  }
  if (failure) failure.lastPassedStage = pages.length ? 'captured-screen-' + pages.length : 'search-submitted'
  return {pages, businesses: mergeBusinesses(pages), coverage: {
    capturedScreens: pages.length, maxPages, partial: true, exhaustive: false, stopReason, scrollAttempts,
  }, failure}
}

export async function runDianpingQuery(client, sid, input, {recover, requireForeground, sourceText, ocr, sleep = pause}) {
  const options = queryOptions(input)
  await preflightArtifacts(options)
  const artifacts = []
  let phase = 'recover'
  let lastPassedStage = 'preflight'
  const startedAt = new Date().toISOString()
  const runId = randomUUID()
  const guarded = async () => {
    const xml = await client.source(sid)
    const stop = sourceStop(xml)
    if (stop) throw new QueryStop(stop)
    await requireForeground(client, sid, DIANPING_BUNDLE, xml)
    return xml
  }
  const foreground = async () => {
    const active = await client.execute(sid, 'mobile: activeAppInfo')
    const appState = await client.execute(sid, 'mobile: queryAppState', [{bundleId: DIANPING_BUNDLE}])
    if (active?.bundleId !== DIANPING_BUNDLE || appState !== 4) throw new QueryStop('target-app-not-foreground')
  }
  const visualText = async () => {
    const bytes = Buffer.from(await client.screenshot(sid), 'base64')
    const result = await ocr(bytes)
    const stop = observationStopReason(result.text)
    if (stop) throw new QueryStop(stop)
    if (!result.text?.trim()) throw new QueryStop('screen-not-readable')
    return result
  }
  const knownResult = (text) => /地图/.test(text) && /全部/.test(text) && /商户|团购/.test(text)
  const click = async (element) => { await foreground(); await client.clickElement(sid, id(element)) }
  const editor = async () => find(client, sid, 'accessibility id', 'search_keyword_edit')
  const guardedEditor = async () => {
    const xml = await guarded()
    if (!/name="search_keyword_edit"/.test(xml) || !/name="Search"/.test(xml)) {
      throw new QueryStop('search-page-unverified')
    }
    const element = await editor()
    if (!element) throw new QueryStop('search-editor-unavailable')
    return element
  }
  try {
    const recovered = await recover(client, sid, DIANPING_BUNDLE)
    if (!recovered.ok) throw new QueryStop(recovered.status || 'app-recovery-failed')
    lastPassedStage = 'app-ready'
    phase = 'navigate-home'
    let xml = await guarded()
    let home = await find(client, sid, 'accessibility id', '搜索按钮')
    const seen = new Set()
    for (let back = 0; !home && back < 5; back++) {
      xml = await guarded()
      let semanticBack = await find(client, sid, '-ios predicate string', "name == '返回' AND visible == 1")
      if (!semanticBack && /name="商户二维码"/.test(xml)) {
        const size = viewport(xml)
        if (size.width !== 414 || size.height !== 896) throw new QueryStop('unsupported-coordinate-layout')
        semanticBack = await find(client, sid, '-ios predicate string',
          "type == 'XCUIElementTypeImage' AND visible == 1 AND rect.x < 45 AND rect.y >= 45 AND rect.y < 90 AND rect.width <= 35 AND rect.height <= 35")
      }
      if (semanticBack) await click(semanticBack)
      else {
        let text = sourceText(await client.execute(sid, 'mobile: source', [{format: 'json'}]))
          .map((row) => row.text).join('\n')
        if (!/最近搜索|历史搜索|搜索发现|店内热搜|本店.*相关内容/.test(text)) text = (await visualText()).text
        const signature = sha256(text)
        if (seen.has(signature)) throw new QueryStop('navigation-unchanged')
        seen.add(signature)
        if (!knownResult(text) && !/最近搜索|历史搜索|搜索发现|店内热搜|本店.*相关内容/.test(text)) {
          throw new QueryStop('coordinate-target-unverified')
        }
        const size = viewport(xml)
        if (size.width !== 414 || size.height !== 896) throw new QueryStop('unsupported-coordinate-layout')
        await foreground()
        await client.tap(sid, 28, 60)
      }
      await sleep(500)
      await guarded()
      home = await find(client, sid, 'accessibility id', '搜索按钮')
    }
    if (!home) throw new QueryStop('home-search-unavailable')
    phase = 'open-search'
    await click(home)
    await sleep(700)
    xml = await guarded()
    let inputElement = await editor()
    if (!inputElement) {
      const visual = await visualText()
      if (!knownResult(visual.text)) throw new QueryStop('coordinate-target-unverified')
      const size = viewport(xml)
      if (size.width !== 414 || size.height !== 896) throw new QueryStop('unsupported-coordinate-layout')
      await foreground()
      await client.tap(sid, 337, 72)
      await sleep(500)
      await guarded()
      inputElement = await editor()
    }
    if (!inputElement) throw new QueryStop('search-editor-unavailable')
    phase = 'replace-query'
    inputElement = await guardedEditor()
    await client.clearElement(sid, id(inputElement))
    inputElement = await guardedEditor()
    await client.setElementValue(sid, id(inputElement), options.query)
    phase = 'submit-query'
    await guardedEditor()
    const inputView = await visualText()
    const inputHeader = normalizeObservations(inputView.observations, 'vision-ocr')
      .filter((row) => row.y < 0.15).map((row) => row.text).join('')
    const canonicalQuery = (text) => text.normalize('NFKC').replace(/\s/g, '').toLowerCase()
    if (!canonicalQuery(inputHeader).includes(canonicalQuery(options.query))) throw new QueryStop('query-input-unverified')
    await guardedEditor()
    const submit = await find(client, sid, 'accessibility id', 'Search')
    if (!submit) throw new QueryStop('search-submit-unavailable')
    await click(submit)
    lastPassedStage = 'search-submitted'
    await sleep(1500)

    phase = 'capture-pages'
    const captured = await capturePages({maxPages: options.maxPages, sleep, capture: async (pageIndex) => {
      const xml = await guarded()
      const size = viewport(xml)
      const readAt = new Date().toISOString()
      const native = await client.execute(sid, 'mobile: source', [{format: 'json'}])
      const stop = sourceStop(JSON.stringify(native))
      if (stop) throw new QueryStop(stop)
      const rows = normalizeObservations(sourceText(native), 'accessibility', size)
      let method = 'accessibility'
      let observations = rows
      let bytes
      let raw = {text: rows.map((row) => row.text).join('\n')}
      if (!groupBusinesses(rows, {pageIndex}).businesses.length) {
        await guarded()
        bytes = Buffer.from(await client.screenshot(sid), 'base64')
        raw = await ocr(bytes)
        const reason = observationStopReason(raw.text)
        if (reason) throw new QueryStop(reason)
        if (!raw.text?.trim()) throw new QueryStop('screen-not-readable')
        method = 'vision-ocr'
        observations = normalizeObservations(raw.observations, method, size)
      }
      await guarded()
      const queryHeader = observations.filter((row) => row.y < 0.15).map((row) => row.text).join('')
      if (pageIndex === 1 && (!knownResult(raw.text) || !canonicalQuery(queryHeader).includes(canonicalQuery(options.query)))) {
        throw new QueryStop('query-or-result-scope-unverified')
      }
      const pageArtifacts = {}
      if (options.sourcePath) {
        pageArtifacts.source = await publishArtifact(pageArtifactPath(options.sourcePath, pageIndex), xml)
        artifacts.push(pageArtifacts.source)
      }
      if (options.screenshotPath) {
        bytes ||= Buffer.from(await client.screenshot(sid), 'base64')
        pageArtifacts.screenshot = await publishArtifact(pageArtifactPath(options.screenshotPath, pageIndex), bytes)
        artifacts.push(pageArtifacts.screenshot)
      }
      return {pageIndex, readAt, method, viewport: size, observations, text: raw.text,
        snapshotNote: 'UI source and pixels are sequential observations; not an atomic snapshot', artifacts: pageArtifacts}
    }, scroll: async () => {
      await guarded()
      await client.execute(sid, 'mobile: swipe', [{direction: 'up', velocity: 500}])
    }})
    const {pages, businesses, coverage, failure} = captured
    const blocked = !['max-pages', 'page-unchanged', 'two-pages-without-new-businesses'].includes(coverage.stopReason)
    const result = {
      schemaVersion: 2, documentType: 'place-search-v2', runId, platform: 'dianping', bundleId: DIANPING_BUNDLE, query: options.query,
      readAt: pages[0]?.readAt || startedAt, finishedAt: new Date().toISOString(),
      method: new Set(pages.map((page) => page.method)).size > 1 ? 'mixed' : pages[0]?.method || null,
      factStatus: 'unverified', status: blocked ? (pages.length ? 'partial' : coverage.stopReason) : 'observations-extracted',
      coverage, pages, businesses, visualReviewRequired: !businesses.length || businesses.some((business) => business.needsReview),
      confidenceMeaning: 'raw recognizer score, not a calibrated accuracy or fact verification probability',
      failure: failure ? {...failure, lastPassedStage: pages.length ? 'captured-screen-' + pages.length : lastPassedStage} : null, artifacts,
    }
    phase = 'publish-result'
    if (options.extractionPath) artifacts.push(await publishArtifact(options.extractionPath, JSON.stringify(result, null, 2)))
    return {ok: !blocked && businesses.length > 0, status: result.status,
      query: options.query, runId, extraction: options.extractionPath, capturedScreens: pages.length,
      businesses: businesses.length, coverage, failure: result.failure, visualReviewRequired: result.visualReviewRequired, artifacts}
  } catch (error) {
    return {ok: false, status: error.status || (isProxyTimeout(error) ? 'protocol-timeout' : 'query-failed'),
      runId, phase, lastPassedStage, outcome: error.outcome || 'unknown', retryable: false,
      transportPending: error.transportPending === true, error: error.message.slice(0, 500), artifacts}
  }
}
