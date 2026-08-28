// DB-touching orchestration for the credit ledger — the pure math lives in
// lib/credit-ledger.ts; this file is the read/write glue around it, mirroring
// the split already established between lib/tariff.ts (pure) and
// lib/usage-pull.ts/lib/billing-writer.ts (DB-touching).
import { supabaseServer } from '@/lib/supabase'
import { enumerateCadenceWindows, type CadenceAnchorMode } from '@/lib/tariff'
import { createRemembillUsageConnector } from '@/lib/connectors/usage/remembill'
import { getCreditRepresentationCapability } from '@/lib/connectors/billing/types'
import { toMinorUnits, fromMinorUnits } from '@/lib/money'
import {
  evaluateCreditEarn, computeRequestedCreditApplication, consumePool,
  type PoolComponent,
} from '@/lib/credit-ledger'
import { detectCreditPriorityNeed } from '@/lib/credit-priority'
import { canFreezeMonetaryBasisEarn } from '@/lib/paid-basis-finalization'
import { classifyContractUnitType, resolveScopeTokenClass, type CommercialComponentClass } from '@/lib/commercial-component-scope'
import type { ContractTerms, ServiceCredit, ServiceCreditInterpretation } from '@/lib/types'

export interface CreditLineItem {
  credit_rule_id: string
  description: string
  amount: number // negative, major units — matches OverageLineItem's convention
  currency: string
  consumed: Array<{ key: string; amount: number }>
  sourceClause: string | null
}

export interface ProposedCreditApplication {
  credit_rule_id: string
  description: string
  availableBalance: number
  proposedAppliedAmount: number
  affectedComponentKeys: string[]
  sourceClause: string | null
}

export type CreditApplicationOutcome =
  | { status: 'none' }
  | { status: 'applied'; creditLineItems: CreditLineItem[] }
  | { status: 'blocked'; reason: string; proposed: ProposedCreditApplication[] }

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Never pulls usage from before the contract was actually in effect, even
// when the trigger window itself is a fixed calendar boundary (e.g. a
// contract starting 17 Aug still only measures a "calendar month" trigger
// from the 17th on, not from the 1st) — a data-correctness clamp, not a
// policy choice. Whether a clamped/partial first window still counts toward
// a consecutive-windows streak is a separate, genuinely open question left
// to earn_rule.requires_confirmation, not decided here.
function clampToContractEffectivePeriod(
  window: { start: Date; end: Date }, contractStart: Date | null, contractEnd: Date | null,
): { start: Date; end: Date } {
  let { start, end } = window
  if (contractStart && start < contractStart) start = contractStart
  if (contractEnd && end > contractEnd) end = contractEnd
  return { start, end }
}

async function pullMetricUsageForWindow(params: {
  orgId: string; meterKey: string; customerId: string; windowStart: Date; windowEnd: Date
}): Promise<number> {
  // Step 17D.1, item A — org_id is the sole ownership column; a genuine
  // Verdix-platform system meter (is_platform_meter) resolves for any
  // calling org, never via a bare org_id IS NULL convention.
  const { data: meterDef } = await supabaseServer
    .from('billing_meters')
    .select('pull_endpoint_url, pull_auth_token, pull_param_name, mode, test_usage_value, connector, response_metric_key')
    .or(`is_platform_meter.eq.true,org_id.eq.${params.orgId}`)
    .eq('meter_key', params.meterKey)
    .maybeSingle()

  if (!meterDef) return 0
  if (meterDef.mode === 'test') return meterDef.test_usage_value ?? 0
  if (meterDef.connector === 'remembill') {
    try {
      const readings = await createRemembillUsageConnector(params.orgId).pullUsage({
        customerId: params.customerId, periodStart: params.windowStart, periodEnd: params.windowEnd,
      })
      const metricKey = meterDef.response_metric_key ?? params.meterKey.toUpperCase()
      return readings.find(r => r.metric === metricKey)?.quantity ?? 0
    } catch (err) {
      console.error(`[credit-ledger-service] remembill pull failed for meter '${params.meterKey}'`, err)
      return 0
    }
  }
  if (!meterDef.pull_endpoint_url) return 0
  const pullUrl = new URL(meterDef.pull_endpoint_url)
  pullUrl.searchParams.set('customer_id', params.customerId)
  pullUrl.searchParams.set('period_start', String(Math.floor(params.windowStart.getTime() / 1000)))
  pullUrl.searchParams.set('period_end', String(Math.floor(params.windowEnd.getTime() / 1000) + 86_399))
  pullUrl.searchParams.set(meterDef.pull_param_name ?? 'billing_parameter', params.meterKey)
  const pullHeaders: Record<string, string> = {}
  if (meterDef.pull_auth_token) pullHeaders['Authorization'] = `Bearer ${meterDef.pull_auth_token}`
  const res = await fetch(pullUrl.toString(), { headers: pullHeaders })
  if (!res.ok) return 0
  const data = await res.json() as { total_billable_units?: number | string }
  return Number(data.total_billable_units ?? 0)
}

