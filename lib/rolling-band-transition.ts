// Step 17C.2 (revised 17C.2a) — the second/third/fourth stages of the
// rolling-band-migration execution chain: compare the rolling aggregate to
// the contract's committed volume (upward-only trigger), select the
// corresponding FixedFeeBand (reusing lib/fixed-fee-band.ts's
// resolveFixedFeeBand directly — never a second tariff table), and
// resolve a transition's lifecycle status (pending_notice/decision_required/
// pending_effective_date/pricing_required/active) as a pure function of its
// own stored fields + asOf.
import type { FixedFeeBand, RollingBandMigrationConfig, TransitionEffectiveRule } from './types'
import { resolveFixedFeeBand } from './fixed-fee-band'
import { computeRollingWindowAggregate, type RollingWindowPeriodValue, type RollingWindowAggregateTrace } from './rolling-window-aggregate'

export type RollingBandTransitionEvaluation =
  | { status: 'not_ready'; reason: string }
  // The current committed volume itself doesn't resolve to a band, or the
  // schedule is otherwise malformed — a config problem, not a "wait for
  // more data" one.
  | { status: 'invalid'; reason: string }
  | { status: 'no_transition'; rollingAverage: number; contractedVolume: number }
  // Section 4 (17C.2) / item 7 (17C.2a) — the average exceeded the
  // committed volume, but the corresponding band has no stated numeric
  // price ("Offereras"/quote required) or doesn't resolve at all. Never
  // invents a price. proposedBand carries the resolved-but-unpriced band
  // (e.g. {from_unit:150001, to_unit:null, monthly_fee:null}) so a caller
  // can persist it as a durable pricing_required record (item 7) — null
  // only in the rarer sub-case where the average exceeds even the top
  // band's own range and nothing resolves at all.
  | {
      status: 'transition_triggered_not_executable'
      rollingAverage: number; contractedVolume: number
      fromBand: FixedFeeBand; proposedBand: FixedFeeBand | null; reason: string; trace: RollingWindowAggregateTrace
    }
  | {
      status: 'transition_triggered'
      rollingAverage: number; contractedVolume: number
      fromBand: FixedFeeBand; toBand: FixedFeeBand; trace: RollingWindowAggregateTrace
    }

export function evaluateRollingBandTransition(params: {
  config: RollingBandMigrationConfig
  bands: FixedFeeBand[] | null | undefined
  contractedVolume: number | null | undefined
  periodValues: RollingWindowPeriodValue[]
}): RollingBandTransitionEvaluation {
  const { config, bands, contractedVolume, periodValues } = params

  const aggregateResult = computeRollingWindowAggregate(config.aggregate, periodValues)
  if (aggregateResult.status === 'not_ready') {
    return { status: 'not_ready', reason: aggregateResult.reason }
  }

  if (contractedVolume == null) {
    return { status: 'not_ready', reason: 'no contracted volume (base_fee_committed_volume) is known to compare the rolling average against' }
  }

  const currentBandResolution = resolveFixedFeeBand(bands, contractedVolume)
  if (currentBandResolution.status !== 'resolved') {
    return {
      status: 'invalid',
      reason: `the contract's own committed volume (${contractedVolume}) does not resolve to a band in base_fee_bands — cannot determine the current band to transition from`,
    }
  }

  // Item 5 — 'greater_than' is the only implemented comparator (see
  // RollingBandMigrationConfig's own doc); this is the sole place that
  // reads it, and it is never evaluated in the opposite direction.
  const triggered = config.trigger_comparator === 'greater_than' && aggregateResult.value > contractedVolume
  if (!triggered) {
    return { status: 'no_transition', rollingAverage: aggregateResult.value, contractedVolume }
  }

  // Item 11's own boundary case — band boundaries (from_unit/to_unit) are
  // discrete WHOLE-NUMBER counts ("1,501–5,000 requests"), but a rolling
  // MEAN of a discrete quantity is routinely fractional (e.g. 5000.333).
  // The trigger above has already confirmed the average is strictly
  // GREATER than the committed volume — rounding UP (never down/
  // truncating) is what keeps that confirmed fact consistent with band
  // selection: a fractional average anywhere above a boundary must select
  // the band above it, never silently fall back into the same band the
  // trigger just proved it exceeded. Math.ceil is a no-op for an
  // already-whole average (8000 stays 8000), so this never changes the
  // outcome for the common case.
  const proposedSelector = Math.ceil(aggregateResult.value)
  const proposedBandResolution = resolveFixedFeeBand(bands, proposedSelector)

  if (proposedBandResolution.status !== 'resolved') {
    return {
      status: 'transition_triggered_not_executable',
      rollingAverage: aggregateResult.value, contractedVolume,
      fromBand: currentBandResolution.band, proposedBand: null,
      reason: `rolling average ${aggregateResult.value} exceeds the committed volume but does not resolve to any configured band`,
      trace: aggregateResult.trace,
    }
  }
  if (proposedBandResolution.band.monthly_fee == null) {
    return {
      status: 'transition_triggered_not_executable',
      rollingAverage: aggregateResult.value, contractedVolume,
      fromBand: currentBandResolution.band, proposedBand: proposedBandResolution.band,
      reason: `the proposed band (${proposedBandResolution.band.from_unit}–${proposedBandResolution.band.to_unit ?? '∞'}) has no stated fixed price — quote required ("Offereras"); a transition cannot be marked executable without inventing a price`,
      trace: aggregateResult.trace,
    }
  }

  return {
    status: 'transition_triggered',
    rollingAverage: aggregateResult.value, contractedVolume,
    fromBand: currentBandResolution.band, toBand: proposedBandResolution.band,
    trace: aggregateResult.trace,
  }
}

