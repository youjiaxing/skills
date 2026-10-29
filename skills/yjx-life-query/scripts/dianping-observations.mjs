#!/usr/bin/env node

import {readFile} from 'node:fs/promises'
import {CAPTURE_STOP_REASONS, groupBusinesses, mergeBusinesses} from '../../yjx-iphone-app-ops/scripts/dianping-results.mjs'

const fields = ['name', 'rating', 'reviewCount', 'pricePerPerson', 'distance', 'area']
const validTime = (value) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sameField = (a, b) => a && b && same(a.value, b.value) && a.evidence === b.evidence
  && same(a.observationIds, b.observationIds) && a.confidence === b.confidence && Boolean(a.ambiguous) === Boolean(b.ambiguous)

function canonicalPages(value) {
  const result = new Map()
  let section = 'primary'
  for (const page of value.pages) {
    const grouped = groupBusinesses(page.observations, {pageIndex: page.pageIndex,
      initialSection: page.pageIndex > 1 && section === 'primary' ? 'unknown' : section})
    section = grouped.sectionAfter
    result.set(page.pageIndex, grouped.businesses)
  }
  return result
}

function canonicalSighting(canonical, sighting) {
  return canonical.get(sighting.pageIndex)?.find((item) => sameField(item.name, sighting.business?.name))
}

export function validateDianpingObservation(value) {
  if (!value || ![1, 2].includes(value.schemaVersion)) throw new Error('unsupported Dianping observation schema')
  if (value.platform !== 'dianping' || value.bundleId !== 'com.dianping.dpscope') throw new Error('unexpected Dianping observation source')
  if (typeof value.query !== 'string' || !value.query.trim() || !validTime(value.readAt)) throw new Error('missing query or observation time')
  if (!['accessibility', 'vision-ocr', 'mixed', null].includes(value.method)) throw new Error('invalid observation method')
  if (value.factStatus !== 'unverified') throw new Error('observation must remain unverified')
  if (!Array.isArray(value.businesses)) throw new Error('business records missing')
  if (value.schemaVersion === 2) {
    if (!['observations-extracted', 'partial', ...CAPTURE_STOP_REASONS].includes(value.status)) throw new Error('invalid observation status')
    if (!validTime(value.finishedAt)) throw new Error('missing finish time')
    if (value.documentType && value.documentType !== 'place-search-v2') throw new Error('unexpected document type')
    if (value.documentType && (typeof value.runId !== 'string' || !value.runId)) throw new Error('missing run ID')
    if (!Array.isArray(value.pages) || value.coverage?.capturedScreens !== value.pages.length ||
        value.coverage?.exhaustive !== false || value.coverage?.partial !== true || !value.coverage?.stopReason) {
      throw new Error('invalid page coverage')
    }
    const pages = new Map()
    for (const page of value.pages) {
      if (!Number.isInteger(page.pageIndex) || pages.has(page.pageIndex) || !validTime(page.readAt) ||
          !Array.isArray(page.observations) || !Array.isArray(page.businesses)) throw new Error('invalid page provenance')
      pages.set(page.pageIndex, page)
    }
    const normalStop = ['max-pages', 'page-unchanged', 'two-pages-without-new-businesses'].includes(value.coverage.stopReason)
    if (!CAPTURE_STOP_REASONS.has(value.coverage.stopReason)) throw new Error('unknown capture stop reason')
    if (normalStop !== (value.status === 'observations-extracted') || (normalStop && value.failure) ||
      (!normalStop && value.pages.length > 0 && value.status !== 'partial') ||
      (value.failure && value.failure.status !== value.coverage.stopReason)) throw new Error('inconsistent observation outcome')
    if (!normalStop && (!value.failure || typeof value.failure.phase !== 'string' || !value.failure.phase ||
      typeof value.failure.outcome !== 'string' || !value.failure.outcome)) throw new Error('missing failure provenance')
    if (Date.parse(value.finishedAt) < Date.parse(value.readAt) || value.pages.some((page) =>
      Date.parse(page.readAt) < Date.parse(value.readAt) || Date.parse(page.readAt) > Date.parse(value.finishedAt))) throw new Error('inconsistent observation timeline')
    const canonical = canonicalPages(value)
    const expected = mergeBusinesses(value.pages.map((page) => ({...page, businesses: canonical.get(page.pageIndex)})))
    const evidenceKey = (business) => business.sightings.map((seen) => [seen.pageIndex, seen.business.name.observationIds]).sort()
    if (expected.length !== value.businesses.length || expected.some((business, index) =>
      !same(evidenceKey(business), evidenceKey(value.businesses[index])) || business.section !== value.businesses[index].section ||
      (business.possibleDuplicateOf || null) !== (value.businesses[index].possibleDuplicateOf || null))) throw new Error('candidate list or section differs from raw observations')
    for (const business of value.businesses) {
      if (!Array.isArray(business.sightings) || !business.sightings.length) throw new Error('business evidence missing')
      for (const key of fields) {
        const chosen = business[key]
        if (chosen && !business.sightings.some((sighting) => {
          const original = sighting.business?.[key]
          return sameField(original, chosen)
        })) throw new Error('merged field is not supported by a sighting')
      }
      for (const sighting of business.sightings) {
        const page = pages.get(sighting.pageIndex)
        if (!page) throw new Error('unknown evidence page')
        const raw = canonicalSighting(canonical, sighting)
        if (!raw) throw new Error('field does not match raw observations')
        for (const key of fields) {
          const field = sighting.business?.[key]
          if (!field) continue
          if (!Array.isArray(field.observationIds) || !field.observationIds.length || field.observationIds.some((id) =>
              !page.observations.some((row) => row.id === id && row.text === field.evidence))) throw new Error('dangling field evidence')
          if (!sameField(field, raw[key])) throw new Error('field value or confidence does not match raw observations')
        }
      }
    }
  }
  for (const business of value.businesses) {
    if (typeof business.name?.value !== 'string' || !business.name.value.trim()) throw new Error('business name missing')
    if (business.rating && !(Number.isFinite(business.rating.value) && business.rating.value >= 0 && business.rating.value <= 5)) throw new Error('rating out of range')
    if (business.reviewCount && !(Number.isInteger(business.reviewCount.value) && business.reviewCount.value >= 0)) throw new Error('invalid review count')
    if (business.pricePerPerson && !(Number.isFinite(business.pricePerPerson.value) && business.pricePerPerson.value >= 0)) throw new Error('invalid price')
    if (business.distance && !(Number.isFinite(business.distance.value?.value) && business.distance.value.value >= 0 && ['m', 'km'].includes(business.distance.value.unit))) throw new Error('invalid distance')
  }
  return value
}

