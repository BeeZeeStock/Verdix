// Step 17C.2 (revised 17C.2a) — the DB-querying wiring layer for the
// rolling-band-migration execution chain, mirroring lib/performance-share-
// pull.ts's own shape (same params style, same "skip and log, never throw
// over one held/invalid mechanism" discipline) rather than inventing a new
// pattern.
//
// Responsibilities, deliberately kept apart:
//   1. evaluateRollingBandMigrations — pure-ish (one DB read) evaluation:
//      resolve the last N completed billing periods, pull each period's
//      finalized operational-input value, call evaluateRollingBandTransition.
//      Never writes anything.
//   2. persistTriggeredRollingBandMigrations — takes evaluation results and
//      persists them: 'transition_triggered' via detect_rolling_band_pricing_transition,
//      'transition_triggered_not_executable' via detect_rolling_band_pricing_required_event
//      (item 7 — a durable, never-activating pricing_required record; the
//      earlier 17C.2 design never persisted this case at all — item 7
//      reverses that).
//   3. compileTransitionEffectiveRule / resolveEffectiveDateFromRule — item
//      1's typed effective-timing authority: a reviewer's structured pick
//      (or a contract-derived rule, once extraction ever populates one)
//      compiles into a TransitionEffectiveRule and resolves to a real date
//      through the SAME cadence/renewal-window machinery every other date
//      in this chain uses — never guessed from "the word monthly".
//   4. resolveEffectiveCommercialState(ForPeriod) — Step 17C.2a item 3 /
//      17C.2b item A's shared resolver: original contracted band/volume +
//      whichever transition is ACTIVE as of a given asOf -> effective
//      band/contracted-volume/fee/transition_id/provenance. Consumed by
//      both the fixed-fee reconciler and lib/usage-pull.ts's overage calc.
//   5. reconcileActiveRollingBandTransitions — item 4/5's future-only
//      schedule reconciliation entry point (delegates the actual
//      planned_invoices work to lib/rolling-band-schedule-reconciliation.ts),
//      widened in 17C.2b item B to also recover previously-held rows once
//      a transition's effective timing is (re-)resolved.
import { supabaseServer } from '@/lib/supabase'
import { getLastNCompletedCadenceWindows } from '@/lib/tariff'
import { resolveInputValueAsOf, type OperationalInputPeriodValueRow } from '@/lib/operational-input-binding'
import { resolveFixedFeeBand } from '@/lib/fixed-fee-band'
import { evaluateRollingBandTransition, resolveTransitionLifecycleStatus, type RollingBandTransitionEvaluation } from '@/lib/rolling-band-transition'
import { reconcileFutureScheduleForTransition, type ScheduleReconciliationResult } from '@/lib/rolling-band-schedule-reconciliation'
import type { RollingWindowPeriodValue } from '@/lib/rolling-window-aggregate'
import type { ContractTerms, FixedFeeBand, RollingBandMigrationConfig, TransitionEffectiveRule, TransitionEffectiveRuleKind, VolumeTransitionRule, VolumeTransitionRuleKind, UnsupportedCommercialMechanism } from '@/lib/types'

export interface RollingBandMigrationMechanismEvaluation {
  mechanismKind: string
  evaluation: RollingBandTransitionEvaluation
}

function dateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Step 17C.3b, item C (acceptance-pass refinement) — the "Monitoring
// begins ..." message is pure display copy (nothing downstream parses this
// reason string back into a date), so it's formatted human-readably at the
// source rather than surfacing the raw ISO date a reviewer would have to
// mentally reparse — e.g. "1 October 2026", not "2026-10-01".
function formatLongDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso + 'T00:00:00'))
}

