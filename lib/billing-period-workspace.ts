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
import { buildPricingDependencyGroups, type PricingDependencyGroups, type PricingDependencyFee, type PricingDependencyTier } from './pricing-dependency'
import { hasContractStarted } from './performance-share-timing'
import type { UsageSourceCard } from './usage-source-cards'
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

// Step 17H.2B item 3/33 — a timeline entry sourced from a real
// planned_invoices 'period' row already KNOWS its own exact period_start/
// period_end (unlike deriveBillingPeriod, which computes the period
// CONTAINING an arbitrary asOf date) — this builds the identical
// BillingPeriodBounds shape from those known bounds, using the exact same
// label/anchorId formatting deriveBillingPeriod uses, so a period rendered
// via the enriched Billing Timeline is visually identical to the same
// period rendered by Billing Periods.
export function periodBoundsFromRange(startIso: string, endIso: string): BillingPeriodBounds {
  const start = new Date(startIso + 'T00:00:00')
  const end = new Date(endIso + 'T00:00:00')
  return { start: startIso, end: endIso, label: fmtRangeLabel(start, end), anchorId: `billing-period-${startIso.slice(0, 7)}` }
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
  // Step E8.3 §2 — the SAME FixedFeeBillingTimingRule.source_clause already
  // threaded into this function as billingTimingRule below; surfaced here
  // (not re-derived) so a presentation layer can show a real clause
  // reference instead of an empty-looking "CONTRACT CLAUSE" heading. null
  // when the rule itself has none — never fabricated.
  sourceClause?: string | null
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
  const sourceClause = billingTimingRule?.source_clause ?? null
  if (!terms.contract_start_date) return { amount: 0, currency, waived: false, billingTiming, sourceClause }
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
    sourceClause,
  }
}

// Step 17H.2B.2 item 12 — 'live_not_final' is its own distinct status, not
// a flag layered onto 'computed'. A reading against an OPEN measurement
// window (or sourced from the pricing-free measurement-only path — see
// lib/usage-measurement-summary.ts) is genuinely a DIFFERENT state from an
// authoritative closed-period measurement: it has a known quantity, but no
// authoritative amount and no eligibility to satisfy period finality. This
// is what makes finality (isUsageMeasurementFinal below) correct BY
// CONSTRUCTION rather than relying on a caller/renderer to remember to
// check an extra flag.
export type UsageComponentStatus = 'awaiting_source' | 'awaiting_period' | 'pending_usage' | 'live_not_final' | 'computed'

// Step 17H.2B.2 item 12 — the ONE generic finality predicate for a usage
// component. A component is final only once it has an authoritative
// closed-period measurement — never merely because SOME reading exists.
// Reused by buildBillingPeriodWorkspace's usageFinal/finalTotal gate and by
// derivePeriodReadiness, so there is exactly one place this rule is
// expressed, never re-derived ad hoc at each call site.
export function isUsageMeasurementFinal(u: { status: UsageComponentStatus }): boolean {
  return u.status === 'computed'
}

export interface UsageComponentState {
  key: string
  label: string
  semanticInputKey: string | null
  sourceName: string | null
  status: UsageComponentStatus
  quantity?: number | null
  // Step 17H.2B.2 items 6/10/11/15/21 — populated ONLY when status ===
  // 'computed' (a genuine closed-period, authoritative measurement).
  // Never populated for 'live_not_final' — a live/open-window quantity
  // must never carry a monetary amount, even informationally, so it can
  // never be summed into Known/Final totals or rendered as a pseudo-
  // invoice line by a caller that forgets to check status first.
  amount?: number | null
  formula?: string | null
  // Step 17H.2B.1 item 2/5/9 — the ACTUAL source this specific reading came
  // from (lib/usage-pull.ts / lib/per-unit-fee-pull.ts's own
  // OverageLineItem.metric_source), never re-derived from static contract
  // configuration. null when no reading exists yet to attribute.
  metricSource?: 'meter_pull' | 'client_pull' | 'manual_entry' | null
  // Step 17H.2B.1/2 item 2/9/10/11 — true exactly when status ===
  // 'live_not_final'. Preserved as a convenience flag for presentation
  // code that already branches on it (17H.2B.1), but it is no longer the
  // ONLY safeguard — status itself now distinguishes live from final, so
  // finality is enforced in the domain model, not just hidden in the UI.
  isLiveNotFinal?: boolean
}