export function toLifeQueryCandidates(value) {
  const observation = validateDianpingObservation(value)
  const legacy = observation.schemaVersion === 1
  const canonical = legacy ? null : canonicalPages(observation)
  const artifacts = Array.isArray(observation.artifacts) ? observation.artifacts
    : Object.entries(observation.artifacts || {}).map(([kind, item]) => ({kind, legacy: true,
      ...(typeof item === 'string' ? {path: item} : item)}))
  const result = {
    query: observation.query, observedAt: observation.readAt, method: observation.method,
    factStatus: 'unverified', status: observation.status || 'legacy-observation',
    coverage: observation.coverage || {capturedScreens: 1, partial: true, exhaustive: false, stopReason: 'legacy-single-screen'},
    failure: observation.failure || null,
    extractionNeedsReview: legacy || !observation.runId || Boolean(observation.failure) ||
      !['max-pages', 'page-unchanged', 'two-pages-without-new-businesses'].includes(observation.coverage?.stopReason) ||
      observation.visualReviewRequired !== false || observation.status === 'partial',
    artifacts,
    candidates: observation.businesses.map((business) => {
      const rawSightings = legacy ? [] : business.sightings.map((sighting) => canonicalSighting(canonical, sighting))
      const reviewReasons = [...new Set([...(business.reviewReasons || []),
        ...rawSightings.flatMap((item) => item.reviewReasons),
        ...(fields.some((key) => !business[key]) ? ['missing-fields'] : []),
        ...(business.possibleDuplicateOf ? ['identity-or-field-conflict'] : [])])]
      if (legacy) reviewReasons.push('legacy-provenance-and-confidence-unvalidated')
      if (typeof business.needsReview !== 'boolean') reviewReasons.push('review-state-missing')
      return {
        id: business.id || null, name: business.name.value, section: business.section || 'unknown',
        verification: 'unverified', fieldPresence: business.completeness ?? null,
        extractionNeedsReview: legacy || business.needsReview !== false || reviewReasons.length > 0,
        reviewReasons, possibleDuplicateOf: business.possibleDuplicateOf || null,
        fields: Object.fromEntries(fields.map((key) => {
          const field = business[key]
          const evidenceRefs = (business.sightings || []).flatMap((sighting) => {
            const seen = sighting.business[key]
            if (!seen || !field || !same(seen.value, field.value)) return []
            return seen.observationIds.map((id) => {
              const page = observation.pages.find((page) => page.pageIndex === sighting.pageIndex)
              const row = page.observations.find((row) => row.id === id)
              return {pageIndex: page.pageIndex, observationId: id, text: row.text,
                bbox: {x: row.x, y: row.y, width: row.width, height: row.height}, readAt: page.readAt}
            })
          })
          return [key, field ? {value: field.value, recognitionConfidence: legacy ? null : field.confidence,
            ambiguous: Boolean(field.ambiguous), factStatus: 'unverified', evidence: field.evidence, evidenceRefs} : null]
        })),
      }
    }),
  }
  result.extractionNeedsReview ||= result.candidates.some((item) => item.extractionNeedsReview)
  return result
}

export async function readDianpingObservation(filePath) {
  return toLifeQueryCandidates(JSON.parse(await readFile(filePath, 'utf8')))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const filePath = process.argv[2]
    if (!filePath) throw new Error('usage: dianping-observations.mjs <extraction.json>')
    process.stdout.write(`${JSON.stringify(await readDianpingObservation(filePath))}\n`)
  } catch (error) {
    process.stderr.write(error.message + '\n')
    process.exitCode = 1
  }
}