// Read-only: resolves the rolling aggregate + trigger + band selection for
// every 'executable' rolling_band_migration mechanism on this contract, as
// of the given instant. Never writes to the database.
export async function evaluateRollingBandMigrations(params: {
  jobId: string
  terms: ContractTerms
  asOf?: string
}): Promise<RollingBandMigrationMechanismEvaluation[]> {
  const { jobId, terms } = params
  const asOf = params.asOf ?? new Date().toISOString()
  const asOfDate = new Date(asOf)

  const mechanisms = (terms.unsupported_commercial_mechanisms ?? []).filter(
    (m): m is UnsupportedCommercialMechanism & { rolling_band_migration: RollingBandMigrationConfig } =>
      m.execution_status === 'executable' && !!m.rolling_band_migration,
  )
  if (mechanisms.length === 0) return []

  if (!terms.contract_start_date) {
    return mechanisms.map(m => ({
      mechanismKind: m.kind,
      evaluation: { status: 'not_ready', reason: 'no contract_start_date is known to anchor billing periods' },
    }))
  }
  const anchorDate = new Date(terms.contract_start_date + 'T00:00:00')

  const results: RollingBandMigrationMechanismEvaluation[] = []

  for (const mechanism of mechanisms) {
    const config = mechanism.rolling_band_migration

    // Step 17C.3b, item C — a contract that hasn't started yet has no
    // billing periods to speak of at all; "0 of 3 periods closed" reads as
    // if monitoring were already underway and merely behind. Distinguish
    // "the agreement itself hasn't begun" from "the agreement is active
    // but its first few periods haven't closed yet" (the ordinary,
    // unchanged 0/3 -> 1/3 -> 2/3 progression once asOf >= contract_start_date).
    if (asOfDate < anchorDate) {
      results.push({
        mechanismKind: mechanism.kind,
        evaluation: { status: 'not_ready', reason: `Monitoring begins ${formatLongDate(terms.contract_start_date)}. No eligible billing periods have started yet.` },
      })
      continue
    }

    const windows = getLastNCompletedCadenceWindows({
      anchorDate, cadence: terms.billing_frequency, asOf: asOfDate, n: config.aggregate.window_count,
    })

    if (windows.length < config.aggregate.window_count) {
      results.push({
        mechanismKind: mechanism.kind,
        evaluation: { status: 'not_ready', reason: `only ${windows.length} of the required ${config.aggregate.window_count} billing periods have closed as of ${asOf}` },
      })
      continue
    }

    const periodBounds = windows.map(w => ({ start: dateOnly(w.start), end: dateOnly(w.end) }))

    const { data: rows, error } = await supabaseServer
      .from('operational_input_period_values')
      .select('id, input_key, period_start, period_end, value, currency, recorded_at, finalized_at, status, revoked_at')
      .eq('job_id', jobId)
      .eq('input_key', config.aggregate.input_key)
      .in('period_start', periodBounds.map(p => p.start))

    if (error) {
      console.error(`[rolling-band-migration-pull] failed to load operational input values for job ${jobId}, mechanism ${mechanism.kind}:`, error.message)
      results.push({ mechanismKind: mechanism.kind, evaluation: { status: 'not_ready', reason: 'failed to load operational input values' } })
      continue
    }

    const valueRows = (rows ?? []) as OperationalInputPeriodValueRow[]
    const periodValues: RollingWindowPeriodValue[] = periodBounds.map(p => ({
      period_start: p.start,
      period_end: p.end,
      value: resolveInputValueAsOf(valueRows, config.aggregate.input_key, p.start, p.end, asOf),
    }))

    const evaluation = evaluateRollingBandTransition({
      config, bands: terms.base_fee_bands, contractedVolume: terms.base_fee_committed_volume, periodValues,
    })

    results.push({ mechanismKind: mechanism.kind, evaluation })
  }

  return results
}

export interface PersistedRollingBandTransitionRow {
  id: string
  job_id: string
  org_id: string
  trigger_metric: string
  trigger_window_end: string
  trigger_value: number
  from_band: FixedFeeBand
  to_band: FixedFeeBand
  detected_at: string
  notice_required: boolean
  notice_status: 'pending' | 'confirmed' | null
  notice_confirmed_at: string | null
  notice_confirmed_by: string | null
  effective_rule: TransitionEffectiveRule | null
  effective_from: string | null
  status: 'pending_notice' | 'decision_required' | 'pending_effective_date' | 'pricing_required'
}

