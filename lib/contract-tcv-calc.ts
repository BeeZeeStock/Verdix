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

export type ConfirmedMinimumCommitment = {
  amount: number
  requires_confirmation: boolean
}

// Committed contract value = Fixed fees + every minimum commitment that has
// actually been confirmed. An unconfirmed commitment (ambiguous interaction
// with an included allowance, unclear proration, etc.) is deliberately left
// out of this figure rather than assumed — per spec, a "committed" total
// must never silently include a number nobody has signed off on yet. Once
// confirmed (or rejected/edited down to 0 by a reviewer), it flows in the
// same way any other confirmed minimum does.
export function computeCommittedContractValue(
  items: BaseTcvItem[],
  minimumCommitments: ConfirmedMinimumCommitment[],
): number {
  const fixedFees = computeBaseTcv(items)
  const confirmedMinimums = minimumCommitments.reduce(
    (s, mc) => s + (mc.requires_confirmation ? 0 : mc.amount),
    0,
  )
  return fixedFees + confirmedMinimums
}

export type ContractLifecycleStatus = 'upcoming' | 'active' | 'completed' | 'no_dates'

// Drives the Billed to date / Realised TCV label choice: a contract is
// "completed" only once its own end date has passed — not when it merely
// looks fully billed, since a contract can be fully billed early (all
// invoices sent ahead of schedule) while still contractually active.
export function contractLifecycleStatus(
  startDate: string | Date | null,
  endDate: string | Date | null,
  today: Date = new Date(),
): ContractLifecycleStatus {
  if (!startDate || !endDate) return 'no_dates'
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate
  const end   = typeof endDate   === 'string' ? new Date(endDate)   : endDate
  if (start > today) return 'upcoming'
  if (end < today) return 'completed'
  return 'active'
}
