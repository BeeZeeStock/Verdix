// Step 17C.3 (hardened 17C.3a) — the compiler bridge between what
// extraction (lib/contract-extractor.ts) can state about a commercial
// mechanism and the ALREADY-EXISTING typed, executable 17C.1/17C.2 configs
// (PercentageOfBasisConfig, RollingBandMigrationConfig). Neither execution
// runtime is redesigned here — see lib/percentage-of-basis-fee.ts /
// lib/performance-share-fee.ts (17C.1) and lib/rolling-band-migration-
// pull.ts / lib/rolling-band-transition.ts (17C.2) for the actual
// execution logic, untouched by this file. This module is deliberately
// NOT a Remembill-specific executor — it is a small, generic, closed
// mapping from a handful of EXPLICIT, individually-stated extracted fields
// into the typed shape, the same way lib/rolling-band-migration-pull.ts's
// compileTransitionEffectiveRule/compileVolumeTransitionRule compile a
// reviewer's structured pick into a typed rule — never free-text parsing,
// never inference from prose, and — per 17C.3a's hardening — never
// inference from an ARRAY'S POSITION/ORDER or from a mechanism's `kind`
// label either.
//
// 17C.3a authority rule, stated once here rather than repeated at every
// call site: raw_inputs[]/required_operational_inputs[] are DISPLAY/
// DEPENDENCY-COLLECTION data only (lib/operational-data-inputs.ts). This
// module never reads array position or array length from either as
// execution authority — every operand this module resolves
// (numerator_input_key, denominator_input_key, charge_basis_input_key,
// rolling_input_key) comes from its own EXPLICIT, individually-extracted
// field. A mechanism whose `kind` string looks exactly like
// 'rolling_volume_pricing_transition' but is missing those explicit fields
// compiles to null just like any other incomplete mechanism — this module
// never branches on `kind` at all.
//
// FAIL CLOSED, always: every compile function below returns null the
// moment ANY required piece is missing, malformed, or ambiguous. The
// caller (lib/contract-extractor.ts's applyExtractionSafetyNets) only
// swaps in the compiled config — and flips unresolved_kind/execution_status
// to mark the mechanism executable — when compilation fully succeeds;
// otherwise the mechanism is left exactly as today's Unsupported fallback,
// unchanged, including required_operational_inputs/raw_inputs/
// source_clause (never rewritten by this module — see
// lib/operational-input-canonicalization.ts's own header for why the
// original extracted wording is preserved separately for display/
// provenance). A mechanism is never partially compiled and never rendered
// as a duplicate alongside its own Unsupported card (see the caller in
// contract-extractor.ts, and the UI's own execution_status/unresolved_kind
// filters in app/(dashboard)/configure/[id]/page.tsx).
//
// This never infers effective_rule or volume_transition_rule — those stay
// reviewer/contract-derived only, exactly as lib/types.ts's own doc
// requires; this module simply never touches those two fields at all.

import type {
  AdditionalRecurringFee,
  ContractTerms,
  PercentageOfBasisConfig,
  RateSchedule,
  RateScheduleBand,
  RollingBandMigrationConfig,
  UnsupportedCommercialMechanism,
} from './types'
import { validateRateSchedule } from './rate-schedule'
import { canonicalizeOperationalInputKey, isValidCanonicalKey } from './operational-input-canonicalization'

// The derived metric's own output is always a 0–100% ratio bound
// (numerator contractually a subset of denominator — see lib/types.ts's
// DerivedMetricConfig.min_output_value/max_output_value doc) whenever it
// feeds a percentage-keyed rate schedule; the schedule's own selector
// domain must equal that same output range by construction, which is why
// both are fixed here rather than derived from the extracted table's own
// first/last row (a table missing its 0 floor or 100 ceiling row should
// fail validation below, not silently narrow the configured domain).
const RATIO_PERCENTAGE_MIN = 0
const RATIO_PERCENTAGE_MAX = 100

// A resolved+validated canonical key, or null the moment the raw field is
// missing/blank or fails to produce a well-formed key. Centralizes the
// "explicit field present AND canonicalizes successfully" check (item B/C)
// so every operand resolution below applies it identically.
function resolveExplicitKey(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null
  const canonical = canonicalizeOperationalInputKey(raw)
  return isValidCanonicalKey(canonical) ? canonical : null
}

function compileRateSchedule(scheduleKey: string, bands: RateScheduleBand[] | null | undefined): RateSchedule | null {
  if (!bands || bands.length === 0) return null
  const schedule: RateSchedule = {
    schedule_key: scheduleKey,
    bands: [...bands].sort((a, b) => a.from - b.from),
    min_selector_value: RATIO_PERCENTAGE_MIN,
    max_selector_value: RATIO_PERCENTAGE_MAX,
  }
  // Step 17C.3a, item C — the same structural validation
  // (no gaps/no overlaps/deterministic boundaries) that governs this
  // schedule at BILLING time also gates compilation itself: an invalid
  // extracted table must never clear the Unsupported fallback, even
  // though the raw rows were extracted "successfully" as text.
  return validateRateSchedule(schedule).valid ? schedule : null
}