// Step 17C.2d — one row of the append/versioned volume-rule history (see
// the migration's own header). superseded_at null means this is the
// CURRENTLY effective version — at most one such row per transition_id,
// enforced by a partial unique index at the DB level.
export interface PersistedVolumeTransitionRuleVersion {
  id: string
  transition_id: string
  rule: VolumeTransitionRule
  resolved_at: string
  superseded_at: string | null
}

// Step 17C.2d — "what was the volume rule effective as of instant T,"
// mirroring lib/operational-input-binding.ts's resolveInputValueAsOf's own
// recorded_at/revoked_at replay invariant exactly, applied to this
// table's resolved_at/superseded_at pair instead. A later reviewer
// decision (a new version, superseding the one active at T) never changes
// what this returns for that same, earlier T.
export function resolveVolumeRuleVersionAsOf(
  versions: PersistedVolumeTransitionRuleVersion[],
  transitionId: string,
  asOf: Date,
): VolumeTransitionRule | null {
  const asOfMs = asOf.getTime()
  const match = versions.find(v =>
    v.transition_id === transitionId
    && new Date(v.resolved_at).getTime() <= asOfMs
    && (v.superseded_at == null || new Date(v.superseded_at).getTime() > asOfMs),
  )
  return match?.rule ?? null
}

export interface PersistedRollingBandMigrationResult extends RollingBandMigrationMechanismEvaluation {
  persisted: PersistedRollingBandTransitionRow | null
}

// Persists BOTH triggered outcomes now (Step 17C.2a, item 7 reverses the
// earlier 17C.2 design, which never persisted the not-executable case at
// all): 'transition_triggered' via the real-transition RPC,
// 'transition_triggered_not_executable' via the dedicated pricing_required
// RPC (only when a proposedBand actually resolved — the rarer "average
// exceeds even the top band's own range" sub-case has no band to durably
// record and is left transient, recomputed fresh on every evaluation,
// exactly like before).
//
// Item 1 — when the mechanism's OWN config carries a contract_derived
// effective_rule, it's compiled/resolved and passed straight into the
// detect RPC so the transition's timing is established immediately, no
// reviewer step needed. No extraction path populates this today, so this
// is exercised only by tests until a future extraction-prompt change
// wires it — documented boundary, not a gap in this step's own logic.
export async function persistTriggeredRollingBandMigrations(params: {
  jobId: string
  orgId: string
  terms: ContractTerms
  evaluations: RollingBandMigrationMechanismEvaluation[]
}): Promise<PersistedRollingBandMigrationResult[]> {
  const { jobId, orgId, terms, evaluations } = params
  const results: PersistedRollingBandMigrationResult[] = []

  for (const item of evaluations) {
    if (item.evaluation.status === 'transition_triggered') {
      const triggerWindowEnd = item.evaluation.trace.windows[item.evaluation.trace.windows.length - 1].period_end

      const mechanism = (terms.unsupported_commercial_mechanisms ?? []).find(m => m.kind === item.mechanismKind)
      const contractRule = mechanism?.rolling_band_migration?.effective_rule ?? null
      let effectiveRule: TransitionEffectiveRule | null = null
      let effectiveFrom: string | null = null
      if (contractRule) {
        const resolvedDate = resolveEffectiveDateFromRule({ rule: contractRule, terms, after: new Date(item.evaluation.trace.windows[item.evaluation.trace.windows.length - 1].period_end + 'T00:00:00') })
        if (resolvedDate) {
          effectiveRule = contractRule
          effectiveFrom = dateOnly(resolvedDate)
        }
      }
      // Step 17C.2c — the SAME optional contract_derived shortcut, for the
      // separate volume decision. Never derived here beyond what the
      // mechanism's own config states verbatim — an absent config leaves
      // volume_transition_rule null, exactly as effective_rule does.
      const contractVolumeRule = mechanism?.rolling_band_migration?.volume_transition_rule ?? null

      const { data, error } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId,
        p_org_id: orgId,
        p_trigger_metric: item.evaluation.trace.input_key,
        p_trigger_window_end: triggerWindowEnd,
        p_trigger_value: item.evaluation.rollingAverage,
        p_from_band: item.evaluation.fromBand,
        p_to_band: item.evaluation.toBand,
        p_notice_required: mechanism?.rolling_band_migration?.notice_required ?? true,
        p_effective_rule: effectiveRule,
        p_effective_from: effectiveFrom,
        p_volume_transition_rule: contractVolumeRule,
      })

      if (error) {
        console.error(`[rolling-band-migration-pull] failed to persist detected transition for job ${jobId}, mechanism ${item.mechanismKind}:`, error.message)
        results.push({ ...item, persisted: null })
        continue
      }
      results.push({ ...item, persisted: data as PersistedRollingBandTransitionRow })
      continue
    }

    if (item.evaluation.status === 'transition_triggered_not_executable' && item.evaluation.proposedBand) {
      const triggerWindowEnd = item.evaluation.trace.windows[item.evaluation.trace.windows.length - 1].period_end
      const { data, error } = await supabaseServer.rpc('detect_rolling_band_pricing_required_event', {
        p_job_id: jobId,
        p_org_id: orgId,
        p_trigger_metric: item.evaluation.trace.input_key,
        p_trigger_window_end: triggerWindowEnd,
        p_trigger_value: item.evaluation.rollingAverage,
        p_from_band: item.evaluation.fromBand,
        p_proposed_band: item.evaluation.proposedBand,
      })
      if (error) {
        console.error(`[rolling-band-migration-pull] failed to persist pricing_required event for job ${jobId}, mechanism ${item.mechanismKind}:`, error.message)
        results.push({ ...item, persisted: null })
        continue
      }
      results.push({ ...item, persisted: data as PersistedRollingBandTransitionRow })
      continue
    }

    results.push({ ...item, persisted: null })
  }

  return results
}

