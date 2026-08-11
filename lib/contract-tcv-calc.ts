// Pure Base TCV calculation — zero I/O, zero server-only imports, so it's
// safe to import from client components. lib/contract-tcv.ts (server-only,
// pulls in supabaseServer) wraps this for the DB-fetching getContractSummaries;
// the Configure page imports this file directly instead, since it already
// has items/terms loaded client-side and importing anything that drags in
// supabaseServer crashes the page (that client throws at module-init time
// when SUPABASE_SERVICE_ROLE_KEY is undefined in the browser bundle).

export function isEscalatorItem(productName: string, appliedRule: string | null | undefined): boolean {
  const name = (productName ?? '').toLowerCase()
  const rule = (appliedRule ?? '').toLowerCase()
  return rule.includes('escalator') || name.includes('escalator') || name.includes('cpi') || name.includes('price escalator')
}

function periodsInTermFor(bp: string | null | undefined, termMonths: number): number {
  if (!termMonths) return 1
  if (bp === 'monthly')     return termMonths
  if (bp === 'quarterly')   return termMonths / 3
  if (bp === 'semi-annual') return termMonths / 6
  if (bp === 'annual')      return termMonths / 12
  return 1
}

export type BaseTcvItem = {
  product_name: string
  applied_rule?: string | null
  total_amount: number | null
  billing_period: string | null
}

// A single line item per billing_period represents a steady recurring rate —
// multiply by how many such periods fit in the term (legacy convention). But
// buildLineItems generates one row *per contract year* for multi-year deals
// ("Year 1 recurring fee", "Year 2 recurring fee", ...) so escalators land on
// the right year — each of those rows is already a complete, distinct
// occurrence, not a steady rate to repeat. Multiplying it again by
// periodsInTermFor double(-or-more)-counts the whole term. Only apply the
// multiplier when a billing_period has exactly one line item; when several
// share it, sum them as-is.
export function computeBaseTcv(items: BaseTcvItem[], termMonths: number): number {
  const countByPeriod = new Map<string, number>()
  for (const item of items) {
    const key = item.billing_period ?? ''
    countByPeriod.set(key, (countByPeriod.get(key) ?? 0) + 1)
  }
  return items.reduce((s, item) => {
    if (isEscalatorItem(item.product_name, item.applied_rule)) return s
    const sharesPeriodWithOthers = (countByPeriod.get(item.billing_period ?? '') ?? 0) > 1
    const multiplier = sharesPeriodWithOthers ? 1 : periodsInTermFor(item.billing_period, termMonths)
    return s + (item.total_amount ?? 0) * multiplier
  }, 0)
}
