import { describe, it, expect } from 'vitest'
import { buildOneTimeFeeConfirmation, OneTimeFeeCapabilityBlockedError, OneTimeFeeValueMutationRejectedError } from './one-time-fee'
import type { OneTimeFee } from './types'

function fee(overrides: Partial<OneTimeFee> = {}): OneTimeFee {
  return { fee_label: 'Onboarding fee', amount: 5000, due_date: null, description: null, ...overrides }
}

describe('buildOneTimeFeeConfirmation — amount dimension (Step 11, item 9)', () => {
  it('confirmAmount clears requires_confirmation and mints reviewer_policy', () => {
    const result = buildOneTimeFeeConfirmation(
      fee({ amount: 100000, requires_confirmation: true, unresolved_kind: 'needs_review', confirmation_reason: 'ambiguous' }),
      { confirmAmount: true },
    )
    expect(result.amount_provenance).toBe('reviewer_policy')
    expect(result.requires_confirmation).toBe(false)
    expect(result.confirmation_reason).toBeNull()
    expect(result.amount).toBe(100000) // unchanged — no correction submitted
  })

  it('confirmAmount plus a corrected amount applies both, still minting reviewer_policy — a corrected number is never itself evidence of contract_derived', () => {
    const result = buildOneTimeFeeConfirmation(
      fee({ amount: 90000, requires_confirmation: true }),
      { confirmAmount: true, amount: 100000 },
    )
    expect(result.amount).toBe(100000)
    expect(result.amount_provenance).toBe('reviewer_policy')
  })

  it('is pure — never mutates the existing fee object', () => {
    const existing = fee({ amount: 5000, requires_confirmation: true })
    const before = JSON.stringify(existing)
    buildOneTimeFeeConfirmation(existing, { confirmAmount: true, amount: 9999 })
    expect(JSON.stringify(existing)).toBe(before)
  })

  it('preserves every other field on the fee unchanged (fee_label, due_date, description, manual_trigger, metric_name, rate_per_unit)', () => {
    const existing = fee({
      fee_label: 'Implementation fee', due_date: '2026-05-01', description: 'Setup work',
      manual_trigger: true, metric_name: 'hours', rate_per_unit: 150, amount: 0, requires_confirmation: true,
    })
    const result = buildOneTimeFeeConfirmation(existing, { confirmAmount: true })
    expect(result.fee_label).toBe('Implementation fee')
    expect(result.due_date).toBe('2026-05-01')
    expect(result.description).toBe('Setup work')
    expect(result.manual_trigger).toBe(true)
    expect(result.metric_name).toBe('hours')
    expect(result.rate_per_unit).toBe(150)
  })
})

describe('buildOneTimeFeeConfirmation — billability dimension (Step 11 amendment)', () => {
  it('confirmBillability alone resolves billability without touching amount_provenance/requires_confirmation', () => {
    const existing = fee({ amount: 100000, requires_confirmation: true, confirmation_reason: 'ambiguous', billability_provenance: null })
    const result = buildOneTimeFeeConfirmation(existing, { confirmBillability: true })
    expect(result.billability_provenance).toBe('reviewer_policy')
    // Amount dimension untouched — item 2: confirming one must never
    // resolve the other.
    expect(result.requires_confirmation).toBe(true)
    expect(result.confirmation_reason).toBe('ambiguous')
    expect(result.amount_provenance).toBeNull()
  })

  it('confirmAmount alone resolves amount without touching billability_provenance', () => {
    const existing = fee({ amount: 100000, requires_confirmation: true, billability_provenance: null })
    const result = buildOneTimeFeeConfirmation(existing, { confirmAmount: true })
    expect(result.amount_provenance).toBe('reviewer_policy')
    expect(result.requires_confirmation).toBe(false)
    // Billability dimension untouched.
    expect(result.billability_provenance).toBeNull()
  })

  it('both dimensions can be confirmed together in one submission, both minting reviewer_policy', () => {
    const existing = fee({ amount: 100000, requires_confirmation: true, billability_provenance: null })
    const result = buildOneTimeFeeConfirmation(existing, { confirmAmount: true, confirmBillability: true })
    expect(result.amount_provenance).toBe('reviewer_policy')
    expect(result.billability_provenance).toBe('reviewer_policy')
    expect(result.requires_confirmation).toBe(false)
  })

  it('neither dimension moves when neither confirm flag is set — a bare amount correction with no confirmAmount does not resolve provenance', () => {
    const existing = fee({ amount: 100000, requires_confirmation: true, amount_provenance: null, billability_provenance: null })
    const result = buildOneTimeFeeConfirmation(existing, { amount: 150000 })
    expect(result.amount).toBe(150000)
    expect(result.amount_provenance).toBeNull()
    expect(result.billability_provenance).toBeNull()
    expect(result.requires_confirmation).toBe(true)
  })
})

