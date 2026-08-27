import { describe, it, expect } from 'vitest'
import { confirmQualificationRuleField, type BillableUnitQualificationRule } from './billable-unit-qualification'
import { buildOs202609Rule, buildOs202609SqmTiers } from './os-2026-09-fixture'
import type { BillableUnitCandidate } from './billable-unit-candidate'
import type { SourceBinding } from './source-bindings'
import type { SourceCoverage } from './source-coverage'
import { aggregateQualifiedUnits, type QualifiedUnitAggregationContext } from './qualified-unit-aggregation'
import {
  resolveCommercialQuantity, requireReadyCommercialQuantity, QuantitySourceNotReadyError,
  type QualifiedUnitAggregateQuantitySource,
} from './commercial-quantity-source'
import { computeMetricOverage } from './tariff'

// ═══════════════════════════════════════════════════════════════════════════
// Step 16B.4, item 12 (and hardening item 3) — proves the qualified-unit
// aggregate flows into the EXISTING pricing engine (lib/tariff.ts's
// computeMetricOverage) unchanged, via lib/commercial-quantity-source.ts's
// normalization layer, using the CANONICAL OS-2026-09 SQM tier table
// (lib/os-2026-09-fixture.ts's buildOs202609SqmTiers — 1-40 @ €250, 41+ @
// €225 all-units, €5,000 monthly minimum) rather than a separate synthetic
// table with different thresholds. No pricing logic is duplicated here —
// the tier table is the SAME shared fixture the commercial engine itself
// would consume. No Stripe/Remembill provider call happens anywhere in
// this file.
// ═══════════════════════════════════════════════════════════════════════════

const PERIOD_START = '2026-09-01T00:00:00.000Z'
const PERIOD_END = '2026-10-01T00:00:00.000Z'

const SOURCE_BINDING_ROLE_KEYS = new Map<string, string>([['binding-crm', 'crm']])
const SOURCE_BINDINGS: SourceBinding[] = [
  { id: 'binding-crm', source_role_id: 'role-crm', job_id: 'job-os-2026-09', org_id: 'org-lynora', label: 'CRM', effective_from: '2020-01-01T00:00:00Z', effective_to: null, supersedes_binding_id: null, status: 'active' },
]

function buildActiveOs202609Rule(): BillableUnitQualificationRule {
  let rule = buildOs202609Rule()
  rule = confirmQualificationRuleField(rule, 'dedupe_rule')
  return { ...rule, id: 'rule-os-2026-09-sqm-v1', status: 'active', effective_from: '2026-01-01T00:00:00Z' }
}

let seq = 0
function qualifiedCandidate(rule: BillableUnitQualificationRule, attributionAt: string): BillableUnitCandidate {
  seq += 1
  return {
    id: `cand-${seq}`, job_id: 'job-os-2026-09', org_id: 'org-lynora', unit_type: 'SQM',
    external_identity: { source_binding_id: 'binding-crm', external_id: `ext-${seq}` },
    booked_at: attributionAt, occurred_at: attributionAt, attribution_at: attributionAt,
    qualification_rule_id: rule.id, qualification_rule_version: rule.version,
    rejection_deadline: null, status: 'qualified', decided_at: attributionAt,
  }
}

function discoveryCoverage(): SourceCoverage[] {
  return [{
    id: 'cov-sept', job_id: 'job-os-2026-09', org_id: 'org-lynora', source_binding_id: 'binding-crm',
    coverage_kind: 'candidate_discovery', covered_from: PERIOD_START, covered_through: PERIOD_END, established_at: '2026-10-02T00:00:00Z',
    completeness_basis: 'connector_high_watermark', established_by: 'test-harness', metadata: {},
    status: 'active', revoked_at: null, revoked_by: null,
  }]
}

function buildCtx(rule: BillableUnitQualificationRule, candidates: BillableUnitCandidate[], coverage: SourceCoverage[]): QualifiedUnitAggregationContext {
  return {
    jobId: 'job-os-2026-09', orgId: 'org-lynora', unitType: 'SQM',
    periodStart: PERIOD_START, periodEnd: PERIOD_END, asOf: '2026-10-05T00:00:00Z',
    ruleVersions: [rule], candidates, sourceBindings: SOURCE_BINDINGS, sourceBindingRoleKeys: SOURCE_BINDING_ROLE_KEYS, coverage,
  }
}

function distinctSeptemberTimestamps(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `2026-09-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z`)
}

