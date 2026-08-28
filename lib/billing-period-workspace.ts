// Step 17F — the contract GUI's new "operate by billing period" workspace.
// Pure, DB-free, React-free: takes already-computed facts (contract terms,
// confirmed usage sources, performance-share status, operational-input
// activity, invoice/settlement state) and derives (a) which billing period
// is currently relevant, (b) each component's (fixed/usage/performance)
// state for that period, and (c) the period's overall readiness. This is
// the SAME model lib/billing-action.ts's Dashboard-facing BillingAction
// derivation consumes (item 12) — one source of truth for "what does this
// period need," never duplicated between the contract GUI and a future
// Dashboard surface.
//
// Deliberately does NOT recompute billing math itself — item 6/10's "do
// not duplicate calculation logic in the page" applies equally to this
// lib. Fixed-fee amounts reuse lib/billing-writer.ts's own exported
// computeMonthlyBaseRate/computeEscalatorMultiplier/computeDiscountMultiplier/
// computeFixedFeePeriodAmount (Stage A's own arithmetic, verbatim — see
// billing-writer.ts's own header on why these are exported as reusable
// pure steps). Usage/performance amounts are supplied by the caller
// (already computed via lib/usage-charge-projection.ts and the existing
// /api/jobs/[id]/performance-share route respectively) — this module only
// ORGANIZES those facts into one period's readiness/action state.
import { computeMonthlyBaseRate, computeEscalatorMultiplier, computeDiscountMultiplier, computeFixedFeePeriodAmount, findCadenceWindowContaining } from './tariff'
import { normaliseCadence } from './billing-cadence'
import type { ContractTerms, FixedFeeBillingTimingRule } from './types'