describe('buildOneTimeFeeConfirmation — capability-blocked fees (item 5/6 critical guard)', () => {
  it('throws OneTimeFeeCapabilityBlockedError rather than resolving a capability-blocked fee via amount confirmation', () => {
    const blocked = fee({ amount: 100000, requires_confirmation: true, unresolved_kind: 'unsupported_semantics' })
    expect(() => buildOneTimeFeeConfirmation(blocked, { confirmAmount: true })).toThrow(OneTimeFeeCapabilityBlockedError)
  })

  it('throws rather than resolving a capability-blocked fee via billability confirmation either — even when amount is already contract_derived (item 5\'s exact regression case)', () => {
    const blocked = fee({
      amount: 100000, amount_provenance: 'contract_derived',
      requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
    })
    expect(() => buildOneTimeFeeConfirmation(blocked, { confirmBillability: true })).toThrow(OneTimeFeeCapabilityBlockedError)
    expect(() => buildOneTimeFeeConfirmation(blocked, { confirmAmount: true, confirmBillability: true })).toThrow(OneTimeFeeCapabilityBlockedError)
  })

  it('the thrown error carries the fee_label so a route handler can report which fee was blocked without exposing source text', () => {
    const blocked = fee({ fee_label: 'Acceptance-gated milestone', unresolved_kind: 'unsupported_semantics' })
    try {
      buildOneTimeFeeConfirmation(blocked, { confirmAmount: true })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(OneTimeFeeCapabilityBlockedError)
      expect((err as OneTimeFeeCapabilityBlockedError).feeLabel).toBe('Acceptance-gated milestone')
    }
  })
})

// Final security correction — the reviewer-confirmation route accepts only
// plain booleans (confirmAmount/confirmBillability) on its wire type, so a
// crafted request literally cannot express 'contract_derived'/
// 'organization_rulebook'/'verdix_rulebook'/'verdix_recommends' through this
// function's real TypeScript signature. These tests prove the runtime
// behavior independently of the type system, exactly as if a route had
// (incorrectly) forwarded an untrusted string through an `as` cast the way
// the pre-fix code did — confirming there is no runtime code path left that
// would honor it even if a future refactor reintroduced such a cast.
describe('buildOneTimeFeeConfirmation — cannot mint any authority other than reviewer_policy (security correction)', () => {
  const authorities = ['contract_derived', 'organization_rulebook', 'verdix_rulebook', 'verdix_recommends'] as const

  for (const asserted of authorities) {
    it(`amount: a request shaped like it's asserting '${asserted}' produces reviewer_policy, never '${asserted}'`, () => {
      // Simulates a pre-fix-style crafted payload smuggled past the type
      // system — confirmAmount is what the real route reads; the extra
      // property is exactly what an attacker controlling the request body
      // could still attach, and must have zero effect.
      const crafted = { confirmAmount: true, amountProvenance: asserted } as Parameters<typeof buildOneTimeFeeConfirmation>[1]
      const result = buildOneTimeFeeConfirmation(fee({ requires_confirmation: true }), crafted)
      expect(result.amount_provenance).toBe('reviewer_policy')
    })

    it(`billability: a request shaped like it's asserting '${asserted}' produces reviewer_policy, never '${asserted}'`, () => {
      const crafted = { confirmBillability: true, billabilityProvenance: asserted } as Parameters<typeof buildOneTimeFeeConfirmation>[1]
      const result = buildOneTimeFeeConfirmation(fee({ billability_provenance: null }), crafted)
      expect(result.billability_provenance).toBe('reviewer_policy')
    })
  }
})

// Item 5 — a reviewer confirmation must never downgrade an already-valid
// higher-authority resolved value. This function itself still never mints
// contract_derived (see its own module header) — but extraction now can,
// for `amount`, via lib/one-time-fee-provenance.ts (Contract B acceptance
// amendment) — so this guard is no longer purely defense-in-depth for a
// hypothetical future path; it is load-bearing today. See lib/one-time-
// fee-provenance.test.ts for the extraction-grounding tests themselves.
describe('buildOneTimeFeeConfirmation — does not downgrade an existing contract_derived value (item 5)', () => {
  it('amount: existing contract_derived amount stays contract_derived after a reviewer-confirm request', () => {
    const existing = fee({ amount: 100000, amount_provenance: 'contract_derived', requires_confirmation: false })
    const result = buildOneTimeFeeConfirmation(existing, { confirmAmount: true })
    expect(result.amount_provenance).toBe('contract_derived')
  })

  it('billability: existing contract_derived billability stays contract_derived after a reviewer-confirm request', () => {
    const existing = fee({ billability_provenance: 'contract_derived' })
    const result = buildOneTimeFeeConfirmation(existing, { confirmBillability: true })
    expect(result.billability_provenance).toBe('contract_derived')
  })

  it('both dimensions independently preserve contract_derived when both are already at that authority', () => {
    const existing = fee({ amount_provenance: 'contract_derived', billability_provenance: 'contract_derived' })
    const result = buildOneTimeFeeConfirmation(existing, { confirmAmount: true, confirmBillability: true })
    expect(result.amount_provenance).toBe('contract_derived')
    expect(result.billability_provenance).toBe('contract_derived')
  })
})

