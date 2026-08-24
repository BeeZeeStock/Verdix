import { ContractTerms, PeriodProrationRule } from './types'
import { billingInterval } from './stripe-meter'
import { supabaseServer } from './supabase'
import { monthCursor, enumerateContractWindows, isPartialWindow } from './tariff'
import { resolveVatTreatment, computeVat, type VatMode, type VatTreatment } from './vat'
import { getCustomerVatConfig } from './vat-service'
import { isOneTimeFeeHeldForExecution, type OperationalEventEvidence } from './operational-event-evidence'
import { buildBillingPlanSnapshot, fingerprintBillingPlan, fingerprintValue, planComponentKey, excludePriorSnapshotFromAlreadySent, type BillingPlanLineInstruction, type BillingPlanSnapshot } from './billing-execution-plan'
import {
  deriveIdempotencyKey, operationKeyFor, classifyStripeFailure, classifyFetchOutcome, BillingPreconditionError,
  canSafelyRetryBillingOperation, STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS,
  type BillingOperationRetryCapability, type BillingExecutionAttempt, type BillingExecutionOperation,
} from './billing-execution-attempt'
import {
  getOrCreateAttempt, markAttemptExecuting, markAttemptStatus,
  getOrCreateOperation, markOperationStarted, markOperationSucceeded, markOperationFailedSafe, markOperationOutcomeUncertain,
} from './billing-execution-store'
import { deriveTerminalSettlementTarget } from './terminal-settlement'

// Re-exported so existing importers of monthCursor from this file (e.g.
// execute/route.ts) don't need to change their import path — the function
// itself now lives in lib/tariff.ts so client components can share it too
// without pulling in this file's supabaseServer import.
export { monthCursor }

// Compute all billing periods for the contract term with their base amounts
// (base fee + additional recurring fees, no overages). Used at push time to
// populate planned_invoices and by the scheduler to understand the schedule.
interface BillingPeriod {
  yearNum: number
  periodIndex: number
  periodStart: Date
  periodEnd: Date
  baseAmount: number
}

// Which rate applies to a given month — ramp schedule → year pricing → flat
// base fee, in that priority order. No escalation, no additions, no discount;
// callers compose those on top. Exported so buildLineItems() (contract
// execute route) can generate real per-year recurring-fee line items using
// the exact same rate logic as the actual billing schedule, instead of a
// separate, potentially-inconsistent approximation.
export function computeMonthlyBaseRate(terms: ContractTerms, globalMonthIdx: number, d: Date): number {
  const yearPricing  = terms.year_pricing
  const rampSchedule = terms.ramp_schedule?.length ? terms.ramp_schedule : null
  const baseAnnualFallback = terms.base_annual_fee ?? 0
  const baseMonthly = terms.base_monthly_fee
    ?? (baseAnnualFallback > 0 && !yearPricing && !rampSchedule ? baseAnnualFallback / 12 : 0)

  if (rampSchedule) {
    for (const step of rampSchedule) {
      // Bare date-only strings ("2024-04-01") parse as UTC midnight, while d
      // (the per-month cursor, built via `new Date(y, m, 1)`) is local
      // midnight — in any timezone east of UTC those disagree by several
      // hours, so the *first* day of every ramp step failed its own
      // `d >= s` check and silently fell through to the wrong rate.
      // Anchoring both to local midnight keeps this correct regardless of
      // which timezone the code happens to run in.
      const s = new Date(step.start_date + 'T00:00:00'), e = new Date(step.end_date + 'T00:00:00')
      if (d >= s && d <= e) return step.monthly_fee
    }
    return rampSchedule[rampSchedule.length - 1].monthly_fee
  }
  if (yearPricing) {
    const yr   = Math.floor(globalMonthIdx / 12) + 1
    const key  = `year${yr}`
    const keys = Object.keys(yearPricing)
    return (yearPricing[key] ?? yearPricing[keys[keys.length - 1]] ?? 0) / 12
  }
  return baseMonthly
}

// Compound escalation multiplier for a given month. Only applies when neither
// ramp_schedule nor year_pricing is set (those already encode their own
// step-ups). Exported alongside computeMonthlyBaseRate for the same reason.
export function computeEscalatorMultiplier(terms: ContractTerms, d: Date): number {
  if (terms.year_pricing || terms.ramp_schedule?.length) return 1
  for (const esc of terms.escalators ?? []) {
    // A discretionary clause ("may be increased") must never silently
    // compound — only an interpretation explicitly confirmed 'automatic'
    // authorizes the calculation engine to apply it. Missing/undefined
    // discretion (rows written before this field existed, or an escalator
    // with no interpretation at all yet) reads as 'automatic' to preserve
    // existing behavior for already-confirmed escalators.
    const discretion = esc.interpretation?.discretion ?? 'automatic'
    if (discretion !== 'automatic') continue

    const ed = esc.effective_date ? new Date(esc.effective_date + 'T00:00:00') : null
    if (ed && d >= ed) {
      // Renewal-triggered indexation (e.g. "on renewal, HICP + cap") is a
      // step applied once at each renewal event, not a recurring intra-term
      // compound — the existing 12-month compounding below is only correct
      // once d has actually reached a renewal boundary, which `d >= ed`
      // already gates on (effective_date is the first possible renewal
      // date). No additional cadence change needed here: renewal_triggered
      // exists to keep effective_date from being misread as an ordinary
      // annual-escalator start during the original term elsewhere in the
      // pipeline (extraction/interpretation), not to alter this compounding
      // math once a genuine renewal boundary has been confirmed reached.
      const ms = (d.getFullYear() - ed.getFullYear()) * 12 + (d.getMonth() - ed.getMonth())
      return Math.pow(1 + (esc.escalator_pct ?? 0) / 100, Math.floor(ms / 12) + 1)
    }
  }
  return 1
}

// Discount multiplier for a given month — 1 (no discount) unless d falls
// within a dated discount window. Exported alongside computeMonthlyBaseRate/
// computeEscalatorMultiplier so buildLineItems (contract execute route) can
// apply the same discount a real invoice would get; previously it ignored
// discounts entirely, so a contract with an intro discount showed a Base TCV
// higher than what actually got billed.
export function computeDiscountMultiplier(terms: ContractTerms, d: Date): number {
  for (const disc of terms.discounts ?? []) {
    // Same local-midnight anchoring as the ramp/escalator dates above.
    const ds = disc.start_date ? new Date(disc.start_date + 'T00:00:00') : null
    const de = disc.end_date   ? new Date(disc.end_date   + 'T00:00:00') : null
    if (ds && de && d >= ds && d <= de && disc.discount_pct) {
      return 1 - disc.discount_pct / 100
    }
  }
  return 1
}

// Scales a full-period component amount for a partial calendar window per
// the confirmed (or not-yet-confirmed) PeriodProrationRule — the exact same
// three-way answer lib/tariff.ts's resolveWindowMinimum already applies to a
// metric's minimum commitment, generalized to a base/recurring fee. Never
// silently assumes full-charge or proration while unresolved: an unconfirmed
// rule withholds this component's contribution for the partial window
// entirely (mirrors lib/usage-pull.ts's identical withhold-not-guess
// treatment of an unconfirmed minimum commitment) rather than guessing
// either extreme.
function applyProrationRule(
  fullAmount: number,
  rule: PeriodProrationRule | null | undefined,
  overlapDays: number,
  windowDays: number,
): number {
  if (!rule) return fullAmount // no stated calendar-boundary ambiguity for this component
  if (rule.requires_confirmation) return 0
  if (rule.prorate_partial_periods === true) return fullAmount * (overlapDays / windowDays)
  return fullAmount // prorate_partial_periods === false — bill the partial period in full, as confirmed
}

