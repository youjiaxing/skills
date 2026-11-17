import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {deflateSync} from 'node:zlib'
import {createOperations, failureResult} from '../scripts/app-operations.mjs'
import {readAppPage, readAppPixels} from '../scripts/app-pages.mjs'
import {extractDetailFields} from '../scripts/dianping-detail.mjs'
import {runDianpingQuery} from '../scripts/dianping-query.mjs'
import {groupBusinesses, mergeBusinesses, normalizeObservations} from '../scripts/dianping-results.mjs'
import {runDianpingShare} from '../scripts/dianping-share.mjs'
import {collectSourceText, probeSessionHealth} from '../scripts/iphone-app-ops.mjs'
import {serviceAction} from '../scripts/iphone-environment.mjs'
import {extractNoteCards, runXiaohongshuQuery} from '../scripts/xiaohongshu-query.mjs'
import {toLifeQueryCandidates} from '../../yjx-life-query/scripts/dianping-observations.mjs'

function makePng(width, height, paint) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y)
      const off = y * (1 + stride) + 1 + x * 4
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const tag = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    return Buffer.concat([len, tag, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('Review #1: readAppPixels keeps hard stop while readAppPage/observe with XML container evidence sanitize static text', async () => {
  const bundleId = 'org.example.app'
  const pixelClient = {
    execute: async (_sid, s) => s === 'mobile: activeAppInfo' ? {bundleId} : 4,
    screenshot: async () => Buffer.from('img').toString('base64'),
  }
  await assert.rejects(
    readAppPixels(pixelClient, 'sid', bundleId, {ocr: async () => ({observations: [{text: '文章提到验证码 123456', x: 0.1, y: 0.5, width: 0.5, height: 0.03}]})}),
    /blocked-verification/,
  )

  const containerXml = `<XCUIElementTypeApplication bundleId="${bundleId}" width="400" height="800"><XCUIElementTypeStatusBar y="0" height="44"/><XCUIElementTypeStaticText value="用户讨论验证码 654321"/></XCUIElementTypeApplication>`
  const pageClient = {
    source: async () => containerXml,
    execute: async () => ({children: []}),
  }
  const page = await readAppPage(pageClient, 'sid', bundleId, {
    requireForeground: async () => {},
    sourceText: () => [{text: '用户讨论验证码 654321 的问题与正常正文内容展示', rect: {x: 20, y: 260, width: 300, height: 30}}],
  }, {useful: (t) => t.length >= 5})
  assert.equal(page.securityCandidate, true)
  assert.ok(page.stopCandidates.length >= 1)
  assert.ok(!page.text.includes('654321'))

  const alertXml = `<XCUIElementTypeApplication bundleId="${bundleId}" width="400" height="800"><XCUIElementTypeAlert name="安全验证"/></XCUIElementTypeApplication>`
  await assert.rejects(
    readAppPage({source: async () => alertXml, execute: async () => ({})}, 'sid', bundleId, {
      requireForeground: async () => {}, sourceText: () => [],
    }),
    /blocked-verification/,
  )

  const ops = createOperations({
    getContext: async () => 'NATIVE_APP', setContext: async () => {},
    execute: async () => ({children: [{type: 'XCUIElementTypeStaticText', label: '文章提到密码 pass1234', isVisible: true, rect: {x: 10, y: 200, width: 200, height: 20}}]}),
  }, 'sid', {bundleId, guardApp: async () => containerXml})
  const obs = await ops.observe()
  assert.equal(obs.ok, true)
  assert.equal(obs.statusBarHeight, 44)
  assert.equal(obs.securityCandidate, true)
  assert.ok(!JSON.stringify(obs.observations).includes('pass1234'))
})

test('Review #1 & #3: gesture allows status-bar-only PNG diff and blocks outside or intersecting diff with diffBoundingBox', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iphone-png-diff-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  const bundleId = 'org.example.app'
  const xml = `<XCUIElementTypeApplication bundleId="${bundleId}" width="100" height="200"><XCUIElementTypeStatusBar y="0" height="20"/><XCUIElementTypeButton name="go" label="Go"/></XCUIElementTypeApplication>`
  const img1 = makePng(100, 200, (x, y) => y < 20 && x < 10 ? [10, 10, 10, 255] : [255, 255, 255, 255])
  const imgStatusChanged = makePng(100, 200, (x, y) => y < 20 && x < 10 ? [200, 20, 20, 255] : [255, 255, 255, 255])
  const imgBodyChanged = makePng(100, 200, (x, y) => (x >= 40 && x < 50 && y >= 100 && y < 120) ? [0, 0, 255, 255] : [255, 255, 255, 255])
  const shotPath = path.join(dir, 'obs.png')
  await writeFile(shotPath, img1)
  const sha1 = createHash('sha256').update(img1).digest('hex')
  const obsPath = path.join(dir, 'obs.json')
  const makeObs = (rect, statusBarHeight = 20) => ({
    documentType: 'app-observation-v1', bundleId, readAt: new Date().toISOString(),
    viewport: {width: 100, height: 200}, ...(statusBarHeight ? {statusBarHeight} : {}),
    imageSha256: sha1, evidence: [{kind: 'screenshot', path: shotPath}],
    targets: [{id: 't1', label: 'Go', rect, imageSha256: sha1}],
  })
  let currentImg = imgStatusChanged, gestures = 0
  const ops = createOperations({
    getContext: async () => 'NATIVE_APP', setContext: async () => {},
    screenshot: async () => currentImg.toString('base64'),
    performActions: async () => { gestures++ },
  }, 'sid', {bundleId, guardApp: async () => xml})

  await writeFile(obsPath, JSON.stringify(makeObs({x: 0.2, y: 0.3, width: 0.4, height: 0.2})))
  const ok = await ops.gesture({observationPath: obsPath, target: 'Go', x: 0.3, y: 0.4})
  assert.equal(ok.ok, true)
  assert.equal(ok.statusBarOnlyChanged, true)
  assert.equal(gestures, 1)

  currentImg = imgBodyChanged
  await assert.rejects(ops.gesture({observationPath: obsPath, target: 'Go', x: 0.3, y: 0.4}), (err) => {
    assert.equal(err.status, 'gesture-screen-changed')
    assert.deepEqual(err.diffBoundingBox.pixelBounds, {x: 40, y: 100, width: 10, height: 20})
    assert.equal(failureResult(err).diffBoundingBox.pixelBounds.x, 40)
    return true
  })

  currentImg = imgStatusChanged
  await writeFile(obsPath, JSON.stringify(makeObs({x: 0.1, y: 0.05, width: 0.4, height: 0.2})))
  await assert.rejects(ops.gesture({observationPath: obsPath, target: 'Go', x: 0.2, y: 0.1}), /gesture-screen-changed/)

  await writeFile(obsPath, JSON.stringify(makeObs({x: 0.2, y: 0.3, width: 0.4, height: 0.2}, null)))
  await assert.rejects(ops.gesture({observationPath: obsPath, target: 'Go', x: 0.3, y: 0.4}), /gesture-screen-changed/)
  assert.equal(gestures, 1)
})

test('Q9 & Review #2: device-locked-recoverable propagates to observations and triggers recover in query flows', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iphone-lock-recover-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  const rows = normalizeObservations([
    {text: 'Test Shop', x: 0.2, y: 0.7, width: 0.4, height: 0.03, confidence: 1},
    {text: '100条 ¥50/人', x: 0.2, y: 0.65, width: 0.4, height: 0.02, confidence: 1},
    {text: '咖啡 五缘湾', x: 0.2, y: 0.62, width: 0.4, height: 0.02, confidence: 1},
  ], 'vision-ocr')
  const first = {pageIndex: 1, readAt: '2026-11-17T00:00:00Z', method: 'vision-ocr', observations: rows,
    businesses: groupBusinesses(rows, {pageIndex: 1}).businesses}
  const doc = {schemaVersion: 2, platform: 'dianping', bundleId: 'com.dianping.dpscope', query: '咖啡',
    method: 'vision-ocr', readAt: '2026-11-17T00:00:00Z', finishedAt: '2026-11-17T00:00:01Z',
    factStatus: 'unverified', status: 'partial',
    coverage: {capturedScreens: 1, maxPages: 3, partial: true, exhaustive: false, stopReason: 'device-locked-recoverable'},
    pages: [first], businesses: mergeBusinesses([first]),
    failure: {status: 'device-locked-recoverable', phase: 'capture', outcome: 'not-sent'}}
  const consumed = toLifeQueryCandidates(doc)
  assert.equal(consumed.coverage.stopReason, 'device-locked-recoverable')
  assert.equal(consumed.extractionNeedsReview, true)

  let recovers = 0, locked = false
  const xhsOut = path.join(dir, 'xhs.json')
  const xhsRes = await runXiaohongshuQuery({
    source: async () => {
      if (locked) { locked = false; return '<SBCoverSheetWindow/>' }
      return '<XCUIElementTypeApplication width="414" height="896"><XCUIElementTypeTextView value="咖啡" visible="true" y="59"/><Button name="recommend_search_button"/><Button name="全部"/><Button name="用户"/></XCUIElementTypeApplication>'
    },
    findElement: async () => ({ELEMENT: 'el'}),
    elementRect: async () => ({x: 59, y: 59, width: 248, height: 22}),
    clickElement: async () => { locked = true },
    clearElement: async () => {},
    setElementValue: async () => {},
    elementAttribute: async () => '咖啡',
    execute: async () => ({type: 'Application', children: []}),
  }, 'sid', {query: '咖啡', output: xhsOut, maxPages: 1}, {
    recover: async () => { recovers++; return {ok: true} },
    requireForeground: async () => {},
    sourceText: collectSourceText,
    sleep: async () => {},
  })
  assert.equal(recovers, 3)
  assert.equal(xhsRes.coverage.stopReason, 'note-cards-not-exposed')
})

