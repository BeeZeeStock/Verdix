import { describe, it, expect } from 'vitest'
import { classifyOneTimeFeeKind, deriveOneTimeFeeBillabilityRow } from './one-time-fee-commercial-logic'

describe('classifyOneTimeFeeKind — Step 17H.3C4 (sign-only, no label inference)', () => {
  // Step 17H.3C4 — proves display-name changes never alter semantic
  // classification, the exact regression the previous (17H.3C3) regex
  // version was vulnerable to. classifyOneTimeFeeKind no longer even
  // accepts a fee_label parameter — these deliberately misleading labels
  // are passed through the full OneTimeFee shape (as page.tsx's real call
  // sites do) to prove the extra property is simply ignored.
  it.each([
    ['Professional services onboarding', 5000],
    ['Sensor equipment kit', 2000],
    ['ERP connector', 1500],
    ['Hardware', 100],
    ['Consulting deployment', 0],
  ])('a positive/zero fee labeled %s is always the generic "One-time / project fee" — never inferred from the label', (fee_label, amount) => {
    expect(classifyOneTimeFeeKind({ fee_label, amount })).toBe('One-time / project fee')
  })

  it('a negative amount is always Credit / adjustment, regardless of label — sign is an authoritative numeric fact, not label inference', () => {
    expect(classifyOneTimeFeeKind({ fee_label: 'Hardware install rebate', amount: -500 })).toBe('Credit / adjustment')
  })

  it('"Annual hardware credit" (negative) classifies by sign, not by the word "hardware" in its label', () => {
    expect(classifyOneTimeFeeKind({ fee_label: 'Annual hardware credit', amount: -1200 })).toBe('Credit / adjustment')
  })

  it('zero amount is not treated as a credit (amount < 0 is the sole, exact threshold)', () => {
    expect(classifyOneTimeFeeKind({ fee_label: 'Anything', amount: 0 })).toBe('One-time / project fee')
  })
})

describe('deriveOneTimeFeeBillabilityRow — Step 17H.3C3', () => {
  it('a capability-blocked fee (unsupported_semantics) has no confirmable action', () => {
    const row = deriveOneTimeFeeBillabilityRow({ unresolved_kind: 'unsupported_semantics', billability_condition: undefined })
    expect(row).toEqual({
      state: 'blocked', value: 'Not supported by Verdix',
      helperText: 'This billability condition does not fit a supported contractual trigger — it stays blocked from billing. There is no confirmation that resolves it.',
    })
  })

  it('an immediate condition, resolved provenance', () => {
    const row = deriveOneTimeFeeBillabilityRow({ billability_condition: { kind: 'immediate' }, billability_provenance: 'contract_derived' })
    expect(row).toEqual({ state: 'resolved', value: 'Immediate', provenanceValue: 'contract_derived' })
  })

  it('a fixed-date condition shows the actual contractual date, never a recurring period', () => {
    const row = deriveOneTimeFeeBillabilityRow({ billability_condition: { kind: 'fixed_date', date: '2026-09-01' }, billability_provenance: 'reviewer_policy' })
    expect(row).toEqual({ state: 'resolved', value: 'Fixed date — 2026-09-01', provenanceValue: 'reviewer_policy' })
  })

  it.each([
    ['contract_signature', 'Contract signature'],
    ['delivery', 'Delivery'],
    ['customer_acceptance', 'Customer acceptance'],
    ['final_acceptance', 'Final acceptance'],
    ['change_order_signature', 'Signed change order'],
  ] as const)('event condition %s resolves to the generic, typed label %s — never a hard-coded single-event assumption', (event_type, label) => {
    const row = deriveOneTimeFeeBillabilityRow({ billability_condition: { kind: 'event', event_type }, billability_provenance: 'contract_derived' })
    expect(row).toEqual({ state: 'resolved', value: label, provenanceValue: 'contract_derived' })
    // Item 15 — the contractual TRIGGER only, never live evidence/execution
    // wording ("awaiting", "confirmed", "evidence").
    expect(row.value).not.toMatch(/awaiting|evidence|confirmed/i)
  })

  it('an unresolved event condition (verdix_recommends provenance) is decision-required, not silently shown as resolved', () => {
    const row = deriveOneTimeFeeBillabilityRow({ billability_condition: { kind: 'event', event_type: 'delivery' }, billability_provenance: 'verdix_recommends' })
    expect(row).toEqual({ state: 'decision_required', value: 'Decision required', helperText: 'When does this fee become billable?' })
  })

  it('a genuine legacy record (billability_condition undefined, manual_trigger true) reads "Manual billing" — matching ReviewPanel, never the retired "On delivery" wording', () => {
    const row = deriveOneTimeFeeBillabilityRow({ billability_condition: undefined, manual_trigger: true })
    expect(row).toEqual({ state: 'resolved', value: 'Manual billing', provenanceValue: undefined })
  })

  it('a legacy record with no manual_trigger and no condition at all reads "Needs review", not silently blank', () => {
    const row = deriveOneTimeFeeBillabilityRow({ billability_condition: undefined, manual_trigger: false })
    expect(row).toEqual({ state: 'resolved', value: 'Needs review', provenanceValue: undefined })
  })
})