function computeBillingSchedule(terms: ContractTerms): BillingPeriod[] {
  const cs = terms.contract_start_date
    ? new Date(terms.contract_start_date + 'T00:00:00')
    : new Date()

  // Prefer explicit term months; fall back to computing from start/end dates.
  let termMonths = terms.contract_term_months ?? 0
  if (!termMonths && terms.contract_end_date) {
    const ce = new Date(terms.contract_end_date + 'T00:00:00')
    termMonths = (ce.getFullYear() - cs.getFullYear()) * 12 + (ce.getMonth() - cs.getMonth()) + 1
  }
  if (!termMonths) return []

  const { interval, intervalCount } = billingInterval(terms.billing_frequency)
  const monthsPerPeriod = interval === 'year' ? 12 * intervalCount : intervalCount

  const additionalFees = terms.additional_recurring_fees ?? []
  const additionalMonthly = additionalFees.reduce((s, f) => s + (f.amount ?? 0), 0)

  // Same "exclusive nextStart minus 1 day" convention as every period
  // boundary this function has always produced — the contract's own defined
  // end date, used to bound the calendar-anchored path below.
  const contractEnd = new Date(cs.getFullYear(), cs.getMonth() + termMonths, cs.getDate() - 1)

  const periods: BillingPeriod[] = []

  // Calendar-anchored base/recurring fees: base_fee_proration's mere
  // presence does NOT by itself mean calendar-boundary billing — it can
  // equally hold a reviewer-confirmed reset_anchor of 'contract_start' (via
  // the "Full fee per contract month" review option), which means periods
  // follow the contract's own start-date anniversary and no partial period
  // ever occurs, exactly like the plain path below with no proration rule
  // at all. Only reset_anchor === 'calendar' actually changes the window
  // engine used — gating on presence alone previously ran calendar-anchored
  // windows even after a reviewer explicitly confirmed contract-month
  // billing, silently overriding their decision. Reuses the exact window
  // engine real billing already relies on for the identical problem on a
  // metric minimum (enumerateContractWindows/isPartialWindow) rather than a
  // second, parallel date calculation.
  if (terms.base_fee_proration && terms.base_fee_proration.reset_anchor === 'calendar') {
    const windows = enumerateContractWindows(cs, contractEnd, terms.billing_frequency, 'calendar')
    let periodIdx  = 0
    let monthsUsed = 0

    for (const w of windows) {
      const partial = isPartialWindow(w, cs, contractEnd)
      const monthsInThisWindow = Math.min(monthsPerPeriod, termMonths - monthsUsed)
      const overlapStart = w.start < cs ? cs : w.start
      const overlapEnd   = w.end   > contractEnd ? contractEnd : w.end
      const overlapDays  = Math.max(0, Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 86_400_000) + 1)
      const windowDays   = Math.max(1, Math.round((w.end.getTime() - w.start.getTime()) / 86_400_000) + 1)

      let baseAmount = 0
      for (let mi = 0; mi < monthsInThisWindow; mi++) {
        const globalMonthIdx = monthsUsed + mi
        const d        = monthCursor(cs, globalMonthIdx)
        const base     = computeMonthlyBaseRate(terms, globalMonthIdx, d)
        const escMult  = computeEscalatorMultiplier(terms, d)
        const discMult = computeDiscountMultiplier(terms, d)

        const baseContribution = partial
          ? applyProrationRule(base, terms.base_fee_proration, overlapDays, windowDays)
          : base
        // additional_recurring_fees don't share the base fee's proration
        // rule — each fee states (or omits) its own. A fee with no
        // proration entry has no stated calendar-boundary ambiguity and
        // bills in full even inside a partial window, same as today.
        const feesContribution = additionalFees.reduce((s, f) => {
          const feeAmt = f.amount ?? 0
          return s + (partial ? applyProrationRule(feeAmt, f.proration, overlapDays, windowDays) : feeAmt)
        }, 0)

        baseAmount += (baseContribution + feesContribution) * escMult * discMult
      }

      periods.push({
        yearNum: Math.floor(monthsUsed / 12) + 1,
        periodIndex: periodIdx,
        periodStart: overlapStart,
        periodEnd: overlapEnd,
        baseAmount: Math.round(baseAmount * 100) / 100,
      })
      periodIdx++
      monthsUsed += monthsInThisWindow
    }

    return periods
  }

  const additionalMonthlyFlat = additionalMonthly
  const periodsFlat: BillingPeriod[] = []
  let periodIdx  = 0
  let monthsUsed = 0

  while (monthsUsed < termMonths) {
    const monthsInThisPeriod = Math.min(monthsPerPeriod, termMonths - monthsUsed)

    const periodStart = new Date(
      cs.getFullYear(),
      cs.getMonth() + monthsUsed,
      cs.getDate(),
    )
    const nextStart = new Date(
      cs.getFullYear(),
      cs.getMonth() + monthsUsed + monthsInThisPeriod,
      cs.getDate(),
    )
    const periodEnd = new Date(nextStart.getTime() - 86_400_000)

    const yearNum = Math.floor(monthsUsed / 12) + 1

    let baseAmount = 0
    for (let mi = 0; mi < monthsInThisPeriod; mi++) {
      const globalMonthIdx = monthsUsed + mi
      const d    = monthCursor(cs, globalMonthIdx)
      const base    = computeMonthlyBaseRate(terms, globalMonthIdx, d)
      const escMult = computeEscalatorMultiplier(terms, d)
      const discMult = computeDiscountMultiplier(terms, d)

      baseAmount += (base + additionalMonthlyFlat) * escMult * discMult
    }

    periodsFlat.push({ yearNum, periodIndex: periodIdx, periodStart, periodEnd, baseAmount })
    periodIdx++
    monthsUsed += monthsInThisPeriod
  }

  return periodsFlat
}

export type BillingPlatform = 'stripe' | 'chargebee' | 'remembill'

export async function getOrgConfig(orgId: string, connector: string): Promise<Record<string, string> | null> {
  const { data } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', orgId)
    .eq('connector_name', connector)
    .eq('is_active', true)
    .single()
  return (data?.config as Record<string, string>) ?? null
}

async function detectOrgPlatform(orgId: string): Promise<BillingPlatform> {
  // Only a fallback for a job that's never been configured before — approve
  // always passes the job's own already-known platform when one exists, so
  // this only runs on first configuration. Still, an org can have more than
  // one active billing connector (e.g. testing a migration), and without an
  // explicit priority the previous .limit(1) picked whichever row Postgres
  // happened to return first — non-deterministic. Fetch all and apply a
  // fixed, explicit priority instead.
  const { data } = await supabaseServer
    .from('org_integrations')
    .select('connector_name')
    .eq('org_id', orgId)
    .eq('connector_type', 'billing')
    .eq('is_active', true)
  const active = new Set((data ?? []).map(r => r.connector_name as string))
  if (active.has('chargebee')) return 'chargebee'
  if (active.has('remembill')) return 'remembill'
  return 'stripe'
}

export interface LineItemInput {
  id?: string
  product_name: string
  quantity: number
  unit_price: number
  billing_period: string
  total_amount: number
  currency: string
  source_section?: string
}

// One-time fees are matched to their approved line_items row by product_name
// (buildLineItems sets product_name = fee_label for one-time fees). Falls
// back to null (caller uses the raw contract-terms amount) when not found —
// e.g. a fee added to the contract after line_items was last generated.
function findOneTimeLineItem(lineItems: LineItemInput[], feeLabel: string): LineItemInput | null {
  return lineItems.find(li => li.billing_period === 'one_time' && li.product_name === feeLabel) ?? null
}

export interface ConfigureResult {
  platform: BillingPlatform
  subscriptionId: string | null
  customerId: string
  lineItemCount: number
  dashboardUrl: string
}

export async function configureBilling(
  terms: ContractTerms,
  lineItems: LineItemInput[],
  platform: BillingPlatform | undefined,
  // Step 14 — required, not optional: every attempt/operation record is
  // scoped to a real job and org (never a client-supplied identity — both
  // always come from approve/route.ts's session-derived org and the job it
  // already loaded). configureChargebee alone still accepts these as
  // optional internally — Chargebee is unchanged, out of Step 14's scope.
  jobId: string,
  orgId: string,
  existingCustomerId?: string,
  // Step 13 — real operational_event_evidence rows for this job, when the
  // caller has them (approve/route.ts loads them via supabaseServer).
  // Defaults to [] so every pre-existing caller keeps exact Step 12
  // behavior: an event-conditioned fee with no evidence known to this call
  // stays held/parked, never auto-invoiced — the safe default.
  operationalEventEvidence: OperationalEventEvidence[] = [],
): Promise<ConfigureResult> {
  const resolved = platform ?? (await detectOrgPlatform(orgId))
  if (resolved === 'chargebee')  return configureChargebee(terms, lineItems, jobId, orgId)
  if (resolved === 'remembill')  return configureRememhill(terms, lineItems, jobId, orgId, existingCustomerId, operationalEventEvidence)
  return configureStripe(terms, lineItems, jobId, orgId, operationalEventEvidence)
}

