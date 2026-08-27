// Step 17C.1 (hardened in 17C.1a) — pilot/waiver interaction for the
// performance-share fee. Mirrors lib/committed-fixed-fee-resolver.ts's
// classifyFixedFeeMateriality/discountMateriallyAffectsFixedFee tri-state
// pattern (same fail-closed-on-unknown discipline) — deliberately a
// parallel implementation, not a reuse-by-import, because the two check
// different component keys against the SAME generic typed shape
// (Discount.affected_components/possibly_affected_components); the
// existing function is hardcoded to BASE_RECURRING_FEE_COMPONENT and has
// no parameter to swap that key. Reads ONLY the typed
// affected_components/possibly_affected_components fields — never
// applies_to/description free text.
import { isDiscountUnresolved } from './commercial-rule-status'

// Matches the component key already used throughout this codebase for this
// exact component (lib/remembill-fixture.ts's discount, lib/rule-
// interpretation.ts's COMPONENT_KEY_LABELS/SCOPE_SUMMARY_LABELS,
// lib/commercial-component-scope.ts's CommercialComponentClass) — not a
// new, independently-invented key.
export const PERFORMANCE_SHARE_FEE_COMPONENT = 'performance_fee'

export interface PerformanceShareDiscountLike {
  interpretation?: { requires_confirmation: boolean } | null
  description?: string | null
  discount_pct?: number | null
  discount_amount?: number | null
  start_date?: string | null
  end_date?: string | null
  duration_days?: number | null
  affected_components?: string[] | null
  possibly_affected_components?: string[] | null
}

export type PerformanceShareMaterialityClassification = 'definitely_affects' | 'definitely_does_not_affect' | 'unknown'

export function classifyPerformanceShareMateriality(discount: PerformanceShareDiscountLike): PerformanceShareMaterialityClassification {
  if (discount.affected_components?.includes(PERFORMANCE_SHARE_FEE_COMPONENT)) return 'definitely_affects'
  if (discount.possibly_affected_components?.includes(PERFORMANCE_SHARE_FEE_COMPONENT)) return 'unknown'
  const typedTargetingPresent = discount.affected_components != null || discount.possibly_affected_components != null
  return typedTargetingPresent ? 'definitely_does_not_affect' : 'unknown'
}

export function discountMateriallyAffectsPerformanceShare(discount: PerformanceShareDiscountLike): boolean {
  const classification = classifyPerformanceShareMateriality(discount)
  if (classification === 'definitely_does_not_affect') return false
  if (classification === 'unknown') return true // fail closed
  const rateIsConcrete = discount.discount_pct != null || discount.discount_amount != null
  return !rateIsConcrete
}

// The discount's own dated window (start_date + either end_date or
// duration_days) — extracted so both performanceShareRequiresConfirmation
// (below) and performanceShareDiscountMultiplierForPeriod (below) resolve
// it identically. Same date-window logic as lib/billing-writer.ts's
// computeDiscountMultiplier — deliberately duplicated, not imported, since
// that function applies the FIRST matching discount in terms.discounts
// unconditionally (correct for the base fee, which every discount there
// is assumed to target); reusing it here would let a discount that does
// NOT materially affect performance_fee still reduce it. Returns null
// when the discount has no resolvable dated window at all (no start_date,
// or no way to derive an end) — callers treat that conservatively.
// A real, confirmed bug caught by this module's own boundary test (Sweden's
// October DST changeover falls squarely inside this exact 90-day-from-
// October-1st pilot window): computing `end` via
// `new Date(ds.getTime() + N * 86_400_000)` — plain local-timezone
// millisecond arithmetic — silently lands a DAY EARLY once the addition
// crosses a fall-back DST transition (the extra hour gained shifts the
// wall-clock date back). Same bug class already found and fixed in
// lib/contract-extractor.ts's flagAmbiguousWaiverExpiryProration (see its
// own comment) — fixed here the identical way: do the DAY arithmetic in
// UTC (which has no DST), then rebuild the result as local midnight of
// whichever calendar date that UTC arithmetic landed on, so it stays
// directly comparable (via plain <, <=, >=, >) against every other
// local-midnight Date this module constructs (periodStart/periodEnd, ds
// itself) without reintroducing a local-timezone dependency into the
// arithmetic step.
function addCalendarDaysDstSafe(base: Date, days: number): Date {
  const utcMs = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate()) + days * 86_400_000
  const utcResult = new Date(utcMs)
  return new Date(utcResult.getUTCFullYear(), utcResult.getUTCMonth(), utcResult.getUTCDate())
}

