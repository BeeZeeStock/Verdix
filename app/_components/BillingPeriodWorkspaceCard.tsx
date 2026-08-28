'use client'

// Step 17F (revised 17F.1) — the contract GUI's "operate billing by
// period" workspace. Surfaces the single currently-relevant billing period
// (the one containing today, or the first period before the contract has
// started) with its fixed/usage/performance components, readiness state,
// and known-vs-final totals.
//
// Step 17F.1, item 7 — REWRITTEN to consume the SAME authoritative
// execution services real billing uses, never a parallel GUI calculation:
//   - Usage-meter charges (both tiered overage AND flat per-unit fees, e.g.
//     the €0.38 per-request fee) come from GET /api/jobs/[id]/consumption-
//     summary, which itself calls lib/usage-pull.ts's computeOverageForPeriod
//     and lib/per-unit-fee-pull.ts's computePerUnitFeeLineItemsForPeriod in
//     LIVE PREVIEW mode (finalize omitted — never persists a snapshot; see
//     that route's own header). This is the exact function pair the real
//     invoice-scheduler cron calls with finalize:true at billing close —
//     same inputs, same math, only the finalize flag differs. The earlier
//     17F version computed its own quantity × rate projection
//     (lib/usage-charge-projection.ts) from a manually-typed "what-if"
//     quantity; that file/approach is retired — a GUI-side recomputation
//     of billing math is exactly what item 7 forbids.
//   - Performance share comes from GET /api/jobs/[id]/performance-share
//     (page.tsx's own existing fetch, passed down — no second request),
//     which itself calls lib/performance-share-fee.ts's
//     computePerformanceShareFee — the SAME function
//     lib/performance-share-pull.ts wraps for real invoice-scheduler
//     execution. Already consistent since Step 17E; unchanged here except
//     for variable_invoice_timing awareness (Step 17F.3, item 6, renamed
//     from variable_settlement_timing — Step 17F.1, item 6).
//   - lib/billing-period-workspace.ts for period bounds/fixed-fee amount
//     (billing-writer.ts's own Stage-A arithmetic)/readiness — unchanged.
//   - /api/jobs/[id]/operational-input-values (item 5) for this period's
//     manual-entry action, dates derived automatically — unchanged.
// Anchored with id={period.anchorId} for deep-linking (item 13).
import { useState, useCallback, useEffect } from 'react'
import {
  deriveBillingPeriod, computeFixedComponentForPeriod, buildBillingPeriodWorkspace,
  type UsageComponentState, type PerformanceComponentState,
} from '@/lib/billing-period-workspace'
import { buildPricingDependencyGroups, type PricingDependencyFee, type PricingDependencyTier } from '@/lib/pricing-dependency'
import { hasContractStarted } from '@/lib/performance-share-timing'
import type { UsageSourceCard } from '@/lib/usage-source-cards'
import type { ContractTerms } from '@/lib/types'

type PerformanceShareResult = {
  feeLabel: string
  status: 'ready' | 'waived' | 'not_ready' | 'invalid' | 'not_started'
  reason?: string
  missingKeys?: string[]
  amount?: number
}

// Mirrors GET /api/jobs/[id]/consumption-summary's own OverageLineItem
// response shape (lib/usage-pull.ts) — only the fields this card reads.
type ConsumptionOverageItem = {
  meter_key: string
  contractUnitType: string | null
  total_units: number
  rate_per_unit?: number
  amount: number
  description: string
}
type ConsumptionPeriod = {
  periodStart: string
  periodEnd: string
  status: 'past' | 'current' | 'pending' | 'future'
  overageItems: ConsumptionOverageItem[]
}

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}
function fmtUnit(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n)
}
function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const READINESS_LABEL: Record<string, { label: string; color: string; background: string }> = {
  upcoming:                       { label: 'Upcoming',                     color: '#6B7280', background: '#F3F4F6' },
  // Step 17F.3, item 3/14 — its own distinct label/state, never folded
  // into "Parked" — the fixed component's amount is known; only its
  // invoice DATE is unresolved.
  fixed_billing_timing_required:  { label: 'Billing timing: Decision required', color: '#B45309', background: '#FEF3C7' },
  waiting_for_usage:              { label: 'Waiting for usage',            color: '#7C3AED', background: '#F3E8FF' },
  // Step 17F.1, item 8 — displayed as "Parked" (the literal expected text
  // for "an applicable invoice component's required inputs are missing")
  // while the underlying readiness/BillingAction TYPE stays the distinct
  // 'waiting_for_operational_inputs' / 'missing_operational_input' (item
  // 10 requires these stay distinguishable from the narrower 'parked' —
  // no confirmed usage source at all — case). Display label only.
  waiting_for_operational_inputs: { label: 'Parked',                       color: '#B45309', background: '#FEF3C7' },
  parked:                         { label: 'Parked',                       color: '#DC2626', background: '#FEE2E2' },
  ready_to_invoice:                { label: 'Ready to invoice',            color: '#0B5C36', background: '#EEF9F2' },
  invoiced:                        { label: 'Invoiced',                    color: '#0B5C36', background: '#EEF9F2' },
}

