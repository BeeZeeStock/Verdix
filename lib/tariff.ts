import type { MinimumCommitment, OverageTier, TierCalculationMethod } from './types'

// Structural minimum accepted by the computation functions —
// compatible with both OverageTier and the local Tier type in RevenueModelTab.
type TierLike = Partial<OverageTier>

export type TierMethod = TierCalculationMethod['method']

// A minimum commitment is stored per-metric (duplicated onto each tier of
// that metric by extraction), not per-tier — take the first one present
// rather than trying to merge conflicting values across tiers.
export function resolveMinimumCommitment(tiers: TierLike[]): MinimumCommitment | null {
  for (const t of tiers) {
    if (t.minimum_commitment) return t.minimum_commitment
  }
  return null
}

// Same per-metric storage convention as minimum_commitment — duplicated
// across a metric's tier rows, take the first present rather than merge.
// Null means this data predates tier_calculation entirely (see
// OverageTier.tier_calculation) and the caller falls back to 'graduated'.
export function resolveTierCalculationMethod(tiers: TierLike[]): TierCalculationMethod | null {
  for (const t of tiers) {
    if (t.tier_calculation) return t.tier_calculation
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

// Graduated/staircase: each band's rate applies only to the units that fall
// within it — the original (and, until now, only) calculation this engine
// supported.
function graduatedAmount(total: number, tiers: TierLike[]): number {
  if (total <= 0 || tiers.length === 0) return 0
  const sorted = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
  let amount = 0, counted = 0
  for (const t of sorted) {
    if (counted >= total) break
    const tierStart = t.from_unit ?? 1
    const tierCap   = t.to_unit != null ? (t.to_unit - tierStart + 1) : total - counted
    const here      = Math.min(total - counted, tierCap)
    amount  += here * (t.rate_per_unit ?? 0)
    counted += here
  }
  return amount
}

// Volume/all-units: the single band containing the full total sets the rate
// for every qualifying unit. Crossing a threshold re-rates everything, not
// just the units past it — the same rate table as graduated can produce a
// materially different total (1-100@10 + 101-200@8, 150 units: graduated
// = 1,400, volume = 150 * 8 = 1,200).
function volumeAmount(total: number, tiers: TierLike[]): number {
  if (total <= 0 || tiers.length === 0) return 0
  const sorted = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
  let applicable = sorted[0]
  for (const t of sorted) {
    if (total >= (t.from_unit ?? 1)) applicable = t
    else break
  }
  return total * (applicable?.rate_per_unit ?? 0)
}

// Block: reaching a band charges a flat fee for that band, not a per-unit
// rate — every band whose start has been reached contributes its
// rate_per_unit once, in full, regardless of how far into the band usage
// actually reached.
function blockAmount(total: number, tiers: TierLike[]): number {
  if (total <= 0 || tiers.length === 0) return 0
  const sorted = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))
  let amount = 0
  for (const t of sorted) {
    if (total >= (t.from_unit ?? 1)) amount += (t.rate_per_unit ?? 0)
    else break
  }
  return amount
}

// 'custom' has no safe generic calculation by definition — it's previewed
// using graduated math (never fabricated as something else) while
// requiresConfirmation (surfaced separately by computeMetricOverage) keeps
// real invoicing from relying on that preview.
function amountForMethod(total: number, tiers: TierLike[], method: TierMethod): number {
  switch (method) {
    case 'volume': return volumeAmount(total, tiers)
    case 'block':  return blockAmount(total, tiers)
    default:       return graduatedAmount(total, tiers)
  }
}

/**
 * Computes the overage charge for seat/user-based metrics.
 * Applies tiers only to units above the included allowance, using the given
 * calculation method (defaults to graduated for backward compatibility).
 */
export function computeUserOverage(
  totalUsers: number,
  included: number,
  tiers: TierLike[],
  method: TierMethod = 'graduated',
): number {
  const extra = Math.max(0, totalUsers - included)
  return amountForMethod(extra, tiers, method)
}

/**
 * Computes the overage charge for transactional metrics (API calls, tokens, etc.)
 * across the full billable quantity, using the given calculation method
 * (defaults to graduated for backward compatibility).
 */