// A single, DST-safe month-stepper shared by resolveNextContractPeriodStart
// and resolveNextRenewalTermStart — same field-based construction
// enumerateCadenceWindows/getLastNCompletedCadenceWindows already use, no
// new date arithmetic invented. Returns the first period boundary,
// `stepMonths` apart starting from anchorDate, that falls STRICTLY after
// `after`.
function resolveNextPeriodBoundary(anchorDate: Date, stepMonths: number, after: Date): Date {
  if (after < anchorDate) return anchorDate
  let n = Math.floor(
    ((after.getFullYear() - anchorDate.getFullYear()) * 12 + (after.getMonth() - anchorDate.getMonth())) / stepMonths,
  )
  for (let guard = 0; guard < 4; guard++) {
    const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + n * stepMonths, anchorDate.getDate())
    if (start <= after) { n++; continue }
    const prevStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + (n - 1) * stepMonths, anchorDate.getDate())
    if (prevStart > after) { n--; continue }
    return start
  }
  // Unreachable given the correction loop above for any sane stepMonths —
  // kept total rather than possibly throwing.
  return new Date(anchorDate.getFullYear(), anchorDate.getMonth() + n * stepMonths, anchorDate.getDate())
}

const CADENCE_STEP_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, 'semi-annual': 6, annual: 12 }

// "Next billing period" — resolved through the SAME cadence-window
// machinery every other date in this chain uses (never a hard-coded "next
// calendar month"). Returns the start of the FIRST billing period that
// begins strictly after `after`. Returns null (Decision Required, never
// guessed) when there isn't enough structured information to resolve it.
export function resolveNextContractPeriodStart(params: {
  contractStartDate: string | null | undefined
  cadence: string | null | undefined
  after: Date
}): Date | null {
  const { contractStartDate, cadence, after } = params
  if (!contractStartDate) return null
  const anchorDate = new Date(contractStartDate + 'T00:00:00')
  const stepMonths = CADENCE_STEP_MONTHS[cadence ?? 'monthly'] ?? 1
  return resolveNextPeriodBoundary(anchorDate, stepMonths, after)
}