test('Q10: dianping-share no longer hard-blocks without branch suffix or street number', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dp-share-nobranch-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  const from = path.join(dir, 'detail.json'), output = path.join(dir, 'share.json')
  await writeFile(from, JSON.stringify({
    status: 'detail-observed', bundleId: 'com.dianping.dpscope', name: '某独立咖啡馆',
    readAt: new Date().toISOString(), runId: 'd1', candidateId: 'c1',
    identity: {sourceRunId: 's1'}, fields: {address: {value: '万象城L2层'}},
  }))
  const res = await runDianpingShare({
    execute: async (_s, script) => script === 'mobile: activeAppInfo' ? {bundleId: 'com.dianping.dpscope'} : 4,
    screenshot: async () => Buffer.from('qr').toString('base64'),
  }, 'sid', {from, output}, {
    ocr: async () => ({
      qrPayloads: ['https://m.dianping.com/shopinfo/123'],
      observations: [
        {text: '商户二维码', confidence: 1, x: 0.3, y: 0.9, width: 0.3, height: 0.03},
        {text: '某独立咖啡馆', confidence: 1, x: 0.2, y: 0.7, width: 0.5, height: 0.03},
      ],
    }),
  })
  assert.equal(res.ok, true)
  assert.equal(res.branchPatternMatched, false)
  assert.equal(res.branchVerification, 'name-matched-branch-unconfirmed')
})