// Step 17C.2a — a transition's LIFECYCLE status, resolved as a pure
// function of its own persisted fields + asOf. 'active' is never a value
// stored in the DB — always DERIVED at read time (see the migration's own
// header) — and neither is 'decision_required' truly a terminal DB write
// target on its own merits: it falls out of the SAME derivation whenever
// notice is settled but no effective_rule/effective_from has been resolved
// yet (item 1). 'pricing_required' is the one state this function trusts
// directly from the stored row rather than deriving — see the field's own
// comment below for why.
export interface PersistedRollingBandTransitionLifecycle {
  notice_required: boolean
  notice_status: 'pending' | 'confirmed' | null
  notice_confirmed_at: string | null
  effective_rule: TransitionEffectiveRule | null
  effective_from: string | null
  /** The RAW stored status column. Only ever consulted for its ONE
   *  'pricing_required' value (item 7) — a fact the evaluation engine
   *  itself produced (no priced band exists for the triggered average) and
   *  that no combination of notice/effective-date facts could ever derive
   *  independently, unlike every other lifecycle state below. Any other
   *  stored value is ignored — this function is the sole authority for
   *  every other state. */
  status: string
}

export type PricingTransitionLifecycleStatus =
  | 'pending_notice'
  // Item 1 — the meaning of "next contract period"/"effective from" is not
  // yet established (no contract_derived or reviewer-confirmed
  // effective_rule exists). Distinct from pending_notice: notice may
  // already be fully confirmed, or not required at all — the remaining
  // blocker is purely the missing effective-timing authority.
  | 'decision_required'
  | 'pending_effective_date'
  // Item 7 — the rolling average resolved to a band with no configured
  // numeric price ("Offereras"/quote required). Structurally distinct from
  // every other blocked state: no amount of notice/date resolution can
  // ever unblock this — only configuring a real price for that band can,
  // and this codebase has no path that does so automatically.
  | 'pricing_required'
  | 'active'

export function resolveTransitionLifecycleStatus(
  transition: PersistedRollingBandTransitionLifecycle,
  asOf: Date,
): PricingTransitionLifecycleStatus {
  // Item 7 — checked first: a pricing_required row has no notice/
  // effective-date facts worth deriving from at all (notice_required is
  // always false for this kind of row — see the migration's own RPC).
  if (transition.status === 'pricing_required') return 'pricing_required'

  // Item 8 — fails closed while a required notice is unresolved,
  // regardless of whatever effective_from might already be set to (a
  // caller must never be able to activate a transition merely by setting
  // a date while notice is still pending).
  if (transition.notice_required && transition.notice_status !== 'confirmed') {
    return 'pending_notice'
  }

  // Item 1 — no resolved effective-timing authority yet (neither
  // contract_derived nor reviewer_policy) — decision required, never
  // guessed from cadence.
  if (!transition.effective_rule || !transition.effective_from) {
    return 'decision_required'
  }

  // Item 2 — activation must PROVE notice_confirmed_at < effective_from,
  // not merely that notice_status === 'confirmed'. If notice was
  // (somehow) confirmed at or after the resolved effective date, the
  // ordering invariant the contract's "after advance notice" language
  // requires cannot be established — remain pending rather than activate
  // on an inconsistent timeline. No notice duration is ever invented here;
  // this only compares two already-recorded instants.
  if (transition.notice_required) {
    if (!transition.notice_confirmed_at) return 'pending_notice'
    const effectiveDate = new Date(transition.effective_from + 'T00:00:00')
    if (new Date(transition.notice_confirmed_at).getTime() >= effectiveDate.getTime()) {
      return 'pending_notice'
    }
  }

  const effectiveDate = new Date(transition.effective_from + 'T00:00:00')
  return asOf >= effectiveDate ? 'active' : 'pending_effective_date'
}