// Final adversarial check — trusted provenance belongs to a particular
// resolved VALUE, not to the field in the abstract. It must not survive an
// unauthorized change to that value. There is no reviewer-override-of-a-
// contract-value workflow yet, so any attempt to change a contract_derived
// amount's number is rejected outright (fail closed) rather than accepted
// with the value mutated but the trusted authority left untouched.
describe('buildOneTimeFeeConfirmation — value mutation cannot inherit trusted provenance (adversarial correction)', () => {
  it('contract-derived amount + the SAME amount resubmitted → safe no-op, remains contract_derived', () => {
    const existing = fee({ amount: 100000, amount_provenance: 'contract_derived' })
    const result = buildOneTimeFeeConfirmation(existing, { amount: 100000, confirmAmount: true })
    expect(result.amount).toBe(100000)
    expect(result.amount_provenance).toBe('contract_derived')
  })

  it('contract-derived amount + a DIFFERENT amount → rejected with OneTimeFeeValueMutationRejectedError, value and provenance both left untouched', () => {
    const existing = fee({ amount: 100000, amount_provenance: 'contract_derived' })
    expect(() => buildOneTimeFeeConfirmation(existing, { amount: 250000, confirmAmount: true }))
      .toThrow(OneTimeFeeValueMutationRejectedError)
    // The existing fee itself is never mutated — buildOneTimeFeeConfirmation is pure.
    expect(existing.amount).toBe(100000)
    expect(existing.amount_provenance).toBe('contract_derived')
  })

  it('contract-derived amount + a different amount, WITHOUT confirmAmount → still rejected — the guard is not gated on the confirm flag', () => {
    const existing = fee({ amount: 100000, amount_provenance: 'contract_derived' })
    expect(() => buildOneTimeFeeConfirmation(existing, { amount: 250000 }))
      .toThrow(OneTimeFeeValueMutationRejectedError)
  })

  it('reviewer-policy amount + a permitted changed amount → new value applied, authority stays reviewer_policy (never upgraded)', () => {
    const existing = fee({ amount: 100000, amount_provenance: 'reviewer_policy' })
    const result = buildOneTimeFeeConfirmation(existing, { amount: 120000, confirmAmount: true })
    expect(result.amount).toBe(120000)
    expect(result.amount_provenance).toBe('reviewer_policy')
  })

  it('unresolved amount (null) + explicit confirmation of a value → reviewer_policy, as currently designed', () => {
    const existing = fee({ amount: 100000, amount_provenance: null, requires_confirmation: true })
    const result = buildOneTimeFeeConfirmation(existing, { amount: 100000, confirmAmount: true })
    expect(result.amount_provenance).toBe('reviewer_policy')
  })

  it('the rejection error carries the fee_label without exposing source text', () => {
    const existing = fee({ fee_label: 'Signature milestone', amount: 100000, amount_provenance: 'contract_derived' })
    try {
      buildOneTimeFeeConfirmation(existing, { amount: 999, confirmAmount: true })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(OneTimeFeeValueMutationRejectedError)
      expect((err as OneTimeFeeValueMutationRejectedError).feeLabel).toBe('Signature milestone')
    }
  })

  it('billability: the reviewer-confirm input has no due_date/manual_trigger field at all — a crafted request smuggling them cannot mutate the underlying billability treatment', () => {
    const existing = fee({ due_date: '2026-01-15', manual_trigger: undefined, billability_provenance: 'contract_derived' })
    // Simulates a crafted payload that also sets due_date/manual_trigger —
    // OneTimeFeeConfirmationInput has no such fields, so even smuggled past
    // the type system via `as`, buildOneTimeFeeConfirmation never reads them.
    const crafted = { confirmBillability: true, due_date: '2099-01-01', manual_trigger: true } as Parameters<typeof buildOneTimeFeeConfirmation>[1]
    const result = buildOneTimeFeeConfirmation(existing, crafted)
    expect(result.due_date).toBe('2026-01-15')
    expect(result.manual_trigger).toBeUndefined()
    expect(result.billability_provenance).toBe('contract_derived') // confirmed, not downgraded
  })
})