export type PerformanceComponentStatus = 'not_started' | 'pending_operational_inputs' | 'computed' | 'waived'

export interface PerformanceComponentState {
  feeLabel: string
  // Step E9B — the fee's stable AdditionalRecurringFee.recurring_fee_id,
  // when the contract extraction/re-extraction assigned one; null/undefined
  // for older data that predates it. Consumers needing a stable identity
  // (e.g. lib/billing-period-card-summary.ts's DeferredItem.key) must
  // prefer this over feeLabel, which is mutable display text, not an id.
  recurringFeeId?: string | null
  status: PerformanceComponentStatus
  missingKeys?: string[]
  amount?: number | null
  contractStartDate?: string | null
  // Step 17H.4B0D4H1B4E2.3 §3/4 — the execution RESULT breakdown (input
  // values, calculated payment rate, calculated share), pass-through only:
  // read straight off the SAME PerformanceShareResultLike the standalone
  // (now-retired) top-level Performance Share display used to render —
  // never recomputed here. The contractual definition (charge basis,
  // rate-selection rule, full calculation chain) stays exclusively in
  // Commercial Logic & Billing Setup (lib/commercial-components.ts) — not
  // duplicated onto these fields.
  numeratorKey?: string
  numeratorValue?: number
  denominatorKey?: string
  denominatorValue?: number
  derivedPct?: number
  selectedRatePct?: number
  currency?: string
  // Step 17H.4B0D4H1B4E2.4 §7 — this fee's OWN invoice-timing decision
  // (lib/types.ts's variable_invoice_timing), independent of the fixed
  // component's own billingTiming above — a period can have a known fixed
  // invoice date while a percentage-of-basis fee's timing is still
  // undecided, or vice versa. Never folded into the fixed component's
  // single billingTiming flag, which previously left this fact silently
  // dropped once the standalone Performance Share display (the only place
  // that used to show it) was retired.
  timingUnresolved?: boolean
  // Step 17H.4B0D4H1B4E5.2 §7 — see PerformanceShareResultLike's identical
  // field/comment above; threaded straight through, same pass-through-only
  // discipline as every other field on this state.
  variableInvoiceTiming?: string | null
}

export type PeriodReadinessState =
  | 'upcoming'
  | 'fixed_billing_timing_required'
  | 'waiting_for_usage'
  | 'waiting_for_operational_inputs'
  | 'parked'
  | 'ready_to_invoice'
  | 'invoiced'

