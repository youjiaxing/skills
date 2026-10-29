import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, readdir, rm, symlink} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {capturePages, publishArtifact, runDianpingQuery} from '../scripts/dianping-query.mjs'
import {groupBusinesses, mergeBusinesses, normalizeObservations} from '../scripts/dianping-results.mjs'
import {toLifeQueryCandidates} from '../../yjx-life-query/scripts/dianping-observations.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixtures/dianping-coffee-ocr.json', import.meta.url), 'utf8'))
const observations = normalizeObservations(fixture.observations, 'vision-ocr')
const page = (index = 1) => ({pageIndex: index, readAt: fixture.capturedAt, method: 'vision-ocr',
  observations, businesses: groupBusinesses(observations, {pageIndex: index}).businesses})

test('real captured cards keep raw low confidence, field ownership and ad exclusion', () => {
  const businesses = page().businesses
  assert.equal(businesses[0].name.value, 'BL Coffee（航空古地石•灵感店）')
  assert.equal(businesses[0].pricePerPerson.value, 37)
  assert.equal(businesses[1].pricePerPerson.value, 43)
  assert.equal(businesses[0].rating.confidence, 0.3)
  assert.equal(businesses[0].needsReview, true)
  assert.equal(businesses[2].section, 'recommended')
  assert.ok(!businesses.some((business) => /千层塔|限时|甄选单人餐/.test(business.name.value)))
})

test('overlap preserves sightings; same names in different areas and conflicts stay separate', () => {
  const first = page(1)
  const next = structuredClone(page(2))
  let merged = mergeBusinesses([first, next])
  assert.equal(merged.length, first.businesses.length)
  assert.deepEqual(merged[0].sightings.map((seen) => seen.pageIndex), [1, 2])
  next.businesses[0].area.value.district = '五缘湾'
  merged = mergeBusinesses([first, next])
  assert.equal(merged.length, first.businesses.length + 1)
  next.businesses[0].area = structuredClone(first.businesses[0].area)
  next.businesses[0].pricePerPerson.value = 999
  merged = mergeBusinesses([first, next])
  assert.ok(merged.find((item) => item.possibleDuplicateOf))
  assert.equal(first.businesses[0].pricePerPerson.value, 37)
})

test('truncated shop names are flagged and never used as dedup identity', () => {
  const a = structuredClone(page(1))
  a.businesses[0].name.value += '（软二'
  a.businesses[0].reviewReasons.push('name-truncated')
  const b = structuredClone(a); b.pageIndex = 2
  const merged = mergeBusinesses([a, b])
  assert.equal(merged.filter((item) => item.name.value.endsWith('（软二')).length, 2)
})

test('unchanged page stops without another scroll; verification preserves partial pages', async () => {
  let scrolls = 0
  const same = await capturePages({maxPages: 5, capture: async (index) => page(index),
    scroll: async () => { scrolls++ }, sleep: async () => {}})
  assert.equal(scrolls, 1)
  assert.equal(same.coverage.stopReason, 'page-unchanged')
  assert.equal(same.businesses[0].sightings.length, 2)
  scrolls = 0
  const blocked = await capturePages({maxPages: 3, capture: async (index) => {
    if (index === 2) throw Object.assign(new Error('verification'), {status: 'blocked-verification'})
    return page(index)
  }, scroll: async () => { scrolls++ }, sleep: async () => {}})
  assert.equal(scrolls, 1)
  assert.equal(blocked.coverage.capturedScreens, 1)
  assert.equal(blocked.coverage.stopReason, 'blocked-verification')
  assert.equal(blocked.coverage.exhaustive, false)
})

test('producer pages survive consumer conversion with all field evidence references', () => {
  const first = page()
  const document = {schemaVersion: 2, platform: 'dianping', bundleId: 'com.dianping.dpscope',
    query: fixture.query, method: first.method, readAt: first.readAt, finishedAt: first.readAt, status: 'observations-extracted', factStatus: 'unverified',
    coverage: {capturedScreens: 1, maxPages: 3, partial: true, exhaustive: false, stopReason: 'max-pages'},
    pages: [first], businesses: mergeBusinesses([first])}
  const consumed = toLifeQueryCandidates(document)
  const rating = consumed.candidates[0].fields.rating
  assert.equal(rating.recognitionConfidence, 0.3)
  assert.equal(rating.factStatus, 'unverified')
  assert.equal(rating.evidenceRefs[0].pageIndex, 1)
  assert.equal(consumed.candidates[0].extractionNeedsReview, true)
  const broken = structuredClone(document)
  broken.businesses[0].sightings[0].business.rating.observationIds = [9999]
  assert.throws(() => toLifeQueryCandidates(broken), /dangling field evidence/)
})

