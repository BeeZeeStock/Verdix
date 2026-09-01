import { describe, it, expect } from 'vitest'
import { buildBillingPlanSnapshot, fingerprintBillingPlan, planComponentKey, type BillingPlanSnapshot } from './billing-execution-plan'
import { applyExtractionSafetyNets } from './contract-extractor'
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
    const a: BillingPlanSnapshot = { provider: 'stripe', currency: 'EUR', customerIdentityKey: 'x', lines: [{ kind: 'period', componentKey: 'period:1:0', amount: 100, currency: 'EUR', quantity: 1, unitPrice: null, dueDate: '2026-01-01', vatMode: 'zero_rated', vatRatePct: 0 }], blockedOneTimeFees: [] }
    const b: BillingPlanSnapshot = { currency: 'EUR', provider: 'stripe', lines: [{ vatRatePct: 0, vatMode: 'zero_rated', dueDate: '2026-01-01', unitPrice: null, quantity: 1, currency: 'EUR', amount: 100, componentKey: 'period:1:0', kind: 'period' }], customerIdentityKey: 'x', blockedOneTimeFees: [] }
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

// Step 17H.4B0B — buildBillingPlanSnapshot is the due-now execution path: a
// one-time fee's `amount`/`quantity`/`unitPrice` here becomes the literal
// Stripe/Remembill invoice figure (see lib/billing-writer.ts's due-now
// loop). Previously resolved via a bare `.find()`, which on a duplicated
// line_items row (e.g. from a re-extraction — 17H.4B0A) silently picked
// whichever candidate Postgres returned first. These tests prove the
// cardinality-aware replacement: unique match unchanged, no match falls
// back safely to the contract-terms amount (never blocks a valid invoice
// for a missing association), and an ambiguous match is excluded from
// `lines` entirely and reported via `blockedOneTimeFees` instead of ever
// being guessed.
describe('buildBillingPlanSnapshot — one-time fee line-item resolution (Step 17H.4B0B)', () => {
  const oneTimeTerms = (label = 'Setup Fee', amount = 5000) => baseTerms({
    one_time_fees: [{ fee_label: label, amount, due_date: null, description: null }],
  })

  it('a unique matching line item is used exactly as before', () => {
    const lineItems = [{ id: 'li-1', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, currency: 'EUR' }]
    const snapshot = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(snapshot.lines).toHaveLength(1)
    expect(snapshot.lines[0].amount).toBe(4800)
    expect(snapshot.lines[0].quantity).toBe(1)
    expect(snapshot.lines[0].unitPrice).toBe(4800)
    expect(snapshot.blockedOneTimeFees).toEqual([])
  })

  it('zero candidates falls back to the contract-terms amount — never blocks a valid invoice for a missing association', () => {
    const snapshot = buildBillingPlanSnapshot({ terms: oneTimeTerms('Setup Fee', 5000), lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(snapshot.lines).toHaveLength(1)
    expect(snapshot.lines[0].amount).toBe(5000)
    expect(snapshot.blockedOneTimeFees).toEqual([])
  })

  it('two identical candidates must not choose the first — blocked, not invoiced', () => {
    const lineItems = [
      { id: 'li-1', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, currency: 'EUR' },
      { id: 'li-2', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, currency: 'EUR' },
    ]
    const snapshot = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(snapshot.lines).toHaveLength(0)
    expect(snapshot.blockedOneTimeFees).toEqual([{ feeLabel: 'Setup Fee', reason: 'Multiple billing line items match this one-time fee. Billing cannot proceed safely.' }])
  })

  it('two candidates with different monetary values must block, not average or pick either', () => {
    const lineItems = [
      { id: 'li-1', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, currency: 'EUR' },
      { id: 'li-2', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 6000, total_amount: 6000, quantity: 1, currency: 'EUR' },
    ]
    const snapshot = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(snapshot.lines).toHaveLength(0)
    expect(snapshot.blockedOneTimeFees).toHaveLength(1)
  })

  it('several unrelated one-time line items do not count as candidates for a different fee', () => {
    const lineItems = [
      { id: 'li-1', product_name: 'Onboarding Fee', billing_period: 'one_time', unit_price: 1000, total_amount: 1000, quantity: 1, currency: 'EUR' },
      { id: 'li-2', product_name: 'Migration Fee', billing_period: 'one_time', unit_price: 2000, total_amount: 2000, quantity: 1, currency: 'EUR' },
      { id: 'li-3', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, currency: 'EUR' },
    ]
    const snapshot = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(snapshot.lines).toHaveLength(1)
    expect(snapshot.lines[0].amount).toBe(4800)
    expect(snapshot.blockedOneTimeFees).toEqual([])
  })

  it('candidate array order never changes the outcome', () => {
    const forward = [
      { id: 'li-1', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, currency: 'EUR' },
      { id: 'li-2', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 6000, total_amount: 6000, quantity: 1, currency: 'EUR' },
    ]
    const reversed = [...forward].reverse()
    const s1 = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems: forward, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    const s2 = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems: reversed, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(s1.lines).toHaveLength(0)
    expect(s2.lines).toHaveLength(0)
    expect(s1.blockedOneTimeFees).toEqual(s2.blockedOneTimeFees)
  })

  it('an ambiguous one-time fee does not block an unrelated due-now period line in the same snapshot', () => {
    const lineItems = [
      { id: 'li-1', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, currency: 'EUR' },
      { id: 'li-2', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 6000, total_amount: 6000, quantity: 1, currency: 'EUR' },
    ]
    const snapshot = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: withSchedule })
    expect(snapshot.lines).toHaveLength(1)
    expect(snapshot.lines[0].kind).toBe('period')
    expect(snapshot.blockedOneTimeFees).toHaveLength(1)
  })

  it('a resolved ambiguity (back to a unique candidate) changes the fingerprint', () => {
    const ambiguous = [
      { id: 'li-1', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, currency: 'EUR' },
      { id: 'li-2', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 6000, total_amount: 6000, quantity: 1, currency: 'EUR' },
    ]
    const unique = [ambiguous[0]]
    const s1 = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems: ambiguous, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    const s2 = buildBillingPlanSnapshot({ terms: oneTimeTerms(), lineItems: unique, evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now, computeBillingSchedule: noSchedule })
    expect(fingerprintBillingPlan(s1)).not.toBe(fingerprintBillingPlan(s2))
  })
})

