// Step 17C.1 — the second stage of the generic execution chain (see
// lib/derived-metric.ts's own header). A RateSchedule stores the
// agreement's EXPLICIT rate table verbatim — never a formula that happens
// to reconstruct it (e.g. "round down to the nearest 5 percentage points"
// would silently misprice every band whose real rate isn't exactly what
// that formula produces; this contract's own table is not uniformly
// stepped — 50–<55% is 2.05%, not the 1.80%+0.20% a naive "+0.20% per
// 5-point step" formula would produce). See lib/types.ts's RateSchedule/
// RateScheduleBand doc for the [from, to) interval convention.
import type { RateSchedule, RateScheduleBand } from './types'

export type RateScheduleValidation =
  | { valid: true }
  | { valid: false; reason: string }

// Structural validation: no gaps, no overlaps, deterministic boundaries.
// Never trusts extraction to have gotten a schedule's arithmetic right —
// this runs before ANY selection, so a malformed schedule fails loudly
// (invalid config) rather than silently mismatching or double-matching a
// selector value.
export function validateRateSchedule(schedule: RateSchedule): RateScheduleValidation {
  if (schedule.bands.length === 0) {
    return { valid: false, reason: 'schedule has no bands' }
  }
  const sorted = [...schedule.bands].sort((a, b) => a.from - b.from)

  if (sorted[0].from !== schedule.min_selector_value) {
    return { valid: false, reason: `first band starts at ${sorted[0].from}, but the schedule's min_selector_value is ${schedule.min_selector_value}` }
  }

  for (let i = 0; i < sorted.length; i++) {
    const band = sorted[i]
    const isLast = i === sorted.length - 1

    if (band.to !== null && band.to <= band.from) {
      return { valid: false, reason: `band starting at ${band.from} has an empty or inverted range (to: ${band.to})` }
    }
    if (!isLast && band.to === null) {
      return { valid: false, reason: `band starting at ${band.from} has no upper bound (to: null) but is not the last band — gaps/overlaps against the next band cannot be determined` }
    }

    if (!isLast) {
      const next = sorted[i + 1]
      if (band.to !== next.from) {
        return {
          valid: false,
          reason: (band.to as number) < next.from
            ? `gap between ${band.to} and ${next.from}`
            : `overlap: band ending at ${band.to} extends past the next band starting at ${next.from}`,
        }
      }
    } else if (schedule.max_selector_value != null && band.to != null && band.to < schedule.max_selector_value) {
      return { valid: false, reason: `last band ends at ${band.to}, below the schedule's max_selector_value (${schedule.max_selector_value}) — gap at the top of the schedule` }
    }
  }

  return { valid: true }
}

export type RateScheduleSelection =
  | { status: 'resolved'; band: RateScheduleBand; rate_pct: number }
  // The selector value itself is outside the schedule's configured domain
  // (below min_selector_value, above max_selector_value, or — defensively
  // — matches no band despite passing both bounds checks, which validation
  // above should already have made structurally impossible).
  | { status: 'out_of_bounds'; reason: string }
  | { status: 'invalid_schedule'; reason: string }

export function selectRate(schedule: RateSchedule, selectorValue: number): RateScheduleSelection {
  const validation = validateRateSchedule(schedule)
  if (!validation.valid) {
    return { status: 'invalid_schedule', reason: validation.reason }
  }
  if (selectorValue < schedule.min_selector_value) {
    return { status: 'out_of_bounds', reason: `${selectorValue} is below the schedule's minimum (${schedule.min_selector_value})` }
  }
  // Values above 100% (or whatever this schedule's own configured maximum
  // is) fail here — never matched against an open-ended last band as if it
  // meant "and above". A schedule that genuinely has no cap sets
  // max_selector_value: null explicitly (see lib/types.ts's own doc).
  if (schedule.max_selector_value != null && selectorValue > schedule.max_selector_value) {
    return { status: 'out_of_bounds', reason: `${selectorValue} exceeds the schedule's configured maximum (${schedule.max_selector_value})` }
  }

  const sorted = [...schedule.bands].sort((a, b) => a.from - b.from)
  // [from, to) — half-open: selectorValue === band.to belongs to the NEXT
  // band, never this one (this is what makes 5.0 select "5–<10%" rather
  // than "<5%", and 100.0 select the {from:100,to:null} top band rather
  // than falling through the 95–<100% band).
  const band = sorted.find(b => selectorValue >= b.from && (b.to === null || selectorValue < b.to))
  if (!band) {
    return { status: 'out_of_bounds', reason: `${selectorValue} does not fall into any configured band` }
  }
  return { status: 'resolved', band, rate_pct: band.rate_pct }
}
