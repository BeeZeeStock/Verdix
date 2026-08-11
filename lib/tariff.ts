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
 * Human-readable breakdown of exactly which tiers a quantity consumed and at
 * what rate — mirrors computeTransactionalOverage's tier-walk so the text
 * shown to a user always matches the amount actually computed. A quantity
 * spanning multiple tiers (the common case) must never be described as a
 * single flat "@ rate/unit", or the total will look wrong even when it's
 * correct.
 */
export function describeTieredUsage(
  meterLabel: string,
  quantity: number,
  tiers: TierLike[],
  includedUnits: number,
  applyMinimumFloor: boolean = true,
): string {
  const billable = Math.max(0, quantity - includedUnits)
  const base = `${meterLabel} — ${quantity.toLocaleString()} total, ${includedUnits.toLocaleString()} included, ${billable.toLocaleString()} billable`

  const sorted = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
  const parts: string[] = []
  let counted = 0
  let tierAmount = 0
  for (const t of sorted) {
    if (counted >= billable) break
    const tierStart = t.from_unit ?? 1
    const tierCap   = t.to_unit != null ? (t.to_unit - tierStart + 1) : billable - counted
    const here      = Math.min(billable - counted, tierCap)
    if (here > 0) { parts.push(`${here.toLocaleString()} @ ${t.rate_per_unit ?? 0}`); tierAmount += here * (t.rate_per_unit ?? 0) }
    counted += here
  }

  // The period minimum only actually binds when it's higher than what the
  // tiers alone would charge — mentioning it whenever one merely exists
  // would be misleading once real usage grows past it.
  const floor = applyMinimumFloor ? tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0) : 0
  const floorNote = floor > tierAmount ? ` (period minimum of ${floor.toLocaleString()} applies)` : ''

  if (billable <= 0 || tiers.length === 0) return base + floorNote
  const tierText = parts.length > 1 ? `${base}: ${parts.join(' + ')}` : `${base} @ ${sorted[0]?.rate_per_unit ?? 0}/unit`
  return tierText + floorNote
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
  // A contract can guarantee a minimum payment per measurement period for a
  // metric regardless of usage (e.g. "minimum SEK 30,000 per half-year for
  // validated invoice lines") — a floor under the tier-computed amount, not
  // an additional charge on top of it. That guarantee is *for the full
  // period* — applying it to a window that hasn't closed yet (a live "so
  // far" preview on day one of a quarter) would show the full quarterly
  // minimum as already owed, which is wrong: the customer hasn't failed to
  // hit the floor, the period just isn't over. Callers previewing an open
  // window must pass false here.
  applyMinimumFloor: boolean = true,
): number {
  const aggType = (tiers[0] as unknown as Record<string, unknown>)?.['aggregation_type'] as string | undefined
  const computed = aggType === 'max_agg'
    ? computeUserOverage(quantity, includedUnits, tiers)
    // Subtract the contract's free allowance; tiers apply only to the excess
    : computeTransactionalOverage(Math.max(0, quantity - includedUnits), tiers)

  if (!applyMinimumFloor) return computed
  const floor = tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0)
  return Math.max(computed, floor)
}

const CADENCE_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, 'semi-annual': 6, annual: 12 }

// Every fully-closed window of the given cadence, anchored to anchorDate,
// whose end falls within [rangeStart, rangeEnd] (inclusive both ends) — the
// window boundaries a metric with its own measurement_period actually
// resets on, independent of the contract's overall billing_frequency. The
// common case (a meter's cadence matches the invoice cadence) yields exactly
// one window equal to the full scan range, so this is a strict superset of
// the old single-period behavior, not a divergent path for it.
export function enumerateCadenceWindows(
  anchorDate: Date,
  cadence: string | null | undefined,
  rangeStart: Date,
  rangeEnd: Date,
): Array<{ start: Date; end: Date }> {
  const months = CADENCE_MONTHS[cadence ?? 'monthly'] ?? 1
  const windows: Array<{ start: Date; end: Date }> = []
  for (let n = 0; n < 1200; n++) {
    const start     = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + n * months, anchorDate.getDate())
    const nextStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + (n + 1) * months, anchorDate.getDate())
    const end       = new Date(nextStart.getTime() - 86_400_000)
    if (start > rangeEnd) break
    if (end >= rangeStart && end <= rangeEnd) windows.push({ start, end })
  }
  return windows
}

// The window (of this cadence, anchored to anchorDate) that contains `date`
// — regardless of whether it's closed yet. enumerateCadenceWindows can only
// ever find *closed* windows (its whole point, for real billing), so a
// meter with a longer cadence than the invoice it's being previewed inside
// (a quarterly metric inside a monthly Consumption-card row) would never
// show anything until the quarter actually closes — correct for what gets
// invoiced, wrong for a live "usage so far this quarter" preview, which
// needs the currently-open window even though it hasn't closed.
export function findCadenceWindowContaining(
  anchorDate: Date,
  cadence: string | null | undefined,
  date: Date,
): { start: Date; end: Date } {
  const months = CADENCE_MONTHS[cadence ?? 'monthly'] ?? 1
  let n = Math.floor(
    ((date.getFullYear() - anchorDate.getFullYear()) * 12 + (date.getMonth() - anchorDate.getMonth())) / months,
  )
  for (let guard = 0; guard < 4; guard++) {
    const start     = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + n * months, anchorDate.getDate())
    const nextStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + (n + 1) * months, anchorDate.getDate())
    if (date < start)      { n--; continue }
    if (date >= nextStart) { n++; continue }
    return { start, end: new Date(nextStart.getTime() - 86_400_000) }
  }
  // Should never hit this given the correction loop above, but keep the
  // function total rather than possibly returning undefined.
  const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + n * months, anchorDate.getDate())
  return { start, end: date }
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