// The Annual Rebate's basis is "transaction-processing fees PAID for that
// Contract Year" — confirmed via app/api/stripe/webhook/route.ts and
// app/api/remembill/webhook/route.ts that planned_invoices.status is
// reliably set to 'paid' by real payment webhooks, not assumed. Sums the
// matching overage_line_items component only from invoices whose payment is
// actually confirmed as of today — unpaid invoices in the window simply
// don't contribute yet, recomputed fresh on every pass.
//
// 2026-08-30 audit fix — matches by CANONICAL COMMERCIAL CLASS, never by raw
// string equality between the earning basis and a line item's OPERATIONAL
// identity, exactly the same principle lib/commercial-component-scope.ts
// already established for application scope (lib/credit-ledger.ts's
// filterEligibleComponents). Confirmed as a real, live bug: the prior
// implementation compared `basis_component` (a full free-text clause
// fragment, e.g. "transaction-processing fees actually paid for that
// Contract Year") against `item.meter_key` (an arbitrary org-chosen
// operational identifier — Contract B's real transaction-processing meter
// is literally named 'sync') via exact Set membership — these two strings
// can never be equal for any real contract, so the rebate's paid basis
// would have silently summed to zero forever, even once real payments
// exist. eligibleClasses is resolved by the caller from
// application_rule.computed_from_component_keys (the pre-existing,
// already-extracted, canonical-token field for "what this % is computed
// from" — a genuinely separate question from eligible_component_keys,
// which governs what the credit may later be APPLIED against; see
// isPaidBasisFinalizationApplicable's own module for the earning-basis vs.
// application-scope distinction). item.contractUnitType — persisted
// verbatim into planned_invoices.overage_line_items at send time
// (lib/usage-pull.ts's OverageLineItem, sourced from contract_meter_
// mappings, never from the operational meter_key) — is what's classified
// here, mirroring invoice-scheduler's own PoolComponent.componentClass
// resolution exactly. An empty/unresolvable eligibleClasses set (a legacy
// record with no computed_from_component_keys, or a genuinely unknown
// token) fails closed to zero — never falls back to matching everything,
// and never falls back to the old meter_key comparison.
// Resolves application_rule.computed_from_component_keys (the pre-existing,
// already-extracted canonical-token field for "what this credit's %-basis
// is computed from") into the closed CommercialComponentClass vocabulary —
// exported and pure so it's directly unit-testable, and so
// isPaidBasisFinalizationApplicable's own "earning basis vs. application
// scope" boundary has exactly one implementation on the earning side, same
// discipline as lib/credit-ledger.ts's filterEligibleComponents on the
// application side. Empty/unresolvable input resolves to an empty set,
// which sumPaidLineItemsForClasses below treats as fail-closed (matches
// nothing, never everything).
export function resolveEarningBasisClasses(
  applicationRule: { computed_from_component_keys?: string[] | null } | null | undefined,
): Set<CommercialComponentClass> {
  return new Set(
    (applicationRule?.computed_from_component_keys ?? [])
      .map(resolveScopeTokenClass)
      .filter((c): c is CommercialComponentClass => c !== null),
  )
}

