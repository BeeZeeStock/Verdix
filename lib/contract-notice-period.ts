// Step 17A, item 10 — a contract stating "three (3) months' notice" must
// never be silently normalized to "90 days notice" for display. Prefers
// ContractTerms.renewal_notice_months (the contract's own stated unit)
// over renewal_notice_days whenever both/either are present — never
// derives one from the other in either direction.
export function formatRenewalNoticePeriod(
  terms: { renewal_notice_months?: number | null; renewal_notice_days?: number | null },
): string | null {
  if (terms.renewal_notice_months != null) {
    const n = terms.renewal_notice_months
    return `${n} ${n === 1 ? 'month' : 'months'} notice required`
  }
  if (terms.renewal_notice_days != null) {
    const n = terms.renewal_notice_days
    return `${n} ${n === 1 ? 'day' : 'days'} notice required`
  }
  return null
}