function discountDatedWindow(discount: PerformanceShareDiscountLike): { start: Date; end: Date } | null {
  const ds = discount.start_date ? new Date(discount.start_date + 'T00:00:00') : null
  if (!ds) return null
  const de = discount.end_date
    ? new Date(discount.end_date + 'T00:00:00')
    : (discount.duration_days ? addCalendarDaysDstSafe(ds, discount.duration_days - 1) : null)
  if (!de) return null
  return { start: ds, end: de }
}

export type PilotPeriodOverlap = 'none' | 'full' | 'straddle'

// Step 17C.1a, item 2 — classifies how a calculated BILLING period
// [periodStart, periodEnd] relates to a discount's own dated pilot/waiver
// window [pilotStart, pilotEnd]:
//   'none'     — the period is entirely before or entirely after the
//                pilot window; the pilot is simply not material to it.
//   'full'     — the period falls entirely within the pilot window; the
//                pilot's own confirmed/unconfirmed status governs the
//                whole period.
//   'straddle' — the period only partially overlaps the pilot window
//                (the pilot starts or ends partway through it) — there is
//                no stated treatment for splitting a monthly monetary
//                basis across that boundary.
export function classifyPilotPeriodOverlap(
  pilotStart: Date, pilotEnd: Date, periodStart: Date, periodEnd: Date,
): PilotPeriodOverlap {
  if (periodEnd < pilotStart || periodStart > pilotEnd) return 'none'
  if (periodStart >= pilotStart && periodEnd <= pilotEnd) return 'full'
  return 'straddle'
}

// Item 8/2 — readiness gate, now PERIOD-AWARE: an unresolved discount/
// waiver that materially affects the performance-share component only
// blocks readiness for a calculated period whose own dated window
// actually OVERLAPS the discount's own dated window (lib/committed-fixed-
// fee-resolver.ts's own gate has no period concept at all — the base fee
// it resolves is a single point-in-time figure, not calculated per
// billing period the way this fee is). A period fully outside the pilot's
// dated window is never blocked by the pilot's own unresolved scope
// question, however unresolved that question remains historically. A
// CONFIRMED waiver whose dated window only partially overlaps the period
// (the pilot expires partway through a monthly period) also blocks —
// there is no confirmed treatment for splitting the monetary basis across
// that boundary, and guessing (waiving or charging the whole month) would
// silently invent one.
export function performanceShareRequiresConfirmation(
  discounts: PerformanceShareDiscountLike[] | null | undefined,
  periodStart: Date,
  periodEnd: Date,
): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = []
  for (const d of discounts ?? []) {
    const classification = classifyPerformanceShareMateriality(d)
    if (classification === 'definitely_does_not_affect') continue

    const window = discountDatedWindow(d)
    // No resolvable dated window at all — cannot determine period
    // overlap, so this conservatively behaves as if it always overlaps
    // (the pre-17C.1a, period-unaware behavior) rather than silently
    // assuming it's irrelevant.
    const overlap = window ? classifyPilotPeriodOverlap(window.start, window.end, periodStart, periodEnd) : 'full'
    if (overlap === 'none') continue

    if (isDiscountUnresolved(d)) {
      reasons.push(`"${d.description ?? 'a discount/waiver'}" is Decision Required — materially affects the performance-share fee for this period`)
      continue
    }

    // Confirmed. A genuine, concrete waiver (classification
    // 'definitely_affects') whose dated window only partially covers this
    // period cannot be mechanically applied — waiving or charging the
    // full period would silently invent a split treatment the contract
    // never states.
    if (classification === 'definitely_affects' && overlap === 'straddle') {
      reasons.push(`"${d.description ?? 'a discount/waiver'}" expires partway through this period — no confirmed treatment for splitting the monthly performance-share basis across the boundary`)
    }
  }
  return { blocked: reasons.length > 0, reasons }
}

// Item 8 — once resolved (confirmed, and per the gate above, either fully
// inside or fully outside the discount's own dated window — never
// straddling), the CONFIRMED discount's own rate is what determines
// whether/how much the performance-share fee is reduced for the given
// period. periodDate should be a point unambiguously WITHIN the period
// being calculated (its own periodStart is sufficient — the readiness
// gate above already guarantees no straddle reaches this function).
export function performanceShareDiscountMultiplierForPeriod(
  discounts: PerformanceShareDiscountLike[] | null | undefined,
  periodDate: Date,
): number {
  for (const disc of discounts ?? []) {
    if (isDiscountUnresolved(disc)) continue
    if (classifyPerformanceShareMateriality(disc) !== 'definitely_affects') continue
    const window = discountDatedWindow(disc)
    if (window && periodDate >= window.start && periodDate <= window.end && disc.discount_pct != null) {
      return 1 - disc.discount_pct / 100
    }
  }
  return 1
}
