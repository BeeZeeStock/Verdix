// Canonical currency display formatter — previously every surface that
// showed a monetary figure (configure/[id]/page.tsx, BillingSummaryCard.tsx,
// RevenueModelTab.tsx, ...) defined its own local Intl.NumberFormat wrapper.
// They were all functionally identical (en-US locale, always 2 decimals),
// so consolidating here changes no output — it just gives every new
// surface (starting with FinancialAmount) one place to read from instead
// of re-implementing the same formatter. Existing local `fmt` functions
// are left in place at their current call sites (a mass find-replace
// across unrelated, already-working call sites is outside this pass's
// scope — see the financial-number design-system task).
export function formatCurrency(amount: number, currency: string = 'EUR'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
}

// Per-unit rates are often sub-cent for high-volume metrics — a fixed 2
// decimals rounds them to 0.00 and makes a real price look unset.
export function formatCurrencyRate(amount: number, currency: string = 'EUR'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount)
}
