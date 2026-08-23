// Pure, presentation-only formatters for the review-card concision pass.
// These turn an already-resolved (clear_from_source) service-credit
// sub-field into a SHORT structured-fact value ("Until fully used", "Not
// redeemable") for a label/value row on the review card, replacing a full
// sentence of prose. They never decide provenance/state/eligibility — that
// remains entirely in lib/credit-application-rule.ts and the
// application_state/survival_state/cash_redeemable_state grading already
// produced upstream. Zero React, zero server import — same discipline as
// lib/rule-interpretation.ts.

export function formatEligibleComponentsFact(keys: string[] | 'all' | null | undefined): string {
  if (keys === 'all') return 'Future amounts payable'
  if (Array.isArray(keys) && keys.length > 0) return keys.map(k => k.replace(/_/g, ' ')).join(', ')
  return 'Not specified'
}

// Short label version of the same carry_forward/expiry_periods/expiry_date
// triple describeSurvivalResolution (configure/[id]/page.tsx) already
// renders as a full sentence elsewhere (e.g. the Confirmed billing rules
// summary) — that function is left untouched; this is a separate, terser
// rendering for the review card's structured-fact row, not a replacement.
export function formatCarryForwardFact(carryForward: boolean | 'unclear' | undefined, expiryPeriods?: number | null, expiryDate?: string | null): string {
  if (carryForward !== true) return 'Does not carry forward'
  if (expiryDate) return `Until ${expiryDate}`
  if (expiryPeriods === 1) return 'Next period only'
  if (expiryPeriods && expiryPeriods > 1) return `${expiryPeriods} periods`
  return 'Until fully used'
}

export function formatCashRedeemableFact(cashRedeemable: boolean | 'unclear' | undefined): string {
  if (cashRedeemable === true) return 'Redeemable'
  if (cashRedeemable === false) return 'Not redeemable'
  return 'Not specified'
}