// Acceptance-test fix round, final amendment (Agreement A, item 1) — proves
// the actual end-to-end execution-safety consequence of the fix in
// lib/contract-extractor.ts's normalizeBillabilityCondition: a fee described
// as "immediate" (kind: 'immediate' projects to due_date: null, which this
// module's own isDue check — `!feeDueDate || feeDueDate <= now` — treats as
// due unconditionally, with NO awareness of the agreement's Effective Date)
// must never be able to bill before the contract's own stated Effective
// Date, even when Verdix processes the contract well ahead of that date —
// a normal, expected sequence, not an edge case.
// Agreement A final amendment (post-review correction) — the ORIGINAL fix
// for this bug (immediate -> due_date null -> always due now, regardless of
// the agreement's own Effective Date) rewrote every extracted `immediate`
// condition to fixed_date(contract_start_date) whenever a start date was
// known. That was too broad: this normalization function has no access to
// the source clause text, only the model's already-chosen `kind` — it
// cannot tell a genuinely Effective-Date-tied clause ("billable immediately
// on the Effective Date") apart from a genuinely signing-tied one
// ("Customer shall pay the onboarding fee immediately [upon execution]")
// misclassified as immediate, or a genuinely untethered one ("payable
// immediately", no anchor named at all). Rewriting based on contractStartDate
// alone would have silently moved a signing-anchored fee to the Effective
// Date whenever the two differ (e.g. signed 1 September, Effective Date 1
// October) — changing contract meaning from a field with no source
// grounding to justify it. The fix now lives entirely in the extraction
// PROMPT (lib/contract-extractor.ts's billability_condition guidance): the
// model reads the actual clause and must emit fixed_date(contract_start_date)
// directly whenever the clause names the Effective Date/commencement,
// event/contract_signature whenever it names signing/execution (even when
// "immediately" modifies that), and immediate only when the clause names
// neither anchor. normalizeBillabilityCondition no longer reinterprets any
// of this after the fact — these tests prove each already-correctly-classified
// raw condition survives normalization unchanged, and that a genuine
// `immediate` condition is never silently moved just because a start date
// happens to be known.
describe('billability_condition kinds survive normalization unchanged — no post-hoc reinterpretation from contractStartDate (Agreement A final amendment, item 1 correction)', () => {
  it('a correctly-extracted Effective-Date fee (fixed_date) cannot execute before that date, and becomes due once it arrives', () => {
    const effectiveDate = '2026-09-17'
    const uploadDay = new Date('2026-08-01T00:00:00') // extraction happens well before the Effective Date
    const rawTerms = {
      customer_name: 'Acme Co', currency: 'SEK', contract_start_date: effectiveDate,
      overage_tiers: [], discounts: [], service_credits: [],
      one_time_fees: [{
        fee_label: 'Account setup fee', amount: 15000, due_date: null, description: null,
        // Simulates a correctly-prompted extraction for "billable
        // immediately on the Effective Date" — the model, not this
        // function, is responsible for choosing fixed_date here.
        billability_condition: { kind: 'fixed_date', date: effectiveDate },
      }],
    } as unknown as ContractTerms

    const terms = applyExtractionSafetyNets(rawTerms)
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'fixed_date', date: effectiveDate })
    expect(fee.due_date).toBe(effectiveDate)

    // Extracted a month and a half before the Effective Date -> must NOT be
    // part of what's due now.
    const beforeEffectiveDate = buildBillingPlanSnapshot({
      terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now: uploadDay, computeBillingSchedule: noSchedule,
    })
    expect(beforeEffectiveDate.lines).toHaveLength(0)

    // Once the Effective Date has actually arrived, the same fee becomes due.
    const onEffectiveDate = buildBillingPlanSnapshot({
      terms, lineItems: [], evidence: [], alreadySentKeys: new Set(), provider: 'stripe', vat, now: new Date(effectiveDate + 'T00:00:00'), computeBillingSchedule: noSchedule,
    })
    expect(onEffectiveDate.lines).toHaveLength(1)
  })

  it('an "upon signing" fee (event/contract_signature) is never moved to the Effective Date, even when contract_start_date is known and later than signing', () => {
    const rawTerms = {
      customer_name: 'Acme Co', currency: 'SEK', contract_start_date: '2026-10-01', // signed 1 Sept, effective 1 Oct
      overage_tiers: [], discounts: [], service_credits: [],
      one_time_fees: [{
        fee_label: 'Onboarding fee', amount: 15000, due_date: null, description: null,
        billability_condition: { kind: 'event', event_type: 'contract_signature' },
      }],
    } as unknown as ContractTerms
    const terms = applyExtractionSafetyNets(rawTerms)
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'event', event_type: 'contract_signature' })
    expect(fee.due_date).toBeNull() // never fixed_date('2026-10-01') — that would be a silent meaning change
  })

  it('a genuinely immediate fee is NOT rewritten to fixed_date merely because contract_start_date exists — the core regression from the prior, too-broad fix', () => {
    const rawTerms = {
      customer_name: 'Acme Co', currency: 'SEK', contract_start_date: '2026-10-01',
      overage_tiers: [], discounts: [], service_credits: [],
      one_time_fees: [{
        fee_label: 'Onboarding fee', amount: 15000, due_date: null, description: null,
        // "Customer shall pay the onboarding fee immediately" — no
        // Effective Date or signing wording named at all.
        billability_condition: { kind: 'immediate' },
      }],
    } as unknown as ContractTerms
    const terms = applyExtractionSafetyNets(rawTerms)
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'immediate' })
    expect(fee.due_date).toBeNull()
  })

  it('without a known contract_start_date, "immediate" is preserved as-is', () => {
    const rawTerms = {
      customer_name: 'Acme Co', currency: 'SEK',
      overage_tiers: [], discounts: [], service_credits: [],
      one_time_fees: [{
        fee_label: 'Account setup fee', amount: 15000, due_date: null, description: null,
        billability_condition: { kind: 'immediate' },
      }],
    } as unknown as ContractTerms
    const terms = applyExtractionSafetyNets(rawTerms)
    expect(terms.one_time_fees[0].billability_condition).toEqual({ kind: 'immediate' })
  })
})
