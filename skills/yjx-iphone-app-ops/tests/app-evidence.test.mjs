import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {collectSourceText} from '../scripts/iphone-app-ops.mjs'
import {extractNoteCards, runXiaohongshuQuery} from '../scripts/xiaohongshu-query.mjs'
import {runDianpingShare} from '../scripts/dianping-share.mjs'
import {extractDetailFields, runDianpingDetail} from '../scripts/dianping-detail.mjs'

const xhs = JSON.parse(await readFile(new URL('./fixtures/xhs-visible-cards.json', import.meta.url), 'utf8'))
const detail = JSON.parse(await readFile(new URL('./fixtures/dianping-detail-lines.json', import.meta.url), 'utf8'))

test('actual XHS cells exclude AI summary and advertisement and keep the correct author', () => {
  const result = extractNoteCards(xhs.tree, {width: 414, height: 896}, collectSourceText)
  assert.equal(result.candidates.length, 1)
  assert.match(result.candidates[0].cardText, /^鹭岛书市/)
  assert.equal(result.candidates[0].authorObserved, '必有特福文创店')
  assert.equal(result.candidates[0].timeObserved, '昨天 20:03')
  assert.equal(result.excludedCards, 1)
})

test('detail hours remain with shop state; address continuation keeps original confidence', () => {
  const result = extractDetailFields(detail)
  assert.equal(result.hours.value, '08:00-21:00')
  assert.ok(!result.hours.evidence.some((text) => /商品|全周|00:18/.test(text)))
  assert.match(result.address.value, /300号-1.*正门口/)
  assert.equal(result.address.confidence, 0.3)
  assert.deepEqual(result.address.observationIds, [26, 27])
})

test('XHS reacquires the editor after focus changes its identity and verifies input before submit', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xhs-editor-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const xml = '<XCUIElementTypeApplication width="414" height="896"><XCUIElementTypeTextView value="厦门 周末 活动" visible="true" y="59"/><Button name="recommend_search_button"/><Button name="全部"/><Button name="用户"/></XCUIElementTypeApplication>'
  let identity = 'header', input = '', submitted = 0
  const client = {
    source: async () => xml,
    findElement: async (_sid, using) => ({ELEMENT: using === '-ios class chain' ? identity : 'submit'}),
    elementRect: async () => ({x: 59, y: 59, width: 248, height: 22}),
    clickElement: async (_sid, id) => { if (id === 'submit') submitted++; else identity = 'focused' },
    clearElement: async (_sid, id) => { assert.equal(id, 'focused'); input = '' },
    setElementValue: async (_sid, id, value) => { assert.equal(id, 'focused'); input = value },
    elementAttribute: async () => input,
    execute: async () => xhs.tree,
  }
  const deps = {recover: async () => ({ok: true}), requireForeground: async () => {}, sourceText: collectSourceText, sleep: async () => {}}
  const ok = await runXiaohongshuQuery(client, 'sid', {query: '厦门 周末 活动', output: path.join(directory, 'ok.json'), maxPages: 1}, deps)
  assert.equal(ok.ok, true)
  assert.equal(submitted, 1)
  client.elementAttribute = async () => '截断查询'
  const blocked = await runXiaohongshuQuery(client, 'sid', {query: '厦门 周末 活动', output: path.join(directory, 'blocked.json'), maxPages: 1}, deps)
  assert.equal(blocked.failure.status, 'query-input-unverified')
  assert.equal(submitted, 1)
})