// Step 17C.3a, item B — compiles a fee's EXPLICIT derived_metric operand
// fields + rate_schedule_bands + EXPLICIT charge_basis_input_key into an
// executable PercentageOfBasisConfig. Only ever attempted for a fee
// extraction itself marked as having no executable mechanism yet
// (unresolved_kind: 'unsupported_semantics') — a fee shaped any other way
// (ordinary fixed/per-unit fee, or one already compiled) has nothing for
// this function to do.
export function compilePercentageOfBasisFee(fee: AdditionalRecurringFee): PercentageOfBasisConfig | null {
  if (fee.unresolved_kind !== 'unsupported_semantics') return null

  const dm = fee.derived_metric
  if (!dm?.metric_name || !dm.formula) return null

  // operation must be EXPLICITLY 'ratio' — never assumed merely because
  // numerator/denominator keys happen to be set.
  if (dm.operation !== 'ratio') return null

  const numeratorKey = resolveExplicitKey(dm.numerator_input_key)
  const denominatorKey = resolveExplicitKey(dm.denominator_input_key)
  if (!numeratorKey || !denominatorKey) return null

  // Both operands must actually be members of the formula's own stated
  // raw_inputs — an explicit numerator/denominator naming something the
  // formula itself doesn't depend on is an inconsistent extraction, not a
  // compilable one.
  const canonicalRawInputs = new Set(dm.raw_inputs.map(canonicalizeOperationalInputKey))
  if (!canonicalRawInputs.has(numeratorKey) || !canonicalRawInputs.has(denominatorKey)) return null

  // The monetary basis must be its OWN explicit field — never inferred
  // from required_operational_inputs having exactly one entry (that
  // array's SHAPE is not execution authority, same principle as
  // raw_inputs' order above).
  const basisKey = resolveExplicitKey(fee.charge_basis_input_key)
  if (!basisKey) return null

  const metricKey = resolveExplicitKey(dm.metric_name)
  if (!metricKey) return null

  const schedule = compileRateSchedule(metricKey + '_schedule', fee.rate_schedule_bands)
  if (!schedule) return null

  return {
    derived_metric: {
      metric_key: metricKey,
      operation: 'ratio',
      numerator_input_key: numeratorKey,
      denominator_input_key: denominatorKey,
      output_unit: 'percentage',
      min_output_value: RATIO_PERCENTAGE_MIN,
      max_output_value: RATIO_PERCENTAGE_MAX,
    },
    rate_schedule: schedule,
    basis_input_key: basisKey,
  }
}

// Step 17C.3a, item D — compiles a mechanism's EXPLICIT rolling_input_key +
// rolling_window_count + notice_required into an executable
// RollingBandMigrationConfig. window_unit/operation/trigger_comparator/
// compared_to are the ONLY implemented members of their respective types
// (see lib/types.ts) — fixed constants here, never read from extraction,
// and never derived merely because `kind` looks like a rolling-average
// mechanism (this function never reads `kind` at all). effective_rule and
// volume_transition_rule are deliberately never set by this function — see
// this file's header.
export function compileRollingBandMigration(mechanism: UnsupportedCommercialMechanism): RollingBandMigrationConfig | null {
  if (mechanism.execution_status === 'executable') return null

  const inputKey = resolveExplicitKey(mechanism.rolling_input_key)
  if (!inputKey) return null

  if (typeof mechanism.rolling_window_count !== 'number' || !Number.isInteger(mechanism.rolling_window_count) || mechanism.rolling_window_count < 1) {
    return null
  }
  if (typeof mechanism.notice_required !== 'boolean') return null

  return {
    aggregate: {
      input_key: inputKey,
      window_count: mechanism.rolling_window_count,
      window_unit: 'billing_period',
      operation: 'mean',
      require_complete_windows: true,
    },
    trigger_comparator: 'greater_than',
    compared_to: 'contracted_volume',
    notice_required: mechanism.notice_required,
  }
}

// Step 17C.3 — the single entry point lib/contract-extractor.ts's
// applyExtractionSafetyNets calls. Maps compilePercentageOfBasisFee /
// compileRollingBandMigration over every fee/mechanism on a freshly
// extracted ContractTerms; a mechanism that fails to compile is returned
// completely unchanged (fail closed, no partial state ever written).
export function compileExecutableCommercialMechanisms(terms: ContractTerms): ContractTerms {
  const additional_recurring_fees = terms.additional_recurring_fees?.map(fee => {
    const compiled = compilePercentageOfBasisFee(fee)
    if (!compiled) return fee
    return { ...fee, percentage_of_basis: compiled, unresolved_kind: null }
  })

  const unsupported_commercial_mechanisms = terms.unsupported_commercial_mechanisms?.map(mechanism => {
    const compiled = compileRollingBandMigration(mechanism)
    if (!compiled) return mechanism
    return { ...mechanism, rolling_band_migration: compiled, execution_status: 'executable' as const }
  })

  return {
    ...terms,
    additional_recurring_fees: additional_recurring_fees ?? terms.additional_recurring_fees,
    unsupported_commercial_mechanisms: unsupported_commercial_mechanisms ?? terms.unsupported_commercial_mechanisms,
  }
}