// Step 17C.2a, item 1 — "next renewal/contract term": the first renewal-
// term boundary strictly after `after`, walking forward from the
// contract's own term length (contract_term_months), then by
// renewal_term_months for every boundary after the first (falling back to
// the original term length when no distinct renewal length is stated).
// Returns null when there isn't enough structured information
// (contract_start_date or contract_term_months) to resolve a first
// boundary at all — never assumes a renewal length that was never stated.
export function resolveNextRenewalTermStart(params: {
  contractStartDate: string | null | undefined
  contractTermMonths: number | null | undefined
  renewalTermMonths: number | null | undefined
  after: Date
}): Date | null {
  const { contractStartDate, contractTermMonths, renewalTermMonths, after } = params
  if (!contractStartDate || !contractTermMonths) return null
  const anchorDate = new Date(contractStartDate + 'T00:00:00')
  const renewalStepMonths = renewalTermMonths ?? contractTermMonths

  let boundary = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + contractTermMonths, anchorDate.getDate())
  for (let guard = 0; guard < 60; guard++) {
    if (boundary > after) return boundary
    boundary = new Date(boundary.getFullYear(), boundary.getMonth() + renewalStepMonths, boundary.getDate())
  }
  return null
}

// Item 1 — the reviewer-facing structured picks a review UI presents
// ("next billing period" / "next renewal/contract term" / "specific
// effective date"). Deliberately NOT free-text: there is no natural-
// language parsing step anywhere in this chain — the "compile" from
// plain-language options into the typed TransitionEffectiveRule IS this
// function, a closed mapping from a small structured selection to the
// typed config, never an inference from contract wording.
export type TransitionEffectiveRuleSelection =
  | { kind: 'next_billing_period' }
  | { kind: 'next_renewal_term' }
  | { kind: 'specific_date'; specific_date: string }

export function compileTransitionEffectiveRule(selection: TransitionEffectiveRuleSelection): TransitionEffectiveRule {
  return {
    kind: selection.kind,
    specific_date: selection.kind === 'specific_date' ? selection.specific_date : null,
    provenance: 'reviewer_policy',
    source_clause: null,
  }
}

// Resolves a TransitionEffectiveRule (whichever kind, whatever its
// provenance) to a real calendar date, given the contract's own
// structured fields. Returns null — surfaced as Decision Required, never
// guessed — when the rule's kind needs structured information the
// contract doesn't have (e.g. next_renewal_term with no known
// contract_term_months).
export function resolveEffectiveDateFromRule(params: {
  rule: TransitionEffectiveRule
  terms: Pick<ContractTerms, 'contract_start_date' | 'billing_frequency' | 'contract_term_months' | 'renewal_term_months'>
  after: Date
}): Date | null {
  const { rule, terms, after } = params
  switch (rule.kind) {
    case 'next_billing_period':
      return resolveNextContractPeriodStart({ contractStartDate: terms.contract_start_date, cadence: terms.billing_frequency, after })
    case 'next_renewal_term':
      return resolveNextRenewalTermStart({
        contractStartDate: terms.contract_start_date,
        contractTermMonths: terms.contract_term_months,
        renewalTermMonths: terms.renewal_term_months,
        after,
      })
    case 'specific_date':
      return rule.specific_date ? new Date(rule.specific_date + 'T00:00:00') : null
    default: {
      const exhaustive: never = rule.kind
      throw new Error(`resolveEffectiveDateFromRule: unhandled TransitionEffectiveRuleKind ${exhaustive}`)
    }
  }
}

// Step 17C.2c — the reviewer-facing structured picks for the SEPARATE
// volume decision (see VolumeTransitionRule's own doc in lib/types.ts).
// Deliberately NOT free-text: the "compile" from plain-language options
// into the typed rule IS this function, a closed mapping from a small
// structured selection to the typed config — no arbitrary formula/
// free-text execution anywhere in this chain.
export type VolumeTransitionRuleSelection =
  | { kind: 'band_upper_bound' }
  | { kind: 'rolling_average' }
  | { kind: 'unchanged' }
  | { kind: 'specific_volume'; value: number }

export function compileVolumeTransitionRule(selection: VolumeTransitionRuleSelection): VolumeTransitionRule {
  return {
    kind: selection.kind,
    value: selection.kind === 'specific_volume' ? selection.value : null,
    provenance: 'reviewer_policy',
    source_clause: null,
  }
}

