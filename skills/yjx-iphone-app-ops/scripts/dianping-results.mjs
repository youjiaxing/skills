import {createHash} from 'node:crypto'

const fieldNames = ['rating', 'reviewCount', 'pricePerPerson', 'distance', 'area']
export const CAPTURE_STOP_REASONS = new Set(['max-pages', 'page-unchanged', 'two-pages-without-new-businesses',
  'blocked-verification', 'blocked-login', 'blocked-credential', 'blocked-permission', 'needs-user-consent',
  'protocol-timeout', 'capture-failed', 'insufficient-result-evidence', 'query-or-result-scope-unverified',
  'screen-not-readable', 'unexpected-overlay', 'viewport-unavailable'])
const normalizedText = (text) => text.normalize('NFKC').toLowerCase().replace(/[\s·•・]/gu, '')
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)

// Both backends use normalized screen coordinates, with origin at the top left.
export function normalizeObservations(rows, method, viewport = {width: 414, height: 896}) {
  return rows.filter((row) => typeof row.text === 'string' && row.text.trim()).map((row, index) => {
    const rect = method === 'accessibility' ? row.rect : null
    return {
      id: index,
      text: row.text.trim(),
      confidence: method === 'accessibility' ? null : Number.isFinite(row.confidence) ? row.confidence : null,
      x: rect ? rect.x / viewport.width : row.x,
      y: rect ? rect.y / viewport.height : 1 - row.y - row.height,
      width: rect ? rect.width / viewport.width : row.width,
      height: rect ? rect.height / viewport.height : row.height,
    }
  }).filter((row) => [row.x, row.y, row.width, row.height].every(Number.isFinite)
    && row.width > 0 && row.height > 0 && row.y >= 0 && row.y < 1)
}

function isTitle(row) {
  const text = row.text
  return row.x >= 0.18 && row.x < 0.7 && row.width >= 0.1 && text.length >= 2
    && text.length <= 80 && /[\p{Script=Han}a-z]/iu.test(text)
    && !/[¥￥/／|“”「」【】]/u.test(text)
    && !/相关推荐|相关结果|排序|全城|营业|休息|浏览过|人均|条|折|限时|可随时|过期退|^榜|^新店|^神券/u.test(text)
    && !/^[大女★☆⭐\s\d.,$＄]+$/u.test(text)
}

function field(rows, regex, convert) {
  const matches = rows.flatMap((row) => {
    const match = row.text.match(regex)
    return match ? [{value: convert(match), confidence: row.confidence,
      evidence: row.text, observationIds: [row.id]}] : []
  })
  if (!matches.length) return null
  const result = {...matches[0]}
  result.ambiguous = matches.some((match) => !sameValue(match.value, result.value))
  return result
}

export function groupBusinesses(observations, {pageIndex = 1, initialSection = 'primary'} = {}) {
  const rows = observations.filter((row) => row.y >= 0.19 && row.y < 0.97)
    .sort((left, right) => left.y - right.y || left.x - right.x)
  const headers = rows.filter((row) => /相关推荐|相关结果|为你推荐更多/.test(row.text))
  const metricRows = rows.filter((row) => row.x >= 0.18 && row.x < 0.85
    && /\d+\s*条|[¥￥]\s*\d+(?:\.\d+)?\s*\/\s*人/.test(row.text))
  const titles = []
  for (const metric of metricRows) {
    const title = rows.filter((row) => isTitle(row) && row.y + row.height <= metric.y + 0.006
      && metric.y - row.y < 0.065).at(-1)
    if (title && !titles.some((row) => row.id === title.id)) titles.push(title)
  }
  const businesses = titles.map((title, index) => {
    const end = Math.min(titles[index + 1]?.y ?? 1, title.y + 0.105,
      headers.find((header) => header.y > title.y)?.y ?? 1)
    const card = rows.filter((row) => row.y >= title.y - 0.003 && row.y < end)
    const metrics = metricRows.filter((row) => card.includes(row))
    const metricY = metrics[0]?.y
    const ratingBand = card.filter((row) => Math.abs(row.y - metricY) < 0.014 && row.x < 0.85)
    const rating = field(ratingBand, /(?:^|[^\d.])([0-5][.,]\d)(?=\s|分|星|条|$)/,
      (match) => Number(match[1].replace(',', '.')))
    const reviewCount = field(metrics, /(\d{1,7})\s*条/, (match) => Number(match[1]))
    const pricePerPerson = field(metrics, /[¥￥]\s*(\d+(?:\.\d+)?)\s*\/\s*人/, (match) => Number(match[1]))
    const distance = field(card.filter((row) => row.x > 0.72),
      /^(<|＜)?\s*(\d+(?:\.\d+)?)\s*(km|公里|m|米)$/i,
      (match) => ({value: Number(match[2]), unit: /km|公里/i.test(match[3]) ? 'km' : 'm', upperBound: Boolean(match[1])}))
    const areaRows = card.filter((row) => row.x >= 0.18 && row.x < 0.7)
    const area = field(areaRows,
      /^(.{1,12}?)\s+([\p{Script=Han}]{2,8})\s*[/／]\s*([\p{Script=Han}\d]{1,16})$/u,
      (match) => ({category: match[1], city: match[2], district: match[3]}))
      || field(areaRows, /^([\p{Script=Han}]{1,8})\s+([\p{Script=Han}\d]{2,18})$/u,
        (match) => ({category: match[1], city: null, district: match[2]}))
    const fields = {rating, reviewCount, pricePerPerson, distance, area}
    const name = {value: title.text, evidence: title.text, confidence: title.confidence, observationIds: [title.id]}
    const missingFields = fieldNames.filter((key) => !fields[key])
    const lowConfidenceFields = Object.entries({name, ...fields})
      .filter(([, value]) => value?.confidence !== null && value?.confidence < 0.6).map(([key]) => key)
    const reviewReasons = []
    if (/[…]|\.{3}|[（(][^）)]*$/.test(name.value) || title.height < 0.012
      || (title.confidence !== null && title.confidence < 0.6 && title.text.length <= 3)) reviewReasons.push('name-truncated')
    if (missingFields.length) reviewReasons.push('missing-fields')
    if (area && !area.value.city) reviewReasons.push('city-not-observed')
    if (lowConfidenceFields.length) reviewReasons.push('low-recognition-confidence')
    if (Object.values(fields).some((value) => value?.ambiguous)) reviewReasons.push('conflicting-fields')
    const section = headers.some((header) => header.y < title.y) ? 'recommended' : initialSection
    return {name, ...fields, section, pageIndex, missingFields, lowConfidenceFields, reviewReasons,
      completeness: Math.round(100 * (fieldNames.length - missingFields.length) / fieldNames.length),
      needsReview: reviewReasons.length > 0}
  })
  return {businesses, sectionAfter: headers.length ? 'recommended' : initialSection}
}