test('publishing never overwrites files or symlink targets and cleans staging files', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-artifact-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const file = path.join(directory, 'result.json')
  await publishArtifact(file, 'old')
  await assert.rejects(publishArtifact(file, 'new'), {code: 'EEXIST'})
  assert.equal(await readFile(file, 'utf8'), 'old')
  const alias = path.join(directory, 'alias.json')
  await symlink(file, alias)
  await assert.rejects(publishArtifact(alias, 'new'), {code: 'EEXIST'})
  assert.deepEqual((await readdir(directory)).sort(), ['alias.json', 'result.json'])
})

test('unverified coordinate page or a new verification stops before taps and query input', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-gate-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const xml = '<XCUIElementTypeApplication bundleId="com.dianping.dpscope" width="414" height="896"/>'
  const actions = []
  const client = {
    source: async () => xml,
    findElement: async () => { throw Object.assign(new Error('missing'), {code: 'no such element'}) },
    execute: async (_sid, script) => script === 'mobile: activeAppInfo' ? {bundleId: 'com.dianping.dpscope'} : 4,
    screenshot: async () => Buffer.from('fake pixels').toString('base64'),
    tap: async () => actions.push('tap'),
    setElementValue: async () => actions.push('input'),
  }
  const result = await runDianpingQuery(client, 'session', {query: '咖啡', extractionPath: path.join(directory, 'result.json')}, {
    recover: async () => ({ok: true}), requireForeground: async () => {}, sourceText: () => [],
    ocr: async () => ({text: '请依次点击下图图标', observations: []}), sleep: async () => {},
  })
  assert.equal(result.status, 'blocked-verification')
  assert.deepEqual(actions, [])
  assert.deepEqual(await readdir(directory), [])
})

test('consumer rejects inflated confidence and reconstructs review from raw evidence', () => {
  const first = page()
  const document = {schemaVersion: 2, platform: 'dianping', bundleId: 'com.dianping.dpscope',
    query: fixture.query, method: first.method, readAt: first.readAt, finishedAt: first.readAt, status: 'observations-extracted', factStatus: 'unverified',
    coverage: {capturedScreens: 1, partial: true, exhaustive: false, stopReason: 'max-pages'},
    pages: [first], businesses: mergeBusinesses([first]), visualReviewRequired: false}
  for (const business of document.businesses) {
    business.needsReview = false; business.reviewReasons = []
    for (const sighting of business.sightings) {
      sighting.business.needsReview = false; sighting.business.reviewReasons = []
    }
  }
  const consumed = toLifeQueryCandidates(document)
  assert.equal(consumed.extractionNeedsReview, true)
  assert.ok(consumed.candidates[0].reviewReasons.includes('low-recognition-confidence'))
  document.businesses[0].rating.confidence = 1
  document.businesses[0].sightings[0].business.rating.confidence = 1
  assert.throws(() => toLifeQueryCandidates(document), /raw observations/)
})

test('second screen timeout keeps prior pages and failure through consumption', async () => {
  const captured = await capturePages({maxPages: 3, capture: async (index) => {
    if (index > 1) throw Object.assign(new Error('read timeout'), {code: 'ETIMEDOUT', phase: 'source', outcome: 'not-sent'})
    return page(index)
  }, scroll: async () => {}, sleep: async () => {}})
  const consumed = toLifeQueryCandidates({schemaVersion: 2, platform: 'dianping', bundleId: 'com.dianping.dpscope',
    query: fixture.query, method: 'vision-ocr', readAt: fixture.capturedAt, finishedAt: fixture.capturedAt, factStatus: 'unverified', status: 'partial', ...captured})
  assert.equal(consumed.failure.status, 'protocol-timeout')
  assert.equal(consumed.coverage.capturedScreens, 1)
  assert.ok(consumed.candidates.length > 0)
})

test('legacy observations force review and normalize artifact records', () => {
  const consumed = toLifeQueryCandidates({schemaVersion: 1, platform: 'dianping', bundleId: 'com.dianping.dpscope',
    query: fixture.query, method: 'vision-ocr', readAt: fixture.capturedAt, factStatus: 'unverified',
    businesses: page().businesses, artifacts: {source: '/tmp/old.xml'}})
  assert.equal(consumed.candidates[0].fields.rating.recognitionConfidence, null)
  assert.equal(consumed.candidates[0].extractionNeedsReview, true)
  assert.deepEqual(consumed.artifacts, [{kind: 'source', legacy: true, path: '/tmp/old.xml'}])
})