// Step 17C.2c (revised 17C.2d, item 2) — resolves the CONTRACTED/INCLUDED
// VOLUME a transition's own VolumeTransitionRule implies, given the
// transition's own already-known facts (to_band, the trigger's own rolling
// average) and the contract's ORIGINAL committed volume. Never invents a
// number beyond what the rule's own kind explicitly authorizes:
// band_upper_bound reads to_band.to_unit (null for an open-ended top band
// — never a fabricated "unlimited"); rolling_average reads the SAME
// trigger_value the transition was detected from, CEILED to whole units
// (issued_payment_request_count and every other countable metric this
// mechanism supports has no fractional units — a 3-period mean like
// 5000.333... must never become a fractional contracted-volume threshold;
// Math.ceil is a no-op for an already-whole average, same rounding
// direction and same reasoning as lib/rolling-band-transition.ts's own
// band-selection rounding — rounding DOWN would under-cover a customer
// whose average the reviewer just confirmed should set the threshold; the
// RAW, unrounded average remains permanently available via the
// transition's own immutable trigger_value, never lost); specific_volume
// reads the reviewer/contract-stated value verbatim; unchanged reads the
// contract's own original committed volume. A null `rule` (nothing
// resolved yet) returns provenance 'unresolved' with a null value — this
// is the ONLY place that state can arise, and callers (lib/usage-pull.ts)
// must treat it as Decision Required, never a silent fallback to either
// the old or new number.
export function resolveEffectiveContractedVolume(params: {
  rule: VolumeTransitionRule | null
  toBand: FixedFeeBand
  triggerValue: number
  originalContractedVolume: number | null
}): { value: number | null; provenance: 'contract_derived' | 'reviewer_policy' | 'unresolved' } {
  const { rule, toBand, triggerValue, originalContractedVolume } = params
  if (!rule) return { value: null, provenance: 'unresolved' }
  switch (rule.kind) {
    case 'band_upper_bound':
      return { value: toBand.to_unit, provenance: rule.provenance }
    case 'rolling_average':
      return { value: Math.ceil(triggerValue), provenance: rule.provenance }
    case 'specific_volume':
      return { value: rule.value ?? null, provenance: rule.provenance }
    case 'unchanged':
      return { value: originalContractedVolume, provenance: rule.provenance }
    default: {
      const exhaustive: never = rule.kind
      throw new Error(`resolveEffectiveContractedVolume: unhandled VolumeTransitionRuleKind ${exhaustive}`)
    }
  }
}

// Step 17C.2b, item A (revised 17C.2c) — the SHARED effective commercial-
// state resolver: period/asOf -> effective fixed-fee band -> effective
// contracted volume -> effective monthly fee. One resolver, consumed by
// BOTH the fixed-fee side (schedule reconciliation — which only ever reads
// effective_band/effective_monthly_fee, never the volume fields) and the
// overage side (lib/usage-pull.ts's computeOverageForPeriod, which reads
// effective_contracted_volume/volume_provenance). Callers pre-filter to
// active transitions themselves (via resolveTransitionLifecycleStatus
// against their own asOf) — this function's only remaining job is picking
// the single one that actually governs, when more than one has ever gone
// active over the contract's life: the one with the LATEST effective_from
// always supersedes any earlier one, exactly mirroring how the schedule
// reconciler (lib/rolling-band-schedule-reconciliation.ts) always
// reconciles against the current latest-active transition too.
//
// Step 17C.2c — effective_contracted_volume is NEVER derived from
// to_band.to_unit unless the transition's OWN typed volume_transition_rule
// explicitly says band_upper_bound (see resolveEffectiveContractedVolume
// above). The base platform fee (effective_band/effective_monthly_fee) can
// still resolve/activate normally even while the volume rule is entirely
// unresolved — volume_provenance: 'unresolved' with a null
// effective_contracted_volume is exactly that "fee is executable, overage
// threshold is Decision Required" split the caller must act on.
export interface EffectiveCommercialStateResolution {
  effective_band: FixedFeeBand | null
  effective_contracted_volume: number | null
  volume_provenance: 'contract_derived' | 'reviewer_policy' | 'unresolved'
  effective_monthly_fee: number | null
  transition_id: string | null
  provenance: 'contract_derived' | 'transition_active'
}