// Step 17H.2B item 33 — moved here (verbatim) from
// BillingPeriodWorkspaceCard.tsx so BillingSummaryCard.tsx's enriched
// recurring-period entries render the IDENTICAL label/color for a given
// readiness state — real field-parity, not just visually-similar
// independently-written copies. 'past' is not a PeriodReadinessState value
// itself; it's the same presentation override both callers apply when
// consumptionPeriodStatus === 'past' overrides an otherwise-'upcoming'
// readiness (see PeriodExecutionModel's own comment).
export const PERIOD_READINESS_LABEL: Record<PeriodReadinessState | 'past', { label: string; color: string; background: string }> = {
  upcoming:                       { label: 'Upcoming',                     color: '#6B7280', background: '#F3F4F6' },
  // Step 17F.3, item 3/14 — its own distinct label/state, never folded
  // into "Parked" — the fixed component's amount is known; only its
  // invoice DATE is unresolved.
  fixed_billing_timing_required:  { label: 'Billing timing: Decision required', color: '#B45309', background: '#FEF3C7' },
  waiting_for_usage:              { label: 'Waiting for usage',            color: '#7C3AED', background: '#F3E8FF' },
  // Step 17F.1, item 8 — displayed as "Parked" (the literal expected text
  // for "an applicable invoice component's required inputs are missing")
  // while the underlying readiness TYPE stays the distinct
  // 'waiting_for_operational_inputs' / 'missing_operational_input' (item
  // 10 requires these stay distinguishable from the narrower 'parked' —
  // no confirmed usage source at all — case). Display label only.
  waiting_for_operational_inputs: { label: 'Parked',                       color: '#B45309', background: '#FEF3C7' },
  parked:                         { label: 'Parked',                       color: '#DC2626', background: '#FEE2E2' },
  ready_to_invoice:                { label: 'Ready to invoice',            color: '#0B5C36', background: '#EEF9F2' },
  invoiced:                        { label: 'Invoiced',                    color: '#0B5C36', background: '#EEF9F2' },
  // Step 17F.8, item 14 — a genuinely past, already-closed period that
  // still has real usage figures but no separate "invoiced" signal wired
  // up in this pure model — distinct neutral label, never implying either
  // "ready" or "parked" for a period that has simply already happened.
  past:                            { label: 'Billed',                      color: '#27AE60', background: '#EEF9F2' },
}

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
  // Step 17H.2B.2 items 10/16 — a 'live_not_final' reading (open
  // measurement window, or sourced from the pricing-free measurement-only
  // path) blocks readiness exactly like 'pending_usage' does: usage
  // measurement for this period genuinely isn't done yet. A period must
  // never read 'ready_to_invoice' merely because a live meter/manual
  // reading currently exists — only once every usage component reaches a
  // real, authoritative closed-period measurement.
  if (params.usage.some(u => u.status === 'pending_usage' || u.status === 'live_not_final')) return 'waiting_for_usage'
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
    // Step 17H.2B.2 item 10/14 — a live/open reading is genuinely
    // different from "nothing measured yet": distinct wording so a
    // reviewer sees a live figure exists, just not yet final.
    else if (u.status === 'live_not_final') missingDependencies.push(`${u.label} — measurement period still open, not yet final`)
  }
  for (const p of performance) {
    if (p.status === 'pending_operational_inputs') {
      for (const k of p.missingKeys ?? []) missingDependencies.push(k)
    }
  }

  // Step 17H.2B.2 items 9/10/12/14/15 — isUsageMeasurementFinal is the ONE
  // predicate deciding whether a usage component's measurement is
  // authoritative enough to satisfy period finality. A 'live_not_final'
  // reading (open window, or sourced from the pricing-free measurement-only
  // path) NEVER satisfies it, regardless of whether it happens to carry a
  // quantity — this is what keeps Known amount / Final total from ever
  // being computed off a live, still-accumulating figure.
  const usageFinal = usage.every(isUsageMeasurementFinal)
  const performanceFinal = performance.every(p => p.status === 'computed' || p.status === 'waived')
  const finalTotal = started && usageFinal && performanceFinal
    ? Math.round((fixed.amount
        + usage.reduce((s, u) => s + (u.amount ?? 0), 0)
        + performance.reduce((s, p) => s + (p.amount ?? 0), 0)) * 100) / 100
    : null

  return { period, readiness, fixed, usage, performance, missingDependencies, finalTotal }
}

// Step 17H.4B0D4H1B4E2.4 §1-6/23 — a bare "Known amount: SEK 2,000.00" (the
// fixed component alone) reads as though it were the complete invoice
// total, and a waived fixed fee reads as a bare "SEK 0.00" with no
// indication that variable/performance charges may still apply. This is
// the presentation-only fix: a pure, typed derivation over the SAME
// workspace fields buildBillingPeriodWorkspace already computes (fixed.
// waived/amount, usage[].status via isUsageMeasurementFinal, performance[].
// status, finalTotal) — no new backend state, no label/text inference.
export type PeriodAmountLineStatus = 'known' | 'waived' | 'pending' | 'not_applicable'

export interface PeriodAmountLine {
  status: PeriodAmountLineStatus
  amount: number | null
}