// ── Step 14 shared operation-execution helper ───────────────────────────────
// Runs one tracked, idempotency-keyed provider side effect. Handles the
// full get-or-create-operation / persist-immediately-on-success /
// classify-and-persist-on-failure lifecycle (items 5, 10, 14) identically
// for every Stripe and Remembill operation, so that logic exists in exactly
// one place rather than being re-implemented per call site.
//
// Retry semantics on re-entry (item 16 case A, "safe idempotent resume",
// and the Step 14 final amendment's items 5-9, time-bounded idempotency):
//   - status 'succeeded'        -> return the cached externalObjectId,
//                                   never call the provider again.
//   - status 'outcome_uncertain' -> gated through
//                                   canSafelyRetryBillingOperation(op, now),
//                                   not just a static capability check:
//                                   'idempotent_retry' is only safe to
//                                   replay with the SAME idempotency key
//                                   while still inside the provider's own
//                                   retention window (Stripe: ~23h,
//                                   conservative under its documented
//                                   ~24h) — past it, or for any other
//                                   capability, this refuses and requires
//                                   explicit admin reconciliation first
//                                   (item 16 case B / the final
//                                   amendment's degrade-to-manual rule),
//                                   which flips status away from
//                                   outcome_uncertain before this can run
//                                   again.
//   - status 'pending'/'started'/'failed_safe'
//                               -> attempt (or re-attempt) execution now.
//                                   'failed_safe' means "confirmed nothing
//                                   was created" — safe to simply try
//                                   again once whatever caused it is
//                                   addressed.
async function runTrackedOperation(params: {
  attemptId: string
  provider: 'stripe' | 'remembill'
  operationType: string
  componentKey?: string
  requestFingerprint: string
  retryCapability: BillingOperationRetryCapability
  execute: (idempotencyKey: string) => Promise<string | null>
  classifyFailure: (err: unknown) => 'failed_safe' | 'outcome_uncertain'
  errorClassOf: (err: unknown) => string
}): Promise<string | null> {
  const { attemptId, provider, operationType, componentKey, requestFingerprint, retryCapability, execute, classifyFailure, errorClassOf } = params
  const operationKey = operationKeyFor(operationType, componentKey)
  const idempotencyKey = deriveIdempotencyKey(attemptId, provider, operationType, componentKey)
  const op = await getOrCreateOperation({ attemptId, operationKey, operationType, idempotencyKey, requestFingerprint, retryCapability })

  if (op.status === 'succeeded') return op.externalObjectId
  if (op.status === 'outcome_uncertain' && !canSafelyRetryBillingOperation(op, new Date())) {
    const windowNote = op.retryCapability === 'idempotent_retry'
      ? ` (its ${STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS}h provider idempotency-retention window has elapsed since it was first attempted)`
      : ''
    throw new Error(`Operation ${operationKey} has an uncertain outcome (capability: ${op.retryCapability})${windowNote} — requires admin verification before it can proceed. See POST /api/jobs/[id]/reconcile-billing-operation.`)
  }

  await markOperationStarted(op.id, op.startedAt === null)
  try {
    const externalObjectId = await execute(idempotencyKey)
    await markOperationSucceeded(op.id, externalObjectId)
    return externalObjectId
  } catch (err) {
    const classification = classifyFailure(err)
    const errorClass = errorClassOf(err)
    if (classification === 'failed_safe') await markOperationFailedSafe(op.id, errorClass)
    else await markOperationOutcomeUncertain(op.id, errorClass)
    throw err
  }
}

function stripeErrorClassOf(err: unknown): string {
  const e = err as { type?: string; code?: string } | null
  return e?.type ? `${e.type}${e.code ? `:${e.code}` : ''}` : (err instanceof Error ? err.constructor.name : 'unknown_error')
}

function fetchErrorClassOf(err: unknown, httpStatus?: number): string {
  if (httpStatus) return `http_${httpStatus}`
  return err instanceof Error ? err.constructor.name : 'unknown_error'
}

