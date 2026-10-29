import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {AppStop, canonicalText, elementId, guardApp, isProxyTimeout, readAppPixels} from './app-pages.mjs'
import {DIANPING_BUNDLE, preflightArtifacts, publishArtifact} from './dianping-query.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runDianpingShare(client, sid, {from, output}, deps) {
  let phase = 'validate-detail'
  const artifacts = []
  let detail, branchVerified = false
  const provenance = (page) => ({sourceCandidateId: detail.candidateId, sourceSearchRunId: detail.identity.sourceRunId,
    sourceDetailRunId: detail.runId, branchEvidence: {
      name: detail.name, address: detail.fields?.address || null,
      observationIds: page.observations.filter((row) => canonicalText(row.text).includes(canonicalText(detail.name))).map((row) => row.id),
      addressObservationIds: page.observations.filter((row) => row.text.length >= 3 && detail.fields?.address?.value &&
        canonicalText(detail.fields.address.value).includes(canonicalText(row.text))).map((row) => row.id),
      scope: 'current-page-full-branch-name-or-previous-detail-address; fact remains unverified',
    }})
  const platformUrls = (payloads = []) => [...new Set(payloads)].filter((payload) => {
    try { const url = new URL(payload); return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'dianping.com' || url.hostname.endsWith('.dianping.com') || url.hostname === 'meituan.com' || url.hostname.endsWith('.meituan.com')) }
    catch { return false }
  })
  try {
    await preflightArtifacts({extractionPath: output, maxPages: 1})
    detail = JSON.parse(await readFile(from, 'utf8'))
    const age = Date.now() - Date.parse(detail.readAt)
    if (detail.status !== 'detail-observed' || detail.bundleId !== DIANPING_BUNDLE || !detail.name ||
        !Number.isFinite(age) || age < 0 || age > 10 * 60 * 1000) throw new AppStop('detail-observation-stale-or-invalid')
    if (!detail.runId || !detail.candidateId || !detail.identity?.sourceRunId) throw new AppStop('branch-unverified')
    branchVerified = /[（(][^）)]{2,40}店[）)]/.test(detail.name)
    const useful = (text) => canonicalText(text).includes(canonicalText(detail.name))
    let page = await readAppPixels(client, sid, DIANPING_BUNDLE, deps)
    if (!useful(page.text)) throw new AppStop('detail-identity-unverified')
    const address = detail.fields?.address?.value
    branchVerified ||=
      (typeof address === 'string' && /\d+号/.test(address) && canonicalText(page.text).includes(canonicalText(address)))
    if (!branchVerified) throw new AppStop('branch-unverified')
    const qrAlreadyVisible = /商户二维码/.test(page.text)
    if (!qrAlreadyVisible) {
      if (!/营业|电话|路线/.test(page.text)) throw new AppStop('detail-page-unverified')
      phase = 'open-share-sheet'
      await guardApp(client, sid, DIANPING_BUNDLE, deps)
      const share = await client.findElement(sid, 'accessibility id', 'food_poi_share')
      await guardApp(client, sid, DIANPING_BUNDLE, deps)
      await client.clickElement(sid, elementId(share))
      await (deps.sleep || pause)(500)
      const sheet = await guardApp(client, sid, DIANPING_BUNDLE, deps)
      if (!/分享至/.test(sheet) || !/detail_share_icon_new_qrcode/.test(sheet)) throw new AppStop('share-sheet-unverified')
      const qr = await client.findElement(sid, 'accessibility id', 'detail_share_icon_new_qrcode')
      await guardApp(client, sid, DIANPING_BUNDLE, deps)
      await client.clickElement(sid, elementId(qr))
      await (deps.sleep || pause)(700)
    }
    phase = 'read-merchant-qr'
    // Force local Vision here: native text cannot expose QR payloads.
    if (!qrAlreadyVisible) page = await readAppPixels(client, sid, DIANPING_BUNDLE, deps)
    if (!/商户二维码/.test(page.text) || !useful(page.text)) throw new AppStop('qr-merchant-identity-unverified')
    const urls = platformUrls(page.qrPayloads)
    if (urls.length !== 1) throw new AppStop('share-link-not-uniquely-exposed')
    const result = {schemaVersion: 1, documentType: 'qr-share-v1', runId: randomUUID(), platform: 'dianping', bundleId: DIANPING_BUNDLE,
      name: detail.name, ...provenance(page), readAt: page.readAt, factStatus: 'unverified',
      status: 'qr-payload-observed', url: urls[0], source: 'merchant-qr', verification: 'qr-title-matched-unopened',
      page, branchVerification: 'explicit-branch-name-or-address-matched', reviewRequired: true}
    artifacts.push(await publishArtifact(output, JSON.stringify(result, null, 2)))
    return {ok: true, status: result.status, name: result.name, output, artifacts,
      verification: result.verification, reviewRequired: true}
  } catch (error) {
    const page = error.observedPage
    const urls = platformUrls(page?.qrPayloads)
    if (detail && page && !branchVerified && typeof detail.fields?.address?.value === 'string') {
      const address = detail.fields.address.value
      branchVerified = /\d+号/.test(address) && canonicalText(page.text).includes(canonicalText(detail.name)) &&
        canonicalText(page.text).includes(canonicalText(address))
    }
    if (detail && branchVerified && page && /商户二维码/.test(page.text) &&
        canonicalText(page.text).includes(canonicalText(detail.name)) && urls.length === 1) {
      const partial = {schemaVersion: 1, documentType: 'qr-share-v1', runId: randomUUID(), platform: 'dianping',
        bundleId: DIANPING_BUNDLE, ...provenance(page), name: detail.name, readAt: page.readAt,
        factStatus: 'unverified', status: 'partial', verification: 'qr-observed-state-unconfirmed',
        url: urls[0], page, failure: {phase, lastPassedStage: 'qr-decoded', status: error.status || (error.code === 'ETIMEDOUT' ? 'protocol-timeout' : 'protocol-failed'), outcome: error.outcome || 'unknown'}, reviewRequired: true}
      artifacts.push(await publishArtifact(output, JSON.stringify(partial, null, 2)))
      return {ok: false, status: 'partial', output, verification: partial.verification, failure: partial.failure, artifacts}
    }
    return {ok: false, status: error.status || (isProxyTimeout(error) ? 'protocol-timeout' : 'share-failed'), phase, outcome: error.outcome || 'unknown',
      retryable: false, error: error.message.slice(0, 500), artifacts}
  }
}
