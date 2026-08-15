import type { MinimumCommitment, OverageTier } from './types'

// Structural minimum accepted by the computation functions —
// compatible with both OverageTier and the local Tier type in RevenueModelTab.
type TierLike = Partial<OverageTier>

// A minimum commitment is stored per-metric (duplicated onto each tier of
// that metric by extraction), not per-tier — take the first one present
// rather than trying to merge conflicting values across tiers.
function resolveMinimumCommitment(tiers: TierLike[]): MinimumCommitment | null {
  for (const t of tiers) {
    if (t.minimum_commitment) return t.minimum_commitment
  }
  return null
}

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
  const mc = resolveMinimumCommitment(tiers)
  const mcActive = !!mc && !mc.requires_confirmation

  // minimum_quantity, once confirmed, is a take-or-pay clause: it raises the
  // billable quantity itself before tier rates apply, unlike the other four
  // modes which act on the resulting currency amount.
  let effectiveQuantity = quantity
  if (mcActive && mc!.mode === 'minimum_quantity' && applyMinimumFloor) {
    const billable = Math.max(0, quantity - includedUnits)
    effectiveQuantity = quantity + Math.max(0, mc!.amount - billable)
  }

  const computed = aggType === 'max_agg'
    ? computeUserOverage(effectiveQuantity, includedUnits, tiers)
    // Subtract the contract's free allowance; tiers apply only to the excess
    : computeTransactionalOverage(Math.max(0, effectiveQuantity - includedUnits), tiers)

  if (!applyMinimumFloor) return computed

  if (mc) {
    // Ambiguous minimum (e.g. unclear interaction with an included
    // allowance) — never silently applied. Usage-based charges still bill;
    // the commitment itself is surfaced for reviewer confirmation
    // separately (getReviewContext/ReviewPanel), not guessed here.
    if (!mcActive) return computed
    switch (mc.mode) {
      case 'floor':
      case 'minimum_spend':
        return Math.max(computed, mc.amount)
      case 'additive':
        return computed + mc.amount
      case 'prepaid_commitment':
        // The commitment amount was already collected up front; only usage
        // beyond that prepaid pool is billed here.
        return Math.max(0, computed - mc.amount)
      case 'minimum_quantity':
        return computed // already folded into effectiveQuantity above
    }
  }

  // No structured commitment on this metric — legacy scalar-floor behavior,
  // preserved for data extracted before the minimum_commitment model existed.
  const floor = tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0)
  return Math.max(computed, floor)
}

const CADENCE_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, 'semi-annual': 6, annual: 12 }

export type CadenceAnchorMode = 'contract_start' | 'calendar'

// 'calendar' mode resets on fixed, universal boundaries — Jan/Apr/Jul/Oct 1
// for quarterly, Jan/Jul 1 for semi-annual, Jan 1 for annual — regardless of
// which day the contract itself started. Only used when the contract text
// explicitly says "calendar quarter"/"calendar year" (OverageTier.reset_anchor);
// 'contract_start' (the historical, still-default behavior) resets on the
// contract's own start-date anniversary instead.
function calendarPeriodStart(date: Date, months: number): Date {
  const periodIndex = Math.floor(date.getMonth() / months)
  return new Date(date.getFullYear(), periodIndex * months, 1)
}

function resolveWindowAnchor(anchorDate: Date, months: number, anchor: CadenceAnchorMode): Date {
  return anchor === 'calendar' ? calendarPeriodStart(anchorDate, months) : anchorDate
}

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
  anchor: CadenceAnchorMode = 'contract_start',
): Array<{ start: Date; end: Date }> {
  const months = CADENCE_MONTHS[cadence ?? 'monthly'] ?? 1
  const base = resolveWindowAnchor(anchorDate, months, anchor)
  const windows: Array<{ start: Date; end: Date }> = []
  for (let n = 0; n < 1200; n++) {
    const start     = new Date(base.getFullYear(), base.getMonth() + n * months, base.getDate())
    const nextStart = new Date(base.getFullYear(), base.getMonth() + (n + 1) * months, base.getDate())
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
  anchor: CadenceAnchorMode = 'contract_start',
): { start: Date; end: Date } {
  const months = CADENCE_MONTHS[cadence ?? 'monthly'] ?? 1
  const base = resolveWindowAnchor(anchorDate, months, anchor)
  let n = Math.floor(
    ((date.getFullYear() - base.getFullYear()) * 12 + (date.getMonth() - base.getMonth())) / months,
  )
  for (let guard = 0; guard < 4; guard++) {
    const start     = new Date(base.getFullYear(), base.getMonth() + n * months, base.getDate())
    const nextStart = new Date(base.getFullYear(), base.getMonth() + (n + 1) * months, base.getDate())
    if (date < start)      { n--; continue }
    if (date >= nextStart) { n++; continue }
    return { start, end: new Date(nextStart.getTime() - 86_400_000) }
  }
  // Should never hit this given the correction loop above, but keep the
  // function total rather than possibly returning undefined.
  const start = new Date(base.getFullYear(), base.getMonth() + n * months, base.getDate())
  return { start, end: date }
}

// True when the contract wasn't actually in effect for this window's full
// span — only possible under 'calendar' anchoring, where window boundaries
// are fixed (Jan/Apr/Jul/Oct 1, etc.) independent of the contract's own
// start/end date, so the first and/or last window a contract touches can be
// shorter than a full cadence cycle. A partial window means a stated
// minimum commitment covering it shouldn't be applied at face value until a
// reviewer confirms how (or whether) it prorates.
export function isPartialWindow(
  window: { start: Date; end: Date },
  contractStartDate: Date | null,
  contractEndDate: Date | null,
): boolean {
  if (contractStartDate && contractStartDate > window.start && contractStartDate <= window.end) return true
  if (contractEndDate && contractEndDate < window.end && contractEndDate >= window.start) return true
  return false
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
