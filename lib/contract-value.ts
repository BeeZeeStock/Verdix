// The single authoritative derived-economics model for a contract — fixed
// fees, minimum commitments, committed contract value, billed-to-date,
// remaining fixed fees, unbilled commitments, projected contract value.
// Wraps (doesn't duplicate) computeBaseTcv from lib/contract-tcv-calc.ts
// (already correct, already used server-side) and adds the term-wide
// minimum-commitment math via lib/tariff.ts's cadence-window engine
// (computeMinimumCommitmentSchedule) — the same engine RevenueModelTab
// already used for its own "generic" tier, but that lib/contract-tcv.ts's
// getContractSummaries never did: it instead summed a single per-period
// minimum-commitment amount ONCE across the whole term (e.g. one quarter's
// SEK 5,000 instead of all four quarters a 12-month contract touches),
// silently under-counting committed contract value. This file exists so
// every screen — the Configure page's header stats, the Graphical View,
// and the Agreements/New-contracts dashboard lists — derives from the same
// function instead of each recomputing (and potentially disagreeing about)
// the same figures.
//
// Client-safe: no supabaseServer import, same discipline as contract-tcv-calc.ts.

import { computeCommittedFixedFees, computeConditionalFixedFees, type BaseTcvItem } from './contract-tcv-calc'
import { resolveCommittedFixedFeeValue, type CommittedFixedFeeResolution, type CommittedFixedFeeDiscountLike } from './committed-fixed-fee-resolver'
import { computeMinimumCommitmentSchedule, type CadenceAnchorMode } from './tariff'
import type { ProrationLike } from './commercial-rule-status'
import type { MinimumCommitment } from './types'

export type ContractValueTier = {
  measurement_period?: string | null
  reset_anchor?: 'contract_start' | 'calendar' | null
  minimum_commitment?: Pick<MinimumCommitment, 'amount' | 'prorate_partial_periods' | 'requires_confirmation'> | null
}

export type ContractValueInputs = {
  items: BaseTcvItem[]
  /** One entry per metric (not per raw tier row) — resolve each metric's
   *  minimum commitment via lib/tariff.ts's resolveMinimumCommitment/
   *  groupTiersByMetric before calling, so a metric with several tier rows
   *  doesn't get its commitment counted once per row. */
  metrics: ContractValueTier[]
  contractStartDate: string | null
  contractEndDate: string | null
  /** Sum of every sent/paid planned_invoices row — same figure
   *  getContractSummaries already computes server-side; RevenueModelTab
   *  derives its own equivalent client-side from billingData. */
  billedToDate: number
  /** Step 17A hardening (review pass 2), item 3 — discounts whose scope/
   *  effective period may still require a reviewer decision (see
   *  lib/committed-fixed-fee-resolver.ts). When any are unresolved, this
   *  model's committedContractValue (and everything derived from it) must
   *  not present a number a still-open decision could change — reuses the
   *  SAME pendingReason null mechanism already used for unresolved
   *  minimum-commitment interpretation below, so every consumer already
   *  handling "pendingReason set -> show Pending, not a number" gets this
   *  correctly for free. */
  discounts?: CommittedFixedFeeDiscountLike[] | null
  /** Step 17A hardening (review pass 3), item 1 — the base/platform fee's
   *  own partial-period proration state (lib/types.ts's PeriodProrationRule,
   *  reused as-is — see lib/contract-extractor.ts's base_fee_proration
   *  guidance for both triggers it now covers). A SEPARATE open question
   *  from discounts above: a pilot/waiver's SCOPE being confirmed does not
   *  by itself confirm how the fee applies to the partial period once that
   *  waiver expires mid-cycle — both must resolve before committed fixed
   *  fees are 'ready'. */
  baseFeeProration?: ProrationLike
}