export interface PeriodAmountPresentation {
  // Never conflated with the invoice total — a fixed fee is either a real
  // known amount, or contractually waived (amount 0 for a stated reason,
  // not "nothing configured").
  fixed: PeriodAmountLine
  // 'not_applicable' when this period has no usage components at all
  // (never shown as "pending" for a period that simply has none).
  variable: PeriodAmountLine
  // 'waived' distinct from 'known' — e.g. a pilot period where performance
  // is waived but still worth stating explicitly, not silently summed as
  // if it were a real computed 0.
  performance: PeriodAmountLine
  // The ONLY value ever presentable as "the invoice total" — final exactly
  // when workspace.finalTotal is non-null (every applicable component is
  // known/final), never a partial subtotal standing in for it.
  invoiceTotal: { status: 'final'; amount: number } | { status: 'not_final' }
}

export function derivePeriodAmountPresentation(workspace: Pick<BillingPeriodWorkspace, 'fixed' | 'usage' | 'performance' | 'finalTotal'>): PeriodAmountPresentation {
  const { fixed, usage, performance, finalTotal } = workspace

  const fixedLine: PeriodAmountLine = fixed.waived
    ? { status: 'waived', amount: 0 }
    : { status: 'known', amount: fixed.amount }

  const variableLine: PeriodAmountLine = usage.length === 0
    ? { status: 'not_applicable', amount: null }
    : usage.every(isUsageMeasurementFinal)
      ? { status: 'known', amount: usage.reduce((s, u) => s + (u.amount ?? 0), 0) }
      : { status: 'pending', amount: null }

  const performanceAllWaived = performance.length > 0 && performance.every(p => p.status === 'waived')
  const performanceLine: PeriodAmountLine = performance.length === 0
    ? { status: 'not_applicable', amount: null }
    : performanceAllWaived
      ? { status: 'waived', amount: 0 }
      : performance.every(p => p.status === 'computed' || p.status === 'waived')
        ? { status: 'known', amount: performance.reduce((s, p) => s + (p.amount ?? 0), 0) }
        : { status: 'pending', amount: null }

  const invoiceTotal: PeriodAmountPresentation['invoiceTotal'] = finalTotal != null
    ? { status: 'final', amount: finalTotal }
    : { status: 'not_final' }

  return { fixed: fixedLine, variable: variableLine, performance: performanceLine, invoiceTotal }
}

// Step 17H.2B item 3/33 — the ONE orchestrating derivation both Billing
// Periods (app/_components/BillingPeriodWorkspaceCard.tsx's PeriodCard) and
// the enriched Billing Timeline (BillingSummaryCard.tsx's recurring-period
// entries) call. Previously this exact sequence — group pricing
// dependencies, compute the fixed component, derive usage/performance
// component state, build the workspace — was written ONCE, inline inside
// PeriodCard. Extracting it here (verbatim, zero behavior change) is what
// makes a genuine field-parity comparison between the two surfaces possible
// during 17H.2B's side-by-side verification window: two independently
// re-written copies could silently drift; one shared function structurally
// cannot.
function findMatchingConsumptionItem(
  fact: { ratePerUnit: number },
  items: Array<{ rate_per_unit?: number; total_units: number; amount?: number; metric_source?: 'meter_pull' | 'client_pull' | 'manual_entry' }>,
): { rate_per_unit?: number; total_units: number; amount?: number; metric_source?: 'meter_pull' | 'client_pull' | 'manual_entry' } | null {
  return items.find(i => typeof i.rate_per_unit === 'number' && Math.abs(i.rate_per_unit - fact.ratePerUnit) < 1e-9) ?? null
}

