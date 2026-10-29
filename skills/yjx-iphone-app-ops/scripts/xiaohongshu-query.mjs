import {createHash, randomUUID} from 'node:crypto'
import {AppStop, canonicalText, elementId, guardApp, isProxyTimeout, pageStop} from './app-pages.mjs'
import {preflightArtifacts, publishArtifact} from './dianping-query.mjs'

export const XHS_BUNDLE = 'com.xingin.discover'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const visible = (node) => node.visible === true || node.isVisible === true || node.isVisible === '1'
const type = (node) => (node.type || '').replace('XCUIElementType', '')
const hash = (value) => createHash('sha256').update(value).digest('hex')

export function extractNoteCards(tree, {width, height}, sourceText) {
  const candidates = []
  let excludedCards = 0
  function walk(node) {
    const rect = node.rect
    if (type(node) === 'Cell' && visible(node) && rect?.width > width * 0.35 && rect.width < width * 0.65 && rect.height > 100) {
      const allText = JSON.stringify(node)
      if (/ai参考小红书|全网内容生成|"(?:label|name|value)":"广告"/.test(allText)) { excludedCards++; return }
      const rows = sourceText(node).filter((row) => row.type?.includes('StaticText') && row.rect?.y >= 135 && row.rect.y < height * 0.95)
      const unique = rows.filter((row, index) => !rows.slice(0, index).some((earlier) => earlier.text === row.text && earlier.rect.y === row.rect.y))
        .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      const textual = unique.filter((row) => row.text.length > 2 && !/^\d+(?:\.\d+)?[万wW]?$/.test(row.text))
      if (textual.length >= 2) {
        const time = textual.find((row) => /^(?:\d+天前|昨天|今天|\d{2,4}[-/]\d{1,2})/.test(row.text))
        const title = textual[0]
        const author = textual.filter((row) => row !== title && row !== time).at(-1)
        if (author && title.rect.y < author.rect.y) candidates.push({cardText: title.text, authorObserved: author.text,
          timeObserved: time?.text || null, url: null, noteId: null, factStatus: 'unverified', reviewRequired: true,
          evidence: unique.map((row, id) => ({id, text: row.text, rect: row.rect})), cellRect: rect})
      }
      return
    }
    for (const child of node.children || []) walk(child)
  }
  walk(tree)
  return {candidates, excludedCards}
}

async function find(client, sid, using, selector) {
  try { return await client.findElement(sid, using, selector) }
  catch (error) { if (error.code === 'no such element') return null; throw error }
}

