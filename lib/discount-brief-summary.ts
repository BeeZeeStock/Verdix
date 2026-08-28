// Step 17E, item 10 — the Contract Brief's one-line discount summary
// previously read generic wording like "100% introductory discount",
// which implies the WHOLE contract is free even when the discount only
// waives one component (e.g. a pilot that waives the fixed platform fee
// while a performance share still applies in full). Renders from the
// discount's own typed scope fields (lib/types.ts's affected_components/
// possibly_affected_components — populated at extraction time, never
// free-form model prose) whenever a scope is actually stated; falls back
// to the old generic phrasing only when the contract genuinely doesn't
// name one. Pure, DB-free — app/(dashboard)/configure/[id]/page.tsx's
// buildContractSummary is the sole caller.
export interface DiscountForBrief {
  discount_pct?: number
  discount_type?: string
  end_date?: string
  duration_months?: number
  duration_days?: number | null
  affected_components?: string[] | null
  possibly_affected_components?: string[] | null
}

const COMPONENT_LABELS: Record<string, string> = {
  base_recurring_fee: 'fixed platform fee',
  platform_fee: 'fixed platform fee',
}

function componentLabel(key: string): string {
  return COMPONENT_LABELS[key] ?? key.replace(/_/g, ' ')
}

export function describeDiscountForBrief(d: DiscountForBrief, fmtDate: (s: string | null | undefined) => string): string {
  const scopeKeys = d.affected_components?.length ? d.affected_components : d.possibly_affected_components
  const isFullyWaived = d.discount_pct === 100
  const till = d.end_date ? ` through ${fmtDate(d.end_date)}` : ''

  if (scopeKeys && scopeKeys.length > 0) {
    const componentPhrase = scopeKeys.map(componentLabel).join(' and ')
    const durationPhrase = d.duration_days ? `${d.duration_days}-day pilot`
      : d.duration_months ? `${d.duration_months}-month pilot`
      : d.end_date ? `Pilot${till}` : 'Pilot'
    return isFullyWaived
      ? `${durationPhrase}: ${componentPhrase} waived`
      : `${durationPhrase}: ${componentPhrase} discounted${d.discount_pct != null ? ` ${d.discount_pct}%` : ''}`
  }

  const pct  = d.discount_pct != null ? `${d.discount_pct}%` : ''
  const type = d.discount_type ? ` ${d.discount_type.replace(/_/g, ' ')}` : ''
  return `${pct}${type} discount${till}`.trim()
}