test('Slice 3 remaining items: main band OCR trigger, missing-city dedup+cropRegion, XHS shortLabel, detail candidates, health summary, service audit, nativeRows suggestedSelector', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'slice3-misc-'))
  t.after(() => rm(dir, {recursive: true, force: true}))
  const bundleId = 'org.example.app'
  let ocrCalled = 0
  const page = await readAppPage({
    source: async () => `<XCUIElementTypeApplication bundleId="${bundleId}" width="400" height="800"><XCUIElementTypeStaticText/></XCUIElementTypeApplication>`,
    execute: async () => ({}),
    screenshot: async () => Buffer.from('img').toString('base64'),
  }, 'sid', bundleId, {
    requireForeground: async () => {},
    sourceText: () => [{text: '顶部很长很长的导航标题占位文案内容超过八十字符顶部很长很长的导航标题占位文案内容超过八十字符顶部很长很长的导航标题占位文案内容超过八十字符', rect: {x: 10, y: 40, width: 300, height: 20}}],
    ocr: async () => { ocrCalled++; return {observations: [{text: '主内容区域识别文字', x: 0.1, y: 0.5, width: 0.5, height: 0.04, confidence: 0.9}]} },
  })
  assert.equal(ocrCalled, 1)
  assert.equal(page.method, 'vision-ocr')

  const obs1 = normalizeObservations([
    {text: '同名咖啡', x: 0.2, y: 0.7, width: 0.4, height: 0.03, confidence: 1},
    {text: '80条 ¥35/人', x: 0.2, y: 0.65, width: 0.4, height: 0.02, confidence: 1},
    {text: '咖啡 五缘湾', x: 0.2, y: 0.62, width: 0.4, height: 0.02, confidence: 1},
    {text: '手工烘焙', x: 0.2, y: 0.60, width: 0.3, height: 0.02, confidence: 1},
  ], 'vision-ocr')
  const p1 = {pageIndex: 1, readAt: '2026-11-17T00:00:00Z', method: 'vision-ocr', observations: obs1, businesses: groupBusinesses(obs1, {pageIndex: 1}).businesses}
  const p2 = {pageIndex: 2, readAt: '2026-11-17T00:00:05Z', method: 'vision-ocr', observations: obs1, businesses: groupBusinesses(obs1, {pageIndex: 2}).businesses}
  assert.ok(p1.businesses[0].cropRegion)
  assert.ok(p1.businesses[0].nearbyObservations.some((r) => r.text === '手工烘焙'))
  const merged = mergeBusinesses([p1, p2])
  assert.equal(merged.length, 2)
  assert.equal(merged[1].possibleDuplicateOf, merged[0].id)

  const xhsTree = {type: 'XCUIElementTypeApplication', children: [
    {type: 'XCUIElementTypeStaticText', label: '图文', isVisible: true, rect: {x: 100, y: 100, width: 40, height: 20}},
    {type: 'XCUIElementTypeCell', isVisible: true, rect: {x: 10, y: 150, width: 190, height: 260}, children: [
      {type: 'XCUIElementTypeStaticText', label: '厦门探店好去处', isVisible: true, rect: {x: 15, y: 300, width: 160, height: 20}},
      {type: 'XCUIElementTypeStaticText', label: '奶茶', isVisible: true, rect: {x: 15, y: 330, width: 40, height: 18}},
      {type: 'XCUIElementTypeStaticText', label: '小羊笔记', isVisible: true, rect: {x: 15, y: 360, width: 80, height: 18}},
    ]},
  ]}
  const xhsCards = extractNoteCards(xhsTree, {width: 414, height: 896}, collectSourceText)
  assert.equal(xhsCards.candidates.length, 1)
  assert.equal(xhsCards.candidates[0].shortLabelCandidate[0].text, '奶茶')
  assert.ok(xhsCards.tabFilterCandidates.some((t) => t.text === '图文'))

  const detailCandidates = extractDetailFields({observations: [
    {id: 0, text: '评价', x: 0.2, y: 0.2, width: 0.1, height: 0.03, confidence: 1},
    {id: 1, text: '万象城东区三层', x: 0.1, y: 0.4, width: 0.4, height: 0.03, confidence: 0.9},
    {id: 2, text: '周一至周日 10:00-22:00', x: 0.1, y: 0.45, width: 0.5, height: 0.03, confidence: 0.9},
  ]})
  assert.equal(detailCandidates.addressCandidates.length, 1)
  assert.equal(detailCandidates.hoursCandidates.length, 1)
  assert.ok(detailCandidates.tabCandidates.some((c) => c.text === '评价'))

  const health = await probeSessionHealth({
    status: async () => ({ready: true}),
    wdaStatus: async () => ({value: {ready: true}}),
    source: async () => '<SBCoverSheetWindow/>',
  }, 'sid', {fetchImpl: async () => ({ok: true, json: async () => ({status: 'OK'})}), udid: 'u1', sessionFile: path.join(dir, 's.json')})
  assert.equal(health.diagnosticSummary.blockingLayer, 'lockscreen')
  assert.equal(health.diagnosticSummary.nextAction, 'run-recover')

  const plistPath = path.join(dir, 'com.yjx.iphone-appium.plist')
  const content = '<plist/>'
  await writeFile(plistPath, content)
  const audit = await serviceAction({
    appiumUrl: 'http://127.0.0.1:4723', sessionFile: path.join(dir, 'sess.json'),
    managedServices: {appium: {path: plistPath, sha256: createHash('sha256').update(content).digest('hex')}},
  }, 'audit', 'appium', {
    definition: {label: 'com.yjx.iphone-appium', domain: 'gui/501', target: plistPath, content, root: false},
    execute: (cmd) => {
      if (cmd === '/bin/launchctl') return 'state = running'
      return 'node 123 user 10u IPv4 TCP 127.0.0.1:4723 (LISTEN)'
    },
  })
  assert.equal(audit.ok, true)
  assert.equal(audit.services[0].owned, true)
  assert.equal(audit.services[0].upToDate, true)
  assert.equal(audit.services[0].loopbackOnly, true)

  const opsNative = createOperations({
    getContext: async () => 'NATIVE_APP', setContext: async () => {},
    execute: async () => ({children: [
      {type: 'XCUIElementTypeCell', name: 'shop_card_1', label: '', isVisible: true, rect: {x: 0, y: 100, width: 300, height: 80}},
      {type: 'XCUIElementTypeLink', label: '查看地图', isVisible: true, rect: {x: 10, y: 200, width: 100, height: 30}},
    ]}),
  }, 'sid', {bundleId, guardApp: async () => `<XCUIElementTypeApplication bundleId="${bundleId}" width="400" height="800"/>`})
  const nativeObs = await opsNative.observe()
  assert.equal(nativeObs.observations.length, 2)
  assert.deepEqual(nativeObs.observations[0].suggestedSelector, {using: 'accessibility-id', selector: 'shop_card_1'})
  assert.deepEqual(nativeObs.observations[1].suggestedSelector, {using: 'predicate', selector: "type == 'XCUIElementTypeLink' AND label == '查看地图'"})
})