export function resolveEffectiveCommercialState(params: {
  contractedBand: FixedFeeBand | null
  contractedVolume: number | null
  activeTransitions: Array<{ id: string; toBand: FixedFeeBand; effectiveFrom: string; triggerValue: number; volumeTransitionRule: VolumeTransitionRule | null }>
}): EffectiveCommercialStateResolution {
  const { contractedBand, contractedVolume, activeTransitions } = params
  if (activeTransitions.length === 0) {
    return {
      effective_band: contractedBand,
      effective_contracted_volume: contractedVolume,
      volume_provenance: 'contract_derived',
      effective_monthly_fee: contractedBand?.monthly_fee ?? null,
      transition_id: null,
      provenance: 'contract_derived',
    }
  }
  const latest = [...activeTransitions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[activeTransitions.length - 1]
  const volumeResolution = resolveEffectiveContractedVolume({
    rule: latest.volumeTransitionRule, toBand: latest.toBand, triggerValue: latest.triggerValue, originalContractedVolume: contractedVolume,
  })
  return {
    effective_band: latest.toBand,
    effective_contracted_volume: volumeResolution.value,
    volume_provenance: volumeResolution.provenance,
    effective_monthly_fee: latest.toBand.monthly_fee,
    transition_id: latest.id,
    provenance: 'transition_active',
  }
}

// DB-querying wrapper: loads every persisted transition for this job's
// rolling-band-migration mechanism(s), filters to whichever are ACTIVE as
// of `asOf` (via resolveTransitionLifecycleStatus, so an OLD asOf
// correctly excludes a transition that only went active more recently —
// item 8's "historical asOf must reproduce which band was effective at
// that time"), and resolves the effective state via the pure function
// above. Never mutates contract_terms/base_fee_bands — always reads the
// ORIGINAL contracted band/volume fresh from terms.
//
// Step 17C.2d — TWO deliberately distinct instants, not one:
//   asOf          — governs whether the PRICING TRANSITION itself is
//                    active (unchanged from 17C.2a/b). This is a
//                    CONTRACTUAL fact tied to the transition's own
//                    effective_from — a real-Postgres acceptance run
//                    confirmed this must stay period-anchored (the caller
//                    passes the billing period's own start) so a period
//                    that closed before effective_from is never treated as
//                    covered by it.
//   volumeRuleAsOf — governs which VERSION of the reviewer's volume-
//                    treatment decision applies (defaults to `asOf` for
//                    every existing single-instant caller/test). This is
//                    NOT a contractual fact — it is a review decision made
//                    at whatever real instant the reviewer acted, with no
//                    inherent tie to the billing period's own calendar
//                    dates. The SAME real-Postgres run found that reusing
//                    the period-anchored `asOf` here was a real defect: a
//                    volume rule resolved today for a period that already
//                    closed weeks ago (the normal arrears-billing case)
//                    would always look "not yet resolved as of the
//                    period's own start" and incorrectly hold forever.
//                    lib/usage-pull.ts passes the real billing execution
//                    instant (billingAsOf) here — never the window's own
//                    calendar start.
export async function resolveEffectiveCommercialStateForPeriod(params: {
  jobId: string
  terms: ContractTerms
  asOf: Date
  volumeRuleAsOf?: Date
}): Promise<EffectiveCommercialStateResolution> {
  const { jobId, terms, asOf } = params
  const volumeRuleAsOf = params.volumeRuleAsOf ?? asOf
  const contractedResolution = resolveFixedFeeBand(terms.base_fee_bands, terms.base_fee_committed_volume)
  const contractedBand = contractedResolution.status === 'resolved' ? contractedResolution.band : null
  const contractedVolume = terms.base_fee_committed_volume ?? null

  const { data: rows, error } = await supabaseServer
    .from('rolling_band_pricing_transitions')
    .select('*')
    .eq('job_id', jobId)
  if (error) {
    console.error(`[rolling-band-migration-pull] failed to load transitions for job ${jobId}:`, error.message)
    return { effective_band: contractedBand, effective_contracted_volume: contractedVolume, volume_provenance: 'contract_derived', effective_monthly_fee: contractedBand?.monthly_fee ?? null, transition_id: null, provenance: 'contract_derived' }
  }

  const activeRows = (rows ?? []).filter((row: PersistedRollingBandTransitionRow) => resolveTransitionLifecycleStatus(row, asOf) === 'active')

  let versions: PersistedVolumeTransitionRuleVersion[] = []
  if (activeRows.length > 0) {
    const { data: versionRows, error: versionsError } = await supabaseServer
      .from('rolling_band_volume_rule_versions')
      .select('id, transition_id, rule, resolved_at, superseded_at')
      .in('transition_id', activeRows.map((r: PersistedRollingBandTransitionRow) => r.id))
    if (versionsError) {
      console.error(`[rolling-band-migration-pull] failed to load volume rule versions for job ${jobId}:`, versionsError.message)
    } else {
      versions = (versionRows ?? []) as PersistedVolumeTransitionRuleVersion[]
    }
  }

  const activeTransitions = activeRows.map((row: PersistedRollingBandTransitionRow) => ({
    id: row.id, toBand: row.to_band, effectiveFrom: row.effective_from!,
    triggerValue: row.trigger_value, volumeTransitionRule: resolveVolumeRuleVersionAsOf(versions, row.id, volumeRuleAsOf),
  }))

  return resolveEffectiveCommercialState({ contractedBand, contractedVolume, activeTransitions })
}

// Item 4/5 (17C.2a), widened in 17C.2b item B — the future-schedule
// reconciliation entry point. Finds whichever transition has the LATEST
// RESOLVED effective_from (same "latest wins" rule
// resolveEffectiveCommercialState uses) and reconciles planned_invoices
// against it. Eligible lifecycle states are 'active' AND
// 'pending_effective_date' — deliberately NOT gated on "already active":
// effective_from is a fixed, known fact the moment it's resolved (even if
// still in the future), so the schedule can and should reflect a known
// upcoming price change immediately (and a straddling period can be
// flagged Decision Required well before it's due) rather than waiting
// until the exact day arrives. This is what makes item B's "rerun
// reconciliation as soon as a transition's decision/effective rule is
// resolved" possible at all — resolving effective_rule alone (via the API
// route) is enough to trigger a real reconciliation pass, previously only
// an 'active' transition could. resolveEffectiveCommercialState's OWN
// asOf-gated activation check is untouched — this widening only affects
// which transitions the SCHEDULE reconciler considers, never what a
// concurrent billing calculation reads as "effective right now".
// A no-op (zeroed result) when no transition has a resolved effective_from
// yet — safe to call unconditionally from a scheduler tick or right after
// a reviewer resolves a transition's notice/effective_rule.
export async function reconcileActiveRollingBandTransitions(params: {
  jobId: string
  orgId: string
  terms: ContractTerms
  asOf?: Date
}): Promise<ScheduleReconciliationResult> {
  const { jobId, orgId, terms } = params
  const asOf = params.asOf ?? new Date()

  const { data: rows, error } = await supabaseServer
    .from('rolling_band_pricing_transitions')
    .select('*')
    .eq('job_id', jobId)
  if (error) {
    console.error(`[rolling-band-migration-pull] failed to load transitions for job ${jobId} (reconciliation):`, error.message)
    return { recomputed: 0, held: 0, recovered: 0, skipped: 0, unsupportedShape: null }
  }

  const eligible = (rows ?? [])
    .filter((row: PersistedRollingBandTransitionRow) => {
      const status = resolveTransitionLifecycleStatus(row, asOf)
      return status === 'active' || status === 'pending_effective_date'
    })
    .sort((a: PersistedRollingBandTransitionRow, b: PersistedRollingBandTransitionRow) => (a.effective_from ?? '').localeCompare(b.effective_from ?? ''))

  const latest = eligible[eligible.length - 1]
  if (!latest) return { recomputed: 0, held: 0, recovered: 0, skipped: 0, unsupportedShape: null }

  return reconcileFutureScheduleForTransition({
    jobId, orgId, terms,
    transition: { id: latest.id, to_band: latest.to_band, effective_from: latest.effective_from! },
  })
}

export type { TransitionEffectiveRuleKind, VolumeTransitionRuleKind }
