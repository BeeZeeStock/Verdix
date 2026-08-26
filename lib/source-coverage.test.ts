import { describe, it, expect } from 'vitest'
import {
  isCoverageUsableAsOf, evaluateUnionIntervalCoverage, evaluateRequiredSourcesCoverage,
  type SourceCoverage,
} from './source-coverage'

function makeCoverage(overrides: Partial<SourceCoverage> & { id: string; source_binding_id: string; covered_from: string; covered_through: string }): SourceCoverage {
  return {
    job_id: 'job-1', org_id: 'org-1', coverage_kind: 'candidate_discovery',
    established_at: overrides.covered_through, completeness_basis: 'connector_high_watermark', established_by: 'test-harness', metadata: {},
    status: 'active', revoked_at: null, revoked_by: null,
    ...overrides,
  }
}

describe('isCoverageUsableAsOf', () => {
  it('usable when established_at <= asOf', () => {
    const c = makeCoverage({ id: 'c1', source_binding_id: 'b1', covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-02-01T00:00:00Z', established_at: '2026-02-01T00:00:00Z' })
    expect(isCoverageUsableAsOf(c, '2026-02-01T00:00:00Z')).toBe(true)
    expect(isCoverageUsableAsOf(c, '2026-03-01T00:00:00Z')).toBe(true)
  })
  it('NOT usable when established_at > asOf — a historical replay must never see future completeness knowledge', () => {
    const c = makeCoverage({ id: 'c1', source_binding_id: 'b1', covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-02-01T00:00:00Z', established_at: '2026-03-01T00:00:00Z' })
    expect(isCoverageUsableAsOf(c, '2026-02-15T00:00:00Z')).toBe(false)
  })

  // Final hardening pass — revocation lifecycle, mirroring
  // CandidateUnitEvidence's own isEvidenceActiveAsOf tests exactly.
  it('visible before revocation', () => {
    const c = makeCoverage({
      id: 'c1', source_binding_id: 'b1', covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-02-01T00:00:00Z', established_at: '2026-02-01T00:00:00Z',
      status: 'revoked', revoked_at: '2026-05-01T00:00:00Z', revoked_by: 'reviewer:alice@example.com',
    })
    expect(isCoverageUsableAsOf(c, '2026-03-01T00:00:00Z')).toBe(true)
  })
  it('invisible after revocation', () => {
    const c = makeCoverage({
      id: 'c1', source_binding_id: 'b1', covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-02-01T00:00:00Z', established_at: '2026-02-01T00:00:00Z',
      status: 'revoked', revoked_at: '2026-05-01T00:00:00Z', revoked_by: 'reviewer:alice@example.com',
    })
    expect(isCoverageUsableAsOf(c, '2026-05-01T00:00:00Z')).toBe(false)
    expect(isCoverageUsableAsOf(c, '2026-06-01T00:00:00Z')).toBe(false)
  })
  it('a corrected replacement (revoke old + append new) never alters what an EARLIER historical asOf already saw', () => {
    const original = makeCoverage({ id: 'c-orig', source_binding_id: 'b1', covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-02-01T00:00:00Z', established_at: '2026-02-01T00:00:00Z' })
    const revokedOriginal: SourceCoverage = { ...original, status: 'revoked', revoked_at: '2026-04-01T00:00:00Z', revoked_by: 'connector:crm-sync-job-77' }
    const corrected = makeCoverage({ id: 'c-corrected', source_binding_id: 'b1', covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-03-01T00:00:00Z', established_at: '2026-04-01T00:00:00Z' })

    // A historical replay at 2026-03-01 (before the correction) sees ONLY
    // the original assertion — exactly as it did when that decision was
    // actually made.
    expect(isCoverageUsableAsOf(revokedOriginal, '2026-03-01T00:00:00Z')).toBe(true)
    expect(isCoverageUsableAsOf(corrected, '2026-03-01T00:00:00Z')).toBe(false)

    // A replay after the correction sees ONLY the corrected assertion.
    expect(isCoverageUsableAsOf(revokedOriginal, '2026-05-01T00:00:00Z')).toBe(false)
    expect(isCoverageUsableAsOf(corrected, '2026-05-01T00:00:00Z')).toBe(true)
  })
})

describe('evaluateUnionIntervalCoverage', () => {
  const requiredFrom = '2026-01-01T00:00:00Z'
  const requiredThrough = '2026-04-01T00:00:00Z'

  it('complete: a single coverage row exactly spans the required interval', () => {
    const coverage = [makeCoverage({ id: 'c1', source_binding_id: 'b1', covered_from: requiredFrom, covered_through: requiredThrough })]
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: ['b1'], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage, asOf: requiredThrough })
    expect(result.status).toBe('complete')
  })

  it('incomplete: no coverage at all', () => {
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: ['b1'], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage: [], asOf: requiredThrough })
    expect(result.status).toBe('incomplete')
  })

  it('incomplete: no sourceBindingIds resolved at all — never trivially "complete" over zero sources', () => {
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: [], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage: [], asOf: requiredThrough })
    expect(result.status).toBe('incomplete')
  })

  it('complete: two adjacent coverage rows from DIFFERENT bindings stitch together (a re-platform mid-window)', () => {
    const coverage = [
      makeCoverage({ id: 'c1', source_binding_id: 'b1', covered_from: requiredFrom, covered_through: '2026-02-15T00:00:00Z' }),
      makeCoverage({ id: 'c2', source_binding_id: 'b2', covered_from: '2026-02-15T00:00:00Z', covered_through: requiredThrough }),
    ]
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: ['b1', 'b2'], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage, asOf: requiredThrough })
    expect(result.status).toBe('complete')
    expect(result.consideredCoverageIds).toEqual(['c1', 'c2'])
  })

  it('incomplete: a real gap between two coverage rows', () => {
    const coverage = [
      makeCoverage({ id: 'c1', source_binding_id: 'b1', covered_from: requiredFrom, covered_through: '2026-02-01T00:00:00Z' }),
      makeCoverage({ id: 'c2', source_binding_id: 'b1', covered_from: '2026-02-10T00:00:00Z', covered_through: requiredThrough }),
    ]
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: ['b1'], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage, asOf: requiredThrough })
    expect(result.status).toBe('incomplete')
    expect(result.gaps).toEqual([{ from: '2026-02-01T00:00:00.000Z', through: '2026-02-10T00:00:00Z' }])
  })

  it('incomplete: coverage only partially overlaps the front or back of the required interval', () => {
    const coverage = [makeCoverage({ id: 'c1', source_binding_id: 'b1', covered_from: '2026-02-01T00:00:00Z', covered_through: requiredThrough })]
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: ['b1'], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage, asOf: requiredThrough })
    expect(result.status).toBe('incomplete')
    expect(result.gaps).toEqual([{ from: '2026-01-01T00:00:00.000Z', through: '2026-02-01T00:00:00Z' }])
  })

  it('a coverage row of the WRONG coverage_kind is ignored', () => {
    const coverage = [makeCoverage({ id: 'c1', source_binding_id: 'b1', covered_from: requiredFrom, covered_through: requiredThrough, coverage_kind: 'rejection_source' })]
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: ['b1'], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage, asOf: requiredThrough })
    expect(result.status).toBe('incomplete')
  })

  it('a coverage row not yet established as of asOf is ignored — future knowledge never leaks into a historical replay', () => {
    const coverage = [makeCoverage({ id: 'c1', source_binding_id: 'b1', covered_from: requiredFrom, covered_through: requiredThrough, established_at: '2026-05-01T00:00:00Z' })]
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: ['b1'], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage, asOf: requiredThrough })
    expect(result.status).toBe('incomplete')
  })

  it('a coverage row for a DIFFERENT source_binding_id is ignored', () => {
    const coverage = [makeCoverage({ id: 'c1', source_binding_id: 'other-binding', covered_from: requiredFrom, covered_through: requiredThrough })]
    const result = evaluateUnionIntervalCoverage({ sourceBindingIds: ['b1'], coverageKind: 'candidate_discovery', requiredFrom, requiredThrough, coverage, asOf: requiredThrough })
    expect(result.status).toBe('incomplete')
  })
})