function performanceStatusOf(r: {
  feeLabel: string
  recurringFeeId?: string | null
  status: 'ready' | 'waived' | 'not_ready' | 'invalid' | 'not_started'
  missingKeys?: string[]
  amount?: number
  numeratorKey?: string
  numeratorValue?: number
  denominatorKey?: string
  denominatorValue?: number
  derivedPct?: number
  selectedRatePct?: number
  currency?: string
  timingUnresolved?: boolean
  variableInvoiceTiming?: string | null
}): PerformanceComponentState {
  const status: PerformanceComponentState['status'] =
    r.status === 'ready' ? 'computed'
    : r.status === 'waived' ? 'waived'
    : r.status === 'not_started' ? 'not_started'
    : 'pending_operational_inputs'
  return {
    feeLabel: r.feeLabel, recurringFeeId: r.recurringFeeId ?? null, status, missingKeys: r.missingKeys, amount: r.amount,
    numeratorKey: r.numeratorKey, numeratorValue: r.numeratorValue,
    denominatorKey: r.denominatorKey, denominatorValue: r.denominatorValue,
    derivedPct: r.derivedPct, selectedRatePct: r.selectedRatePct, currency: r.currency,
    timingUnresolved: r.timingUnresolved, variableInvoiceTiming: r.variableInvoiceTiming,
  }
}

export interface ConsumptionPeriodLike {
  periodStart: string
  periodEnd: string
  status: 'past' | 'current' | 'pending' | 'future'
  overageItems: Array<{
    meter_key: string
    rate_per_unit?: number
    total_units: number
    // Step 17H.2B.2 items 3/9/11 — optional, deliberately: absent means
    // this item came from the pricing-free measurement-only path
    // (lib/usage-measurement-summary.ts) — quantity known, no commercial
    // calculation performed. Never treated as "amount happens to be 0";
    // absence and zero are kept distinct throughout.
    amount?: number
    description?: string
    // Step 17H.2B.1 — lib/usage-pull.ts's OverageLineItem.metric_source,
    // carried through so the UI can show the actual observed source
    // (meter vs manual) rather than only static contract configuration.
    metric_source?: 'meter_pull' | 'client_pull' | 'manual_entry'
  }>
  overageTotal: number
}

export interface PerformanceShareResultLike {
  feeLabel: string
  // Step E9B — see PerformanceComponentState's identical field/comment.
  recurringFeeId?: string | null
  status: 'ready' | 'waived' | 'not_ready' | 'invalid' | 'not_started'
  reason?: string
  missingKeys?: string[]
  amount?: number
  periodStart?: string | null
  // Step 17H.4B0D4H1B4E2.3 — same execution-result breakdown as
  // PerformanceComponentState above; threaded straight through from the
  // real GET /api/jobs/[id]/performance-share response, which always sets
  // these together with `amount` whenever status is 'ready'/'waived'.
  numeratorKey?: string
  numeratorValue?: number
  denominatorKey?: string
  denominatorValue?: number
  derivedPct?: number
  selectedRatePct?: number
  currency?: string
  // Step 17H.4B0D4H1B4E2.4 §7 — the real route (app/api/jobs/[id]/
  // performance-share/route.ts) always sets this per fee, independent of
  // status; threaded through so this fee's own timing decision is visible
  // inside Billing Timeline again (previously silently dropped once
  // PerformanceShareDisplay, the only prior consumer, was retired).
  variableInvoiceTimingUnresolved?: boolean
  // Step 17H.4B0D4H1B4E5.2 §7 — the raw confirmed timing value (never just
  // the derived unresolved boolean above), so a period entry can
  // distinguish "nothing chosen yet" from "reviewer chose the one
  // structured value with no execution path yet" (invoice_at_period_end —
  // see lib/rule-interpretation.ts's isVariableInvoiceTimingConfirmed).
  variableInvoiceTiming?: string | null
}

export interface PeriodExecutionModel {
  pricingGroups: PricingDependencyGroups
  workspace: BillingPeriodWorkspace
  started: boolean
  // Step 17F.8, item 14's "past" presentation override, preserved here so
  // both callers derive it identically: a period whose consumption-summary
  // status is 'past' (closed, AND the following period's invoice has
  // actually been sent) reads as "Billed" even when workspace.readiness
  // itself never resolved past 'upcoming' — distinct from the readiness
  // enum, which callers keep using for every other case.
  consumptionPeriodStatus: 'past' | 'current' | 'pending' | 'future' | null
}

