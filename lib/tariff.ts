import type { OverageTier } from './types'

// Structural minimum accepted by the computation functions —
// compatible with both OverageTier and the local Tier type in RevenueModelTab.
type TierLike = Partial<OverageTier>

/**
 * Converts a human-readable unit_type string into a stable Lago metric code.
 * e.g. "API call" → "api_call", "User seat" → "user_seat"
 */
export function slugifyMetricCode(unitType: string): string {
  return unitType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Computes the overage charge for seat/user-based metrics.
 * Applies graduated tiers only to units above the included allowance.
 */
export function computeUserOverage(
  totalUsers: number,
  included: number,
  tiers: TierLike[],
): number {
  const extra = Math.max(0, totalUsers - included)
  if (extra <= 0 || tiers.length === 0) return 0
  const sorted = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
  let total = 0, counted = 0
  for (const t of sorted) {
    if (counted >= extra) break
    const cap  = t.to_unit != null ? (t.to_unit - (t.from_unit ?? 1) + 1) : extra - counted
    const here = Math.min(extra - counted, cap)
    total  += here * (t.rate_per_unit ?? 0)
    counted += here
  }
  return total
}

/**
 * Computes the overage charge for transactional metrics (API calls, tokens, etc.).
 * Applies graduated tiers across the full usage quantity.
 */
export function computeTransactionalOverage(
  quantity: number,
  tiers: TierLike[],
): number {
  if (quantity <= 0 || tiers.length === 0) return 0
  const sorted = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
  let total = 0, counted = 0
  for (const t of sorted) {
    if (counted >= quantity) break
    const tierStart = t.from_unit ?? 1
    const tierCap   = t.to_unit != null ? (t.to_unit - tierStart + 1) : quantity - counted
    const here      = Math.min(quantity - counted, tierCap)
    total  += here * (t.rate_per_unit ?? 0)
    counted += here
  }
  return total
}

/**
 * Resolves the correct overage computation based on aggregation_type.
 * max_agg metrics (e.g. active user seats) use seat-style logic;
 * everything else uses transactional graduated tiers.
 */
export function computeMetricOverage(
  quantity: number,
  tiers: OverageTier[],
  includedUnits: number,
): number {
  const aggType = (tiers[0] as unknown as Record<string, unknown>)?.['aggregation_type'] as string | undefined
  if (aggType === 'max_agg') {
    return computeUserOverage(quantity, includedUnits, tiers)
  }
  // Subtract the contract's free allowance; tiers apply only to the excess
  const billable = Math.max(0, quantity - includedUnits)
  return computeTransactionalOverage(billable, tiers)
}

/**
 * Groups a flat overage_tiers array by metric_code (derived from unit_type).
 * Returns a map of metric_code → tiers[], ready for per-metric computation.
 */
export function groupTiersByMetric(
  tiers: OverageTier[],
): Map<string, OverageTier[]> {
  const map = new Map<string, OverageTier[]>()
  for (const t of tiers) {
    const code = slugifyMetricCode(t.unit_type)
    const existing = map.get(code) ?? []
    existing.push(t)
    map.set(code, existing)
  }
  return map
}