describe('evaluateRequiredSourcesCoverage', () => {
  const requiredFrom = '2026-01-01T00:00:00Z'
  const requiredThrough = '2026-02-01T00:00:00Z'

  it('complete only when EVERY required source is independently complete — a complete CRM feed never substitutes for an incomplete portal feed', () => {
    const coverage = [
      makeCoverage({ id: 'crm-1', source_binding_id: 'crm-binding', coverage_kind: 'rejection_source', covered_from: requiredFrom, covered_through: requiredThrough }),
    ]
    const result = evaluateRequiredSourcesCoverage({
      requiredSources: [{ label: 'crm', sourceBindingIds: ['crm-binding'] }, { label: 'portal', sourceBindingIds: ['portal-binding'] }],
      coverageKind: 'rejection_source', requiredFrom, requiredThrough, coverage, asOf: requiredThrough,
    })
    expect(result.status).toBe('incomplete')
    expect(result.reason).toContain('portal')
  })

  it('complete when every required source independently has complete coverage', () => {
    const coverage = [
      makeCoverage({ id: 'crm-1', source_binding_id: 'crm-binding', coverage_kind: 'rejection_source', covered_from: requiredFrom, covered_through: requiredThrough }),
      makeCoverage({ id: 'portal-1', source_binding_id: 'portal-binding', coverage_kind: 'rejection_source', covered_from: requiredFrom, covered_through: requiredThrough }),
    ]
    const result = evaluateRequiredSourcesCoverage({
      requiredSources: [{ label: 'crm', sourceBindingIds: ['crm-binding'] }, { label: 'portal', sourceBindingIds: ['portal-binding'] }],
      coverageKind: 'rejection_source', requiredFrom, requiredThrough, coverage, asOf: requiredThrough,
    })
    expect(result.status).toBe('complete')
  })

  it('incomplete when no required sources are configured at all — never trivially complete over an empty requirement', () => {
    const result = evaluateRequiredSourcesCoverage({
      requiredSources: [], coverageKind: 'rejection_source', requiredFrom, requiredThrough, coverage: [], asOf: requiredThrough,
    })
    expect(result.status).toBe('incomplete')
  })
})