async function configureStripe(
  terms: ContractTerms,
  lineItems: LineItemInput[],
  jobId: string,
  orgId: string,
  operationalEventEvidence: OperationalEventEvidence[] = [],
): Promise<ConfigureResult> {
  const { default: Stripe } = await import('stripe')
  const orgConfig = await getOrgConfig(orgId, 'stripe')
  const stripeKey = orgConfig?.secret_key ?? process.env.STRIPE_SECRET_KEY!
  const stripe    = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

  const cur         = (terms.currency ?? 'EUR').toLowerCase()
  const contractId  = terms.contract_id ?? jobId
  const daysUntilDue = terms.payment_terms_days ?? 30
  const now          = new Date()
  const isTestKey    = stripeKey.includes('_test_')

  const fmtLabel  = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  const formatDate = (d: Date) => {
    const y   = d.getFullYear()
    const mo  = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${day}`
  }

  type PlannedRow = {
    job_id?: string; org_id?: string
    year_num: number | null; period_start: string; period_end: string
    base_amount: number; currency: string; fee_label: string | null
    invoice_type: string; status: string
    stripe_invoice_id: string | null; stripe_invoice_url: string | null
    sent_at: string | null
    line_item_id?: string | null; quantity?: number | null; unit_price?: number | null
    // Populated ONLY for a parked, event-gated one-time fee (see the
    // one_time_fees/isHeld loop below) — the sole discriminator
    // app/api/admin/invoice-scheduler/route.ts uses to later find this row
    // once matching evidence exists. Never set for a legacy manual_trigger
    // parked fee, which stays exclusively human-driven via
    // POST /parked-invoices, unaffected by that new path.
    fee_id?: string | null
    // Only set for invoice_type='terminal_settlement' — see
    // lib/terminal-settlement.ts. period_start/period_end on that row are
    // the TRIGGER date (day after the contract's real final period ends);
    // these two carry the actual settlement-target identity.
    settlement_period_start?: string | null
    settlement_period_end?: string | null
  }

  // Idempotent repush: carry forward already-sent invoices unchanged, and
  // clear stale not-yet-sent rows before regenerating — otherwise every
  // repush (e.g. re-syncing edited terms, or a platform switch) both
  // creates a second real Stripe invoice for any period that's already due
  // and leaves the first set of planned_invoices rows in place, duplicating
  // the billing schedule. Mirrors configureRememhill's existing pattern.
  const { data: sent } = await supabaseServer
    .from('planned_invoices')
    .select('year_num, period_start, period_end, invoice_type, fee_label, stripe_invoice_id, stripe_invoice_url, base_amount, currency, sent_at, status')
    .eq('job_id', jobId)
    .in('status', ['sent', 'paid'])
  const sentRows = sent ?? []
  const alreadySentKeys = new Set(sentRows.map(r => planComponentKey({
    invoice_type: r.invoice_type, year_num: r.year_num, period_start: r.period_start, fee_label: r.fee_label,
  })))

  const { error: cleanErr } = await supabaseServer
    .from('planned_invoices')
    .delete()
    .eq('job_id', jobId)
    .in('status', ['scheduled', 'parked', 'processing', 'draft'])
  if (cleanErr) console.error('[billing-writer/stripe] stale planned_invoices cleanup failed', cleanErr)

  // Step 14, item 3 — the deterministic snapshot of everything that needs
  // to be sent RIGHT NOW, built before any external call. The Stripe path
  // has never set per-line VAT (Stripe Tax/manual are out of scope here,
  // unchanged) — vat stays a fixed 'not_configured' placeholder in the
  // Stripe snapshot rather than a real resolved treatment.
  const snapshot = buildBillingPlanSnapshot({
    terms, lineItems, evidence: operationalEventEvidence, alreadySentKeys, provider: 'stripe',
    vat: { mode: 'not_configured', ratePct: null }, now, computeBillingSchedule,
  })
  const fingerprint = fingerprintBillingPlan(snapshot)
  // Step 14 final state-integrity correction — see getOrCreateAttempt's own
  // param doc. Only invoked for a prior attempt whose every operation
  // succeeded; reconstructs "what the plan would fingerprint as right now
  // if THAT attempt's own already-sent lines were still pending", so a
  // changed-commercial-data comparison isn't confounded by that attempt's
  // own success having drained alreadySentKeys.
  // TODO(follow-up): currently verified only via live integration
  // (real Stripe test-mode execution + real planned_invoices state), not
  // a permanent automated regression — extract as much of this
  // reconstruction/comparison as practical into a deterministic,
  // DB-free test seam. Logged per explicit instruction not to hold the
  // Step 14 commit for it.
  const recomputeFingerprintExcludingPriorSnapshot = (priorSnapshot: BillingPlanSnapshot): string => {
    const reducedAlreadySentKeys = excludePriorSnapshotFromAlreadySent(alreadySentKeys, priorSnapshot)
    const counterfactual = buildBillingPlanSnapshot({
      terms, lineItems, evidence: operationalEventEvidence, alreadySentKeys: reducedAlreadySentKeys, provider: 'stripe',
      vat: { mode: 'not_configured', ratePct: null }, now, computeBillingSchedule,
    })
    return fingerprintBillingPlan(counterfactual)
  }
  const attempt = await getOrCreateAttempt({ orgId, jobId, provider: 'stripe', fingerprint, snapshot, recomputeFingerprintExcludingPriorSnapshot })
  await markAttemptExecuting(attempt.id)

  try {
    // ── Op: resolve customer (search is read-only/best-effort; the actual
    // create-or-update call is the tracked, idempotency-keyed side effect) ──
    const emailInContact = terms.billing_contact?.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0]
    const billingEmail   = emailInContact
      ?? `billing@${(terms.customer_name ?? 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.com`
    const safeName = (terms.customer_name ?? '').replace(/'/g, "\\'")
    const customerFields = {
      name:     terms.customer_name ?? undefined,
      email:    billingEmail,
      address:  terms.customer_address ? { line1: terms.customer_address } : undefined,
      metadata: { contract_id: contractId, source: 'verdix' },
    }
    const customerId = (await runTrackedOperation({
      attemptId: attempt.id, provider: 'stripe', operationType: 'resolve_customer',
      requestFingerprint: fingerprintValue(customerFields),
      // Item 7 — a real Stripe request-level idempotencyKey now backs this
      // call (added below), so a same-key retry is Stripe's own guarantee,
      // not a local heuristic — idempotent_retry, not merely reconcilable.
      retryCapability: 'idempotent_retry',
      classifyFailure: classifyStripeFailure, errorClassOf: stripeErrorClassOf,
      execute: async (idempotencyKey) => {
        const existing = safeName
          ? await stripe.customers.search({ query: `name:'${safeName}'`, limit: 1 }).catch(() => ({ data: [] }))
          : { data: [] }
        const found = existing.data[0]
        const customer = found
          ? await stripe.customers.update(found.id, customerFields, { idempotencyKey })
          : await stripe.customers.create(customerFields, { idempotencyKey })
        return customer.id
      },
    })) as string
    const isTest = isTestKey

    // ── Due-now operations: create_invoice -> create_invoice_item -> finalize_invoice, per line ──
    for (const line of snapshot.lines) {
      const description = line.kind === 'period'
        ? (() => {
            const [yearNumStr, periodIndexStr] = line.componentKey.split(':').slice(1)
            const period = computeBillingSchedule(terms).find(p => p.yearNum === Number(yearNumStr) && p.periodIndex === Number(periodIndexStr))!
            return `Base subscription — Year ${period.yearNum} (${fmtLabel(period.periodStart)} – ${fmtLabel(period.periodEnd)})`
          })()
        : (line.unitPrice != null
            ? `${line.componentKey.slice(4)} — ${line.quantity.toLocaleString()} × ${cur.toUpperCase()} ${line.unitPrice.toLocaleString()}`
            : line.componentKey.slice(4))

      const invMetadata = {
        verdix_job: jobId, verdix_contract: contractId,
        invoice_type: line.kind === 'period' ? 'period' : 'one_time',
        fee_type: line.kind === 'one_time_fee' ? 'one_time' : '',
        fee_label: line.kind === 'one_time_fee' ? line.componentKey.slice(4) : '',
        scheduled_date: line.dueDate ?? '',
      }
      const days = line.kind === 'period'
        ? daysUntilDue
        : (() => {
            const feeDueDate = line.dueDate ? new Date(line.dueDate + 'T00:00:00') : null
            const feeDueDaysFromNow = feeDueDate ? Math.ceil((feeDueDate.getTime() - Date.now()) / 86_400_000) : 0
            return feeDueDaysFromNow > 1 ? feeDueDaysFromNow : (terms.payment_terms_days ?? 30)
          })()

      const invoiceId = await runTrackedOperation({
        attemptId: attempt.id, provider: 'stripe', operationType: 'create_invoice', componentKey: line.componentKey,
        requestFingerprint: fingerprintValue({ customerId, days, invMetadata }),
        retryCapability: 'idempotent_retry', classifyFailure: classifyStripeFailure, errorClassOf: stripeErrorClassOf,
        execute: async (idempotencyKey) => {
          const inv = await stripe.invoices.create({
            customer: customerId, collection_method: 'send_invoice', days_until_due: days,
            pending_invoice_items_behavior: 'exclude', metadata: invMetadata,
          }, { idempotencyKey })
          return inv.id
        },
      }) as string

      await runTrackedOperation({
        attemptId: attempt.id, provider: 'stripe', operationType: 'create_invoice_item', componentKey: line.componentKey,
        requestFingerprint: fingerprintValue({ invoiceId, amount: line.amount, currency: line.currency, description }),
        retryCapability: 'idempotent_retry', classifyFailure: classifyStripeFailure, errorClassOf: stripeErrorClassOf,
        execute: async (idempotencyKey) => {
          const item = await stripe.invoiceItems.create({
            customer: customerId, invoice: invoiceId, amount: Math.round(line.amount * 100), currency: cur, description,
          }, { idempotencyKey })
          return item.id
        },
      })

      // Item 7 — the previous code silently swallowed EVERY finalizeInvoice
      // failure (`.catch(err => { console.error(...); return inv })`),
      // treating a genuinely failed/uncertain finalize as if it had
      // succeeded, using the stale unfinalized invoice object. That is
      // exactly the "silently misclassify an ambiguous outcome as success"
      // failure mode Step 14 exists to close — errors now propagate through
      // the same classify-and-persist path as every other operation.
      let hostedInvoiceUrl: string | null = null
      await runTrackedOperation({
        attemptId: attempt.id, provider: 'stripe', operationType: 'finalize_invoice', componentKey: line.componentKey,
        requestFingerprint: fingerprintValue({ invoiceId }),
        retryCapability: 'idempotent_retry', classifyFailure: classifyStripeFailure, errorClassOf: stripeErrorClassOf,
        execute: async (idempotencyKey) => {
          const finalized = await stripe.invoices.finalizeInvoice(invoiceId, {}, { idempotencyKey })
          hostedInvoiceUrl = finalized.hosted_invoice_url ?? null
          return invoiceId
        },
      })

      // Item 10 — persisted immediately after this specific line's external
      // side effects all succeeded, not batched with every other line at
      // the very end — a crash after line N no longer loses knowledge that
      // lines 1..N-1 already have real Stripe invoices.
      const plannedRow: PlannedRow = line.kind === 'period'
        ? { year_num: Number(line.componentKey.split(':')[1]), period_start: line.dueDate!, period_end: line.dueDate!, base_amount: line.amount, currency: terms.currency ?? 'EUR', fee_label: null, invoice_type: 'period', status: 'sent', stripe_invoice_id: invoiceId, stripe_invoice_url: hostedInvoiceUrl, sent_at: new Date().toISOString() }
        : { year_num: null, period_start: line.dueDate!, period_end: line.dueDate!, base_amount: line.amount, currency: terms.currency ?? 'EUR', fee_label: line.componentKey.slice(4), invoice_type: 'one_time', status: 'sent', stripe_invoice_id: invoiceId, stripe_invoice_url: hostedInvoiceUrl, sent_at: new Date().toISOString(), quantity: line.unitPrice != null ? line.quantity : null, unit_price: line.unitPrice }
      const { error: rowErr } = await supabaseServer.from('planned_invoices').insert({ ...plannedRow, job_id: jobId, org_id: orgId })
      if (rowErr) console.error('[billing-writer/stripe] planned_invoices insert failed for a sent line', rowErr)
    }

    // ── Scheduled/parked rows for everything NOT due now — no external
    // call, so these are safe to batch-insert with no operation tracking. ──
    const scheduledRows: PlannedRow[] = []
    const fullSchedule = computeBillingSchedule(terms)
    for (const period of fullSchedule) {
      const periodStartStr = formatDate(period.periodStart)
      if (alreadySentKeys.has(`period:${period.yearNum}:${periodStartStr}`)) continue
      if (period.periodStart <= now && period.baseAmount > 0) continue // already handled above
      scheduledRows.push({
        year_num: period.yearNum, period_start: periodStartStr, period_end: formatDate(period.periodEnd),
        base_amount: period.baseAmount, currency: terms.currency ?? 'EUR', fee_label: null,
        invoice_type: 'period', status: 'scheduled', stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
      })
    }
    // Terminal settlement — the contract's real final service period has no
    // next advance-period row to trigger its own arrears usage/minimum/
    // chargeback settlement under the existing backward-scan model. Adds
    // exactly one extra row (never a manufactured extra subscription
    // period — base_amount stays 0) whose trigger date is the day after
    // the schedule's own last period ends. See lib/terminal-settlement.ts.
    const lastPeriod = fullSchedule[fullSchedule.length - 1]
    if (lastPeriod) {
      const terminalTarget = deriveTerminalSettlementTarget(lastPeriod.periodStart, lastPeriod.periodEnd, terms)
      if (terminalTarget) {
        scheduledRows.push({
          year_num: null, period_start: terminalTarget.triggerDate, period_end: terminalTarget.triggerDate,
          base_amount: 0, currency: terms.currency ?? 'EUR', fee_label: null,
          invoice_type: 'terminal_settlement', status: 'scheduled', stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
          settlement_period_start: terminalTarget.settlementPeriodStart, settlement_period_end: terminalTarget.settlementPeriodEnd,
        })
      }
    }
    const oneTimeFees = terms.one_time_fees ?? []
    const isHeld = (fee: typeof oneTimeFees[number]) => isOneTimeFeeHeldForExecution(fee, operationalEventEvidence, now)
    for (const fee of oneTimeFees.filter(isHeld)) {
      if (alreadySentKeys.has(`one_time_fee:${fee.fee_label}`)) continue
      const li = findOneTimeLineItem(lineItems, fee.fee_label)
      // isHeld is also true for a genuine legacy manual_trigger fee (no
      // billability_condition at all) — that case must NEVER get a fee_id,
      // since it stays exclusively human-driven via POST /parked-invoices;
      // only a real event-gated fee is eligible for the scheduler's later
      // automatic evidence-triggered execution.
      const isEventGated = fee.billability_condition?.kind === 'event'
      scheduledRows.push({
        year_num: null, period_start: fee.due_date ?? formatDate(now), period_end: fee.due_date ?? formatDate(now),
        base_amount: fee.amount ?? 0, currency: terms.currency ?? 'EUR', fee_label: fee.fee_label,
        invoice_type: 'one_time', status: 'parked', stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
        line_item_id: li?.id ?? null, quantity: null, unit_price: li?.unit_price ?? fee.rate_per_unit ?? null,
        fee_id: isEventGated ? (fee.fee_id ?? null) : null,
      })
    }
    for (const fee of oneTimeFees.filter(f => !isHeld(f) && f.amount > 0)) {
      if (alreadySentKeys.has(`one_time_fee:${fee.fee_label}`)) continue
      const feeDueDate = fee.due_date ? new Date(fee.due_date + 'T00:00:00') : null
      const isDue = !feeDueDate || feeDueDate <= now
      if (isDue) continue // already handled above
      const li = findOneTimeLineItem(lineItems, fee.fee_label)
      const amount = li?.total_amount ?? fee.amount
      const hasBreakdown = !!li && li.quantity > 0 && li.unit_price > 0
      const dueDateStr = formatDate(feeDueDate!)
      scheduledRows.push({
        year_num: null, period_start: dueDateStr, period_end: dueDateStr, base_amount: amount,
        currency: terms.currency ?? 'EUR', fee_label: fee.fee_label, invoice_type: 'one_time', status: 'scheduled',
        stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null, line_item_id: li?.id ?? null,
        quantity: hasBreakdown ? li.quantity : null, unit_price: hasBreakdown ? li.unit_price : null,
      })
    }
    if (scheduledRows.length > 0) {
      const { error: schedErr } = await supabaseServer.from('planned_invoices').insert(scheduledRows.map(r => ({ ...r, job_id: jobId, org_id: orgId })))
      if (schedErr) console.error('[billing-writer/stripe] scheduled planned_invoices insert failed', schedErr)
    }

    await markAttemptStatus(attempt.id, 'succeeded')

    const dashboardUrl = `https://dashboard.stripe.com/${isTest ? 'test/' : ''}customers/${customerId}`
    return {
      platform:       'stripe',
      subscriptionId: null,
      customerId,
      lineItemCount:  computeBillingSchedule(terms).length + oneTimeFees.filter(f => f.amount > 0).length,
      dashboardUrl,
    }
  } catch (err) {
    // The individual operation that threw already recorded its own
    // failed_safe/outcome_uncertain status; the attempt as a whole is
    // marked with the same classification — conservative by default (item
    // 15 wants the attempt to explain where uncertainty began, not just
    // echo the last error).
    const attemptOutcome = classifyStripeFailure(err)
    await markAttemptStatus(attempt.id, attemptOutcome)
    throw err
  }
}

// ── Remembill ──────────────────────────────────────────────────────────────────
// Remembill is an invoice-based billing platform (no subscriptions).
// Flow: create customer → for each due period create a draft invoice, add one
// row, deliver via email. Future periods are stored as 'scheduled' planned rows
// and pushed by the daily invoice-scheduler cron.
// Taxes are handled by Remembill automatically — we send net amounts.
const REMEMBILL_BASE = 'https://api.remembill.com/v1'

// HTTP header values must be printable ASCII. Strip any non-ASCII character
// (em dashes, curly quotes, etc.) and collapse runs of non-alphanumeric to a
// single hyphen so idempotency keys remain readable and safe.
export function safeHeaderValue(s: string): string {
  return s
    .replace(/[^\x20-\x7E]/g, '-')   // non-printable-ASCII → hyphen
    .replace(/[^a-zA-Z0-9_\-]/g, '-') // remaining specials → hyphen
    .replace(/-{2,}/g, '-')            // collapse repeated hyphens
    .replace(/^-|-$/g, '')             // trim leading/trailing hyphens
    .slice(0, 255)
}

// Builds an app.remembill.com URL that respects the org path segment.
// Set REMEMBILL_ORG_SLUG in Vercel to the slug that appears after /org/ in
// your Remembill dashboard URL (e.g. "acme" if the URL is app.remembill.com/org/acme/...).
function remembillAppUrl(path: string): string {
  const slug = process.env.REMEMBILL_ORG_SLUG
  const base = slug ? `https://app.remembill.com/org/${slug}` : 'https://app.remembill.com'
  return `${base}${path}`
}

function remembillHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  }
}