// The actual classification + summing logic, kept separate from the DB
// fetch below (sumPaidComponentAmountForWindow) so it's directly unit-
// testable without a database — same pure/imperative split this file's own
// header describes for the rest of the codebase (lib/tariff.ts vs.
// lib/usage-pull.ts). item.contractUnitType — persisted verbatim into
// planned_invoices.overage_line_items at send time (lib/usage-pull.ts's
// OverageLineItem, sourced from contract_meter_mappings, never from the
// operational meter_key) — is what's classified, mirroring invoice-
// scheduler's own PoolComponent.componentClass resolution exactly.
export function sumPaidLineItemsForClasses(
  rows: Array<{ overage_line_items: Array<{ meter_key: string; amount: number; contractUnitType?: string | null }> | null }>,
  eligibleClasses: Set<CommercialComponentClass>,
): number {
  if (eligibleClasses.size === 0) return 0
  let totalMinor = 0
  for (const row of rows) {
    for (const item of row.overage_line_items ?? []) {
      const cls = classifyContractUnitType(item.contractUnitType)
      if (cls !== null && eligibleClasses.has(cls)) totalMinor += toMinorUnits(item.amount)
    }
  }
  return totalMinor
}

async function sumPaidComponentAmountForWindow(params: {
  jobId: string; windowStart: Date; windowEnd: Date; eligibleClasses: Set<CommercialComponentClass>
}): Promise<number> {
  if (params.eligibleClasses.size === 0) return 0

  const { data: rows } = await supabaseServer
    .from('planned_invoices')
    .select('overage_line_items, status, period_start')
    .eq('job_id', params.jobId)
    .eq('status', 'paid')
    .gte('period_start', fmtDate(params.windowStart))
    .lte('period_start', fmtDate(params.windowEnd))

  return sumPaidLineItemsForClasses(
    (rows ?? []) as Array<{ overage_line_items: Array<{ meter_key: string; amount: number; contractUnitType?: string | null }> | null }>,
    params.eligibleClasses,
  )
}

function creditBasisToValues(interp: ServiceCreditInterpretation): {
  flatMinor: number | null; pctBp: number | null; perUnitMinor: number | null
} {
  const value = interp.credit_value ?? 0
  switch (interp.credit_basis) {
    case 'flat_amount':          return { flatMinor: toMinorUnits(value), pctBp: null, perUnitMinor: null }
    case 'pct_of_period_fee':
    case 'pct_of_affected_component': return { flatMinor: null, pctBp: Math.round(value * 100), perUnitMinor: null }
    case 'usage_units':          return { flatMinor: null, pctBp: null, perUnitMinor: toMinorUnits(value) }
    default:                     return { flatMinor: null, pctBp: null, perUnitMinor: null }
  }
}