function fmtDateOnly(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtRangeLabel(start: Date, end: Date): string {
  const dayMonth = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const full = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return start.getFullYear() === end.getFullYear() ? `${dayMonth(start)} – ${full(end)}` : `${full(start)} – ${full(end)}`
}

export interface BillingPeriodBounds {
  start: string
  end: string
  label: string
  // Deep-link target (item 13) — e.g. "billing-period-2026-10". Stable for
  // the life of the period (derived from its start date), so a link built
  // today still resolves correctly whenever the period is later revisited.
  anchorId: string
}

// The billing period containing `asOf` — reuses lib/tariff.ts's own
// findCadenceWindowContaining verbatim (the same function real billing's
// window enumeration is built from), never a second date-math
// implementation. Returns null only when the contract has no start date at
// all (nothing to anchor a period to yet).
export function deriveBillingPeriod(params: {
  contractStartDate: string | null | undefined
  billingFrequency: string | null | undefined
  asOf: Date
}): BillingPeriodBounds | null {
  if (!params.contractStartDate) return null
  const anchor = new Date(params.contractStartDate + 'T00:00:00')
  const cadence = normaliseCadence(params.billingFrequency)
  // findCadenceWindowContaining extrapolates the cadence infinitely in both
  // directions from the anchor — before the contract has even started,
  // that would resolve to a nonexistent "period" earlier than the first
  // one. Clamping asOf forward to the anchor itself in that case correctly
  // yields the FIRST real period instead.
  const effectiveAsOf = params.asOf < anchor ? anchor : params.asOf
  const window = findCadenceWindowContaining(anchor, cadence, effectiveAsOf)
  const start = fmtDateOnly(window.start)
  return {
    start, end: fmtDateOnly(window.end),
    label: fmtRangeLabel(window.start, window.end),
    anchorId: `billing-period-${start.slice(0, 7)}`,
  }
}

// month-distance from contract start to a period start — plain index
// arithmetic (never a pricing decision), matching the same pattern already
// used inline in app/_components/BillingSummaryCard.tsx's own timeline
// construction.
function globalMonthIndex(contractStartDate: string, periodStart: string): number {
  const cs = new Date(contractStartDate + 'T00:00:00')
  const ps = new Date(periodStart + 'T00:00:00')
  return (ps.getFullYear() - cs.getFullYear()) * 12 + (ps.getMonth() - cs.getMonth())
}

// Step 17F.3, item 10 — the fixed component's AMOUNT (known as soon as the
// period starts, computed below) is deliberately independent of its
// BILLING TIMING resolution (item 2/3) — "Known amount" stays separate
// from "invoice issue date." A contract with an unresolved
// fixed_fee_billing_timing still has a perfectly well-known fixed fee
// amount; it just cannot yet produce an authoritative INVOICE DATE for it
// (see PeriodReadinessState below, which is where timing resolution
// actually gates something).
export interface FixedComponentState {
  amount: number
  currency: string
  // true when the discount multiplier fully zeroes an otherwise-nonzero
  // fee (e.g. the Remembill 90-day pilot waiver) — lets the UI say WHY the
  // known amount is 0 instead of it reading as "nothing configured."
  waived: boolean
  // Step 17F.3, item 2/9 — never inferred from cadence or payment terms;
  // resolved: false means "Decision Required" must be shown verbatim,
  // never a scheduler-assumed date. timing is null exactly when
  // !resolved.
  billingTiming: {
    resolved: boolean
    timing: 'bill_at_period_start' | 'bill_at_period_end' | null
  }
}

// Reuses Stage A's own exported arithmetic verbatim — additionalFixedFeesTotal
// is the sum of additional_recurring_fees with a flat `amount` (not
// rate_per_unit/percentage_of_basis, which are usage/performance
// components, never fixed ones) — same scoping billing-writer.ts's own
// computeBillingSchedule uses for its `feesContribution`/`additionalMonthlyFlat`.
export function computeFixedComponentForPeriod(params: {
  terms: ContractTerms
  periodStart: string
  additionalFixedFeesTotal: number
  currency: string
  // Step 17F.3, item 2 — the job-level typed rule (lib/types.ts's
  // FixedFeeBillingTimingRule); absent/requires_confirmation:true means
  // genuinely unresolved — never defaulted to bill_at_period_start just
  // because that's the scheduler's own structural convention today (item
  // 1's audit finding: that convention is a scheduler implementation
  // default, never contract-derived truth on its own).
  billingTimingRule?: FixedFeeBillingTimingRule | null
}): FixedComponentState {
  const { terms, periodStart, additionalFixedFeesTotal, currency, billingTimingRule } = params
  const billingTiming = (billingTimingRule && !billingTimingRule.requires_confirmation && billingTimingRule.timing !== 'unclear')
    ? { resolved: true, timing: billingTimingRule.timing }
    : { resolved: false, timing: null }
  if (!terms.contract_start_date) return { amount: 0, currency, waived: false, billingTiming }
  const globalMonthIdx = globalMonthIndex(terms.contract_start_date, periodStart)
  const d = new Date(periodStart + 'T00:00:00')
  const base = computeMonthlyBaseRate(terms, globalMonthIdx, d)
  const escMult = computeEscalatorMultiplier(terms, d)
  const discMult = computeDiscountMultiplier(terms, d)
  const rawAmount = base + additionalFixedFeesTotal
  const amount = computeFixedFeePeriodAmount(base, additionalFixedFeesTotal, escMult, discMult)
  return {
    amount: Math.round(amount * 100) / 100,
    currency,
    waived: rawAmount > 0 && discMult === 0,
    billingTiming,
  }
}

export type UsageComponentStatus = 'awaiting_source' | 'awaiting_period' | 'pending_usage' | 'computed'

export interface UsageComponentState {
  key: string
  label: string
  semanticInputKey: string | null
  sourceName: string | null
  status: UsageComponentStatus
  quantity?: number | null
  amount?: number | null
  formula?: string | null
}

export type PerformanceComponentStatus = 'not_started' | 'pending_operational_inputs' | 'computed' | 'waived'

export interface PerformanceComponentState {
  feeLabel: string
  status: PerformanceComponentStatus
  missingKeys?: string[]
  amount?: number | null
  contractStartDate?: string | null
}

export type PeriodReadinessState =
  | 'upcoming'
  | 'fixed_billing_timing_required'
  | 'waiting_for_usage'
  | 'waiting_for_operational_inputs'
  | 'parked'
  | 'ready_to_invoice'
  | 'invoiced'

// Item 9 — "Parked" here means a CONFIGURATION dependency is unresolved
// (no confirmed usage source at all for a component this period needs) —
// distinct from "waiting for usage/operational inputs," which means
// configuration is complete and the period is simply waiting on runtime
// data that will naturally arrive. Deliberately narrower than (and
// unrelated to) the existing one-time-fee "parked invoice"
// operational-event-evidence mechanism (app/api/jobs/[id]/parked-invoices,
// surfaced via BillingSummaryCard) — that mechanism is untouched by this
// module and continues to govern its own invoice rows; this is a
// period-level READINESS label, reusing the same word for the same
// underlying idea ("cannot proceed without a human resolving something
// first") rather than inventing a second, contradictory model.
//
// Step 17F.3, item 3/11 — 'fixed_billing_timing_required' is its own
// distinct state (never collapsed into 'parked') so a future Dashboard
// action (lib/billing-action.ts) and this workspace can both name the
// SPECIFIC blocker precisely: the fixed component's AMOUNT is known, but
// no authoritative invoice DATE can be produced for it while timing is
// unresolved. Checked before usage 'parked'/'waiting_for_*' — a period
// this fundamentally undated is not more "ready" than one merely waiting
// on a usage source, but the DISTINCT reason must survive to the reviewer
// rather than reading as an unspecific block.
export function derivePeriodReadiness(params: {
  started: boolean
  alreadyInvoiced: boolean
  fixedBillingTimingResolved: boolean
  usage: UsageComponentState[]
  performance: PerformanceComponentState[]
}): PeriodReadinessState {
  if (params.alreadyInvoiced) return 'invoiced'
  if (!params.started) return 'upcoming'
  if (!params.fixedBillingTimingResolved) return 'fixed_billing_timing_required'
  if (params.usage.some(u => u.status === 'awaiting_source')) return 'parked'
  const missingOperationalInputs = params.performance.some(p => p.status === 'pending_operational_inputs')
  if (missingOperationalInputs) return 'waiting_for_operational_inputs'
  if (params.usage.some(u => u.status === 'pending_usage')) return 'waiting_for_usage'
  return 'ready_to_invoice'
}

export interface BillingPeriodWorkspace {
  period: BillingPeriodBounds
  readiness: PeriodReadinessState
  fixed: FixedComponentState
  usage: UsageComponentState[]
  performance: PerformanceComponentState[]
  // Human-readable labels for exactly what's blocking this period —
  // derived from the same usage/performance arrays above, never a second,
  // separately-maintained list.
  missingDependencies: string[]
  // Item 7 — null ("TBD") whenever any variable component for this period
  // isn't final yet; a number only once every usage component is 'computed'
  // and every performance component is 'computed'/'waived' (or there are
  // none at all).
  finalTotal: number | null
}

export function buildBillingPeriodWorkspace(params: {
  period: BillingPeriodBounds
  started: boolean
  alreadyInvoiced: boolean
  fixed: FixedComponentState
  usage: UsageComponentState[]
  performance: PerformanceComponentState[]
}): BillingPeriodWorkspace {
  const { period, started, alreadyInvoiced, fixed, usage, performance } = params
  const readiness = derivePeriodReadiness({
    started, alreadyInvoiced, usage, performance,
    fixedBillingTimingResolved: fixed.billingTiming.resolved,
  })

  const missingDependencies: string[] = []
  if (!fixed.billingTiming.resolved) missingDependencies.push('Fixed-fee billing timing — decision required')
  for (const u of usage) {
    if (u.status === 'awaiting_source') missingDependencies.push(`${u.label} — no confirmed usage source`)
    else if (u.status === 'pending_usage') missingDependencies.push(`${u.label} — usage not yet measured`)
  }
  for (const p of performance) {
    if (p.status === 'pending_operational_inputs') {
      for (const k of p.missingKeys ?? []) missingDependencies.push(k)
    }
  }

  const usageFinal = usage.every(u => u.status === 'computed')
  const performanceFinal = performance.every(p => p.status === 'computed' || p.status === 'waived')
  const finalTotal = started && usageFinal && performanceFinal
    ? Math.round((fixed.amount
        + usage.reduce((s, u) => s + (u.amount ?? 0), 0)
        + performance.reduce((s, p) => s + (p.amount ?? 0), 0)) * 100) / 100
    : null

  return { period, readiness, fixed, usage, performance, missingDependencies, finalTotal }
}
