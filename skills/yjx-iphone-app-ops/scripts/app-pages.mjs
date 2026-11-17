import {normalizeObservations, observationStopReason} from './dianping-results.mjs'

export class AppStop extends Error {
  constructor(status) { super(status); this.status = status }
}

export function isProxyTimeout(error) {
  return error?.code === 'ETIMEDOUT' || /timeout of \d+ms exceeded|Could not proxy command to the remote server/i.test(error?.message || '')
}

export function pageStop(text) {
  if (/XCUIElementTypeSecureTextField/.test(text)) return 'blocked-credential'
  if (/SBCoverSheetWindow|lockscreen-date-view/.test(text)) {
    return /Enter Passcode|输入密码|输入锁屏密码/i.test(text) ? 'blocked-credential' : 'device-locked-recoverable'
  }
  if (/允许.*(?:定位|通讯录|照片)|想要访问您的|Would Like to Access/.test(text)) return 'blocked-permission'
  if (/隐私政策.*(?:更新|同意)|用户协议.*(?:更新|同意)/.test(text)) return 'needs-user-consent'
  return observationStopReason(text)
}

export function hasXmlStructure(xml) {
  return typeof xml === 'string' && /<XCUIElementType(?:Window|Other|ScrollView|Table|CollectionView|StaticText|Button|Cell|WebView|TextField|TextView|NavigationBar|TabBar)\b/.test(xml)
}

export function hasSecurityStructure(xml) {
  if (typeof xml !== 'string' || !xml) return false
  if (/XCUIElementTypeSecureTextField|XCUIElementTypeAlert|XCUIElementTypeSheet/.test(xml)) return true
  if (/<XCUIElementTypeButton\b[^>]*(?:name|label)="[^"]*(?:登录|立即登录|短信登录|手机号登录|去登录|登录[\/／或]注册)[^"]*"/.test(xml)) return true
  if (/<XCUIElementType(?:TextField|TextView|SearchField)\b[^>]*(?:name|label|placeholderValue)="[^"]*(?:手机号|密码|验证码|passcode|password|verification)[^"]*"/i.test(xml)) return true
  return false
}

const SOFT_STOP_REASONS = new Set(['blocked-verification', 'blocked-login', 'needs-user-consent'])
const STATIC_SECURITY_TEXT_RE = /隐私政策.{0,30}(?:更新|同意)|用户协议.{0,30}(?:更新|同意)|验证码|安全验证|请依次点击下图图标|密码|password|passcode|verification\s*code|立即登录|短信登录|手机号登录|请先登录|登录后.{0,10}(?:继续|查看|内容)|登录查看商户|登录[\/／或]注册/i

export function sanitizeStaticSecurityObservations(observations) {
  const stopCandidates = []
  const redactString = (str) => str
    .replace(/(验证码|安全验证|密码|password|passcode|verification\s*code)[\s:：]*[A-Za-z0-9_-]{3,}/gi, '$1 [redacted]')
    .replace(/\b\d{4,8}\b/g, '[redacted]')
  const sanitized = observations.map((row, index) => {
    const text = String(row.text ?? '')
    const reason = observationStopReason(text) || (STATIC_SECURITY_TEXT_RE.test(text) ? 'security-keyword-static-text' : null)
    if (!reason) return row
    stopCandidates.push({observationId: row.id ?? index, reason})
    return {
      ...row,
      text: redactString(text),
      ...(typeof row.label === 'string' ? {label: redactString(row.label)} : {}),
      ...(typeof row.value === 'string' ? {value: redactString(row.value)} : {}),
      ...(typeof row.name === 'string' ? {name: redactString(row.name)} : {}),
      ...(row.suggestedSelector?.selector ? {suggestedSelector: {...row.suggestedSelector, selector: redactString(row.suggestedSelector.selector)}} : {}),
      securityRedacted: true,
    }
  })
  return {observations: sanitized, stopCandidates, securityCandidate: stopCandidates.length > 0}
}

export async function guardApp(client, sid, bundleId, deps, {allowStaticSecurityCandidate = false} = {}) {
  const xml = await client.source(sid)
  const stop = pageStop(xml)
  if (stop === 'device-locked-recoverable') {
    if (client.sourceDepthLimit != null && client.findElements) {
      const secure = await client.findElements(sid, '-ios predicate string', 'type == "XCUIElementTypeSecureTextField"')
      if (!Array.isArray(secure)) throw new AppStop('safety-check-unreadable')
      if (secure.length > 0) throw new AppStop('blocked-credential')
    }
    throw Object.assign(new AppStop('device-locked-recoverable'), {credentialRequired: false})
  }
  const canSoften = allowStaticSecurityCandidate && SOFT_STOP_REASONS.has(stop) && hasXmlStructure(xml) && !hasSecurityStructure(xml)
  if (stop && !canSoften) throw new AppStop(stop)
  await deps.requireForeground(client, sid, bundleId, xml)
  return xml
}

