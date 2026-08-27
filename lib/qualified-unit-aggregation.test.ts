import { describe, it, expect } from 'vitest'
import { confirmQualificationRuleField, type BillableUnitQualificationRule } from './billable-unit-qualification'
import { buildOs202609Rule } from './os-2026-09-fixture'
import type { BillableUnitCandidate } from './billable-unit-candidate'
import type { SourceBinding } from './source-bindings'
import type { SourceCoverage } from './source-coverage'
import {
  aggregateQualifiedUnits, evaluatePeriodReadiness, projectQualifiedUnit, resolveRuleSegmentsForPeriod,
  effectiveCandidateStatusAsOf, type QualifiedUnitAggregationContext,
} from './qualified-unit-aggregation'

// ═══════════════════════════════════════════════════════════════════════════
// Step 16B.4 — OS-2026-09 fixture cases A-J for the qualified-unit
// aggregation / period-readiness layer. Candidates are constructed already
// TERMINAL (status/decided_at set directly) — 16B.3's own evidence-driven
// finality evaluation is unchanged and untouched by this file; these tests
// exercise only what happens AFTER a candidate is already qualified/
// rejected/pending.
// ═══════════════════════════════════════════════════════════════════════════

function buildActiveOs202609Rule(overrides?: Partial<BillableUnitQualificationRule>): BillableUnitQualificationRule {
  let rule = buildOs202609Rule()
  rule = confirmQualificationRuleField(rule, 'dedupe_rule')
  return { ...rule, id: 'rule-os-2026-09-sqm-v1', status: 'active', effective_from: '2026-01-01T00:00:00Z', ...overrides }
}

const SOURCE_BINDING_ROLE_KEYS = new Map<string, string>([['binding-crm', 'crm']])
const SOURCE_BINDINGS: SourceBinding[] = [
  { id: 'binding-crm', source_role_id: 'role-crm', job_id: 'job-os-2026-09', org_id: 'org-lynora', label: 'CRM', effective_from: '2020-01-01T00:00:00Z', effective_to: null, supersedes_binding_id: null, status: 'active' },
]

// .000 milliseconds included deliberately — resolveRuleSegmentsForPeriod's
// segment boundaries always round-trip through new Date(...).toISOString(),
// which always emits milliseconds; keeping these constants in that exact
// form lets segment-boundary assertions below use plain string equality.
const PERIOD_START = '2026-09-01T00:00:00.000Z'
const PERIOD_END = '2026-10-01T00:00:00.000Z'

let candidateSeq = 0
function makeCandidate(params: {
  status: BillableUnitCandidate['status']
  attribution_at: string
  occurred_at?: string | null
  decided_at?: string | null
  // Defaults to well before any test's asOf — existing tests (which don't
  // care about creation-time gating) stay unaffected; only hardening item
  // 1's own regressions below set this explicitly.
  created_at?: string
  rule: BillableUnitQualificationRule
}): BillableUnitCandidate {
  candidateSeq += 1
  const decided_at = params.decided_at !== undefined ? params.decided_at : (params.status === 'pending' ? null : params.attribution_at)
  return {
    id: `cand-${candidateSeq}`, job_id: 'job-os-2026-09', org_id: 'org-lynora', unit_type: 'SQM',
    external_identity: { source_binding_id: 'binding-crm', external_id: `ext-${candidateSeq}` },
    booked_at: params.occurred_at ?? params.attribution_at, occurred_at: params.occurred_at ?? params.attribution_at,
    attribution_at: params.attribution_at,
    qualification_rule_id: params.rule.id, qualification_rule_version: params.rule.version,
    rejection_deadline: null, status: params.status, decided_at,
    created_at: params.created_at ?? '2020-01-01T00:00:00Z',
  }
}

function makeCoverage(params: { covered_from: string; covered_through: string; established_at: string }): SourceCoverage {
  return {
    id: `cov-${params.covered_from}-${params.established_at}`, job_id: 'job-os-2026-09', org_id: 'org-lynora',
    source_binding_id: 'binding-crm', coverage_kind: 'candidate_discovery',
    covered_from: params.covered_from, covered_through: params.covered_through, established_at: params.established_at,
    completeness_basis: 'connector_high_watermark', established_by: 'test-harness', metadata: {},
    status: 'active', revoked_at: null, revoked_by: null,
  }
}