export function computeTransactionalOverage(
  quantity: number,
  tiers: TierLike[],
  method: TierMethod = 'graduated',
): number {
  return amountForMethod(quantity, tiers, method)
}

/**
 * Human-readable breakdown of exactly which tiers a quantity consumed and at
 * what rate — mirrors the calculation functions' tier-walk for the given
 * method so the text shown to a user always matches the amount actually
 * computed. A quantity spanning multiple graduated tiers must never be
 * described as a single flat "@ rate/unit", or the total will look wrong
 * even when it's correct.
 */
export function describeTieredUsage(
  meterLabel: string,
  quantity: number,
  tiers: TierLike[],
  includedUnits: number,
  applyMinimumFloor: boolean = true,
  method: TierMethod = 'graduated',
): string {
  const billable = Math.max(0, quantity - includedUnits)
  const base = `${meterLabel} — ${quantity.toLocaleString()} total, ${includedUnits.toLocaleString()} included, ${billable.toLocaleString()} billable`
  const sorted = [...tiers].sort((a, b) => (a.from_unit ?? 0) - (b.from_unit ?? 0))

  let tierText = base
  let tierAmount = 0

  if (billable > 0 && tiers.length > 0) {
    if (method === 'volume') {
      let applicable = sorted[0]
      for (const t of sorted) {
        if (billable >= (t.from_unit ?? 1)) applicable = t
        else break
      }
      tierAmount = billable * (applicable?.rate_per_unit ?? 0)
      tierText = `${base}: ${billable.toLocaleString()} @ ${applicable?.rate_per_unit ?? 0}/unit (volume — tier "${applicable?.tier_label ?? ''}" applies to all billable units)`
    } else if (method === 'block') {
      const parts: string[] = []
      for (const t of sorted) {
        if (billable < (t.from_unit ?? 1)) break
        parts.push(`${t.tier_label ?? t.from_unit} @ ${t.rate_per_unit ?? 0} flat`)
        tierAmount += (t.rate_per_unit ?? 0)
      }
      tierText = parts.length > 0 ? `${base}: ${parts.join(' + ')} (block pricing)` : base
    } else {
      // graduated, and 'custom' previewed as graduated
      const parts: string[] = []
      let counted = 0
      for (const t of sorted) {
        if (counted >= billable) break
        const tierStart = t.from_unit ?? 1
        const tierCap   = t.to_unit != null ? (t.to_unit - tierStart + 1) : billable - counted
        const here      = Math.min(billable - counted, tierCap)
        if (here > 0) { parts.push(`${here.toLocaleString()} @ ${t.rate_per_unit ?? 0}`); tierAmount += here * (t.rate_per_unit ?? 0) }
        counted += here
      }
      tierText = parts.length > 1 ? `${base}: ${parts.join(' + ')}` : `${base} @ ${sorted[0]?.rate_per_unit ?? 0}/unit`
    }
  }

  // The period minimum only actually binds when it's higher than what the
  // tiers alone would charge — mentioning it whenever one merely exists
  // would be misleading once real usage grows past it.
  const floor = applyMinimumFloor ? tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0) : 0
  const floorNote = floor > tierAmount ? ` (period minimum of ${floor.toLocaleString()} applies)` : ''
  return tierText + floorNote
}

export interface MetricOverageResult {
  amount: number
  /** The tier-calculation method actually used for `amount`. When
   *  requiresConfirmation is true, this is 'graduated' used only as a
   *  provisional preview — not a confirmed reading of the contract. */
  method: TierMethod
  /** True when the metric's tier_calculation is missing/ambiguous and a
   *  reviewer hasn't confirmed a method yet. Real invoicing must not bill
   *  off `amount` while this is true (see lib/usage-pull.ts) — the same
   *  never-silently-bill rule already applied to minimum commitments. */
  requiresConfirmation: boolean
  /** The pure usage-tier charge, before any minimum-commitment adjustment —
   *  lets a caller decompose `amount` into "usage" vs. "minimum commitment"
   *  components (e.g. distinguishing a deterministic additive fee from the
   *  usage sitting on top of it, or showing how far usage exceeded a floor)
   *  without re-deriving the tier calculation itself. */
  usageAmount: number
  /** True when a confirmed minimum commitment actually changed `amount`
   *  from what pure usage tiers alone would have produced this period. */
  minimumApplied: boolean
}

