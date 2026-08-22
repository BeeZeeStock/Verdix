import { describe, it, expect } from 'vitest'
import { buildBillingPlanSnapshot, fingerprintBillingPlan, planComponentKey, type BillingPlanSnapshot } from './billing-execution-plan'
import type { ContractTerms } from './types'

const schedule = [{ yearNum: 1, periodIndex: 0, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-12-31'), baseAmount: 10000 }]
const noSchedule = () => []
const withSchedule = () => schedule

function baseTerms(overrides: Partial<ContractTerms> = {}): ContractTerms {
  return {
    customer_name: 'Acme Co', currency: 'EUR', one_time_fees: [], ...overrides,
  } as ContractTerms
}

const now = new Date('2026-06-01')
const vat = { mode: 'zero_rated' as const, ratePct: 0 }

describe('buildBillingPlanSnapshot + fingerprintBillingPlan (Step 14, items 3/4)', () => {
  it('same inputs produce the identical snapshot and fingerprint', () => {
    const terms = baseTerms()
    const s1 = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: withSchedule })
    const s2 = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: withSchedule })
    expect(fingerprintBillingPlan(s1)).toBe(fingerprintBillingPlan(s2))
    expect(s1).toEqual(s2)
  })

  it('a changed amount changes the fingerprint', () => {
    const terms = baseTerms()
    const s1 = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: withSchedule })
    const s2 = buildBillingPlanSnapshot({
      terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now,
      computeBillingSchedule: () => [{ ...schedule[0], baseAmount: 20000 }],
    })
    expect(fingerprintBillingPlan(s1)).not.toBe(fingerprintBillingPlan(s2))
  })

  it('a changed currency changes the fingerprint', () => {
    const s1 = buildBillingPlanSnapshot({ terms: baseTerms({ currency: 'EUR' }), lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: withSchedule })
    const s2 = buildBillingPlanSnapshot({ terms: baseTerms({ currency: 'USD' }), lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: withSchedule })
    expect(fingerprintBillingPlan(s1)).not.toBe(fingerprintBillingPlan(s2))
  })

  it('a changed VAT treatment changes the fingerprint (item 3: "tax" is a fingerprinted field)', () => {
    const terms = baseTerms()
    const s1 = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat: { mode: 'zero_rated', ratePct: 0 }, now, computeBillingSchedule: withSchedule })
    const s2 = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat: { mode: 'rate', ratePct: 25 }, now, computeBillingSchedule: withSchedule })
    expect(fingerprintBillingPlan(s1)).not.toBe(fingerprintBillingPlan(s2))
  })

  it('a changed component (new one-time fee) changes the fingerprint', () => {
    const s1 = buildBillingPlanSnapshot({ terms: baseTerms(), lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    const s2 = buildBillingPlanSnapshot({
      terms: baseTerms({ one_time_fees: [{ fee_label: 'Setup Fee', amount: 5000, due_date: null, description: null }] }),
      lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule,
    })
    expect(fingerprintBillingPlan(s1)).not.toBe(fingerprintBillingPlan(s2))
  })

  it('a changed customer identity (name) changes the fingerprint', () => {
    const s1 = buildBillingPlanSnapshot({ terms: baseTerms({ customer_name: 'Acme Co' }), lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    const s2 = buildBillingPlanSnapshot({ terms: baseTerms({ customer_name: 'Acme Corp' }), lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(fingerprintBillingPlan(s1)).not.toBe(fingerprintBillingPlan(s2))
  })

  it('property insertion order never affects the fingerprint (canonical serialization)', () => {
    const a: BillingPlanSnapshot = { provider: 'stripe', currency: 'EUR', customerIdentityKey: 'x', lines: [{ kind: 'period', componentKey: 'period:1:0', amount: 100, currency: 'EUR', quantity: 1, unitPrice: null, dueDate: '2026-01-01', vatMode: 'zero_rated', vatRatePct: 0 }] }
    const b: BillingPlanSnapshot = { currency: 'EUR', provider: 'stripe', lines: [{ vatRatePct: 0, vatMode: 'zero_rated', dueDate: '2026-01-01', unitPrice: null, quantity: 1, currency: 'EUR', amount: 100, componentKey: 'period:1:0', kind: 'period' }], customerIdentityKey: 'x' }
    expect(fingerprintBillingPlan(a)).toBe(fingerprintBillingPlan(b))
  })

  it('an already-sent component is excluded from the plan (does not get re-fingerprinted as pending)', () => {
    const terms = baseTerms()
    const withoutSent = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: withSchedule })
    const withSent = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set([planComponentKey({ invoice_type: 'period', year_num: 1, period_start: '2026-01-01', fee_label: null })]), provider: 'stripe', vat, now, computeBillingSchedule: withSchedule })
    expect(withoutSent.lines).toHaveLength(1)
    expect(withSent.lines).toHaveLength(0)
  })

  it('an event-conditioned fee with no satisfying evidence is excluded (held, not part of the plan)', () => {
    const terms = baseTerms({
      one_time_fees: [{
        fee_label: 'Milestone Fee', amount: 5000, due_date: null, description: null,
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' }, fee_id: 'fee-1',
      }],
    })
    const snapshot = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(snapshot.lines).toHaveLength(0)
  })

  it('the same fee becomes part of the plan once satisfying evidence exists — and the fingerprint changes accordingly (item 4: changed evidence -> different plan)', () => {
    const terms = baseTerms({
      one_time_fees: [{
        fee_label: 'Milestone Fee', amount: 5000, due_date: null, description: null,
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' }, fee_id: 'fee-1',
      }],
    })
    const before = buildBillingPlanSnapshot({ terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    const after = buildBillingPlanSnapshot({
      terms, lineItems: [], evidence: [{
        id: 'ev-1', subjectId: 'fee-1', eventType: 'customer_acceptance', occurredAt: now.toISOString(),
        source: 'reviewer_attestation', recordedAt: now.toISOString(), recordedBy: 'admin@test.local', status: 'active',
      }], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule,
    })
    expect(before.lines).toHaveLength(0)
    expect(after.lines).toHaveLength(1)
    expect(fingerprintBillingPlan(before)).not.toBe(fingerprintBillingPlan(after))
  })
})