export type ContractValueModel = {
  fixedRecurringValue: number
  /** Committed one-time fees only — excludes any fee still conditional on
   *  an unsigned future Change Order (see conditionalFixedFees below). */
  oneTimeFees: number
  /** "Committed fixed fees" — see computeCommittedFixedFees. Never includes
   *  a fee whose existence depends on an unsigned, optional future Change
   *  Order; committedContractValue below is built from this, not from the
   *  all-inclusive potential total. */
  fixedFees: number
  /** Sum of fees still conditional on an unsigned future Change Order —
   *  shown separately, never folded into fixedFees/committedContractValue.
   *  Agreement A final amendment, item 2. */
  conditionalFixedFees: number
  /** fixedFees + conditionalFixedFees — the all-inclusive "if every
   *  currently-optional Change Order were signed" figure. Equivalent to
   *  computeBaseTcv(items); provided so a caller never has to re-derive it
   *  or risk the parts not summing to a whole it also displays. */
  potentialFixedFees: number
  /** Null when any confirmed-mode commitment's partial-period treatment is
   *  still unresolved — never a guessed number, per "don't present an
   *  authoritative minimum commitment until required rules are resolved." */
  minimumCommitments: number | null
  committedContractValue: number | null
  billedToDate: number
  remainingFixedFees: number
  unbilledCommitments: number | null
  projectedContractValue: number | null
  /** Set whenever any of the above is null — the specific reason to surface
   *  as "Pending [x] interpretation" rather than a generic "unavailable". */
  pendingReason: string | null
  /** Step 17A hardening (review pass 2), item 3 — the authoritative,
   *  resolver-driven readiness of THIS agreement's committed fixed fees
   *  (see lib/committed-fixed-fee-resolver.ts). Every user-facing surface
   *  presenting "committed fixed fees" for this agreement must check this
   *  before displaying fixedFees/committedContractValue as a final number —
   *  fixedFees itself stays a raw number (unchanged, backward compatible)
   *  purely for internal/legacy math; this field is the one to gate on. */
  committedFixedFeesResolution: CommittedFixedFeeResolution
}

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function computeContractValueModel(inputs: ContractValueInputs): ContractValueModel {
  // Excludes conditional_future_agreement items — must stay in lockstep
  // with fixedFees below (computeCommittedFixedFees), since
  // fixedRecurringValue is derived as fixedFees - oneTimeFees; if oneTimeFees
  // still included a Change-Order-conditional fee while fixedFees had
  // already excluded it, fixedRecurringValue would go negative by that
  // fee's amount instead of correctly reflecting only recurring value.
  const oneTimeFees = inputs.items
    .filter(i => /one.?time/i.test(i.billing_period ?? '') && i.commitmentStatus !== 'conditional_future_agreement')
    .reduce((s, i) => s + (i.total_amount ?? 0), 0)
  const fixedFees = computeCommittedFixedFees(inputs.items)
  const conditionalFixedFees = computeConditionalFixedFees(inputs.items)
  const potentialFixedFees = fixedFees + conditionalFixedFees
  const fixedRecurringValue = fixedFees - oneTimeFees

  let minimumCommitments: number | null = null
  let pendingReason: string | null = null

  if (inputs.contractStartDate && inputs.contractEndDate) {
    const start = parseLocalDate(inputs.contractStartDate)
    const end = parseLocalDate(inputs.contractEndDate)
    let total = 0
    let anyConfirmed = false
    for (const tier of inputs.metrics) {
      const mc = tier.minimum_commitment
      if (!mc) continue
      if (mc.requires_confirmation) { pendingReason = 'Pending minimum-commitment interpretation'; continue }
      const anchor: CadenceAnchorMode = tier.reset_anchor === 'calendar' ? 'calendar' : 'contract_start'
      const schedule = computeMinimumCommitmentSchedule(start, end, tier.measurement_period, anchor, mc)
      if (schedule.requiresConfirmation || schedule.total == null) {
        pendingReason = 'Pending partial-period interpretation'
        continue
      }
      total += schedule.total
      anyConfirmed = true
    }
    if (!pendingReason && anyConfirmed) minimumCommitments = Math.round(total * 100) / 100
    else if (!pendingReason) minimumCommitments = 0
  }

  // Hardening item 3 (review pass 2) — the SAME resolver every other
  // user-facing surface uses. When unresolved, committedContractValue (and
  // everything derived from it) must go null too — a still-open pilot-
  // scope/proration decision could still change the base fixedFees figure
  // that committedContractValue is built on top of, so adding a confirmed
  // minimum commitment to it would only compound a number that isn't
  // settled yet. Reuses the existing pendingReason mechanism rather than a
  // new parallel one — this is checked FIRST so it can never be silently
  // overwritten by the (unrelated) minimum-commitment loop's own reason.
  const committedFixedFeesResolution = resolveCommittedFixedFeeValue(inputs.items, inputs.discounts ?? null, inputs.baseFeeProration)
  if (committedFixedFeesResolution.status === 'unresolved') {
    pendingReason = committedFixedFeesResolution.reasons[0] ?? 'Pending committed-fixed-fee decision'
  }

  const committedContractValue = (committedFixedFeesResolution.status === 'unresolved' || minimumCommitments == null)
    ? null
    : fixedFees + minimumCommitments
  const remainingFixedFees = Math.max(0, fixedFees - inputs.billedToDate)
  const unbilledCommitments = minimumCommitments
  const projectedContractValue = committedContractValue

  return {
    fixedRecurringValue,
    oneTimeFees,
    fixedFees,
    conditionalFixedFees,
    potentialFixedFees,
    minimumCommitments,
    committedContractValue,
    committedFixedFeesResolution,
    billedToDate: inputs.billedToDate,
    remainingFixedFees,
    unbilledCommitments,
    projectedContractValue,
    pendingReason,
  }
}