/**
 * Resolves the correct overage computation based on aggregation_type and the
 * metric's confirmed (or defaulted) tier-calculation method.
 * max_agg metrics (e.g. active user seats) use seat-style logic;
 * everything else uses transactional tiers.
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
): MetricOverageResult {
  const aggType = (tiers[0] as unknown as Record<string, unknown>)?.['aggregation_type'] as string | undefined
  const mc = resolveMinimumCommitment(tiers)
  const mcActive = !!mc && !mc.requires_confirmation

  const tierCalc = resolveTierCalculationMethod(tiers)
  const method: TierMethod = tierCalc?.method ?? 'graduated'
  const requiresConfirmation = !!tierCalc?.requires_confirmation
  let usageAmountForFinalize = 0
  const finalize = (amount: number): MetricOverageResult => ({
    amount, method, requiresConfirmation,
    usageAmount: usageAmountForFinalize,
    minimumApplied: amount !== usageAmountForFinalize,
  })

  // minimum_quantity, once confirmed, is a take-or-pay clause: it raises the
  // billable quantity itself before tier rates apply, unlike the other four
  // modes which act on the resulting currency amount.
  let effectiveQuantity = quantity
  if (mcActive && mc!.mode === 'minimum_quantity' && applyMinimumFloor) {
    const billable = Math.max(0, quantity - includedUnits)
    effectiveQuantity = quantity + Math.max(0, mc!.amount - billable)
  }

  const computed = aggType === 'max_agg'
    ? computeUserOverage(effectiveQuantity, includedUnits, tiers, method)
    // Subtract the contract's free allowance; tiers apply only to the excess
    : computeTransactionalOverage(Math.max(0, effectiveQuantity - includedUnits), tiers, method)
  usageAmountForFinalize = computed

  if (!applyMinimumFloor) return finalize(computed)

  if (mc) {
    // Ambiguous minimum (e.g. unclear interaction with an included
    // allowance) — never silently applied. Usage-based charges still bill;
    // the commitment itself is surfaced for reviewer confirmation
    // separately (getReviewContext/ReviewPanel), not guessed here.
    if (!mcActive) return finalize(computed)
    switch (mc.mode) {
      case 'floor':
      case 'minimum_spend':
        return finalize(Math.max(computed, mc.amount))
      case 'additive':
        return finalize(computed + mc.amount)
      case 'prepaid_commitment':
        // The commitment amount was already collected up front; only usage
        // beyond that prepaid pool is billed here.
        return finalize(Math.max(0, computed - mc.amount))
      case 'minimum_quantity':
        return finalize(computed) // already folded into effectiveQuantity above
    }
  }

  // No structured commitment on this metric — legacy scalar-floor behavior,
  // preserved for data extracted before the minimum_commitment model existed.
  const floor = tiers.reduce((max, t) => Math.max(max, t.minimum_period_amount ?? 0), 0)
  return finalize(Math.max(computed, floor))
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

export interface MinimumCommitmentSchedule {
  /** Total minimum-commitment value across the full contract term, given
   *  the confirmed partial-period proration treatment. Null whenever any
   *  touched partial window's treatment is still 'unclear' — never
   *  silently averaged or guessed; the caller must surface a review item
   *  rather than display a number. */
  total: number | null
  requiresConfirmation: boolean
  windowCount: number
  fullWindowCount: number
  partialWindowCount: number
}

// Every cadence window the contract touches — shared enumeration between
// computeMinimumCommitmentSchedule (term total) and any caller needing the
// individual windows themselves (e.g. one billing-timeline event per
// window, each showing that window's own applicable minimum). Padding the
// scan range by one extra cadence period matters here: enumerateCadenceWindows
// filters by each window's END falling within the range — correct for its
// real-billing callers (usage-pull.ts: "only fully-closed windows within
// this scan"), but the contract's own FINAL touched window's calendar end
// almost always extends past the contract's actual end date (that's
// precisely what makes it partial), so passing contractEndDate as rangeEnd
// directly would silently drop it. Filtering by each window's START falling
// on/before the contract's end date is what correctly determines which
// windows the contract actually touches.
export function enumerateContractWindows(
  contractStartDate: Date,
  contractEndDate: Date,
  cadence: string | null | undefined,
  anchor: CadenceAnchorMode,
): Array<{ start: Date; end: Date }> {
  const months    = CADENCE_MONTHS[cadence ?? 'monthly'] ?? 1
  const paddedEnd = new Date(contractEndDate.getFullYear(), contractEndDate.getMonth() + months, contractEndDate.getDate())
  return enumerateCadenceWindows(contractStartDate, cadence, contractStartDate, paddedEnd, anchor)
    .filter(w => w.start <= contractEndDate)
}

