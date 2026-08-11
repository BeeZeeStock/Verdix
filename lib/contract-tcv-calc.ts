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

export type BaseTcvItem = {
  product_name: string
  applied_rule?: string | null
  total_amount: number | null
  billing_period: string | null
}

// buildLineItems (app/api/jobs/[id]/execute/route.ts) always emits
// total_amount as the item's *already fully-resolved* contribution to the
// term — quantity × unit_price, pre-multiplied by however many cycles that
// row spans (one row per distinct rate block, so an escalator or ramp
// contract naturally produces several rows, each already complete). TCV is
// therefore just the sum of every non-escalator row's total_amount — no
// further multiplication, and no need to infer a per-item cycle count from
// how many other rows happen to share its billing_period (that heuristic
// broke as soon as two unrelated fields — e.g. the base fee and an overage
// tier — could legitimately share the same cadence).
export function computeBaseTcv(items: BaseTcvItem[]): number {
  return items.reduce((s, item) => {
    if (isEscalatorItem(item.product_name, item.applied_rule)) return s
    return s + (item.total_amount ?? 0)
  }, 0)
}