function performanceStatusOf(r: PerformanceShareResult): PerformanceComponentState {
  const status: PerformanceComponentState['status'] =
    r.status === 'ready' ? 'computed'
    : r.status === 'waived' ? 'waived'
    : r.status === 'not_started' ? 'not_started'
    : 'pending_operational_inputs'
  return { feeLabel: r.feeLabel, status, missingKeys: r.missingKeys, amount: r.amount }
}

// Correlates one pricing-dependency usage-meter fact (lib/pricing-
// dependency.ts, derived from typed contract terms) with the matching REAL
// line item the consumption-summary route actually computed, by rate —
// this contract's three usage-meter rates (0.38, 0.60, 1.70) are each
// distinct, and rate is the one field both a tiered-overage item
// (lib/usage-pull.ts) and a flat per-unit-fee item (lib/per-unit-fee-
// pull.ts) reliably carry in the same units, unlike contractUnitType
// (a raw unit_type string for one producer, a canonical semantic key for
// the other — see per-unit-fee-pull.ts/usage-pull.ts's own item shapes).
function findMatchingConsumptionItem(fact: { ratePerUnit: number }, items: ConsumptionOverageItem[]): ConsumptionOverageItem | null {
  return items.find(i => typeof i.rate_per_unit === 'number' && Math.abs(i.rate_per_unit - fact.ratePerUnit) < 1e-9) ?? null
}