export interface WindowMinimum {
  /** The applicable minimum for this one window — prorated when the window
   *  is partial and the confirmed treatment prorates by days, the full
   *  amount when the window is partial but still bills in full, or null
   *  when the treatment is still unconfirmed for a partial window (never
   *  guessed — see requiresConfirmation). */
  amount: number | null
  isPartial: boolean
  requiresConfirmation: boolean
}

// The applicable minimum for ONE cadence window — shared by
// computeMinimumCommitmentSchedule (term total, sums every window) and any
// caller needing a single window's figure (a billing-timeline event for
// that specific quarter), so the two can never disagree about the same window.
export function resolveWindowMinimum(
  window: { start: Date; end: Date },
  contractStartDate: Date,
  contractEndDate: Date,
  anchor: CadenceAnchorMode,
  mc: Pick<MinimumCommitment, 'amount' | 'prorate_partial_periods'>,
): WindowMinimum {
  const partial = anchor === 'calendar' && isPartialWindow(window, contractStartDate, contractEndDate)
  if (!partial) return { amount: mc.amount, isPartial: false, requiresConfirmation: false }
  if (mc.prorate_partial_periods === true) {
    // Prorate by the number of days the contract actually overlaps this window.
    const overlapStart = window.start < contractStartDate ? contractStartDate : window.start
    const overlapEnd   = window.end   > contractEndDate   ? contractEndDate   : window.end
    const overlapDays  = Math.max(0, Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 86_400_000) + 1)
    const windowDays   = Math.max(1, Math.round((window.end.getTime() - window.start.getTime()) / 86_400_000) + 1)
    return { amount: Math.round(mc.amount * (overlapDays / windowDays) * 100) / 100, isPartial: true, requiresConfirmation: false }
  }
  if (mc.prorate_partial_periods === false) return { amount: mc.amount, isPartial: true, requiresConfirmation: false }
  return { amount: null, isPartial: true, requiresConfirmation: true }
}

// Sums a confirmed minimum commitment's amount across every cadence window
// the contract touches, respecting the confirmed partial-period proration
// treatment — reuses the same window engine real billing uses
// (enumerateCadenceWindows/isPartialWindow) rather than a parallel date
// calculation. A quarterly SEK 5,000 commitment on a contract that starts
// mid-quarter is NOT simply (quarters touched) × amount — the two edge
// quarters are only partially covered, and whether that partial coverage
// still bills the full amount, a prorated share, or is genuinely
// undetermined is exactly what prorate_partial_periods records.
export function computeMinimumCommitmentSchedule(
  contractStartDate: Date,
  contractEndDate: Date,
  cadence: string | null | undefined,
  anchor: CadenceAnchorMode,
  mc: Pick<MinimumCommitment, 'amount' | 'prorate_partial_periods'>,
): MinimumCommitmentSchedule {
  const windows = enumerateContractWindows(contractStartDate, contractEndDate, cadence, anchor)
  let total = 0
  let fullCount = 0, partialCount = 0
  let requiresConfirmation = false

  for (const w of windows) {
    const wm = resolveWindowMinimum(w, contractStartDate, contractEndDate, anchor, mc)
    if (wm.isPartial) partialCount++; else fullCount++
    if (wm.requiresConfirmation) { requiresConfirmation = true; continue }
    total += wm.amount ?? 0
  }

  return {
    total: requiresConfirmation ? null : Math.round(total * 100) / 100,
    requiresConfirmation,
    windowCount: windows.length,
    fullWindowCount: fullCount,
    partialWindowCount: partialCount,
  }
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