function septemberCoverage(establishedAt = '2026-10-02T00:00:00Z'): SourceCoverage[] {
  return [makeCoverage({ covered_from: PERIOD_START, covered_through: PERIOD_END, established_at: establishedAt })]
}

function buildCtx(overrides: Partial<QualifiedUnitAggregationContext> & { rule: BillableUnitQualificationRule; candidates: BillableUnitCandidate[]; coverage: SourceCoverage[] }): QualifiedUnitAggregationContext {
  const { rule, ...rest } = overrides
  return {
    jobId: 'job-os-2026-09', orgId: 'org-lynora', unitType: 'SQM',
    periodStart: PERIOD_START, periodEnd: PERIOD_END, asOf: '2026-10-05T00:00:00Z',
    sourceBindings: SOURCE_BINDINGS, sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS,
    ruleVersions: [rule],
    ...rest,
  }
}

describe('OS-2026-09 — qualified-unit aggregation cases A-J', () => {
  it('A — 3 September-attributed qualified candidates, discovery complete -> quantity 3 / ready', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = [
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-05T10:00:00Z', rule }),
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-15T10:00:00Z', rule }),
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-25T10:00:00Z', rule }),
    ]
    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates, coverage: septemberCoverage() }))
    expect(result.readiness.outcome).toBe('ready')
    expect(result.quantity).toBe(3)
    expect(result.projections).toHaveLength(3)
    expect(result.projections.every(p => p.quantity === 1)).toBe(true)
  })

  it('B — 2 qualified + 1 rejected -> quantity 2 / ready', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = [
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-05T10:00:00Z', rule }),
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-15T10:00:00Z', rule }),
      makeCandidate({ status: 'rejected', attribution_at: '2026-09-20T10:00:00Z', rule }),
    ]
    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates, coverage: septemberCoverage() }))
    expect(result.readiness.outcome).toBe('ready')
    expect(result.quantity).toBe(2)
    expect(result.readiness.rejectedCandidateIds).toHaveLength(1)
  })

  it('C — 2 qualified + 1 pending -> period pending / no executable quantity', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = [
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-05T10:00:00Z', rule }),
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-15T10:00:00Z', rule }),
      makeCandidate({ status: 'pending', attribution_at: '2026-09-28T10:00:00Z', rule }),
    ]
    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates, coverage: septemberCoverage() }))
    expect(result.readiness.outcome).toBe('pending')
    expect(result.quantity).toBeNull()
    expect(result.readiness.pendingCandidateIds).toHaveLength(1)
  })

  it('D — all known candidates terminal but candidate-discovery coverage incomplete -> period pending', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = [
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-05T10:00:00Z', rule }),
      makeCandidate({ status: 'rejected', attribution_at: '2026-09-15T10:00:00Z', rule }),
    ]
    // Coverage only reaches half the month — a real gap, not merely absent.
    const coverage = [makeCoverage({ covered_from: PERIOD_START, covered_through: '2026-09-15T00:00:00Z', established_at: '2026-10-02T00:00:00Z' })]
    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates, coverage }))
    expect(result.readiness.outcome).toBe('pending')
    expect(result.quantity).toBeNull()
    expect(result.readiness.discoveryCompleteness.status).toBe('incomplete')
  })

  it('E — meeting occurs Sep 30, qualifies Oct 3, attribution_at Sep 30 -> counted in September', () => {
    const rule = buildActiveOs202609Rule()
    const candidate = makeCandidate({
      status: 'qualified', occurred_at: '2026-09-30T09:00:00Z', attribution_at: '2026-09-30T09:00:00Z',
      decided_at: '2026-10-03T12:00:00Z', rule,
    })
    const projection = projectQualifiedUnit(candidate, PERIOD_START, PERIOD_END, '2026-10-05T00:00:00Z')
    expect(projection).not.toBeNull()
    expect(projection!.billing_period).toEqual({ start: PERIOD_START, end: PERIOD_END })

    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates: [candidate], coverage: septemberCoverage() }))
    expect(result.readiness.outcome).toBe('ready')
    expect(result.quantity).toBe(1)
    expect(result.candidateIdsConsidered).toContain(candidate.id)
  })

  it('F — meeting occurs Oct 1 -> not counted in September', () => {
    const rule = buildActiveOs202609Rule()
    const septCandidate = makeCandidate({ status: 'qualified', attribution_at: '2026-09-10T09:00:00Z', rule })
    const octCandidate = makeCandidate({ status: 'qualified', attribution_at: '2026-10-01T00:00:00Z', rule })
    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates: [septCandidate, octCandidate], coverage: septemberCoverage() }))
    expect(result.readiness.outcome).toBe('ready')
    expect(result.quantity).toBe(1)
    expect(result.candidateIdsConsidered).toContain(septCandidate.id)
    expect(result.candidateIdsConsidered).not.toContain(octCandidate.id)
  })

  it('G — coverage established after billingAsOf -> invisible / period pending historically', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = [makeCandidate({ status: 'qualified', attribution_at: '2026-09-10T09:00:00Z', rule })]
    const coverage = septemberCoverage('2026-10-10T00:00:00Z') // established well after an early billingAsOf

    const earlyAsOf = buildCtx({ rule, candidates, coverage, asOf: '2026-10-02T00:00:00Z' })
    const early = aggregateQualifiedUnits(earlyAsOf)
    expect(early.readiness.outcome).toBe('pending')
    expect(early.quantity).toBeNull()

    const lateAsOf = buildCtx({ rule, candidates, coverage, asOf: '2026-10-11T00:00:00Z' })
    const late = aggregateQualifiedUnits(lateAsOf)
    expect(late.readiness.outcome).toBe('ready')
    expect(late.quantity).toBe(1)
  })

  it('H — same ready period evaluated repeatedly -> identical quantity and candidate set', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = [
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-05T10:00:00Z', rule }),
      makeCandidate({ status: 'qualified', attribution_at: '2026-09-15T10:00:00Z', rule }),
    ]
    const ctx = buildCtx({ rule, candidates, coverage: septemberCoverage() })
    const first = aggregateQualifiedUnits(ctx)
    const second = aggregateQualifiedUnits(ctx)
    expect(second.quantity).toBe(first.quantity)
    expect(second.candidateIdsConsidered).toEqual(first.candidateIdsConsidered)
    expect(second.projections.map(p => p.candidate_id)).toEqual(first.projections.map(p => p.candidate_id))
  })

  it('I — terminal rejected candidate never contributes quantity', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = [makeCandidate({ status: 'rejected', attribution_at: '2026-09-10T09:00:00Z', rule })]
    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates, coverage: septemberCoverage() }))
    expect(result.readiness.outcome).toBe('ready')
    expect(result.quantity).toBe(0)
    expect(result.projections).toHaveLength(0)
  })

  it('J — empty month + complete discovery coverage -> legitimate quantity 0 / ready', () => {
    const rule = buildActiveOs202609Rule()
    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates: [], coverage: septemberCoverage() }))
    expect(result.readiness.outcome).toBe('ready')
    expect(result.quantity).toBe(0)
  })

  it('J (contrast) — empty month + incomplete discovery coverage -> pending, NOT zero', () => {
    const rule = buildActiveOs202609Rule()
    const result = aggregateQualifiedUnits(buildCtx({ rule, candidates: [], coverage: [] }))
    expect(result.readiness.outcome).toBe('pending')
    expect(result.quantity).toBeNull()
    expect(result.readiness.discoveryCompleteness.status).toBe('incomplete')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Hardening item 1 — historical candidate visibility. A candidate's CURRENT
// row status is not what a historical billingAsOf replay must see; only
// effectiveCandidateStatusAsOf's decided_at <= asOf gate determines that.
// ═══════════════════════════════════════════════════════════════════════════
describe('effectiveCandidateStatusAsOf', () => {
  const rule = buildActiveOs202609Rule()

  it('a pending candidate is pending regardless of asOf', () => {
    const c = makeCandidate({ status: 'pending', attribution_at: '2026-09-10T09:00:00Z', rule })
    expect(effectiveCandidateStatusAsOf(c, '2020-01-01T00:00:00Z')).toBe('pending')
    expect(effectiveCandidateStatusAsOf(c, '2030-01-01T00:00:00Z')).toBe('pending')
  })

  it('a qualified candidate is qualified once asOf reaches decided_at, pending before it', () => {
    const c = makeCandidate({ status: 'qualified', attribution_at: '2026-09-30T09:00:00Z', decided_at: '2026-10-03T12:00:00Z', rule })
    expect(effectiveCandidateStatusAsOf(c, '2026-10-01T00:00:00Z')).toBe('pending')
    expect(effectiveCandidateStatusAsOf(c, '2026-10-03T12:00:00Z')).toBe('qualified') // inclusive
    expect(effectiveCandidateStatusAsOf(c, '2026-10-04T00:00:00Z')).toBe('qualified')
  })

  it('a rejected candidate is rejected once asOf reaches decided_at, pending before it', () => {
    const c = makeCandidate({ status: 'rejected', attribution_at: '2026-09-30T09:00:00Z', decided_at: '2026-10-03T12:00:00Z', rule })
    expect(effectiveCandidateStatusAsOf(c, '2026-10-01T00:00:00Z')).toBe('pending')
    expect(effectiveCandidateStatusAsOf(c, '2026-10-03T12:00:00Z')).toBe('rejected')
  })
})

describe('period readiness respects historical candidate visibility (hardening item 1)', () => {
  it('a Sep-30 candidate that qualifies Oct 3 leaves September pending when evaluated Oct 1, and includes it when evaluated Oct 3', () => {
    const rule = buildActiveOs202609Rule()
    const candidate = makeCandidate({
      status: 'qualified', attribution_at: '2026-09-30T09:00:00Z', decided_at: '2026-10-03T12:00:00Z', rule,
    })
    // Discovery coverage complete well before either asOf — isolates the
    // ONLY variable under test to the candidate's own historical status.
    const coverage = septemberCoverage('2026-10-01T00:00:00Z')

    const asOfOct1 = aggregateQualifiedUnits(buildCtx({ rule, candidates: [candidate], coverage, asOf: '2026-10-01T00:00:00Z' }))
    expect(asOfOct1.readiness.outcome).toBe('pending')
    expect(asOfOct1.quantity).toBeNull()
    expect(asOfOct1.readiness.pendingCandidateIds).toContain(candidate.id)

    const asOfOct3 = aggregateQualifiedUnits(buildCtx({ rule, candidates: [candidate], coverage, asOf: '2026-10-03T12:00:00Z' }))
    expect(asOfOct3.readiness.outcome).toBe('ready')
    expect(asOfOct3.quantity).toBe(1)
  })

  it('the same historical gating applies to a later REJECTION — pending before decided_at, rejected (contributing zero) after', () => {
    const rule = buildActiveOs202609Rule()
    const candidate = makeCandidate({
      status: 'rejected', attribution_at: '2026-09-30T09:00:00Z', decided_at: '2026-10-03T12:00:00Z', rule,
    })
    const coverage = septemberCoverage('2026-10-01T00:00:00Z')

    const asOfOct1 = aggregateQualifiedUnits(buildCtx({ rule, candidates: [candidate], coverage, asOf: '2026-10-01T00:00:00Z' }))
    expect(asOfOct1.readiness.outcome).toBe('pending')
    expect(asOfOct1.readiness.pendingCandidateIds).toContain(candidate.id)

    const asOfOct3 = aggregateQualifiedUnits(buildCtx({ rule, candidates: [candidate], coverage, asOf: '2026-10-03T12:00:00Z' }))
    expect(asOfOct3.readiness.outcome).toBe('ready')
    expect(asOfOct3.quantity).toBe(0)
    expect(asOfOct3.readiness.rejectedCandidateIds).toContain(candidate.id)
  })
})

describe('candidate existence is itself asOf-gated (hardening item 1, final pass)', () => {
  it('a September-attributed candidate created Oct 5 is INVISIBLE at billingAsOf Oct 1 — not present, not pending, not blocking readiness', () => {
    const rule = buildActiveOs202609Rule()
    const candidate = makeCandidate({
      status: 'qualified', attribution_at: '2026-09-12T09:00:00Z', decided_at: '2026-09-12T09:00:00Z',
      created_at: '2026-10-05T00:00:00Z', rule,
    })
    const coverage = septemberCoverage('2026-10-01T00:00:00Z') // established before Oct 1 -> visible at that asOf

    const asOfOct1 = aggregateQualifiedUnits(buildCtx({ rule, candidates: [candidate], coverage, asOf: '2026-10-01T00:00:00Z' }))
    // Not merely "pending" — genuinely absent. An empty, fully-covered
    // period is a legitimate ready/zero (case J), which is exactly what
    // this must resolve to: the not-yet-created candidate does not block.
    expect(asOfOct1.readiness.outcome).toBe('ready')
    expect(asOfOct1.quantity).toBe(0)
    expect(asOfOct1.readiness.pendingCandidateIds).not.toContain(candidate.id)
    expect(asOfOct1.readiness.qualifiedCandidateIds).not.toContain(candidate.id)
    expect(asOfOct1.candidateIdsConsidered).not.toContain(candidate.id)
    expect(effectiveCandidateStatusAsOf(candidate, '2026-10-01T00:00:00Z')).toBe('not_yet_created')
  })

  it('the same candidate participates according to its effective status once billingAsOf reaches its created_at', () => {
    const rule = buildActiveOs202609Rule()
    const candidate = makeCandidate({
      status: 'qualified', attribution_at: '2026-09-12T09:00:00Z', decided_at: '2026-09-12T09:00:00Z',
      created_at: '2026-10-05T00:00:00Z', rule,
    })
    const coverage = septemberCoverage('2026-10-01T00:00:00Z')

    const asOfOct6 = aggregateQualifiedUnits(buildCtx({ rule, candidates: [candidate], coverage, asOf: '2026-10-06T00:00:00Z' }))
    expect(asOfOct6.readiness.outcome).toBe('ready')
    expect(asOfOct6.quantity).toBe(1)
    expect(asOfOct6.readiness.qualifiedCandidateIds).toContain(candidate.id)
    expect(asOfOct6.candidateIdsConsidered).toContain(candidate.id)
    expect(effectiveCandidateStatusAsOf(candidate, '2026-10-06T00:00:00Z')).toBe('qualified')
  })

  it('a later-created candidate cannot retroactively alter a historical aggregate already evaluated at an earlier asOf — correction only ever flows through SourceCoverage, never candidate row time-travel', () => {
    const rule = buildActiveOs202609Rule()
    const earlyCandidate = makeCandidate({
      status: 'qualified', attribution_at: '2026-09-08T09:00:00Z', decided_at: '2026-09-08T09:00:00Z',
      created_at: '2026-09-08T09:00:00Z', rule,
    })
    // Discovery coverage established BEFORE the historical asOf — proves
    // completeness genuinely known at that time, independent of which
    // candidate rows happen to exist by the time this test itself runs.
    const coverage = septemberCoverage('2026-10-01T00:00:00Z')
    const historicalAsOf = '2026-10-01T00:00:00Z'

    const beforeBackfill = aggregateQualifiedUnits(buildCtx({ rule, candidates: [earlyCandidate], coverage, asOf: historicalAsOf }))
    expect(beforeBackfill.readiness.outcome).toBe('ready')
    expect(beforeBackfill.quantity).toBe(1)

    // Time passes; a second, genuinely September-attributed candidate is
    // discovered/backfilled on Oct 5 — added to the SAME input array a
    // later caller would now pass in.
    const backfilledCandidate = makeCandidate({
      status: 'qualified', attribution_at: '2026-09-20T09:00:00Z', decided_at: '2026-09-20T09:00:00Z',
      created_at: '2026-10-05T00:00:00Z', rule,
    })

    // Re-running the EXACT SAME historical replay (same asOf) with the new
    // row present must reproduce the IDENTICAL result — never silently
    // pick up the backfilled candidate for a replay that predates its own
    // creation.
    const replay = aggregateQualifiedUnits(buildCtx({ rule, candidates: [earlyCandidate, backfilledCandidate], coverage, asOf: historicalAsOf }))
    expect(replay.quantity).toBe(1)
    expect(replay.candidateIdsConsidered).toEqual(beforeBackfill.candidateIdsConsidered)
    expect(replay.candidateIdsConsidered).not.toContain(backfilledCandidate.id)

    // Only a LATER asOf (at/after the backfilled row's own created_at)
    // legitimately sees it.
    const laterAsOf = aggregateQualifiedUnits(buildCtx({ rule, candidates: [earlyCandidate, backfilledCandidate], coverage, asOf: '2026-10-06T00:00:00Z' }))
    expect(laterAsOf.quantity).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Hardening item 4 — no one-rule-per-period limitation. A billing period is
// partitioned into rule-effective segments; the period is ready only when
// EVERY segment's own discovery completeness independently clears.
// ═══════════════════════════════════════════════════════════════════════════
describe('resolveRuleSegmentsForPeriod', () => {
  it('resolves the one rule version whose effective window fully covers the period', () => {
    const rule = buildActiveOs202609Rule()
    const result = resolveRuleSegmentsForPeriod([rule], 'SQM', PERIOD_START, PERIOD_END)
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.segments).toEqual([{ start: PERIOD_START, end: PERIOD_END, rule }])
    }
  })

  it('fails closed (gap) when no rule version covers part of the period', () => {
    const rule = { ...buildActiveOs202609Rule(), effective_from: '2026-11-01T00:00:00Z' }
    const result = resolveRuleSegmentsForPeriod([rule], 'SQM', PERIOD_START, PERIOD_END)
    expect(result.status).toBe('gap')
  })

  it('fails closed (ambiguous) when two rule versions both cover the same sub-interval', () => {
    const rule1 = buildActiveOs202609Rule()
    const rule2 = { ...buildActiveOs202609Rule(), id: 'rule-os-2026-09-sqm-v2' }
    const result = resolveRuleSegmentsForPeriod([rule1, rule2], 'SQM', PERIOD_START, PERIOD_END)
    expect(result.status).toBe('ambiguous')
  })

  it('partitions a mid-period amendment into two contiguous segments, each with its own governing rule', () => {
    const ruleV1 = buildActiveOs202609Rule({ id: 'rule-v1', status: 'superseded', effective_from: '2026-01-01T00:00:00Z', effective_to: '2026-09-15T00:00:00Z' })
    const ruleV2 = buildActiveOs202609Rule({ id: 'rule-v2', status: 'active', effective_from: '2026-09-15T00:00:00Z', effective_to: null, supersedes_rule_id: 'rule-v1' })
    const result = resolveRuleSegmentsForPeriod([ruleV1, ruleV2], 'SQM', PERIOD_START, PERIOD_END)
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.segments).toEqual([
        { start: PERIOD_START, end: '2026-09-15T00:00:00.000Z', rule: ruleV1 },
        { start: '2026-09-15T00:00:00.000Z', end: PERIOD_END, rule: ruleV2 },
      ])
    }
  })
})

describe('period readiness across a mid-period rule amendment (hardening item 4)', () => {
  const ruleV1 = buildActiveOs202609Rule({ id: 'rule-v1', status: 'superseded', effective_from: '2026-01-01T00:00:00Z', effective_to: '2026-09-15T00:00:00Z' })
  const ruleV2 = buildActiveOs202609Rule({ id: 'rule-v2', status: 'active', effective_from: '2026-09-15T00:00:00Z', effective_to: null, supersedes_rule_id: 'rule-v1' })

  function ctxWithBothRules(overrides: { candidates: BillableUnitCandidate[]; coverage: SourceCoverage[]; asOf?: string }): QualifiedUnitAggregationContext {
    return {
      jobId: 'job-os-2026-09', orgId: 'org-lynora', unitType: 'SQM',
      periodStart: PERIOD_START, periodEnd: PERIOD_END, asOf: overrides.asOf ?? '2026-10-05T00:00:00Z',
      sourceBindings: SOURCE_BINDINGS, sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS,
      ruleVersions: [ruleV1, ruleV2], candidates: overrides.candidates, coverage: overrides.coverage,
    }
  }

  it('ready only once BOTH segments (Sep 1-14 under v1, Sep 15-30 under v2) have complete discovery coverage', () => {
    const candidateV1 = makeCandidate({ status: 'qualified', attribution_at: '2026-09-05T10:00:00Z', rule: ruleV1 })
    const candidateV2 = makeCandidate({ status: 'qualified', attribution_at: '2026-09-20T10:00:00Z', rule: ruleV2 })
    const coverage = [
      makeCoverage({ covered_from: PERIOD_START, covered_through: '2026-09-15T00:00:00Z', established_at: '2026-10-01T00:00:00Z' }),
      makeCoverage({ covered_from: '2026-09-15T00:00:00Z', covered_through: PERIOD_END, established_at: '2026-10-01T00:00:00Z' }),
    ]
    const result = aggregateQualifiedUnits(ctxWithBothRules({ candidates: [candidateV1, candidateV2], coverage }))
    expect(result.readiness.outcome).toBe('ready')
    expect(result.quantity).toBe(2)
  })

  it('pending when only the FIRST segment (v1) has complete discovery coverage', () => {
    const candidateV1 = makeCandidate({ status: 'qualified', attribution_at: '2026-09-05T10:00:00Z', rule: ruleV1 })
    const candidateV2 = makeCandidate({ status: 'qualified', attribution_at: '2026-09-20T10:00:00Z', rule: ruleV2 })
    const coverage = [makeCoverage({ covered_from: PERIOD_START, covered_through: '2026-09-15T00:00:00Z', established_at: '2026-10-01T00:00:00Z' })]
    const result = aggregateQualifiedUnits(ctxWithBothRules({ candidates: [candidateV1, candidateV2], coverage }))
    expect(result.readiness.outcome).toBe('pending')
    expect(result.quantity).toBeNull()
    expect(result.readiness.discoveryCompleteness.reason).toMatch(/rule-v2/)
  })

  it('pending when only the SECOND segment (v2) has complete discovery coverage', () => {
    const candidateV1 = makeCandidate({ status: 'qualified', attribution_at: '2026-09-05T10:00:00Z', rule: ruleV1 })
    const candidateV2 = makeCandidate({ status: 'qualified', attribution_at: '2026-09-20T10:00:00Z', rule: ruleV2 })
    const coverage = [makeCoverage({ covered_from: '2026-09-15T00:00:00Z', covered_through: PERIOD_END, established_at: '2026-10-01T00:00:00Z' })]
    const result = aggregateQualifiedUnits(ctxWithBothRules({ candidates: [candidateV1, candidateV2], coverage }))
    expect(result.readiness.outcome).toBe('pending')
    expect(result.readiness.discoveryCompleteness.reason).toMatch(/rule-v1/)
  })

  it('fails closed when the two rule versions overlap ambiguously (a mis-amended period) rather than picking one', () => {
    const overlappingV2 = { ...ruleV2, effective_from: '2026-09-10T00:00:00Z' } // v1 ends 09-15, v2 starts 09-10 — a real overlap
    const candidate = makeCandidate({ status: 'qualified', attribution_at: '2026-09-12T10:00:00Z', rule: ruleV1 })
    const result = aggregateQualifiedUnits({
      jobId: 'job-os-2026-09', orgId: 'org-lynora', unitType: 'SQM',
      periodStart: PERIOD_START, periodEnd: PERIOD_END, asOf: '2026-10-05T00:00:00Z',
      sourceBindings: SOURCE_BINDINGS, sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS,
      ruleVersions: [ruleV1, overlappingV2], candidates: [candidate], coverage: septemberCoverage(),
    })
    expect(result.readiness.outcome).toBe('pending')
    expect(result.readiness.reason).toMatch(/cannot resolve which rule version/)
  })
})

describe('evaluatePeriodReadiness — cross-rule invariant', () => {
  it('throws when an in-period candidate is pinned to a different rule than the segment governing its own attribution_at', () => {
    const rule = buildActiveOs202609Rule()
    const otherRule = { ...rule, id: 'rule-other' }
    const candidate = makeCandidate({ status: 'qualified', attribution_at: '2026-09-10T09:00:00Z', rule: otherRule })
    expect(() => evaluatePeriodReadiness(buildCtx({ rule, candidates: [candidate], coverage: septemberCoverage() })))
      .toThrow(/pinned to rule/)
  })
})