export function derivePeriodExecutionModel(params: {
  terms: ContractTerms
  currency: string
  usageSourceCards: UsageSourceCard[]
  period: BillingPeriodBounds
  consumptionPeriod: ConsumptionPeriodLike | null
  performanceShareResults: PerformanceShareResultLike[] | null
}): PeriodExecutionModel {
  const { terms, currency, usageSourceCards, period, consumptionPeriod, performanceShareResults } = params
  const started = hasContractStarted(terms.contract_start_date)

  const pricingGroups = buildPricingDependencyGroups({
    baseMonthlyFee: terms.base_monthly_fee,
    fees: (terms.additional_recurring_fees ?? []) as PricingDependencyFee[],
    tiers: (terms.overage_tiers ?? []) as PricingDependencyTier[],
    usageSources: usageSourceCards,
  })
  const additionalFixedFeesTotal = pricingGroups.fixed.filter(f => f.key !== 'base_monthly_fee').reduce((s, f) => s + f.amount, 0)
  const fixed = computeFixedComponentForPeriod({
    terms, periodStart: period.start, additionalFixedFeesTotal, currency,
    billingTimingRule: terms.fixed_fee_billing_timing,
  })

  const usage: UsageComponentState[] = pricingGroups.usageMeter.map(fact => {
    if (!started) return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: fact.sourceName, status: 'awaiting_period' }
    if (!fact.sourceName) return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: null, status: 'awaiting_source' }
    if (consumptionPeriod === null) return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: fact.sourceName, status: 'pending_usage' }
    const item = findMatchingConsumptionItem(fact, consumptionPeriod.overageItems)
    if (!item) return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: fact.sourceName, status: 'pending_usage' }
    // Step 17H.2B.2 items 9/10/11/15 — 'live_not_final' whenever EITHER
    // the measurement window is still open, OR the item carries no amount
    // at all (the pricing-free measurement-only path never computes one).
    // Either condition alone is sufficient — this is what makes finality
    // correct even if some future caller passes an amount-bearing item for
    // an open window: the window's own openness is still authoritative.
    const isLive = consumptionPeriod.status === 'current' || item.amount == null
    return {
      key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: fact.sourceName,
      status: isLive ? 'live_not_final' : 'computed',
      quantity: item.total_units,
      // Never populated for a live/not-final reading (item 15) — only a
      // genuine closed-period measurement carries an authoritative amount.
      amount: isLive ? undefined : item.amount,
      metricSource: item.metric_source ?? null,
      isLiveNotFinal: isLive,
    }
  })

  // Real figures only ever attributed to the period they were actually
  // computed for (GET /performance-share resolves ONE most-recent period
  // with recorded data) — a result is only ever attributed to a period
  // whose own periodStart it genuinely matches, or to a not-yet-started
  // period when the result itself says 'not_started'. Every other period
  // falls back to its OWN started-derived generic pending/not_started
  // state — never borrowing one period's real figures for a different one.
  const resultsForThisPeriod = performanceShareResults?.filter(r =>
    r.periodStart === period.start || (r.status === 'not_started' && !started),
  ) ?? null
  const performance: PerformanceComponentState[] = resultsForThisPeriod && resultsForThisPeriod.length > 0
    ? resultsForThisPeriod.map(r => performanceStatusOf({ ...r, timingUnresolved: r.variableInvoiceTimingUnresolved }))
    : pricingGroups.performanceBased.map(p => ({ feeLabel: p.label, recurringFeeId: p.recurringFeeId ?? null, status: started ? 'pending_operational_inputs' as const : 'not_started' as const }))

  const workspace = buildBillingPeriodWorkspace({
    period, started, alreadyInvoiced: consumptionPeriod?.status === 'past', fixed, usage, performance,
  })

  return { pricingGroups, workspace, started, consumptionPeriodStatus: consumptionPeriod?.status ?? null }
}