// Earning pass for one credit: enumerates closed trigger windows in
// [scanStart, scanEnd], pulls/measures each, writes a trigger_check snapshot
// always, and an earn row only once a window both meets the threshold AND
// (for the Annual Rebate specifically) has reached its finalization
// deadline — see CreditEarnRule.finalization_deadline_days.
// Exported so the credit finalization sweep (app/api/admin/
// credit-finalization-sweep/route.ts) can re-invoke this EXACT function for
// a specific pending window, rather than duplicating its logic — the sweep
// and applyCreditLedgerForPeriod's own per-invoice earning pass are the
// same operation, just triggered from two different places (a due
// planned_invoice vs. a periodic re-check of a still-pending trigger_check
// window with no planned_invoice involved at all).
export async function runEarningPass(params: {
  jobId: string; orgId: string; terms: ContractTerms; customerId: string
  credit: ServiceCredit; scanStart: Date; scanEnd: Date; today: Date
}): Promise<void> {
  const interp = params.credit.interpretation
  const creditRuleId = params.credit.credit_rule_id
  if (!interp?.earn_rule || !interp.application_rule || !creditRuleId) return
  const earnRule = interp.earn_rule

  const contractStart = params.terms.contract_start_date ? new Date(params.terms.contract_start_date + 'T00:00:00') : null
  const contractEnd = params.terms.contract_end_date ? new Date(params.terms.contract_end_date + 'T00:00:00') : null
  const anchorDate = contractStart ?? params.scanStart
  const anchorMode: CadenceAnchorMode = earnRule.window_anchor === 'calendar' ? 'calendar' : 'contract_start'

  const cadence = earnRule.trigger_window === 'calendar_month' ? 'monthly'
    : earnRule.trigger_window === 'contract_year' ? 'annual'
    : null

  const windows = cadence
    ? enumerateCadenceWindows(anchorDate, cadence, params.scanStart, params.scanEnd, anchorMode)
    : [{ start: params.scanStart, end: params.scanEnd }]

  const { flatMinor, pctBp, perUnitMinor } = creditBasisToValues(interp)
  const capMinor = interp.cap_amount != null ? toMinorUnits(interp.cap_amount) : null

  for (const window of windows) {
    const clamped = clampToContractEffectivePeriod(window, contractStart, contractEnd)

    // Prior streak state, read from the last trigger_check snapshot for the
    // immediately preceding window — persisted forward window to window so
    // a multi-window streak (Growth Credit's "3 consecutive months") can be
    // picked back up correctly across separate scheduler runs.
    const { data: priorChecks } = await supabaseServer
      .from('credit_ledger_entries')
      .select('window_start, details')
      .eq('job_id', params.jobId).eq('credit_rule_id', creditRuleId)
      .eq('entry_type', 'trigger_check')
      .lt('window_start', fmtDate(window.start))
      .order('window_start', { ascending: false })
      .limit(1)
    const priorConsecutive = (priorChecks?.[0]?.details as { consecutiveWindowsMet?: number } | undefined)?.consecutiveWindowsMet ?? 0

    const { data: existingEarn } = await supabaseServer
      .from('credit_ledger_entries')
      .select('id')
      .eq('job_id', params.jobId).eq('credit_rule_id', creditRuleId)
      .eq('entry_type', 'earn').eq('window_start', fmtDate(window.start))
      .maybeSingle()

    const { data: anyEarnEver } = await supabaseServer
      .from('credit_ledger_entries')
      .select('id')
      .eq('job_id', params.jobId).eq('credit_rule_id', creditRuleId)
      .eq('entry_type', 'earn')
      .limit(1)

    let measuredQuantity = 0
    let computedFromAmountMinor = 0
    if (earnRule.trigger_metric_key) {
      measuredQuantity = await pullMetricUsageForWindow({
        orgId: params.orgId, meterKey: earnRule.trigger_metric_key, customerId: params.customerId,
        windowStart: clamped.start, windowEnd: clamped.end,
      })
    }
    if (pctBp != null && interp.basis_component) {
      // Earning basis, classified through the SAME canonical taxonomy
      // application scope uses (lib/commercial-component-scope.ts) — never
      // collapsed INTO application scope, though: eligible_component_keys
      // (what this credit may reduce) is read nowhere here.
      // computed_from_component_keys answers a different, earning-only
      // question ("what is the % computed from") and is resolved
      // independently. Contract B: eligible_component_keys includes
      // platform_subscription_fees (the rebate may be APPLIED against the
      // platform fee later), but computed_from_component_keys is
      // ['transaction_processing_fees'] only — platform fees must never
      // leak into the earning sum just because they're an eligible
      // application target.
      //
      // 2026-08-30 correction — WHICH sum function runs (if any) is now
      // gated on monetary_basis_recognition, the sole trusted source for
      // "what monetary state does this % apply to" (never on credit_basis
      // type alone — see lib/paid-basis-finalization.ts). 'paid' uses the
      // real, corrected paid-amount sum. 'component_amount' and unresolved
      // both leave computedFromAmountMinor at 0 — never a guessed number —
      // because canFreezeMonetaryBasisEarn (below) already prevents either
      // case from ever freezing into an immutable earn; only the
      // provisional trigger_check preview would otherwise show a
      // fabricated figure for a basis Verdix cannot yet correctly compute.
      if (interp.monetary_basis_recognition === 'paid') {
        computedFromAmountMinor = await sumPaidComponentAmountForWindow({
          jobId: params.jobId, windowStart: window.start, windowEnd: window.end,
          eligibleClasses: resolveEarningBasisClasses(interp.application_rule),
        })
      }
    }

    const evaluation = evaluateCreditEarn({
      earnRule, measuredTriggerQuantity: measuredQuantity, computedFromAmountMinor,
      creditValueFlatMinor: flatMinor, creditValuePctBp: pctBp, creditValuePerUnitMinor: perUnitMinor,
      capAmountMinor: capMinor, priorConsecutiveWindowsMet: priorConsecutive,
      isOneTime: interp.application_rule.one_time === true, alreadyEarnedOnce: !!anyEarnEver?.length,
    })

    // trigger_check: always written (or refreshed, same-day), the audit
    // trail of how the basis evolved — upsert so a same-day retry updates
    // this snapshot rather than being rejected by the unique index.
    await supabaseServer.from('credit_ledger_entries').upsert({
      job_id: params.jobId, org_id: params.orgId, credit_rule_id: creditRuleId,
      entry_type: 'trigger_check', window_start: fmtDate(window.start), window_end: fmtDate(window.end),
      evaluation_date: fmtDate(params.today), currency: interp.currency ?? params.terms.currency ?? 'EUR',
      measured_quantity: measuredQuantity, threshold_met: evaluation.earned || evaluation.consecutiveWindowsMetAfterThis > 0,
      amount_minor: evaluation.earnedAmountMinor,
      source_clause: params.credit.source_clause,
      commercial_rule_interpretation_id: null,
      details: { consecutiveWindowsMet: evaluation.consecutiveWindowsMetAfterThis, reason: evaluation.reason },
    }, { onConflict: 'job_id,credit_rule_id,window_start,evaluation_date' })

    if (!evaluation.earned || existingEarn) continue

    // Finalization deadline: the Annual Rebate's basis stays provisional
    // (trigger_check only) until window_end + finalization_deadline_days is
    // reached — only then does the earn row (frozen, one-time-only per
    // window via the unique index) get written. Credits with no deadline
    // finalize the moment their window closes.
    //
    // This is currently implemented as a mandatory WAIT ("do not finalize
    // before window_end + N days") for every credit that sets this field —
    // today, only Contract-B-shaped paid-basis rebates do. That is NOT what
    // finalization_deadline_days is documented to mean in general (see its
    // own doc comment in lib/types.ts: "a deadline, not a mandatory wait" —
    // an upper bound, "finalize no later than N days"). Do not read this
    // block as license to assume every finalization_deadline_days is
    // inherently a wait — it happens to produce the right paid-basis
    // behavior for deadline_cutoff (below) today, but a future credit that
    // sets this field for an unrelated reason should not inherit a wait
    // it never asked for without a fresh audit. Left exactly as-is per
    // that audit's explicit instruction not to globally reinterpret it as
    // collateral work here.
    if (earnRule.finalization_deadline_days != null) {
      const deadline = new Date(window.end)
      deadline.setDate(deadline.getDate() + earnRule.finalization_deadline_days)
      if (params.today < deadline) continue
    }

    // Monetary basis recognition + paid-basis finalization (2026-08-24 ->
    // 2026-08-30 audit) — reaching the deadline above is necessary but not
    // sufficient to freeze a percentage-of-component basis: Verdix must
    // first know WHAT monetary state that basis represents
    // (monetary_basis_recognition — never inferred from credit_basis type
    // or from this file's own status='paid' query), and if it's 'paid',
    // WHEN it's complete enough to freeze (paid_basis_finalization_policy
    // — a reviewer decision this codebase never invents). Unresolved
    // monetary_basis_recognition, 'component_amount' (no verified
    // execution path today), unresolved paid_basis_finalization_policy,
    // and 'full_attribution' (no invoice-terminality model) all mean:
    // never freeze. The credit-finalization-sweep keeps rediscovering this
    // window from its trigger_check row (written above regardless) every
    // day until a 'paid' + 'deadline_cutoff' resolution exists.
    if (!canFreezeMonetaryBasisEarn(interp)) continue

    await supabaseServer.from('credit_ledger_entries').insert({
      job_id: params.jobId, org_id: params.orgId, credit_rule_id: creditRuleId,
      entry_type: 'earn', window_start: fmtDate(window.start), window_end: fmtDate(window.end),
      amount_minor: evaluation.earnedAmountMinor, currency: interp.currency ?? params.terms.currency ?? 'EUR',
      measured_quantity: measuredQuantity, threshold_met: true,
      is_one_time: interp.application_rule.one_time === true,
      source_clause: params.credit.source_clause,
      details: { reason: evaluation.reason },
    })
  }
}

