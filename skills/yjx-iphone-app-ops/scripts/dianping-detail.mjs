import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {AppStop, canonicalText, guardApp, isProxyTimeout, readAppPage} from './app-pages.mjs'
import {groupBusinesses} from './dianping-results.mjs'
import {preflightArtifacts, publishArtifact, DIANPING_BUNDLE} from './dianping-query.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function extractDetailFields(page) {
  const rows = page.observations.filter((row) => row.y > 0.18 && row.y < 0.75)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const pack = (selected) => selected.length ? {value: selected.map((row) => row.text).join(''),
    observationIds: selected.map((row) => row.id), evidence: selected.map((row) => row.text),
    confidence: selected.some((row) => row.confidence === null) ? null : Math.min(...selected.map((row) => row.confidence)),
    factStatus: 'unverified'} : null
  const address = rows.find((row) => /(?:路|街|巷).{0,20}\d+号|\d+号[-—]\d+/.test(row.text) && !/榜|名|券/.test(row.text))
  const addressRows = address ? [address] : []
  if (address && /[（(][^）)]*$/.test(address.text)) {
    const next = rows.find((row) => row.y > address.y + address.height && row.y < address.y + address.height + 0.03
      && Math.abs(row.x - address.x) < 0.06 && /[）)]/.test(row.text))
    if (next) addressRows.push(next)
  }
  const state = rows.find((row) => row.y < 0.6 && /^(?:休息中|营业中)/.test(row.text))
  const hours = state ? rows.filter((row) => Math.abs(row.y - state.y) < 0.018 &&
    /\d{1,2}[:：]\d{2}.*[-—~～].*\d{1,2}[:：]\d{2}/.test(row.text)) : []
  return {address: pack(addressRows), businessState: pack(state ? [state] : []), hours: pack(hours),
    hoursScope: hours.length ? 'current-page-summary; weekly rules not expanded' : null}
}

export async function runDianpingDetail(client, sid, {from, candidateId, output, current = false}, deps) {
  const artifacts = []
  let phase = 'validate-candidate'
  try {
    await preflightArtifacts({extractionPath: output, maxPages: 1})
    const source = JSON.parse(await readFile(from, 'utf8'))
    if (source.schemaVersion !== 2 || source.bundleId !== DIANPING_BUNDLE || source.platform !== 'dianping') throw new AppStop('invalid-candidate-source')
    const candidate = source.businesses?.find((item) => item.id === candidateId)
    if (!candidate || !candidate.name?.value || candidate.reviewReasons?.includes('name-truncated')) throw new AppStop('candidate-identity-incomplete')
    const age = Date.now() - Date.parse(source.finishedAt)
    if (!Number.isFinite(age) || age < 0 || (!current && age > 10 * 60 * 1000)) throw new AppStop('candidate-observation-stale')
    let listName = candidate.name
    if (!current) {
      phase = 'verify-visible-candidate'
      const list = await readAppPage(client, sid, DIANPING_BUNDLE, deps, {useful: (text) => /地图/.test(text) && /商户/.test(text) && text.includes(candidate.name.value)})
      const header = list.observations.filter((row) => row.y < 0.15).map((row) => row.text).join('')
      if (!canonicalText(header).includes(canonicalText(source.query)) || !/地图/.test(list.text) || !/商户/.test(list.text)) throw new AppStop('query-or-result-scope-unverified')
      const matches = groupBusinesses(list.observations).businesses.filter((item) => canonicalText(item.name.value) === canonicalText(candidate.name.value))
      if (matches.length !== 1 || matches[0].reviewReasons.includes('name-truncated') ||
          (matches[0].name.confidence !== null && matches[0].name.confidence < 0.6)) throw new AppStop('candidate-not-uniquely-visible')
      for (const key of ['reviewCount', 'pricePerPerson', 'area']) {
        if (candidate[key] && matches[0][key] && JSON.stringify(candidate[key].value) !== JSON.stringify(matches[0][key].value)) throw new AppStop('candidate-fields-changed')
      }
      const row = list.observations.find((item) => item.id === matches[0].name.observationIds[0])
      if (row.y < 0.2 || row.y + row.height > 0.9) throw new AppStop('candidate-outside-safe-area')
      await guardApp(client, sid, DIANPING_BUNDLE, deps)
      phase = 'open-detail'
      await client.tap(sid, Math.round((row.x + row.width / 2) * list.viewport.width), Math.round((row.y + row.height / 2) * list.viewport.height))
      await (deps.sleep || pause)(1400)
      listName = matches[0].name
    }
    phase = 'read-detail'
    const detail = await readAppPage(client, sid, DIANPING_BUNDLE, deps, {useful: (text) => text.includes(candidate.name.value) && /地址|营业|电话/.test(text)})
    if (!canonicalText(detail.text).includes(canonicalText(candidate.name.value)) || !/地址|营业|电话|路线/.test(detail.text)) throw new AppStop('detail-identity-unverified')
    const fields = extractDetailFields(detail)
    const result = {schemaVersion: 1, documentType: 'place-detail-v1', runId: randomUUID(), platform: 'dianping', bundleId: DIANPING_BUNDLE,
      query: source.query, candidateId, name: candidate.name.value, readAt: detail.readAt, factStatus: 'unverified',
      status: 'detail-observed', identity: {listName, sourceRunId: source.runId || null, searchReadAt: source.readAt, acquisition: current ? 'current-detail-read-only' : 'visible-list-card'},
      page: detail, fields,
      links: detail.observations.flatMap((item) => (item.text.match(/https?:\/\/[^\s<>"）)]+/g) || []).map((url) => ({url, observationId: item.id, status: 'observed-unopened'}))),
      missingFields: ['verified-address', 'applicable-hours', 'verified-share-link'], reviewRequired: true}
    phase = 'publish-detail'
    artifacts.push(await publishArtifact(output, JSON.stringify(result, null, 2)))
    return {ok: true, status: result.status, name: result.name, output, artifacts, links: result.links.length, reviewRequired: true}
  } catch (error) {
    return {ok: false, status: error.status || (isProxyTimeout(error) ? 'protocol-timeout' : 'detail-failed'), phase, outcome: error.outcome || 'unknown', retryable: false, error: error.message.slice(0, 500), artifacts}
  }
}