test('decoded QR evidence survives a failed final foreground read as partial', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qr-state-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const from = path.join(directory, 'detail.json'), output = path.join(directory, 'share.json')
  let name = '五兰沙茶面（曾厝垵店）', address = null
  await writeFile(from, JSON.stringify({status: 'detail-observed', bundleId: 'com.dianping.dpscope', name,
    readAt: new Date().toISOString(), runId: 'detail-run', candidateId: 'candidate-6', identity: {sourceRunId: 'run-1'}}))
  let decoded = false
  const client = {
    source: async () => { throw Error('QR read must not take an XML snapshot') },
    execute: async (_sid, script) => {
      if (decoded) throw Object.assign(new Error('read timed out'), {code: 'ETIMEDOUT', outcome: 'unknown'})
      return script === 'mobile: activeAppInfo' ? {bundleId: 'com.dianping.dpscope'} : 4
    }, screenshot: async () => Buffer.from('pixels').toString('base64'),
    clickElement: async () => { throw new Error('no click expected') },
  }
  const result = await runDianpingShare(client, 'sid', {from, output}, {
    requireForeground: async () => {}, sourceText: () => [],
    ocr: async () => { decoded = true; return {qrPayloads: ['https://m.dianping.com/shopinfo/test'],
      observations: [{text: '商户二维码', confidence: 1, x: 0.3, y: 0.9, width: 0.4, height: 0.02},
        {text: name, confidence: 1, x: 0.2, y: 0.7, width: 0.6, height: 0.02},
        ...(address ? [{text: address, confidence: 1, x: 0.2, y: 0.6, width: 0.6, height: 0.02}] : [])]} },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial')
  const saved = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(saved.verification, 'qr-observed-state-unconfirmed')
  assert.equal(saved.page.qrPayloads.length, 1)
  assert.equal(saved.failure.status, 'protocol-timeout')
  assert.equal(saved.sourceCandidateId, 'candidate-6')
  assert.equal(saved.sourceSearchRunId, 'run-1')
  assert.equal(saved.sourceDetailRunId, 'detail-run')
  // A plain brand name needs the same observed address even on the error path.
  name = '五兰沙茶面'; address = '思明区教堂街300号'; decoded = false
  await writeFile(from, JSON.stringify({status: 'detail-observed', bundleId: 'com.dianping.dpscope', name,
    readAt: new Date().toISOString(), runId: 'detail-run', candidateId: 'candidate-6',
    identity: {sourceRunId: 'run-1'}, fields: {address: {value: address}}}))
  const addressOutput = path.join(directory, 'address-share.json')
  const addressResult = await runDianpingShare(client, 'sid', {from, output: addressOutput}, {
    requireForeground: async () => {}, sourceText: () => [],
    ocr: async () => { decoded = true; return {qrPayloads: ['https://m.dianping.com/shopinfo/test'], observations: [
      {text: '商户二维码', confidence: 1, x: 0.3, y: 0.9, width: 0.4, height: 0.02},
      {text: name, confidence: 1, x: 0.2, y: 0.7, width: 0.6, height: 0.02},
      {text: address, confidence: 1, x: 0.2, y: 0.6, width: 0.6, height: 0.02}]} },
  })
  assert.equal(addressResult.status, 'partial')
  const addressSaved = JSON.parse(await readFile(addressOutput, 'utf8'))
  assert.deepEqual(addressSaved.branchEvidence.addressObservationIds, [2])
})

test('current detail mode reads fresh fields without using old list coordinates or refreshing its history', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'detail-current-'))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const from = path.join(directory, 'old-search.json'), output = path.join(directory, 'detail.json')
  const name = '五兰沙茶面（曾厝垵店）'
  const historical = '2020-01-01T00:00:00Z'
  await writeFile(from, JSON.stringify({schemaVersion: 2, platform: 'dianping', bundleId: 'com.dianping.dpscope',
    runId: 'original-search', query: '沙茶面', readAt: historical, finishedAt: historical,
    businesses: [{id: 'candidate-1', name: {value: name}, reviewReasons: []}]}))
  const rows = detail.observations.map((row) => ({text: row.text, rect: {x: row.x * 414, y: row.y * 896,
    width: row.width * 414, height: row.height * 896}}))
  const client = {source: async () => '<XCUIElementTypeApplication width="414" height="896"/>',
    execute: async () => ({}), tap: async () => { throw Error('read-only mode must not tap') }}
  const result = await runDianpingDetail(client, 'sid', {from, candidateId: 'candidate-1', output, current: true}, {
    requireForeground: async () => {}, sourceText: () => rows,
    ocr: async () => { throw Error('native fields suffice') },
  })
  assert.equal(result.ok, true)
  const saved = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(saved.identity.searchReadAt, historical)
  assert.equal(saved.identity.acquisition, 'current-detail-read-only')
  assert.ok(Date.parse(saved.readAt) > Date.parse(historical))
  assert.match(saved.fields.address.value, /300号-1/)
})
