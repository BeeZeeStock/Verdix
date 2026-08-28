// Step 17C.2 — the first stage of the rolling-band-migration execution
// chain (see lib/types.ts's RollingWindowAggregateConfig doc): a
// deterministic mean over N complete billing periods. No LLM at execution
// time, no arbitrary formula language — 'mean' is the only implemented
// operation. Deliberately PURE: takes already-resolved per-period values
// (each one already run through lib/operational-input-binding.ts's
// resolveInputValueAsOf, which already enforces "finalized only" and
// asOf-correct historical replay — this module never queries the database
// or re-implements that resolution) and never decides WHICH periods are
// relevant — that's lib/tariff.ts's getLastNCompletedCadenceWindows, a
// separate, reused concern.
import type { RollingWindowAggregateConfig } from './types'

export interface RollingWindowAggregateTrace {
  input_key: string
  operation: 'mean'
  window_count: number
  windows: Array<{ period_start: string; period_end: string; value: number }>
  value: number
}

export type RollingWindowAggregateResult =
  | { status: 'ready'; value: number; trace: RollingWindowAggregateTrace }
  | { status: 'not_ready'; reason: string }

// One entry per candidate window, in chronological order, oldest first —
// value is null when that period's input isn't yet finalized/available
// (the caller resolves this via resolveInputValueAsOf; a null here always
// means "genuinely not ready," never "treat as zero").
export interface RollingWindowPeriodValue {
  period_start: string
  period_end: string
  value: number | null
}

export function computeRollingWindowAggregate(
  config: RollingWindowAggregateConfig,
  periodValues: RollingWindowPeriodValue[],
): RollingWindowAggregateResult {
  // require_complete_windows: true (the only supported value — see the
  // config's own doc) means: never average in the current, still-open
  // period. The caller is responsible for only ever passing CLOSED
  // periods here (lib/tariff.ts's getLastNCompletedCadenceWindows already
  // filters to closed windows) — this function additionally refuses to
  // proceed at all unless it was handed at least window_count of them,
  // rather than silently averaging over fewer.
  if (periodValues.length < config.window_count) {
    return {
      status: 'not_ready',
      reason: `only ${periodValues.length} of the required ${config.window_count} complete billing periods are available for '${config.input_key}'`,
    }
  }

  // The most recent window_count periods — chronologically last N, never
  // an arbitrary subset. Callers pass periodValues oldest-first (matching
  // getLastNCompletedCadenceWindows' own return order).
  const relevant = periodValues.slice(-config.window_count)
  const missing = relevant.filter(p => p.value == null)
  if (missing.length > 0) {
    const labels = missing.map(p => `${p.period_start}–${p.period_end}`).join(', ')
    return {
      status: 'not_ready',
      reason: `missing finalized '${config.input_key}' for ${missing.length} of ${config.window_count} required period(s): ${labels}`,
    }
  }

  const values = relevant.map(p => p.value as number)
  const sum = values.reduce((a, b) => a + b, 0)
  const mean = sum / values.length

  return {
    status: 'ready',
    value: mean,
    trace: {
      input_key: config.input_key,
      operation: 'mean',
      window_count: config.window_count,
      windows: relevant.map((p, i) => ({ period_start: p.period_start, period_end: p.period_end, value: values[i] })),
      value: mean,
    },
  }
}