test('unverified input text cannot submit a different search', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'iphone-input-gate-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const actions = []
  const xml = '<XCUIElementTypeApplication bundleId="com.dianping.dpscope" width="414" height="896"><Text name="search_keyword_edit"/><Button name="Search"/></XCUIElementTypeApplication>'
  const result = await runDianpingQuery({
    source: async () => xml,
    findElement: async (_sid, _using, value) => ({ELEMENT: value}),
    execute: async (_sid, script) => script === 'mobile: activeAppInfo' ? {bundleId: 'com.dianping.dpscope'} : 4,
    clickElement: async (_sid, element) => actions.push(element),
    clearElement: async () => {}, setElementValue: async () => {},
    screenshot: async () => Buffer.from('pixels').toString('base64'),
  }, 'session', {query: '沙茶面 厦门', extractionPath: path.join(directory, 'result.json')}, {
    recover: async () => ({ok: true}), requireForeground: async () => {}, sourceText: () => [],
    ocr: async () => ({text: '错误查询', observations: []}), sleep: async () => {},
  })
  assert.equal(result.status, 'query-input-unverified')
  assert.deepEqual(actions, ['搜索按钮'])
})

test('a located query control is clicked after lightweight foreground checks without a duplicate deep snapshot', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dianping-click-gate-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const xml = '<XCUIElementTypeApplication bundleId="com.dianping.dpscope" width="414" height="896"><Button name="搜索按钮"/></XCUIElementTypeApplication>'
  let sourceCalls = 0, sourceCallsAtClick = null, clicked = false
  const client = {
    source: async () => { sourceCalls++; return xml },
    execute: async (_sid, script) => script === 'mobile: activeAppInfo' ? {bundleId: 'com.dianping.dpscope'} : 4,
    findElement: async (_sid, using, value) => {
      if (using === 'accessibility id' && value === '搜索按钮') return {ELEMENT: 'search'}
      throw Object.assign(new Error('missing'), {code: 'no such element'})
    },
    clickElement: async () => { sourceCallsAtClick = sourceCalls; clicked = true },
  }
  const result = await runDianpingQuery(client, 'sid', {query: '沙茶面', extractionPath: path.join(directory, 'out.json')}, {
    recover: async () => ({ok: true}), requireForeground: async () => {}, sourceText: () => [],
    ocr: async () => ({text: '未识别', observations: []}), sleep: async () => {},
  })
  assert.equal(clicked, true)
  assert.ok(['open-search', 'replace-query'].includes(result.phase))
  assert.equal(sourceCallsAtClick, 1)
})

test('same-screen same-name cards remain independent and damaged candidate sets are rejected', () => {
  const first = page()
  const duplicate = structuredClone(first.businesses[0])
  first.businesses.push(duplicate)
  const merged = mergeBusinesses([first])
  assert.equal(merged.length, first.businesses.length)
  assert.equal(merged.at(-1).possibleDuplicateOf, merged[0].id)
  const clean = page()
  const document = {schemaVersion: 2, platform: 'dianping', bundleId: 'com.dianping.dpscope',
    query: fixture.query, method: clean.method, readAt: clean.readAt, finishedAt: clean.readAt,
    status: 'observations-extracted', factStatus: 'unverified',
    coverage: {capturedScreens: 1, partial: true, exhaustive: false, stopReason: 'max-pages'},
    pages: [clean], businesses: mergeBusinesses([clean])}
  const missing = structuredClone(document); missing.businesses.pop()
  assert.throws(() => toLifeQueryCandidates(missing), /candidate list/)
  const section = structuredClone(document); section.businesses[0].section = 'recommended'
  assert.throws(() => toLifeQueryCandidates(section), /section/)
  const ambiguous = structuredClone(document); ambiguous.businesses[0].rating.ambiguous = true
  ambiguous.businesses[0].sightings[0].business.rating.ambiguous = true
  assert.throws(() => toLifeQueryCandidates(ambiguous), /raw observations/)
  const noStatus = structuredClone(document); delete noStatus.status
  assert.throws(() => toLifeQueryCandidates(noStatus), /invalid observation status/)
})

test('partial observations require failure provenance and a consistent timeline', () => {
  const first = page()
  const document = {schemaVersion: 2, platform: 'dianping', bundleId: 'com.dianping.dpscope',
    query: fixture.query, method: first.method, readAt: first.readAt, finishedAt: first.readAt,
    status: 'partial', factStatus: 'unverified', coverage: {capturedScreens: 1, partial: true,
      exhaustive: false, stopReason: 'blocked-verification'}, pages: [first], businesses: mergeBusinesses([first]), failure: null}
  assert.throws(() => toLifeQueryCandidates(document), /missing failure provenance/)
  document.failure = {status: 'blocked-verification', phase: 'capture', outcome: 'not-sent'}
  assert.equal(toLifeQueryCandidates(document).extractionNeedsReview, true)
  const unknown = structuredClone(document); unknown.coverage.stopReason = 'made-up'; unknown.failure.status = 'made-up'
  assert.throws(() => toLifeQueryCandidates(unknown), /unknown capture stop reason/)
  document.finishedAt = '2000-01-01T00:00:00Z'
  assert.throws(() => toLifeQueryCandidates(document), /timeline/)
})