// Item 5 — dates are DERIVED from the billing period (read-only display),
// never typed by the reviewer. Same POST /operational-input-values
// endpoint ManualInputEntry itself calls — no second persistence path.
function PeriodOperationalInputEntry({ jobId, inputKey, periodStart, periodEnd }: {
  jobId: string; inputKey: string; periodStart: string; periodEnd: string
}) {
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('')
  const [saving, setSaving] = useState<'draft' | 'final' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const save = useCallback(async (isFinal: boolean) => {
    const numericValue = Number(value)
    if (value.trim() === '' || !Number.isFinite(numericValue)) { setMsg('Enter a numeric value first.'); return }
    setSaving(isFinal ? 'final' : 'draft')
    setMsg(null)
    const res = await fetch(`/api/jobs/${jobId}/operational-input-values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_key: inputKey, period_start: periodStart, period_end: periodEnd, value: numericValue, currency: currency.trim() || null, is_final: isFinal }),
    }).catch(() => null)
    setSaving(null)
    if (!res?.ok) { setMsg('Save failed — try again.'); return }
    setMsg(isFinal ? 'Marked final.' : 'Draft saved.')
  }, [jobId, inputKey, periodStart, periodEnd, value, currency])

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="number" placeholder="Value" value={value} onChange={e => setValue(e.target.value)}
        aria-label={`${inputKey} value`} className="text-[11px] border rounded px-1.5 py-1 w-24" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
      />
      <input
        type="text" placeholder="EUR" value={currency} onChange={e => setCurrency(e.target.value)}
        aria-label={`${inputKey} currency`} className="text-[11px] border rounded px-1.5 py-1 w-14" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
      />
      <button onClick={() => save(false)} disabled={saving !== null}
        className="text-[11px] font-medium text-stone hover:text-ink px-2 py-1 rounded border disabled:opacity-50" style={{ borderColor: 'rgba(26,61,43,0.15)' }}>
        {saving === 'draft' ? 'Saving…' : 'Save draft'}
      </button>
      <button onClick={() => save(true)} disabled={saving !== null}
        className="text-[11px] font-medium text-white px-2 py-1 rounded bg-forest hover:bg-sage disabled:opacity-50">
        {saving === 'final' ? 'Saving…' : 'Mark final'}
      </button>
      {msg && <p className="text-[10px] text-stone/70 w-full">{msg}</p>}
    </div>
  )
}

export function BillingPeriodWorkspaceCard({
  jobId, terms, currency, usageSourceCards, performanceShareResults,
}: {
  jobId: string
  terms: ContractTerms
  currency: string
  usageSourceCards: UsageSourceCard[]
  performanceShareResults: PerformanceShareResult[] | null
}) {
  const [consumptionPeriods, setConsumptionPeriods] = useState<ConsumptionPeriod[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/jobs/${jobId}/consumption-summary`)
      .then(r => r.json())
      .then((res: { periods?: ConsumptionPeriod[] }) => { if (!cancelled) setConsumptionPeriods(res.periods ?? []) })
      .catch(() => { if (!cancelled) setConsumptionPeriods([]) })
    return () => { cancelled = true }
  }, [jobId])

  const period = deriveBillingPeriod({ contractStartDate: terms.contract_start_date, billingFrequency: terms.billing_frequency, asOf: new Date() })
  if (!period) return null

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

  // The consumption-summary row whose window matches this workspace's
  // derived period — null while still loading, or when no billing
  // schedule exists yet for this contract (nothing to correlate against).
  const matchingConsumptionPeriod = consumptionPeriods?.find(p => p.periodStart === period.start) ?? null

  const usage: UsageComponentState[] = pricingGroups.usageMeter.map(fact => {
    if (!started) return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: fact.sourceName, status: 'awaiting_period' }
    if (!fact.sourceName) return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: null, status: 'awaiting_source' }
    if (consumptionPeriods === null) return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: fact.sourceName, status: 'pending_usage' }
    const item = matchingConsumptionPeriod ? findMatchingConsumptionItem(fact, matchingConsumptionPeriod.overageItems) : null
    if (!item) return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: fact.sourceName, status: 'pending_usage' }
    return { key: fact.key, label: fact.label, semanticInputKey: fact.semanticInputKey, sourceName: fact.sourceName, status: 'computed', quantity: item.total_units, amount: item.amount }
  })

  // performanceShareResults is the already-fetched /api/jobs/[id]/
  // performance-share response (page.tsx's own existing state, no second
  // fetch here) — null only while that request is still in flight, in
  // which case every percentage_of_basis component is shown as pending
  // rather than silently omitted.
  const performance: PerformanceComponentState[] = performanceShareResults
    ? performanceShareResults.map(performanceStatusOf)
    : pricingGroups.performanceBased.map(p => ({ feeLabel: p.label, status: 'pending_operational_inputs' as const }))

  const workspace = buildBillingPeriodWorkspace({ period, started, alreadyInvoiced: false, fixed, usage, performance })
  const readiness = READINESS_LABEL[workspace.readiness]

  return (
    <div id={period.anchorId} className="bg-white rounded-2xl border border-forest/10 overflow-hidden scroll-mt-6">
      <div className="p-6 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
        <div>
          <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Billing period workspace</h2>
          <p className="text-[13px] font-medium text-ink mt-1">{period.label}</p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full" style={{ color: readiness.color, background: readiness.background }}>
          {readiness.label}
        </span>
      </div>

      <div className="p-6 space-y-5">
        {/* Step 17F.3, item 9 — FIXED FEE is its own visually distinct
            stream from USAGE / PERFORMANCE below: the fixed component's
            eligibility date and the usage/performance measurement-close
            date are never the same fact, and must never be presented as
            one single "invoice date" for the whole period (item 1's audit
            finding — that used to be an unstated scheduler assumption,
            never contract truth). Billing timing shown per item 2/3: the
            contract-derived/reviewer-confirmed value verbatim, or an
            explicit "Decision required" — never inferred from cadence or
            payment terms, never silently defaulted. */}
        <div>
          <p className="text-[10px] font-semibold text-stone uppercase tracking-wide mb-1.5">Fixed fee</p>
          <p className="text-[13px] font-medium text-ink">{fmt(fixed.amount, currency)}</p>
          {fixed.waived && <p className="text-[11px] text-stone/60">Pilot waiver</p>}
          <p className="text-[11px] mt-1">
            <span className="text-stone">Billing timing: </span>
            {fixed.billingTiming.resolved ? (
              <span className="text-ink font-medium">
                {fixed.billingTiming.timing === 'bill_at_period_start' ? 'Bill at beginning of billing period' : 'Bill at end of billing period'}
              </span>
            ) : (
              <span className="font-medium" style={{ color: '#B45309' }}>Decision required</span>
            )}
          </p>
          {/* Step 17F.6, item 7 — the scheduler no longer treats
              period_start as the authoritative invoice date unconditionally
              (see lib/fixed-fee-invoice-scheduling.ts); the GUI must not
              either. A concrete date is only ever shown once billing timing
              is actually resolved, and reflects THAT resolution (start vs.
              end), never a hardcoded assumption. */}
          <p className="text-[11px] mt-0.5">
            <span className="text-stone">Planned invoice date: </span>
            {fixed.billingTiming.resolved ? (
              <span className="text-ink font-medium">{fmtDate(fixed.billingTiming.timing === 'bill_at_period_end' ? period.end : period.start)}</span>
            ) : (
              <span className="font-medium" style={{ color: '#B45309' }}>Pending decision</span>
            )}
          </p>
        </div>

        {(pricingGroups.usageMeter.length > 0 || pricingGroups.performanceBased.length > 0) && (
          <div className="pt-1" style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
            <p className="text-[10px] font-semibold text-stone uppercase tracking-wide mb-1.5 pt-3">Usage / performance</p>
            <p className="text-[11px] text-stone mb-3">Measurement period: {period.label}</p>

            {/* Usage components — real figures from GET consumption-summary
                (the SAME live-preview call the invoice-scheduler makes with
                finalize:true at billing close), never a GUI-side
                recomputation. Item 4 — structurally arrears-based: no
                "advance vs arrears" question is ever asked here, only
                whether the period has closed yet. */}
            {pricingGroups.usageMeter.length > 0 && (
              <div className="mb-3">
                <p className="text-[10px] font-semibold text-stone uppercase tracking-wide mb-1.5">Usage</p>
                <div className="space-y-2">
                  {usage.map(u => (
                    <div key={u.key} className="text-[12px]">
                      <p className="text-ink">{u.label}</p>
                      <p className="text-stone/60 text-[11px]">Source: {u.sourceName ?? 'Not yet confirmed'}</p>
                      {u.status === 'awaiting_period' && <p className="text-stone/50 text-[11px] italic">Awaiting billing period</p>}
                      {u.status === 'awaiting_source' && <p className="text-[11px]" style={{ color: '#B45309' }}>No confirmed usage source</p>}
                      {u.status === 'pending_usage' && <p className="text-stone/50 text-[11px] italic">Finalized after period close</p>}
                      {u.status === 'computed' && (
                        <p className="text-ink font-medium tabular-nums">
                          {u.quantity?.toLocaleString()} × {fmtUnit((pricingGroups.usageMeter.find(f => f.key === u.key)?.ratePerUnit) ?? 0, currency)} = {fmt(u.amount ?? 0, currency)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Performance component — item 5: structurally in arrears,
                waiting on period close + final operational inputs. No
                reviewer decision ever asks "is this determined in
                arrears" — only whether the required inputs are final yet. */}
            {pricingGroups.performanceBased.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-stone uppercase tracking-wide mb-1.5">Performance share</p>
                {performance.map(p => (
                  <div key={p.feeLabel} className="text-[12px]">
                    {p.status === 'not_started' && <p className="text-stone/60 text-[11px] italic">Awaiting first billing period</p>}
                    {p.status === 'pending_operational_inputs' && (
                      <>
                        <p className="text-stone/50 text-[11px] italic mb-1">Finalized after period close</p>
                        <p className="text-[11px]" style={{ color: '#B45309' }}>Pending operational inputs</p>
                        {(p.missingKeys ?? []).map(k => (
                          <div key={k} className="mt-1.5">
                            <p className="text-[11px] text-stone">{k}</p>
                            <PeriodOperationalInputEntry jobId={jobId} inputKey={k} periodStart={period.start} periodEnd={period.end} />
                          </div>
                        ))}
                      </>
                    )}
                    {p.status === 'computed' && <p className="text-ink font-medium">{fmt(p.amount ?? 0, currency)}</p>}
                    {p.status === 'waived' && <p className="text-stone/60 text-[11px]">Waived this period</p>}
                  </div>
                ))}
                {/* Item 6/7 — WHEN an already-determined performance charge
                    is invoiced is a separate, still-typed question from
                    whether it's determined in arrears (structural, shown
                    above via "Finalized after period close" only). Shown
                    only once genuinely relevant (a fee compiled with
                    percentage_of_basis) and only while unresolved — a
                    confirmed timing is display-neutral here (it just works). */}
                {(terms.additional_recurring_fees ?? []).some(f => f.percentage_of_basis && f.variable_invoice_timing?.requires_confirmation !== false) && (
                  <p className="text-[11px] mt-1.5" style={{ color: '#B45309' }}>Variable invoice timing: Decision required</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Known vs final total (item 7/10) */}
        <div className="pt-3" style={{ borderTop: '1px solid rgba(26,61,43,0.07)' }}>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-stone">Known fixed amount</span>
            <span className="text-ink font-medium tabular-nums">{fmt(fixed.amount, currency)}</span>
          </div>
          <div className="flex items-center justify-between text-[12px] mt-1">
            <span className="text-stone">Final total</span>
            <span className="text-ink font-semibold tabular-nums">{workspace.finalTotal != null ? fmt(workspace.finalTotal, currency) : 'TBD'}</span>
          </div>
          {workspace.missingDependencies.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: workspace.readiness === 'parked' ? '#DC2626' : '#B45309' }}>
                {(workspace.readiness === 'parked' || workspace.readiness === 'waiting_for_operational_inputs') ? 'Parked — missing:' : 'Missing:'}
              </p>
              <ul className="mt-1 space-y-0.5">
                {workspace.missingDependencies.map((d, i) => (
                  <li key={i} className="text-[11px] text-stone">• {d}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