function priceQuantity(quantity: number) {
  return computeMetricOverage(quantity, buildOs202609SqmTiers(), 0, true)
}

describe('qualified-unit aggregate -> existing pricing engine, canonical OS-2026-09 terms (items 3, 12)', () => {
  it('10 SQMs -> 10 x €250 = €2,500 -> below the €5,000 floor -> €5,000', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = distinctSeptemberTimestamps(10).map(at => qualifiedCandidate(rule, at))
    const aggregate = aggregateQualifiedUnits(buildCtx(rule, candidates, discoveryCoverage()))
    expect(aggregate.readiness.outcome).toBe('ready')
    expect(aggregate.quantity).toBe(10)

    const source: QualifiedUnitAggregateQuantitySource = { kind: 'qualified_unit_aggregate', metricKey: 'SQM', periodStart: PERIOD_START, periodEnd: PERIOD_END, aggregate }
    const quantity = requireReadyCommercialQuantity(resolveCommercialQuantity(source))
    expect(quantity).toBe(10)

    const priced = priceQuantity(quantity)
    expect(priced.amount).toBe(5000)
    expect(priced.minimumApplied).toBe(true)
  })

  it('40 SQMs -> still Tier 1 (all-units) -> 40 x €250 = €10,000', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = distinctSeptemberTimestamps(40).map(at => qualifiedCandidate(rule, at))
    const aggregate = aggregateQualifiedUnits(buildCtx(rule, candidates, discoveryCoverage()))
    expect(aggregate.quantity).toBe(40)

    const source: QualifiedUnitAggregateQuantitySource = { kind: 'qualified_unit_aggregate', metricKey: 'SQM', periodStart: PERIOD_START, periodEnd: PERIOD_END, aggregate }
    const quantity = requireReadyCommercialQuantity(resolveCommercialQuantity(source))

    const priced = priceQuantity(quantity)
    expect(priced.amount).toBe(10000)
    expect(priced.minimumApplied).toBe(false)
  })

  it('41 SQMs -> crosses into Tier 2 (all-units) -> 41 x €225 = €9,225 (the 40->41 discontinuity)', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = distinctSeptemberTimestamps(41).map(at => qualifiedCandidate(rule, at))
    const aggregate = aggregateQualifiedUnits(buildCtx(rule, candidates, discoveryCoverage()))
    expect(aggregate.quantity).toBe(41)

    const source: QualifiedUnitAggregateQuantitySource = { kind: 'qualified_unit_aggregate', metricKey: 'SQM', periodStart: PERIOD_START, periodEnd: PERIOD_END, aggregate }
    const quantity = requireReadyCommercialQuantity(resolveCommercialQuantity(source))

    const priced = priceQuantity(quantity)
    // All-units/volume: crossing 41 re-rates the FULL quantity at €225 —
    // 41 * 225 = 9,225, LESS than the 40-unit amount above (€10,000) even
    // though one more SQM qualified. Unusual, but exactly what the
    // contract's own all-units structure implies — tested deliberately.
    expect(priced.amount).toBe(9225)
    expect(priced.amount).toBeLessThan(10000)
    expect(priced.minimumApplied).toBe(false)
  })

  it('pending period -> QuantitySourceNotReadyError -> existing pricing engine is never invoked (no guessed invoice)', () => {
    const rule = buildActiveOs202609Rule()
    const candidates = [
      qualifiedCandidate(rule, '2026-09-05T09:00:00Z'),
      { ...qualifiedCandidate(rule, '2026-09-20T09:00:00Z'), status: 'pending' as const, decided_at: null },
    ]
    const aggregate = aggregateQualifiedUnits(buildCtx(rule, candidates, discoveryCoverage()))
    expect(aggregate.readiness.outcome).toBe('pending')

    const source: QualifiedUnitAggregateQuantitySource = { kind: 'qualified_unit_aggregate', metricKey: 'SQM', periodStart: PERIOD_START, periodEnd: PERIOD_END, aggregate }
    const resolved = resolveCommercialQuantity(source)
    expect(resolved.ready).toBe(false)

    let pricingEngineWasCalled = false
    expect(() => {
      const quantity = requireReadyCommercialQuantity(resolved)
      pricingEngineWasCalled = true
      priceQuantity(quantity)
    }).toThrow(QuantitySourceNotReadyError)
    expect(pricingEngineWasCalled).toBe(false)
  })
})