export async function readAppPage(client, sid, bundleId, deps, {useful = (text) => text.length >= 80} = {}) {
  const xml = await guardApp(client, sid, bundleId, deps, {allowStaticSecurityCandidate: true})
  const allowStaticSoftening = hasXmlStructure(xml) && !hasSecurityStructure(xml)
  const root = xml.match(/<XCUIElementTypeApplication\b[^>]*>/)?.[0] || ''
  const viewport = {width: Number(root.match(/\bwidth="([\d.]+)"/)?.[1]),
    height: Number(root.match(/\bheight="([\d.]+)"/)?.[1])}
  if (!(viewport.width > 0 && viewport.height > 0)) throw new AppStop('viewport-unavailable')
  const readAt = new Date().toISOString()
  const native = await client.execute(sid, 'mobile: source', [{format: 'json'}])
  const nativeStop = pageStop(JSON.stringify(native))
  if (nativeStop && !(allowStaticSoftening && SOFT_STOP_REASONS.has(nativeStop))) {
    throw nativeStop === 'device-locked-recoverable'
      ? Object.assign(new AppStop(nativeStop), {credentialRequired: false})
      : new AppStop(nativeStop)
  }
  let method = 'accessibility'
  let qrPayloads = []
  let observations = normalizeObservations(deps.sourceText(native), method, viewport)
  let text = observations.map((row) => row.text).join('\n')
  let contentRows = observations.filter((row) => row.y >= 0.18 && row.y <= 0.88)
  let contentText = contentRows.map((row) => row.text).join('\n')
  const hasMainContent = contentRows.length > 0 && contentText.trim().length >= 8
  if (!useful(text) || !hasMainContent) {
    await guardApp(client, sid, bundleId, deps, {allowStaticSecurityCandidate: true})
    const raw = await deps.ocr(Buffer.from(await client.screenshot(sid), 'base64'))
    method = 'vision-ocr'
    qrPayloads = raw.qrPayloads || []
    observations = normalizeObservations(raw.observations || [], method, viewport)
    text = observations.map((row) => row.text).join('\n')
    contentRows = observations.filter((row) => row.y >= 0.18 && row.y <= 0.88)
    contentText = contentRows.map((row) => row.text).join('\n')
  }
  const stop = pageStop(text)
  let stopCandidates = []
  let securityCandidate = false
  if (stop) {
    if (allowStaticSoftening && SOFT_STOP_REASONS.has(stop)) {
      const sanitized = sanitizeStaticSecurityObservations(observations)
      observations = sanitized.observations
      text = observations.map((row) => row.text).join('\n')
      stopCandidates = sanitized.stopCandidates
      securityCandidate = sanitized.securityCandidate
    } else {
      throw stop === 'device-locked-recoverable'
        ? Object.assign(new AppStop(stop), {credentialRequired: false})
        : new AppStop(stop)
    }
  }
  if (!text.trim()) throw new AppStop('screen-not-readable')
  const page = {readAt, method, viewport, observations, text, qrPayloads,
    contentBandCoverage: {rows: contentRows.length, textLength: contentText.length},
    ...(securityCandidate ? {securityCandidate, stopCandidates} : {})}
  try { await guardApp(client, sid, bundleId, deps, {allowStaticSecurityCandidate: true}) }
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
  if (stop) {
    throw stop === 'device-locked-recoverable'
      ? Object.assign(new AppStop(stop), {credentialRequired: false})
      : new AppStop(stop)
  }
  if (!text.trim()) throw new AppStop('screen-not-readable')
  const page = {readAt, method: 'vision-ocr', observations, text, qrPayloads: raw.qrPayloads || [],
    foregroundEvidence: {before}, snapshotNote: 'read-only pixels with app state before and after; no XML snapshot'}
  try { page.foregroundEvidence.after = await state() }
  catch (error) { error.observedPage = page; throw error }
  return page
}

export const canonicalText = (text) => text.normalize('NFKC').replace(/\s/g, '').toLowerCase()
export const elementId = (element) => element?.['element-6066-11e4-a52e-4f735466cecf'] || element?.ELEMENT