export async function runXiaohongshuQuery(client, sid, {query, output, maxPages = 3}, deps) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100 || !output || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error('xiaohongshu-search requires query, new output path and max-pages 1..5')
  await preflightArtifacts({extractionPath: output, maxPages})
  const artifacts = [], pages = []
  const runId = randomUUID()
  let phase = 'recover', failure = null, stopReason = 'max-pages', scrollAttempts = 0
  const guard = () => guardApp(client, sid, XHS_BUNDLE, deps)
  const predicate = (selector) => find(client, sid, '-ios predicate string', selector)
  const searchButton = () => find(client, sid, 'accessibility id', 'recommend_search_button')
  const editor = async () => {
    const xml = await guard()
    if (!/name="recommend_search_button"/.test(xml) || !/<XCUIElementTypeTextView\b[^>]*visible="true"/.test(xml)) throw new AppStop('search-page-unverified')
    const found = await find(client, sid, '-ios class chain', '**/XCUIElementTypeTextView[`visible == 1`][1]')
    if (!found) throw new AppStop('search-editor-unavailable')
    const rect = await client.elementRect(sid, elementId(found))
    if (rect.x < 40 || rect.y < 40 || rect.y > 95 || rect.width < 150 || rect.height > 50) throw new AppStop('search-editor-layout-unverified')
    return found
  }
  try {
    const recovered = await deps.recover(client, sid, XHS_BUNDLE)
    if (!recovered.ok) throw new AppStop(recovered.status || 'app-recovery-failed')
    phase = 'open-search'
    let submit = await searchButton()
    const seen = new Set()
    for (let step = 0; !submit && step < 4; step++) {
      const xml = await guard()
      const fingerprint = hash(xml.replace(/processId="\d+"/g, ''))
      if (seen.has(fingerprint)) throw new AppStop('navigation-unchanged')
      seen.add(fingerprint)
      const home = /name="菜单"/.test(xml) && /name="发现"/.test(xml) && /name="同城"/.test(xml)
      let target
      if (home && /width="414" height="896"/.test(xml)) {
        // This anonymous top-right Button profile was verified on this device.
        target = await predicate("type == 'XCUIElementTypeButton' AND visible == 1 AND rect.x >= 360 AND rect.y >= 40 AND rect.y < 90 AND rect.width <= 55")
      } else target = await predicate("name == '返回' AND visible == 1")
      if (!target) throw new AppStop('search-entry-unverified')
      await guard(); await client.clickElement(sid, elementId(target))
      await (deps.sleep || pause)(600)
      await guard(); submit = await searchButton()
    }
    if (!submit) throw new AppStop('search-page-unavailable')
    phase = 'replace-query'
    let input = await editor()
    if (!input) throw new AppStop('search-editor-unavailable')
    // Results headers become a different TextView when editing starts.
    await guard(); await client.clickElement(sid, elementId(input))
    await (deps.sleep || pause)(500)
    input = await editor()
    await client.clearElement(sid, elementId(input))
    await (deps.sleep || pause)(300)
    input = await editor()
    await client.setElementValue(sid, elementId(input), query)
    phase = 'submit-query'
    input = await editor()
    const actual = await client.elementAttribute(sid, elementId(input), 'value')
    if (canonicalText(actual || '') !== canonicalText(query)) throw new AppStop('query-input-unverified')
    submit = await searchButton(); if (!submit) throw new AppStop('search-submit-unavailable')
    await guard(); await client.clickElement(sid, elementId(submit))
    await (deps.sleep || pause)(1200)
    phase = 'capture-pages'
    const fingerprints = new Set()
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const xml = await guard()
      const header = xml.match(/<XCUIElementTypeTextView\b[^>]*\bvalue="([^"]*)"[^>]*visible="true"[^>]*y="(?:[0-9]|[1-9][0-9])"/)?.[1]
      if (!header || canonicalText(header) !== canonicalText(query) || !/name="全部"/.test(xml) || !/name="用户"/.test(xml)) throw new AppStop('query-or-result-scope-unverified')
      const tree = await client.execute(sid, 'mobile: source', [{format: 'json'}])
      const stop = pageStop(JSON.stringify(tree)); if (stop) throw new AppStop(stop)
      await guard()
      const root = xml.match(/<XCUIElementTypeApplication\b[^>]*>/)?.[0] || ''
      const viewport = {width: Number(root.match(/\bwidth="([\d.]+)"/)?.[1]), height: Number(root.match(/\bheight="([\d.]+)"/)?.[1])}
      if (viewport.width !== 414 || viewport.height !== 896) throw new AppStop('unsupported-layout')
      const grouped = extractNoteCards(tree, viewport, deps.sourceText)
      const page = {pageIndex, readAt: new Date().toISOString(), method: 'accessibility', viewport, ...grouped}
      const fingerprint = hash(JSON.stringify(grouped.candidates.map((item) => [item.cardText, item.authorObserved, Math.round(item.cellRect.y / 10)])))
      pages.push(page)
      if (!grouped.candidates.length) { stopReason = 'note-cards-not-exposed'; break }
      if (fingerprints.has(fingerprint)) { stopReason = 'page-unchanged'; break }
      fingerprints.add(fingerprint)
      if (pageIndex < maxPages) {
        await guard(); scrollAttempts++
        await client.execute(sid, 'mobile: swipe', [{direction: 'up', velocity: 500}])
        await (deps.sleep || pause)(1200)
      }
    }
  } catch (error) {
    stopReason = error.status || (isProxyTimeout(error) ? 'protocol-timeout' : 'query-failed')
    failure = {status: stopReason, phase, outcome: error.outcome || 'unknown', message: error.message.slice(0, 500)}
  }
  const normal = ['max-pages', 'page-unchanged'].includes(stopReason)
  const candidates = []
  for (const page of pages) for (const item of page.candidates) {
    const key = canonicalText(item.cardText) + '|' + canonicalText(item.authorObserved)
    const possible = candidates.find((item) => item.key === key)
    const candidate = {...item, id: 'note-candidate-' + (candidates.length + 1), key,
      sightings: [{pageIndex: page.pageIndex, readAt: page.readAt, evidence: item.evidence}]}
    if (possible) candidate.possibleDuplicateOf = possible.id
    candidates.push(candidate)
  }
  const result = {schemaVersion: 1, documentType: 'note-search-v1', platform: 'xiaohongshu', bundleId: XHS_BUNDLE, runId, query,
    readAt: pages[0]?.readAt || new Date().toISOString(), factStatus: 'unverified',
    status: normal ? 'note-cards-observed' : pages.length ? 'partial' : stopReason,
    coverage: {maxPages, capturedScreens: pages.length, scrollAttempts, stopReason, partial: true, exhaustive: false},
    pages, candidates, failure, reviewRequired: true,
    missingFields: ['original-note-url', 'full-post-content', 'applicable-date-verification']}
  artifacts.push(await publishArtifact(output, JSON.stringify(result, null, 2)))
  return {ok: normal && candidates.length > 0, status: result.status, output, runId, candidates: candidates.length,
    coverage: result.coverage, failure, artifacts}
}