// A definitive HTTP response FROM Remembill (even an error one) — thrown
// explicitly by the operation code below, distinct from `fetch()` itself
// throwing (network failure, no response received at all).
class RemembillHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

// Item 14 — the same conservative two-bucket rule as classifyFetchOutcome,
// adapted to this file's control flow: a RemembillHttpError means a
// definitive response came back (failed_safe); anything else thrown
// (fetch() itself failed — network error, timeout, abort) means no
// definitive response was ever received (outcome_uncertain).
function remembillClassifyFailure(err: unknown): 'failed_safe' | 'outcome_uncertain' {
  return classifyFetchOutcome({ requestThrew: !(err instanceof RemembillHttpError), receivedResponse: err instanceof RemembillHttpError })
}
function remembillErrorClassOf(err: unknown): string {
  return err instanceof RemembillHttpError ? fetchErrorClassOf(err, err.status) : fetchErrorClassOf(err)
}

async function configureRememhill(
  terms: ContractTerms,
  lineItems: LineItemInput[],
  jobId: string,
  orgId: string,
  existingCustomerId?: string,
  operationalEventEvidence: OperationalEventEvidence[] = [],
): Promise<ConfigureResult> {
  const orgConfig = await getOrgConfig(orgId, 'remembill')
  const apiKey = orgConfig?.api_key ?? process.env.REMEMBILL_API_KEY
  // Item 14 — deterministic, local, pre-any-external-call validation
  // failures. Thrown as BillingPreconditionError, BEFORE any execution
  // attempt is even created, so approve/route.ts can restore the job to
  // its real prior state (item 3's "no external attempt -> no ambiguity")
  // instead of landing in the same FAILED state used for a genuinely
  // uncertain provider outcome.
  if (!apiKey) throw new BillingPreconditionError('Remembill API key not configured')

  const h      = remembillHeaders(apiKey)
  const cur    = (terms.currency || 'SEK').toUpperCase()   // || so empty string falls back too
  const now    = new Date()
  const netDays = terms.payment_terms_days ?? 30

  const fmtDate  = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const fmtLabel = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  const addDays  = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

  if (!cur) {
    throw new BillingPreconditionError('Remembill: currency is missing from contract terms — set it in the contract details and try again.')
  }
  if (cur !== 'SEK') {
    throw new BillingPreconditionError(
      `Remembill only supports invoicing in SEK. This contract is in ${cur}. ` +
      'Please use Stripe for non-SEK contracts, or update the contract currency to SEK.',
    )
  }
  if (!existingCustomerId && !terms.customer_org_number) {
    throw new BillingPreconditionError(
      'Remembill requires a company registration number (org number). ' +
      'Please add it in the contract details under "Customer org / reg number" and try again.',
    )
  }

  // Item 3 — VAT resolved deterministically before any external call, from
  // whichever source is actually available pre-customer-creation: the
  // real customer_vat_config for an existing customer, or the job's staged
  // pending_vat_mode/rate (set pre-approval, before any customer exists —
  // the same source approve/route.ts's own readiness gate already reads)
  // for a brand-new one. Never left unresolved into the snapshot.
  let vatTreatmentForPush: VatTreatment
  if (existingCustomerId) {
    const customerVatConfig = await getCustomerVatConfig(orgId, existingCustomerId)
    vatTreatmentForPush = resolveVatTreatment(customerVatConfig, null)
  } else {
    const { data: vatRow } = await supabaseServer.from('jobs').select('pending_vat_mode, pending_vat_rate_pct').eq('id', jobId).maybeSingle()
    vatTreatmentForPush = {
      mode: (vatRow?.pending_vat_mode as VatMode | undefined) ?? 'not_configured',
      ratePct: vatRow?.pending_vat_mode === 'rate' ? (vatRow?.pending_vat_rate_pct as number | null) : null,
    }
  }

  // ── Preserve already-sent invoices; delete only unsent rows ────────────────
  const { data: sent } = await supabaseServer
    .from('planned_invoices')
    .select('year_num, period_start, period_end, invoice_type, fee_label, stripe_invoice_id, stripe_invoice_url, base_amount, currency, sent_at, status')
    .eq('job_id', jobId)
    .in('status', ['sent', 'paid'])
  const sentRows = sent ?? []
  const alreadySentKeys = new Set(sentRows.map(r => planComponentKey({
    invoice_type: r.invoice_type, year_num: r.year_num, period_start: r.period_start, fee_label: r.fee_label,
  })))

  const { error: cleanErr } = await supabaseServer
    .from('planned_invoices')
    .delete()
    .eq('job_id', jobId)
    .in('status', ['scheduled', 'parked', 'processing', 'draft'])
  if (cleanErr) console.error('[billing-writer/remembill] stale planned_invoices cleanup failed', cleanErr)

  const snapshot = buildBillingPlanSnapshot({
    terms, lineItems, evidence: operationalEventEvidence, alreadySentKeys, provider: 'remembill',
    vat: { mode: vatTreatmentForPush.mode, ratePct: vatTreatmentForPush.ratePct }, now, computeBillingSchedule,
  })
  const fingerprint = fingerprintBillingPlan(snapshot)
  // Step 14 final state-integrity correction — see getOrCreateAttempt's own
  // param doc / the Stripe call site's identical comment above.
  const recomputeFingerprintExcludingPriorSnapshot = (priorSnapshot: BillingPlanSnapshot): string => {
    const reducedAlreadySentKeys = excludePriorSnapshotFromAlreadySent(alreadySentKeys, priorSnapshot)
    const counterfactual = buildBillingPlanSnapshot({
      terms, lineItems, evidence: operationalEventEvidence, alreadySentKeys: reducedAlreadySentKeys, provider: 'remembill',
      vat: { mode: vatTreatmentForPush.mode, ratePct: vatTreatmentForPush.ratePct }, now, computeBillingSchedule,
    })
    return fingerprintBillingPlan(counterfactual)
  }
  const attempt = await getOrCreateAttempt({ orgId, jobId, provider: 'remembill', fingerprint, snapshot, recomputeFingerprintExcludingPriorSnapshot })
  await markAttemptExecuting(attempt.id)

  type PlannedRow = {
    job_id?: string; org_id?: string
    year_num: number | null; period_start: string; period_end: string
    base_amount: number; currency: string; fee_label: string | null
    invoice_type: string; status: string
    stripe_invoice_id: string | null; stripe_invoice_url: string | null
    sent_at: string | null
    line_item_id?: string | null; quantity?: number | null; unit_price?: number | null
    // See the identical field on configureStripe's own PlannedRow above —
    // populated only for a parked, event-gated one-time fee.
    fee_id?: string | null
    // See the identical field on configureStripe's own PlannedRow above —
    // only set for invoice_type='terminal_settlement'.
    settlement_period_start?: string | null
    settlement_period_end?: string | null
  }

  try {
    // ── Op: resolve customer. Reusing existingCustomerId is itself the
    // local reconciliation mechanism (Verdix's own persisted
    // jobs.billing_customer_id, written immediately on first success below)
    // — that is what makes this 'reconcilable' rather than
    // 'manual_verification_required': a retry that finds existingCustomerId
    // already set never re-attempts creation at all. ──
    const customerId = (await runTrackedOperation({
      attemptId: attempt.id, provider: 'remembill', operationType: 'resolve_customer',
      requestFingerprint: fingerprintValue({ existingCustomerId: existingCustomerId ?? null, name: terms.customer_name, orgNumber: terms.customer_org_number }),
      retryCapability: 'reconcilable', classifyFailure: remembillClassifyFailure, errorClassOf: remembillErrorClassOf,
      execute: async (idempotencyKey) => {
        if (existingCustomerId) {
          console.log('[billing-writer/remembill] reusing existing customer:', existingCustomerId)
          return existingCustomerId
        }
        const realEmail = terms.customer_email
          ?? terms.billing_contact?.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0]
          ?? null
        const customerBody: Record<string, string> = { type: 'business', name: terms.customer_name ?? 'Unknown' }
        if (realEmail) {
          customerBody.email = realEmail
        } else {
          const slug = (terms.customer_name ?? 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'customer'
          customerBody.email = `billing+${slug}@verdix-noreply.com`
        }
        customerBody.org_number = terms.customer_org_number!

        const custRes = await fetch(`${REMEMBILL_BASE}/customers`, {
          method: 'POST', headers: { ...h, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(customerBody),
        })
        const custRawBody = await custRes.text()
        if (!custRes.ok) throw new RemembillHttpError(custRes.status, `Remembill customer creation failed (${custRes.status}): ${custRawBody}`)
        const custJson = JSON.parse(custRawBody) as Record<string, unknown>
        const custObj  = (custJson.customer ?? custJson.data ?? custJson) as Record<string, unknown>
        const newCustomerId = custObj.id as string | undefined
        if (!newCustomerId) throw new Error(`Remembill customer creation: could not extract id from response: ${custRawBody}`)

        // Persist immediately — this write IS the reconciliation mechanism
        // a future retry relies on (existingCustomerId above).
        const { error: saveErr } = await supabaseServer.from('jobs').update({ billing_customer_id: newCustomerId }).eq('id', jobId)
        if (saveErr) console.error('[billing-writer/remembill] failed to persist customer_id early', saveErr)
        return newCustomerId
      },
    })) as string
    console.log('[billing-writer/remembill] customerId:', customerId, '| currency:', cur)

    async function pushLine(line: BillingPlanLineInstruction, description: string, unitPrice: number, issueDate: Date, quantity: number, vatRatePct: number): Promise<{ id: string; url: string | null }> {
      const dueDate = addDays(issueDate, netDays)
      const invoiceBody = { customer_id: customerId, currency: cur, issue_date: fmtDate(issueDate), due_date: fmtDate(dueDate), payment_terms: `Net ${netDays}` }

      // Item 8 — the stable, attempt-derived key REPLACES the old
      // Date.now()-based pushStamp, which regenerated on every configure
      // call and so never actually protected a retry from a second Approve
      // request. Capability stays 'manual_verification_required' —
      // whether Remembill's backend genuinely honors this header across
      // retries is unverified (no sandbox environment safely available;
      // see the STEP14 doc's capability matrix) — a stable key is strictly
      // better than the old bug regardless of whether Remembill honors it,
      // but Verdix does not claim a safety guarantee it cannot prove.
      const invoiceId = await runTrackedOperation({
        attemptId: attempt.id, provider: 'remembill', operationType: 'create_invoice', componentKey: line.componentKey,
        requestFingerprint: fingerprintValue(invoiceBody),
        retryCapability: 'manual_verification_required', classifyFailure: remembillClassifyFailure, errorClassOf: remembillErrorClassOf,
        execute: async (idempotencyKey) => {
          const invRes = await fetch(`${REMEMBILL_BASE}/invoices`, {
            method: 'POST', headers: { ...h, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(invoiceBody),
          })
          const invRawBody = await invRes.text()
          if (!invRes.ok) throw new RemembillHttpError(invRes.status, `Remembill invoice creation failed (${invRes.status}): ${invRawBody}`)
          const invJson = JSON.parse(invRawBody) as Record<string, unknown>
          const invObj  = (invJson.invoice ?? invJson.data ?? invJson) as Record<string, unknown>
          const id = invObj.id as string | undefined
          if (!id) throw new Error(`Remembill invoice creation: could not extract id from response: ${invRawBody}`)
          return id
        },
      }) as string

      // price is in öre (minor units): 1 kr = 100 öre. vat is 0–100 percent,
      // resolved by the caller from customer_vat_config (never hardcoded).
      const rowBody = { name: description, quantity, price: Math.round(unitPrice * 100), vat: Math.round(vatRatePct) }
      await runTrackedOperation({
        attemptId: attempt.id, provider: 'remembill', operationType: 'create_invoice_row', componentKey: line.componentKey,
        requestFingerprint: fingerprintValue(rowBody),
        // No idempotency mechanism exists for this endpoint at all
        // (confirmed: POST /invoices/:id/rows carries no Idempotency-Key
        // in the first place) — honestly marked manual_verification_
        // required, never invented local dedup and called it safe.
        retryCapability: 'manual_verification_required', classifyFailure: remembillClassifyFailure, errorClassOf: remembillErrorClassOf,
        execute: async () => {
          const rowRes = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, { method: 'POST', headers: h, body: JSON.stringify(rowBody) })
          const rowRawBody = await rowRes.text()
          if (!rowRes.ok) throw new RemembillHttpError(rowRes.status, `Remembill row creation failed (${rowRes.status}): ${rowRawBody}`)
          return null
        },
      })

      // Email delivery is best-effort and NOT a financial side effect (a
      // duplicate send is a minor annoyance, not a billing-correctness
      // risk) — left outside the tracked-operation model, unchanged.
      await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/email`, {
        method: 'POST', headers: h, body: JSON.stringify({}),
      }).catch(err => console.error('[billing-writer/remembill] email delivery failed', err))

      return { id: invoiceId, url: remembillAppUrl('') }
    }

    for (const line of snapshot.lines) {
      const description = line.kind === 'period'
        ? (() => {
            const [yearNumStr, periodIndexStr] = line.componentKey.split(':').slice(1)
            const period = computeBillingSchedule(terms).find(p => p.yearNum === Number(yearNumStr) && p.periodIndex === Number(periodIndexStr))!
            return `Base subscription — Year ${period.yearNum} (${fmtLabel(period.periodStart)} – ${fmtLabel(period.periodEnd)})`
          })()
        : line.componentKey.slice(4)
      const issueDate = line.kind === 'period' ? now : (line.dueDate ? new Date(line.dueDate + 'T00:00:00') : now)
      const unitPrice = line.unitPrice ?? line.amount
      const { id, url } = await pushLine(line, description, unitPrice, issueDate, line.quantity, line.vatRatePct ?? 0)

      const plannedRow: PlannedRow = line.kind === 'period'
        ? { year_num: Number(line.componentKey.split(':')[1]), period_start: line.dueDate!, period_end: line.dueDate!, base_amount: line.amount, currency: terms.currency ?? 'SEK', fee_label: null, invoice_type: 'period', status: 'sent', stripe_invoice_id: id, stripe_invoice_url: url, sent_at: new Date().toISOString() }
        : { year_num: null, period_start: line.dueDate!, period_end: line.dueDate!, base_amount: line.amount, currency: terms.currency ?? 'SEK', fee_label: line.componentKey.slice(4), invoice_type: 'one_time', status: 'sent', stripe_invoice_id: id, stripe_invoice_url: url, sent_at: new Date().toISOString(), quantity: line.unitPrice != null ? line.quantity : null, unit_price: line.unitPrice }
      const { error: rowErr } = await supabaseServer.from('planned_invoices').insert({ ...plannedRow, job_id: jobId, org_id: orgId })
      if (rowErr) console.error('[billing-writer/remembill] planned_invoices insert failed for a sent line', rowErr)
    }

    // ── Scheduled/parked rows for everything NOT due now — no external call. ──
    const scheduledRows: PlannedRow[] = []
    const fullSchedule = computeBillingSchedule(terms)
    for (const period of fullSchedule) {
      const periodStartStr = fmtDate(period.periodStart)
      if (alreadySentKeys.has(`period:${period.yearNum}:${periodStartStr}`)) continue
      if (period.periodStart <= now && period.baseAmount > 0) continue
      scheduledRows.push({
        year_num: period.yearNum, period_start: periodStartStr, period_end: fmtDate(period.periodEnd),
        base_amount: period.baseAmount, currency: terms.currency ?? 'SEK', fee_label: null,
        invoice_type: 'period', status: 'scheduled', stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
      })
    }
    // See the identical block in configureStripe above.
    const lastPeriod = fullSchedule[fullSchedule.length - 1]
    if (lastPeriod) {
      const terminalTarget = deriveTerminalSettlementTarget(lastPeriod.periodStart, lastPeriod.periodEnd, terms)
      if (terminalTarget) {
        scheduledRows.push({
          year_num: null, period_start: terminalTarget.triggerDate, period_end: terminalTarget.triggerDate,
          base_amount: 0, currency: terms.currency ?? 'SEK', fee_label: null,
          invoice_type: 'terminal_settlement', status: 'scheduled', stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
          settlement_period_start: terminalTarget.settlementPeriodStart, settlement_period_end: terminalTarget.settlementPeriodEnd,
        })
      }
    }
    const oneTimeFees = terms.one_time_fees ?? []
    const isHeld = (fee: typeof oneTimeFees[number]) => isOneTimeFeeHeldForExecution(fee, operationalEventEvidence, now)
    for (const fee of oneTimeFees.filter(isHeld)) {
      if (alreadySentKeys.has(`one_time_fee:${fee.fee_label}`)) continue
      const li = findOneTimeLineItem(lineItems, fee.fee_label)
      // See the identical comment on configureStripe's own isHeld loop —
      // only a real event-gated fee gets a fee_id.
      const isEventGated = fee.billability_condition?.kind === 'event'
      scheduledRows.push({
        year_num: null, period_start: fee.due_date ?? fmtDate(now), period_end: fee.due_date ?? fmtDate(now),
        base_amount: fee.amount ?? 0, currency: terms.currency ?? 'SEK', fee_label: fee.fee_label,
        invoice_type: 'one_time', status: 'parked', stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null,
        line_item_id: li?.id ?? null, quantity: null, unit_price: li?.unit_price ?? fee.rate_per_unit ?? null,
        fee_id: isEventGated ? (fee.fee_id ?? null) : null,
      })
    }
    for (const fee of oneTimeFees.filter(f => !isHeld(f) && f.amount > 0)) {
      if (alreadySentKeys.has(`one_time_fee:${fee.fee_label}`)) continue
      const feeDueDate = fee.due_date ? new Date(fee.due_date + 'T00:00:00') : null
      const isDue = !feeDueDate || feeDueDate <= now
      if (isDue) continue
      const li = findOneTimeLineItem(lineItems, fee.fee_label)
      const amount = li?.total_amount ?? fee.amount
      const hasBreakdown = !!li && li.quantity > 0 && li.unit_price > 0
      const dueDateStr = fmtDate(feeDueDate!)
      scheduledRows.push({
        year_num: null, period_start: dueDateStr, period_end: dueDateStr, base_amount: amount,
        currency: terms.currency ?? 'SEK', fee_label: fee.fee_label, invoice_type: 'one_time', status: 'scheduled',
        stripe_invoice_id: null, stripe_invoice_url: null, sent_at: null, line_item_id: li?.id ?? null,
        quantity: hasBreakdown ? li.quantity : null, unit_price: hasBreakdown ? li.unit_price : null,
      })
    }
    if (scheduledRows.length > 0) {
      const { error: schedErr } = await supabaseServer.from('planned_invoices').insert(scheduledRows.map(r => ({ ...r, job_id: jobId, org_id: orgId })))
      if (schedErr) console.error('[billing-writer/remembill] scheduled planned_invoices insert failed', schedErr)
    }

    await markAttemptStatus(attempt.id, 'succeeded')

    return {
      platform:       'remembill',
      subscriptionId: null,
      customerId,
      lineItemCount:  computeBillingSchedule(terms).length + oneTimeFees.filter(f => f.amount > 0).length,
      dashboardUrl:   remembillAppUrl(''),
    }
  } catch (err) {
    const attemptOutcome = remembillClassifyFailure(err)
    await markAttemptStatus(attempt.id, attemptOutcome)
    throw err
  }
}

async function configureChargebee(
  terms: ContractTerms,
  lineItems: LineItemInput[],
  jobId?: string,
  orgId?: string,
): Promise<ConfigureResult> {
  const orgConfig = orgId ? await getOrgConfig(orgId, 'chargebee') : null
  const site   = orgConfig?.site    ?? process.env.CHARGEBEE_SITE!
  const apiKey = orgConfig?.api_key ?? process.env.CHARGEBEE_API_KEY!
  const base = `https://${site}.chargebee.com/api/v2`
  const headers = {
    'Authorization': `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  const customerRes = await fetch(`${base}/customers`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      'first_name':     terms.customer_name ?? 'Unknown',
      'cf_contract_id': terms.contract_id   ?? '',
      'cf_source':      'verdix',
      ...(jobId ? { 'cf_revlens_job_id': jobId } : {}),
    }).toString(),
  })
  const customerData = await customerRes.json()
  const customerId   = customerData.customer?.id

  const params = new URLSearchParams({ 'customer_id': customerId })
  lineItems.forEach((item, i) => {
    params.append(`subscription_items[item_price_id][${i}]`, item.product_name.toLowerCase().replace(/\s+/g, '-'))
    // Chargebee subscription items recur automatically per their item
    // price's own configured interval — quantity means "units per cycle",
    // never "how many cycles". item.quantity here instead counts billing
    // cycles over the contract term (for the Configure page's display /
    // Base TCV), so it must never be forwarded as-is — doing so would tell
    // Chargebee to charge unit_price × cycle-count *every single cycle*.
    params.append(`subscription_items[quantity][${i}]`, '1')
    params.append(`subscription_items[unit_price][${i}]`, String(Math.round(item.unit_price * 100)))
  })

  const subRes = await fetch(`${base}/subscriptions/create_with_items/${customerId}`, {
    method: 'POST',
    headers,
    body: params.toString(),
  })
  const subData      = await subRes.json()
  const subscriptionId = subData.subscription?.id ?? 'unknown'

  return {
    platform:       'chargebee',
    subscriptionId,
    customerId,
    lineItemCount:  lineItems.length,
    dashboardUrl:   `https://${site}.chargebee.com/subscriptions/${subscriptionId}`,
  }
}

// Creates a one-off invoice with arbitrary line items on the org's connected
// Stripe or Remembill account. Used for manually-triggered invoices (e.g. the
// job-scoped manual invoice generator) where the caller has already computed
// the line items and just needs them pushed to the real billing platform —
// mirrors the proven Stripe/Remembill mechanics used elsewhere in this file
// so there's one code path for "create an ad-hoc invoice," not several.
export async function createAdHocInvoice(params: {
  orgId: string
  billingPlatform: 'stripe' | 'remembill'
  customerId: string
  currency: string
  netDays: number
  lineItems: Array<{ description: string; quantity: number; unitPrice: number }>
  idempotencyKey: string
  metadata?: Record<string, string>
  // Per-invoice VAT override, when the caller already knows one applies
  // (e.g. a correction's replacement invoice) — previously hardcoded to
  // null here regardless of caller, meaning an invoice-level override was
  // silently ignored on the ACTUAL Remembill/Stripe push even when a
  // caller had separately computed one for its own bookkeeping. Falls
  // through to the customer default when omitted, same as resolveVatTreatment
  // everywhere else.
  vatOverride?: VatTreatment | null
}): Promise<{
  invoiceId: string
  hostedUrl: string | null
  // The exact VAT treatment/figures actually applied to this invoice —
  // callers must persist this as a snapshot on their own planned_invoices
  // row (see 20260821000007_vat_config.sql's vat_mode/vat_rate_pct/
  // net_amount/vat_amount/gross_amount columns) rather than recomputing
  // from customer_vat_config later, which could drift from what was
  // actually charged if the customer's default VAT changes afterward.
  vat: { mode: VatMode; ratePct: number | null; netAmount: number; vatAmount: number; grossAmount: number }
}> {
  const { orgId, billingPlatform, customerId, currency, netDays, lineItems, idempotencyKey, metadata, vatOverride } = params
  const today = new Date()
  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  const adHocNet = lineItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0)
  const adHocVatTreatment = resolveVatTreatment(await getCustomerVatConfig(orgId, customerId), vatOverride ?? null)
  const adHocVat = computeVat(adHocNet, adHocVatTreatment)
  if (!adHocVat.ok) throw new Error(`Billing blocked: ${adHocVat.reason}`)
  const adHocVatRatePct = Math.round(adHocVat.calculation.vatRatePct)
  const vatSnapshot = {
    mode: adHocVatTreatment.mode, ratePct: adHocVatTreatment.ratePct,
    netAmount: adHocVat.calculation.netAmount, vatAmount: adHocVat.calculation.vatAmount, grossAmount: adHocVat.calculation.grossAmount,
  }

  if (billingPlatform === 'remembill') {
    const orgConfig = await getOrgConfig(orgId, 'remembill')
    const apiKey = orgConfig?.api_key ?? process.env.REMEMBILL_API_KEY
    if (!apiKey) throw new Error('Remembill API key not configured')
    const h       = remembillHeaders(apiKey)
    const dueDate = new Date(today.getTime() + netDays * 86_400_000)

    const invRes = await fetch(`${REMEMBILL_BASE}/invoices`, {
      method: 'POST',
      headers: { ...h, 'Idempotency-Key': safeHeaderValue(idempotencyKey) },
      body: JSON.stringify({
        customer_id:   customerId,
        currency:      currency.toUpperCase(),
        issue_date:    fmtDate(today),
        due_date:      fmtDate(dueDate),
        payment_terms: `Net ${netDays}`,
      }),
    })
    if (!invRes.ok) {
      const raw = await invRes.text()
      throw new Error(`Remembill invoice creation failed (${invRes.status}): ${raw}`)
    }
    const invJson    = await invRes.json() as Record<string, unknown>
    const invObj     = (invJson.invoice ?? invJson.data ?? invJson) as Record<string, unknown>
    const invoiceId  = invObj.id as string | undefined
    if (!invoiceId) throw new Error(`Could not extract Remembill invoice id: ${JSON.stringify(invJson)}`)

    for (const item of lineItems) {
      await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ name: item.description, quantity: item.quantity, price: Math.round(item.unitPrice * 100), vat: adHocVatRatePct }),
      })
    }

    await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/email`, {
      method: 'POST', headers: h, body: JSON.stringify({}),
    }).catch(() => {})

    return { invoiceId, hostedUrl: remembillAppUrl(''), vat: vatSnapshot }
  }

  // ── Stripe ──────────────────────────────────────────────────────────────────
  const { default: Stripe } = await import('stripe')
  const orgConfig = await getOrgConfig(orgId, 'stripe')
  const stripeKey = orgConfig?.secret_key ?? process.env.STRIPE_SECRET_KEY!
  const stripe    = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

  let adHocTaxRateId: string | null = null
  if (adHocVatTreatment.mode === 'rate' && adHocVatRatePct > 0) {
    const existing = await stripe.taxRates.list({ active: true, limit: 100 })
    const match = existing.data.find(tr => tr.display_name === 'VAT' && tr.percentage === adHocVatRatePct && !tr.inclusive)
    adHocTaxRateId = match?.id
      ?? (await stripe.taxRates.create({ display_name: 'VAT', percentage: adHocVatRatePct, inclusive: false })).id
  }

  const inv = await stripe.invoices.create({
    customer:                       customerId,
    collection_method:              'send_invoice',
    days_until_due:                 netDays,
    pending_invoice_items_behavior: 'exclude',
    metadata,
  })

  for (const item of lineItems) {
    await stripe.invoiceItems.create({
      customer:    customerId,
      invoice:     inv.id,
      amount:      Math.round(item.quantity * item.unitPrice * 100),
      currency:    currency.toLowerCase(),
      description: item.quantity !== 1
        ? `${item.description} — ${item.quantity} × ${currency.toUpperCase()} ${item.unitPrice}`
        : item.description,
      tax_rates:   adHocTaxRateId ? [adHocTaxRateId] : undefined,
    })
  }

  const finalized = await stripe.invoices.finalizeInvoice(inv.id).catch(() => inv)
  return { invoiceId: inv.id, hostedUrl: finalized.hosted_invoice_url ?? null, vat: vatSnapshot }
}

// Step 14 final financial-state correction, item 3 — "Verdix should
// recover/finish the job from the durable successful attempt." Called by
// approve/route.ts when getOrCreateAttempt throws PriorBillingAttemptExecutedError
// (every operation on a prior attempt succeeded — the crash-after-success
// scenario). Reconstructs a ConfigureResult purely from already-persisted
// facts — customerId from the resolve_customer operation's own recorded
// external_object_id — NEVER calls the provider again. subscriptionId is
// always null for Stripe/Remembill (matches every other ConfigureResult
// this file returns for these two platforms — only Chargebee has a real
// subscription id, out of scope here).
export async function recoverConfigureResultFromSucceededAttempt(
  attempt: BillingExecutionAttempt, operations: BillingExecutionOperation[], orgId: string,
): Promise<ConfigureResult> {
  const customerOp = operations.find(o => o.operationType === 'resolve_customer')
  const customerId = customerOp?.externalObjectId
  if (!customerId) {
    throw new Error(`Cannot recover billing result: succeeded attempt ${attempt.id} has no resolve_customer operation with a recorded external object id.`)
  }
  const lineItemCount = operations.filter(o => o.operationType === 'create_invoice').length

  if (attempt.provider === 'stripe') {
    const orgConfig = await getOrgConfig(orgId, 'stripe')
    const stripeKey = orgConfig?.secret_key ?? process.env.STRIPE_SECRET_KEY!
    const isTest = stripeKey.includes('_test_')
    return {
      platform: 'stripe', subscriptionId: null, customerId, lineItemCount,
      dashboardUrl: `https://dashboard.stripe.com/${isTest ? 'test/' : ''}customers/${customerId}`,
    }
  }
  if (attempt.provider === 'remembill') {
    return { platform: 'remembill', subscriptionId: null, customerId, lineItemCount, dashboardUrl: remembillAppUrl('') }
  }
  throw new Error(`Cannot recover billing result for provider "${attempt.provider}" — not supported by this recovery path.`)
}

// Re-export computeBillingSchedule for use by the invoice scheduler
export { computeBillingSchedule, REMEMBILL_BASE, remembillHeaders, remembillAppUrl }
export type { BillingPeriod }