function identity(business) {
  if (!business.area?.value.city || business.reviewReasons.includes('name-truncated')) return null
  return [normalizedText(business.name.value), business.area.value.city, business.area.value.district].join('|')
}

// Exact name + area + matching metrics only. Incomplete names never identify a shop.
export function mergeBusinesses(pages) {
  const merged = []
  for (const page of pages) {
    for (const business of page.businesses) {
      const key = identity(business)
      const possible = key && merged.find((item) => identity(item) === key)
      const conflicts = possible && fieldNames.filter((name) => possible[name] && business[name]
        && !sameValue(possible[name].value, business[name].value))
      const matchesMetric = possible && ['reviewCount', 'pricePerPerson', 'distance']
        .some((name) => possible[name] && business[name] && sameValue(possible[name].value, business[name].value))
      const sameScreen = possible?.sightings.some((seen) => seen.pageIndex === page.pageIndex)
      const sighting = {pageIndex: page.pageIndex, readAt: page.readAt, method: page.method, business}
      if (possible && !sameScreen && matchesMetric && !conflicts.length) {
        possible.sightings.push(sighting)
        for (const name of fieldNames) if (!possible[name] && business[name]) possible[name] = business[name]
      } else {
        const item = {...business, id: 'candidate-' + (merged.length + 1), sightings: [sighting]}
        if (possible) {
          item.possibleDuplicateOf = possible.id
          item.reviewReasons = [...item.reviewReasons, 'identity-or-field-conflict']
          item.needsReview = true
          possible.needsReview = true
          possible.reviewReasons = [...new Set([...possible.reviewReasons, 'identity-or-field-conflict'])]
        }
        merged.push(item)
      }
    }
  }
  return merged
}

export function pageFingerprint(observations) {
  const text = observations.filter((row) => row.y >= 0.19 && row.y < 0.96)
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((row) => normalizedText(row.text) + '@' + Math.round(row.x * 100) + ',' + Math.round(row.y * 100)).join('\n')
  return createHash('sha256').update(text).digest('hex')
}

export function observationStopReason(text) {
  if (/身份核实|请依次点击|验证码|安全验证|访问过于频繁|操作过于频繁|异常访问/.test(text)) return 'blocked-verification'
  if (/大众点评隐私政策协议/.test(text)) return 'needs-user-consent'
  if (/请输入.*(?:密码|手机号)|短信登录|手机号登录|请先登录|立即登录|登录后.{0,10}(?:继续|查看|内容)|登录查看商户|登录[\/／或]注册/.test(text)) return 'blocked-login'
  if (/隐私政策.{0,30}(?:更新|同意)|用户协议.{0,30}(?:更新|同意)/.test(text)) return 'needs-user-consent'
  if (/反馈问题/.test(text) && /不感兴趣|内容不适/.test(text)) return 'unexpected-overlay'
  return null
}
