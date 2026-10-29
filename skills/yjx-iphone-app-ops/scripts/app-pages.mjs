import {normalizeObservations, observationStopReason} from './dianping-results.mjs'

export class AppStop extends Error {
  constructor(status) { super(status); this.status = status }
}

export function isProxyTimeout(error) {
  return error?.code === 'ETIMEDOUT' || /timeout of \d+ms exceeded|Could not proxy command to the remote server/i.test(error?.message || '')
}

export function pageStop(text) {
  if (/SBCoverSheetWindow|lockscreen-date-view|XCUIElementTypeSecureTextField/.test(text)) return 'blocked-credential'
  if (/允许.*(?:定位|通讯录|照片)|想要访问您的|Would Like to Access/.test(text)) return 'blocked-permission'
  if (/隐私政策.*(?:更新|同意)|用户协议.*(?:更新|同意)/.test(text)) return 'needs-user-consent'
  return observationStopReason(text)
}

export async function guardApp(client, sid, bundleId, deps) {
  const xml = await client.source(sid)
  const stop = pageStop(xml)
  if (stop) throw new AppStop(stop)
  await deps.requireForeground(client, sid, bundleId, xml)
  return xml
}

export async function readAppPage(client, sid, bundleId, deps, {useful = (text) => text.length >= 80} = {}) {
  const xml = await guardApp(client, sid, bundleId, deps)
  const root = xml.match(/<XCUIElementTypeApplication\b[^>]*>/)?.[0] || ''
  const viewport = {width: Number(root.match(/\bwidth="([\d.]+)"/)?.[1]),
    height: Number(root.match(/\bheight="([\d.]+)"/)?.[1])}
  if (!(viewport.width > 0 && viewport.height > 0)) throw new AppStop('viewport-unavailable')
  const readAt = new Date().toISOString()
  const native = await client.execute(sid, 'mobile: source', [{format: 'json'}])
  const nativeStop = pageStop(JSON.stringify(native))
  if (nativeStop) throw new AppStop(nativeStop)
  let method = 'accessibility'
  let qrPayloads = []
  let observations = normalizeObservations(deps.sourceText(native), method, viewport)
  let text = observations.map((row) => row.text).join('\n')
  if (!useful(text)) {
    await guardApp(client, sid, bundleId, deps)
    const raw = await deps.ocr(Buffer.from(await client.screenshot(sid), 'base64'))
    method = 'vision-ocr'
    qrPayloads = raw.qrPayloads || []
    observations = normalizeObservations(raw.observations || [], method, viewport)
    text = observations.map((row) => row.text).join('\n')
  }
  const stop = pageStop(text)
  if (stop) throw new AppStop(stop)
  if (!text.trim()) throw new AppStop('screen-not-readable')
  const page = {readAt, method, viewport, observations, text, qrPayloads}
  try { await guardApp(client, sid, bundleId, deps) }
  catch (error) { error.observedPage = page; throw error }
  return page
}

// QR payloads require pixels; this read-only path avoids an unnecessary deep AX snapshot.
export async function readAppPixels(client, sid, bundleId, deps) {
  const state = async () => {
    const active = await client.execute(sid, 'mobile: activeAppInfo')
    const appState = await client.execute(sid, 'mobile: queryAppState', [{bundleId}])
    if (active?.bundleId !== bundleId || appState !== 4) throw new AppStop('app-state-unverified')
    return {bundleId: active.bundleId, appState}
  }
  const before = await state()
  const readAt = new Date().toISOString()
  const raw = await deps.ocr(Buffer.from(await client.screenshot(sid), 'base64'))
  const observations = normalizeObservations(raw.observations || [], 'vision-ocr')
  const text = observations.map((row) => row.text).join('\n')
  const stop = pageStop(text)
  if (stop) throw new AppStop(stop)
  if (!text.trim()) throw new AppStop('screen-not-readable')
  const page = {readAt, method: 'vision-ocr', observations, text, qrPayloads: raw.qrPayloads || [],
    foregroundEvidence: {before}, snapshotNote: 'read-only pixels with app state before and after; no XML snapshot'}
  try { page.foregroundEvidence.after = await state() }
  catch (error) { error.observedPage = page; throw error }
  return page
}

export const canonicalText = (text) => text.normalize('NFKC').replace(/\s/g, '').toLowerCase()
export const elementId = (element) => element?.['element-6066-11e4-a52e-4f735466cecf'] || element?.ELEMENT
