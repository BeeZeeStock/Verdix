// Pure, presentation-only formatters for the review-card concision pass.
// These turn an already-resolved (clear_from_source) service-credit
// sub-field into a SHORT structured-fact value ("Until fully used", "Not
// redeemable") for a label/value row on the review card, replacing a full
// sentence of prose. They never decide provenance/state/eligibility — that
// remains entirely in lib/credit-application-rule.ts and the
// application_state/survival_state/cash_redeemable_state grading already
// produced upstream. Zero React, zero server import — same discipline as
// lib/rule-interpretation.ts.

// eligible_component_keys/excluded_component_keys are freeform strings the
// extraction model derives from each contract's own wording (no fixed
// enum) — e.g. "transaction_processing_fees", "platform_subscription_fees".
// A blind `.replace(/_/g, ' ')` produces a readable-enough phrase already,
// but this codebase's own established house style hyphenates "X
// processing" as a single compound term (see the extraction prompt's own
// "transaction-processing fees" phrasing) — kept here so a raw internal key
// never appears unhyphenated/uncapitalized in customer-facing UI, without
// hardcoding a fixed lookup table for a genuinely open-ended vocabulary.
function formatComponentKeyLabel(key: string): string {
  return key.replace(/_/g, ' ').trim().replace(/(\S+) processing\b/gi, '$1-processing')
}

export function formatEligibleComponentsFact(keys: string[] | 'all' | null | undefined): string {
  if (keys === 'all') return 'Future amounts payable'
  if (Array.isArray(keys) && keys.length > 0) {
    const joined = keys.map(formatComponentKeyLabel).join(', ')
    return joined.charAt(0).toUpperCase() + joined.slice(1)
  }
  return 'Not specified'
}

// Short label version of the same carry_forward/expiry_periods/expiry_date
// triple describeSurvivalResolution (configure/[id]/page.tsx) also renders,
// as a full sentence, elsewhere (e.g. confirmation/preview messages) — that
// function is a separate implementation for that separate context, not
// replaced by this one; both were corrected together for the same
// underlying semantic bug (see either one's own comment for the full
// explanation): every credit's availability is fixed to 'next_period' (no
// same-period execution path exists anywhere in this codebase), so
// carry_forward: false structurally means "applied against the next
// invoice only, then any remainder expires" — it can never mean "does not
// survive to be applied at all" (a same-period-only state this model
// cannot represent). 'unclear'/undefined get their own distinct "Not
// specified" branch — collapsing them into the false branch would have
// been an equally real, separate error (this function was previously only
// ever called with a real boolean, but the type signature always allowed
// 'unclear'/undefined, so this closes that latent gap too).
export function formatCarryForwardFact(carryForward: boolean | 'unclear' | undefined, expiryPeriods?: number | null, expiryDate?: string | null): string {
  if (carryForward === true) {
    if (expiryDate) return `Until ${expiryDate}`
    if (expiryPeriods === 1) return 'Next period only'
    if (expiryPeriods && expiryPeriods > 1) return `${expiryPeriods} periods`
    return 'Until fully used'
  }
  if (carryForward === false) return 'Expires after next invoice'
  return 'Not specified'
}

export function formatCashRedeemableFact(cashRedeemable: boolean | 'unclear' | undefined): string {
  if (cashRedeemable === true) return 'Redeemable'
  if (cashRedeemable === false) return 'Not redeemable'
  return 'Not specified'
}