async function availableBalanceMinor(jobId: string, creditRuleId: string, periodStart: string): Promise<number> {
  const { data: rows } = await supabaseServer
    .from('credit_ledger_entries')
    .select('entry_type, amount_minor, status, window_end')
    .eq('job_id', jobId).eq('credit_rule_id', creditRuleId)
    .in('entry_type', ['earn', 'application'])

  let earned = 0, consumed = 0
  for (const row of rows ?? []) {
    if (row.entry_type === 'earn' && row.window_end < periodStart) earned += row.amount_minor
    if (row.entry_type === 'application' && (row.status === 'reserved' || row.status === 'applied')) consumed += row.amount_minor
  }
  return Math.max(0, earned - consumed)
}

// The main entry point, called from invoice-scheduler per due 'period'
// invoice. Runs the earning pass for every confirmed credit on the job,
// computes what (if anything) should apply against this period's real
// component pool, and — critically — checks the downstream platform's
// verified credit-representation capability BEFORE ever reserving anything.
// A Remembill job whose calculated invoice needs a credit and has no
// verified representation returns 'blocked' having reserved nothing at all;
// the caller must not send that invoice.
export async function applyCreditLedgerForPeriod(params: {
  jobId: string; orgId: string; terms: ContractTerms; customerId: string; billingPlatform: string
  plannedInvoiceId: string; periodStart: string; periodEnd: string
  fullComponentPool: PoolComponent[]
  scanStart: Date; scanEnd: Date
}): Promise<CreditApplicationOutcome> {
  const credits = (params.terms.service_credits ?? []).filter(c => c.interpretation?.earn_rule && c.interpretation?.application_rule && c.credit_rule_id)
  if (credits.length === 0) return { status: 'none' }

  const today = new Date()
  for (const credit of credits) {
    await runEarningPass({
      jobId: params.jobId, orgId: params.orgId, terms: params.terms, customerId: params.customerId,
      credit, scanStart: params.scanStart, scanEnd: params.scanEnd, today,
    })
  }

  // Resolve application order for any overlapping credits (3b) — credits
  // whose priority is genuinely needed but unconfirmed are excluded, same
  // as any other unresolved application_rule.
  const resolvableCredits = credits.filter(c => c.interpretation!.application_rule!.requires_confirmation === false)
  const priorityNeed = detectCreditPriorityNeed(resolvableCredits.map(c => ({
    credit_rule_id: c.credit_rule_id!, application_rule: c.interpretation!.application_rule!,
  })))
  const confirmedOrder = params.terms.credit_application_priority?.requires_confirmation === false
    ? params.terms.credit_application_priority.order
    : null
  let applicationOrder: string[]
  if (!priorityNeed.needed) {
    applicationOrder = resolvableCredits.map(c => c.credit_rule_id!)
  } else if (confirmedOrder) {
    applicationOrder = confirmedOrder.filter(id => resolvableCredits.some(c => c.credit_rule_id === id))
  } else {
    // Priority is needed but unconfirmed — only the conflicting credits are
    // blocked; anything outside the conflict set can still proceed.
    applicationOrder = resolvableCredits
      .map(c => c.credit_rule_id!)
      .filter(id => !priorityNeed.conflictingIds.includes(id))
  }

  // ── Gross computation (always safe — no reservation, no DB write beyond
  // the earning pass above) ────────────────────────────────────────────────
  let remainingPool = params.fullComponentPool.map(c => ({ ...c }))
  const proposals: Array<{ credit: ServiceCredit; requestedAmountMinor: number; matchedComponentKeys: string[]; availableBalanceMinor: number }> = []
  for (const creditRuleId of applicationOrder) {
    const credit = resolvableCredits.find(c => c.credit_rule_id === creditRuleId)!
    const balance = await availableBalanceMinor(params.jobId, creditRuleId, params.periodStart)
    const { requestedAmountMinor, matchedComponentKeys } = computeRequestedCreditApplication({
      applicationRule: credit.interpretation!.application_rule!,
      remainingPool, lastKnownBalanceMinor: balance,
    })
    proposals.push({ credit, requestedAmountMinor, matchedComponentKeys, availableBalanceMinor: balance })
    if (requestedAmountMinor > 0) {
      const { remainingPool: next } = consumePool(remainingPool, matchedComponentKeys, requestedAmountMinor)
      remainingPool = next
    }
  }

  const totalProposedMinor = proposals.reduce((s, p) => s + p.requestedAmountMinor, 0)
  if (totalProposedMinor === 0) return { status: 'none' }

  // ── Fail-closed capability gate — checked BEFORE any reservation ────────
  const capability = getCreditRepresentationCapability(params.billingPlatform)
  if (capability === 'unsupported_pending_vendor_guidance') {
    return {
      status: 'blocked',
      reason: `Billing blocked: this invoice requires a contractual credit, but the configured ${params.billingPlatform} integration does not currently have a verified credit-adjustment method.`,
      proposed: proposals.filter(p => p.requestedAmountMinor > 0).map(p => ({
        credit_rule_id: p.credit.credit_rule_id!,
        description: p.credit.description,
        availableBalance: fromMinorUnits(p.availableBalanceMinor),
        proposedAppliedAmount: fromMinorUnits(p.requestedAmountMinor),
        affectedComponentKeys: p.matchedComponentKeys,
        sourceClause: p.credit.source_clause,
      })),
    }
  }

  // ── Real, atomic reservation — only reached once we know delivery is
  // actually possible ──────────────────────────────────────────────────────
  const creditLineItems: CreditLineItem[] = []
  let pool = params.fullComponentPool.map(c => ({ ...c }))
  for (const creditRuleId of applicationOrder) {
    const credit = resolvableCredits.find(c => c.credit_rule_id === creditRuleId)!
    const balance = await availableBalanceMinor(params.jobId, creditRuleId, params.periodStart)
    const { requestedAmountMinor, matchedComponentKeys } = computeRequestedCreditApplication({
      applicationRule: credit.interpretation!.application_rule!, remainingPool: pool, lastKnownBalanceMinor: balance,
    })
    if (requestedAmountMinor <= 0) continue
    const { consumed, remainingPool: next } = consumePool(pool, matchedComponentKeys, requestedAmountMinor)
    pool = next

    // reserve_credit_balance is `returns setof credit_ledger_entries` — a
    // zero-amount reservation yields zero rows ([]), never a null-fields
    // object, which is the only way to distinguish "no-op" from "a real
    // reservation" unambiguously over PostgREST (a single-row nullable
    // composite return serializes as an all-null object, not JSON null).
    const { data: reservedRows, error } = await supabaseServer.rpc('reserve_credit_balance', {
      p_job_id: params.jobId, p_credit_rule_id: creditRuleId, p_planned_invoice_id: params.plannedInvoiceId,
      p_period_start: params.periodStart, p_requested_amount_minor: requestedAmountMinor,
      p_currency: credit.interpretation!.currency ?? params.terms.currency ?? 'EUR',
      p_details: { consumed: consumed.map(c => ({ key: c.key, amount_minor: c.amountMinor })) },
      p_is_one_time: credit.interpretation!.application_rule!.one_time === true,
      p_source_clause: credit.source_clause,
      p_commercial_rule_interpretation_id: null,
    })
    if (error) {
      console.error(`[credit-ledger-service] reserve_credit_balance failed for credit ${creditRuleId}`, error)
      continue
    }
    const reserved = reservedRows?.[0]
    if (!reserved) continue // 0-amount no-op, per design — never a line item

    creditLineItems.push({
      credit_rule_id: creditRuleId,
      description: `Credit applied: ${fromMinorUnits(reserved.amount_minor).toLocaleString()} — ${credit.description}${credit.source_clause ? ` (clause: ${credit.source_clause.slice(0, 80)})` : ''}`,
      amount: -fromMinorUnits(reserved.amount_minor),
      currency: reserved.currency,
      consumed: consumed.map(c => ({ key: c.key, amount: fromMinorUnits(c.amountMinor) })),
      sourceClause: credit.source_clause,
    })
  }

  return creditLineItems.length > 0 ? { status: 'applied', creditLineItems } : { status: 'none' }
}
