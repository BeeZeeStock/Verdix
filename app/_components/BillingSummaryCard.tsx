'use client'

import { useState, useEffect, useCallback } from 'react'
import { partialPeriodLabel } from '@/lib/cadence-labels'
import { useVatConfig } from './useVatConfig'
import { resolveInvoiceVatDisplay } from '@/lib/vat'
import { isGenuinelyIssuedInvoice, isManualOriginInvoice } from '@/lib/invoice-history-classification'
import { FinancialAmount } from './FinancialAmount'
import { EVIDENCE_RECORDED_LABELS, EVIDENCE_WAITING_LABELS } from '@/lib/billability-event-labels'
import { buildParkedTimelineEntry, type ParkedInvoiceSummary, type BillingTimelineEntry } from '@/lib/billing-timeline-entry'
import { derivePeriodExecutionModel, periodBoundsFromRange, PERIOD_READINESS_LABEL, type PeriodExecutionModel, type ConsumptionPeriodLike, type PerformanceShareResultLike } from '@/lib/billing-period-workspace'
import { buildFixedTile, buildUsageTile, buildPerformanceTile, buildDeferredItems, deriveMeasurementPhase, buildComponentDetailRows, type CategoryTile, type TileState } from '@/lib/billing-period-card-summary'
import { RollingBandMigrationCard, humanizeMechanismKind, type RollingBandMigrationConfig } from './RollingBandMigrationCard'
import { SourceClauseLink } from './SourceClauseLink'
import type { UsageSourceCard } from '@/lib/usage-source-cards'
import type { ContractTerms, UnsupportedCommercialMechanism } from '@/lib/types'

type SubscriptionInfo = {
  id: string
  status: string
  interval: string
  intervalCount: number
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  isTest: boolean
  dashboardUrl: string
}

type OverageLineItem = {
  meter_key: string
  total_units: number
  included_units: number
  billable_units?: number
  rate_per_unit?: number
  amount: number
  currency: string
  description: string
  metric_source: 'meter_pull' | 'client_pull' | 'manual_entry'
}

type InvoiceInfo = {
  id: string
  number: string | null
  status: string | null
  amount: number
  currency: string
  dueDate: string | null
  created: string
  periodEnd: string | null
  pdfUrl: string | null
  hostedUrl: string | null
  feeLabel?: string | null
  yearNum?: number | null
  scheduledDate?: string | null
  baseAmount?: number
  overageLineItems?: OverageLineItem[]
  overageTotal?: number
  quantity?: number | null
  unitPrice?: number | null
  errorMessage?: string | null
  // VAT snapshot — present only once invoice-scheduler has actually sent
  // this row (app/api/jobs/[id]/billing-summary/route.ts's PlannedRow
  // comment has the full rationale). null/undefined for a scheduled row,
  // meaning no snapshot exists yet — VAT must be computed live from the
  // CURRENT customer default for those, never treated as "no VAT".
  vatMode?: 'rate' | 'zero_rated' | null
  vatRatePct?: number | null
  vatSource?: 'customer_default' | 'override' | null
  netAmount?: number | null
  vatAmount?: number | null
  grossAmount?: number | null
}

type YearPayment = {
  year: number
  amount: number
  currency: string
  periodStart: string | null
  periodEnd: string | null
}

type OneTimeFee = {
  fee_label: string
  amount: number
  due_date?: string | null
  description?: string | null
}

// ParkedInvoiceSummary now lives in lib/billing-timeline-entry.ts (Step
// 17H.2A item 20) — the same shape, imported rather than duplicated, since
// that module's buildParkedTimelineEntry is what actually classifies these
// rows for this card's timeline.

type CommercialRuleEvent = {
  id: string; meterKey: string; mode: string; amount: number; currency: string
  cadence: string; windowStart: string; windowEnd: string
  partialPeriod: { isPartial: boolean; needsConfirmation: boolean; prorated: boolean } | null
  isDeterministic: boolean
}

const COMMITMENT_MODE_LABEL: Record<string, string> = {
  floor: 'Minimum floor', additive: 'Additive fee', minimum_spend: 'Spend commitment',
  prepaid_commitment: 'Prepaid commitment', minimum_quantity: 'Minimum quantity',
}

type Summary = {
  subscription: SubscriptionInfo
  invoices: InvoiceInfo[]
  annualDraftInvoices: InvoiceInfo[]
  oneTimeInvoices: InvoiceInfo[]
  commercialRuleEvents?: CommercialRuleEvent[]
  parkedInvoices?: ParkedInvoiceSummary[]
  paymentSchedule: YearPayment[] | null
  oneTimeFees: OneTimeFee[]
  contractStart: string | null
  currency: string
  paymentTermsDays: number | null
  computedInvoices: { external_invoice_id: string; status: string; total_amount: number; period_start: string }[]
  billingPlatform?: string
  hasOverageTerms?: boolean
  overageMeterTypes?: string[]
  // Step 17F.8 — when present and requires_confirmation, a not-yet-issued
  // 'subscription' timeline entry must show "Pending decision" instead of
  // a definite planned date (see renderEntry's dateLabel override below).
  fixedFeeBillingTiming?: { timing: string; requires_confirmation: boolean } | null
}

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

// Per-unit rates are often sub-cent for high-volume metrics — a fixed 2
// decimals rounds them to 0.00 and makes a real price look unset.
function fmtRate(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n)
}

function fmtDate(iso: string | null | undefined, opts?: Intl.DateTimeFormatOptions) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', opts ?? { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtShortDate(iso: string | null | undefined) {
  return fmtDate(iso, { month: 'short', year: 'numeric' })
}

// Step 17H.4B0D4H1B4E2.3 §3/4 — same transform the (now-retired) standalone
// Performance Share display used, for the numerator/denominator labels in
// the enriched "Performance / outcome" block below.
function humanizeKey(k: string) {
  return k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

// Step 17H.2C item 18/19 — provider display name derived from the actual
// billingPlatform value, never a hardcoded two-way isRememhill ? 'Remembill'
// : 'Stripe' assumption. Known platforms get their proper display casing;
// anything else (a future provider) still gets a truthful, readable name
// instead of silently mislabeling it as Stripe.
function providerDisplayName(platform: string | undefined): string {
  if (platform === 'remembill') return 'Remembill'
  if (platform === 'stripe') return 'Stripe'
  if (platform === 'chargebee') return 'Chargebee'
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'your billing provider'
}

function intervalLabel(interval: string, count: number) {
  if (interval === 'year'  && count === 1) return 'Annual'
  if (interval === 'month' && count === 1) return 'Monthly'
  if (interval === 'month' && count === 3) return 'Quarterly'
  if (interval === 'month' && count === 6) return 'Semi-annual'
  return `Every ${count} ${interval}${count > 1 ? 's' : ''}`
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, { icon: string; color: string; label: string }> = {
    active:        { icon: 'ti-circle-check',  color: '#27AE60', label: 'Active' },
    paid:          { icon: 'ti-circle-check',  color: '#27AE60', label: 'Paid' },
    open:          { icon: 'ti-clock',         color: '#D97706', label: 'Awaiting payment' },
    draft:         { icon: 'ti-circle-dashed', color: '#9CA3AF', label: 'Draft' },
    past_due:      { icon: 'ti-alert-circle',  color: '#DC2626', label: 'Past due' },
    uncollectible: { icon: 'ti-alert-circle',  color: '#DC2626', label: 'Uncollectible' },
    void:          { icon: 'ti-circle-x',      color: '#9CA3AF', label: 'Void' },
    canceled:      { icon: 'ti-circle-x',      color: '#9CA3AF', label: 'Canceled' },
    pending:       { icon: 'ti-circle-dashed', color: '#9CA3AF', label: 'Pending' },
    failed:        { icon: 'ti-alert-triangle', color: '#DC2626', label: 'Push failed' },
    // A confirmed commercial rule whose cadence window hasn't closed yet —
    // deliberately distinct from "Draft" (an actual invoice row awaiting
    // issue): there's nothing to invoice yet, just a known future charge.
    scheduled:     { icon: 'ti-calendar-time', color: '#9CA3AF', label: 'Scheduled' },
    // Step 17H.2A items 8/9/10/14 — parked-invoice display states, minimally
    // extending this existing map rather than building a second parallel
    // status-to-icon system. Reuses ti-clock-pause (already the Parked
    // Invoices card's own header icon — no new icon shape introduced),
    // differentiated by color: amber for "still waiting" (matches the
    // existing 'open' semantic), indigo for "condition satisfied, waiting
    // on execution" (matches this file's existing Test-mode indigo accent —
    // deliberately not green/paid, since nothing has actually been billed
    // yet), neutral gray for a reusable template or an unrecognized shape.
    parked_awaiting_evidence: { icon: 'ti-clock-pause', color: '#D97706', label: 'Awaiting condition' },
    parked_evidence_recorded: { icon: 'ti-clock-pause', color: '#6366F1', label: 'Evidence recorded' },
    parked_manual_template:   { icon: 'ti-clock-pause', color: '#9CA3AF', label: 'Reusable template' },
    parked_unsupported:       { icon: 'ti-help-circle',  color: '#9CA3AF', label: 'Unrecognized' },
  }
  const s = status ?? 'unknown'
  const style = map[s] ?? { icon: 'ti-circle-dashed', color: '#9CA3AF', label: s }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: style.color }}>
      <i className={`ti ${style.icon}`} style={{ fontSize: 13 }} />
      {style.label}
    </span>
  )
}



export function BillingSummaryCard({ jobId, terms, usageSourceCards, onHasSchedule, onParkedInvoices, onSentOneTimeInvoices, onViewSource, onNavigateToOperationalInputs }: {
  jobId: string
  // Step 17H.2B item 3/6 — the same ContractTerms/UsageSourceCard[] page.tsx
  // already threads into BillingPeriodWorkspaceCard, so a recurring-period
  // timeline entry's enrichment joins against the identical inputs, never a
  // second independently-fetched/derived copy (item 33's parity
  // requirement depends on this — two different `terms` objects could
  // silently disagree). Optional/nullable so this card degrades gracefully
  // (no enrichment, exactly today's behavior) if a future caller doesn't
  // have them yet.
  terms?: ContractTerms | null
  usageSourceCards?: UsageSourceCard[]
  onHasSchedule?: (has: boolean) => void
  onParkedInvoices?: (invoices: ParkedInvoiceSummary[]) => void
  onSentOneTimeInvoices?: (invoices: { feeLabel: string | null; amount: number }[]) => void
  // Step 17H.4B0D4H1B4E2.4 §17 — small, pure plumbing (page.tsx's own
  // openPDF is already a one-line state-setter closure): lets the Rolling-
  // band evaluation section below offer a "View source clause" link back
  // to Commercial Logic's authoritative rule, the same affordance
  // SourceClauseLink already provides everywhere else. Never duplicates
  // the clause text itself — optional, degrades to no link if omitted.
  onViewSource?: (section: string) => void
  // Step E8.3 §4/§6 — Timeline is the period-status surface; Billing
  // Operations (the #operational-inputs-section anchor E6.1 already
  // introduced) remains the one authoritative manual-entry workspace. Same
  // plumbing shape as MeterMappingPanel's own onNavigateToOperationalInputs
  // (page.tsx already wires that one to a scrollIntoView) — never a second,
  // independently-invented navigation/persistence mechanism. Optional so
  // this card degrades to no CTA if a future caller doesn't have it yet.
  onNavigateToOperationalInputs?: () => void
}) {
  const [summary, setSummary]         = useState<Summary | null>(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [parking, setParking]         = useState<Set<string>>(new Set())
  const [syncing, setSyncing]         = useState(false)
  const [syncResult, setSyncResult]   = useState<{ checked: number; paid: number } | null>(null)
  const [expanded, setExpanded]       = useState<Set<string>>(new Set())
  // Step 17H.4B0D4H1B4E8 §10 — the period card's own "Calculation basis &
  // sources" disclosure, independent of `expanded` above (which gates the
  // whole period card's own expand/collapse). Collapsed by default for
  // every period; no auto-expand for the current/exception period in this
  // pass (§10/§25 — deliberately deferred, not implemented unsafely).
  const [expandedCalcBasis, setExpandedCalcBasis] = useState<Set<string>>(new Set())
  // For the net/VAT/gross breakdown on each invoice row below — same
  // canonical hook/endpoint every VAT surface in the product uses (see
  // useVatConfig's own comment), read-only here.
  const vat = useVatConfig(jobId)

  // Step 17H.2B item 3/7/15 — this card loads consumption-summary and
  // performance-share DIRECTLY, in its own effect, rather than depending on
  // another component (e.g. the standalone PerformanceShareDisplay) to
  // mount first and forward results via a callback — the exact dependency
  // 17H.1B/item 15 flagged for BillingPeriodWorkspaceCard's own
  // performanceShareResults prop. Proves that dependency isn't
  // architecturally required for the unified model; BillingPeriodWorkspace-
  // Card's own existing wiring is left unchanged (still kept temporarily
  // for parity comparison, per this step's explicit instruction).
  const [consumptionPeriods, setConsumptionPeriods] = useState<ConsumptionPeriodLike[] | null>(null)
  const [performanceShareResults, setPerformanceShareResults] = useState<PerformanceShareResultLike[] | null>(null)
  // Step 17H.2B.1 items 2/13/14 — Refresh's own "observed at" fact and
  // failure signal for the operational-measurement half of the refresh
  // (distinct from `error`/`loading`, which track the provider/invoice
  // half via billing-summary — item 13's "orchestrate safely rather than
  // one silently replacing the other").
  const [measurementRefreshedAt, setMeasurementRefreshedAt] = useState<Date | null>(null)
  const [measurementRefreshFailed, setMeasurementRefreshFailed] = useState(false)

  // Step 17H.2B.1 items 1/3/4/7 — this ONLY ever calls the two existing
  // read-only GET endpoints (never finalize:true, never the invoice writer
  // or scheduler). On failure, item 14: keep whatever was last successfully
  // loaded (functional setState with `?? []` — only the very first,
  // never-yet-loaded case falls back to empty) — a failed refresh must
  // never zero out or corrupt already-displayed measurement state.
  //
  // Deliberately NOT shared with the mount effect below (matching
  // useVatConfig.ts's own established precedent/comment on this exact
  // lint constraint: "Fetch defined inline inside the effect... save()
  // performs its own separate fetch-and-refresh rather than sharing this
  // closure") — the stricter set-state-in-effect rule requires an effect's
  // own state-setting logic to be inline, not an extracted callback.
  // Step 17H.2B.2 items 2-5 — Refresh calls the PRICING-FREE
  // /measurement-summary route (never /consumption-summary, which
  // internally still runs computeOverageForPeriod/computePerUnitFee-
  // LineItemsForPeriod's tier/rate math for 'current'/'pending' periods).
  // Its response covers ONLY 'current'/'pending' periods (items 8/9 — no
  // future polling, no closed-period re-poll) — merged BY periodStart into
  // whatever consumptionPeriods the initial mount load already has, so
  // 'past'-status periods (real, already-sent invoice data, zero pricing
  // computation of its own) are left exactly as they were, never re-fetched.
  const refreshMeasurementState = useCallback(async () => {
    const [measurementRes, performanceRes] = await Promise.allSettled([
      fetch(`/api/jobs/${jobId}/measurement-summary`).then(r => r.json()) as Promise<{ periods?: Array<{ periodStart: string; periodEnd: string; status: 'current' | 'pending'; measurements: Array<{ meter_key: string; rate_per_unit?: number; total_units: number; metric_source: 'meter_pull' | 'manual_entry' }> }> }>,
      fetch(`/api/jobs/${jobId}/performance-share`).then(r => r.json()) as Promise<{ fees?: PerformanceShareResultLike[] }>,
    ])
    if (measurementRes.status === 'fulfilled') {
      const measuredPeriods = measurementRes.value.periods ?? []
      setConsumptionPeriods(prev => {
        const byStart = new Map((prev ?? []).map(p => [p.periodStart, p]))
        for (const mp of measuredPeriods) {
          byStart.set(mp.periodStart, {
            periodStart: mp.periodStart, periodEnd: mp.periodEnd, status: mp.status,
            overageItems: mp.measurements.map(m => ({
              meter_key: m.meter_key, rate_per_unit: m.rate_per_unit, total_units: m.total_units,
              // No `amount` — the pricing-free path never computes one
              // (item 15's "Known amount must not be populated from a live
              // preview calculation").
              metric_source: m.metric_source,
            })),
            overageTotal: 0,
          })
        }
        return Array.from(byStart.values()).sort((a, b) => a.periodStart.localeCompare(b.periodStart))
      })
    } else {
      setConsumptionPeriods(prev => prev ?? [])
    }
    if (performanceRes.status === 'fulfilled') setPerformanceShareResults(performanceRes.value.fees ?? [])
    else setPerformanceShareResults(prev => prev ?? [])
    const anyFailed = measurementRes.status === 'rejected' || performanceRes.status === 'rejected'
    setMeasurementRefreshFailed(anyFailed)
    if (!anyFailed) setMeasurementRefreshedAt(new Date())
  }, [jobId])

  useEffect(() => {
    let cancelled = false
    async function doLoad() {
      const [consumptionRes, performanceRes] = await Promise.allSettled([
        fetch(`/api/jobs/${jobId}/consumption-summary`).then(r => r.json()) as Promise<{ periods?: ConsumptionPeriodLike[] }>,
        fetch(`/api/jobs/${jobId}/performance-share`).then(r => r.json()) as Promise<{ fees?: PerformanceShareResultLike[] }>,
      ])
      if (cancelled) return
      if (consumptionRes.status === 'fulfilled') setConsumptionPeriods(consumptionRes.value.periods ?? [])
      else setConsumptionPeriods(prev => prev ?? [])
      if (performanceRes.status === 'fulfilled') setPerformanceShareResults(performanceRes.value.fees ?? [])
      else setPerformanceShareResults(prev => prev ?? [])
      const anyFailed = consumptionRes.status === 'rejected' || performanceRes.status === 'rejected'
      setMeasurementRefreshFailed(anyFailed)
      if (!anyFailed) setMeasurementRefreshedAt(new Date())
    }
    doLoad()
    return () => { cancelled = true }
  }, [jobId])

  const toggleExpanded = (entryId: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
  }

  useEffect(() => {
    let cancelled = false
    async function doLoad() {
      try {
        const res = await fetch(`/api/jobs/${jobId}/billing-summary`)
        if (cancelled) return
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          setError(d.error ?? `Error ${res.status}`)
          onHasSchedule?.(false)
        } else {
          const data = await res.json()
          setSummary(data)
          onHasSchedule?.(Array.isArray(data.invoices) && data.invoices.length > 0)
          onParkedInvoices?.(data.parkedInvoices ?? [])
          onSentOneTimeInvoices?.(data.oneTimeInvoices ?? [])
        }
      } catch {
        if (!cancelled) setError('Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    doLoad()
    return () => { cancelled = true }
  }, [jobId, onHasSchedule, onParkedInvoices, onSentOneTimeInvoices])

  const handleRefresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    // Step 17H.2B.1 items 1/2/13 — Refresh now also retrieves the latest
    // OBSERVABLE operational measurement state (consumption-summary,
    // performance-share) alongside the existing provider/invoice refresh —
    // run independently (Promise.allSettled inside refreshMeasurementState)
    // so a measurement-fetch failure can never block or corrupt the
    // provider/invoice refresh, or vice versa. Neither call ever finalizes
    // anything (item 3/4) — both are the same plain GET the mount effect
    // already used, never the invoice writer/scheduler.
    const measurementPromise = refreshMeasurementState()
    try {
      const res = await fetch(`/api/jobs/${jobId}/billing-summary`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error ?? `Error ${res.status}`)
      } else {
        const data = await res.json()
        setSummary(data)
        onHasSchedule?.(Array.isArray(data.invoices) && data.invoices.length > 0)
        onParkedInvoices?.(data.parkedInvoices ?? [])
        onSentOneTimeInvoices?.(data.oneTimeInvoices ?? [])
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
    await measurementPromise
  }, [jobId, onHasSchedule, onParkedInvoices, onSentOneTimeInvoices, refreshMeasurementState])

  const handleSyncPayments = useCallback(async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/sync-payment-status`, { method: 'POST' })
      const data = await res.json() as { checked: number; paid: number; error?: string }
      if (!res.ok) {
        setSyncResult(null)
      } else {
        setSyncResult(data)
        if (data.paid > 0) await handleRefresh()
      }
    } catch {
      // silent — UI stays as-is
    } finally {
      setSyncing(false)
    }
  }, [jobId, handleRefresh])

  const isRememhill = summary?.billingPlatform === 'remembill'
  const hasSentInvoices = (summary?.invoices ?? []).some(i => i.status === 'sent')

  if (loading) return (
    <div className="bg-white rounded-2xl border border-forest/10 p-6 flex items-center gap-3">
      <div className="w-4 h-4 border-2 border-forest border-t-transparent rounded-full animate-spin" />
      <span className="text-[12px] text-stone">Loading billing configuration…</span>
    </div>
  )

  if (error) return (
    <div className="bg-white rounded-2xl border border-forest/10 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <i className="ti ti-alert-circle" style={{ fontSize: 14, color: '#D97706' }} />
          <span className="text-[12px] text-stone">{error}</span>
        </div>
        <button onClick={handleRefresh} className="text-[11px] font-semibold text-forest hover:text-sage transition-colors flex items-center gap-1">
          <i className="ti ti-refresh" style={{ fontSize: 11 }} /> Retry
        </button>
      </div>
    </div>
  )

  if (!summary) return null

  const { subscription: sub, invoices, annualDraftInvoices, oneTimeInvoices, commercialRuleEvents, parkedInvoices, paymentSchedule, oneTimeFees, currency, paymentTermsDays, contractStart, hasOverageTerms, overageMeterTypes, fixedFeeBillingTiming } = summary
  const meterTypes = overageMeterTypes ?? []


  return (
    <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
      {/* Header */}
      <div className="p-6 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
        <div>
          {/* Step 17H.4B0D4H1B4E2.3 §9/11, revised 17H.4B0D4H1B4E2.4 §18 —
              renamed from "Billing setup" (which collided with "Commercial
              Logic & Billing Setup"), then briefly "Billing execution"
              paired with a second, separate "Billing timeline" heading
              further down this same card — on audit, that read as two
              competing headings for what is structurally ONE section.
              This is now the ONE primary heading for the whole card
              ("Billing Timeline"); the inner heading below was removed
              (its descriptive subtitle stayed, as plain text — see that
              block's own comment). */}
          <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Billing Timeline</h2>
          {/* Step 17H.2C item 19 — "Invoice schedule managed via X" was
              too narrow (the timeline now also carries period execution,
              consumption, and conditional obligations, not just a
              schedule) and inconsistently worded between providers.
              Generic, dynamic phrasing: Verdix coordinates execution WITH
              whichever provider is configured, never hardcoded to two
              options. */}
          <p className="text-[11px] text-stone mt-1">
            Verdix coordinates billing execution with {providerDisplayName(summary?.billingPlatform)}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <StatusBadge status={sub.status} />
          {sub.isTest && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: '#6366F1' }}>
              <i className="ti ti-test-pipe" style={{ fontSize: 13 }} /> Test mode
            </span>
          )}
          {isRememhill && hasSentInvoices && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleSyncPayments}
                disabled={syncing}
                className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-xl transition-colors disabled:opacity-50"
                style={{ background: '#EEF9F2', color: '#1A3D2B', border: '1px solid rgba(74,124,89,0.25)' }}
              >
                <i className={`ti ti-refresh ${syncing ? 'animate-spin' : ''}`} style={{ fontSize: 11 }} />
                {syncing ? 'Checking…' : 'Refresh payments'}
              </button>
              {syncResult && (
                <span className="text-[11px]" style={{ color: syncResult.paid > 0 ? '#0B5C36' : '#6B7280' }}>
                  {syncResult.paid > 0 ? `${syncResult.paid} marked paid` : 'No new payments'}
                </span>
              )}
            </div>
          )}
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-xl transition-colors"
            style={{ background: '#EEF9F2', color: '#1A3D2B', border: '1px solid rgba(74,124,89,0.25)' }}
          >
            <i className="ti ti-refresh" style={{ fontSize: 11 }} /> Refresh
          </button>
        </div>
      </div>

      {/* Step 17H.2B.1 item 14 — surfaces a failed measurement refresh
          without corrupting or hiding whatever was last successfully
          loaded (refreshMeasurementState never resets state to empty on
          failure). Purely informational — never blocks the rest of the
          card. */}
      {measurementRefreshFailed && (
        <div className="px-6 py-2 flex items-center gap-1.5" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)', background: '#FFFBEB' }}>
          <i className="ti ti-alert-circle" style={{ fontSize: 12, color: '#B45309' }} />
          <p className="text-[10px]" style={{ color: '#B45309' }}>
            Couldn&apos;t refresh live measurement data — showing the last known values.
          </p>
        </div>
      )}

      {sub.cancelAtPeriodEnd && (
        <div className="px-6 py-2" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)', background: 'rgba(26,61,43,0.02)' }}>
          <p className="text-[10px] text-amber-600">Cancels at period end</p>
        </div>
      )}

      {/* Step 17G.3 — the editable VAT control that used to live here
          moved to the Contract Setup card's Billing details group (one
          VatConfigRow instance, same useVatConfig persistence, no second
          editable VAT source of truth). Per-invoice VAT breakdown
          (netAmount/vatAmount/grossAmount, via resolveInvoiceVatDisplay)
          shown further down in this card is unrelated and untouched — it
          reads real invoice-level VAT snapshots, not the editable
          current-default control. */}


      {/* ── Billing timeline ─────────────────────────────────────── */}
      {(() => {
        // Merge all invoices (subscription + one-time) into a unified chronological timeline
        type TLEntry = {
          id: string; label: string; dateLabel: string; date: Date; amount: number; currency: string
          status: string | null; hostedUrl?: string | null; pdfUrl?: string | null; kind: 'subscription' | 'one-time' | 'pending-setup' | 'commercial-rule'
          baseAmount: number; overageLineItems: OverageLineItem[]; overageTotal: number; description?: string | null
          quantity?: number | null; unitPrice?: number | null; errorMessage?: string | null
          // VAT snapshot — see InvoiceInfo's own comment for when this is
          // present vs. null (only once invoice-scheduler actually sent it).
          vatMode?: 'rate' | 'zero_rated' | null; vatRatePct?: number | null; vatSource?: 'customer_default' | 'override' | null
          netAmount?: number | null; vatAmount?: number | null; grossAmount?: number | null
          // Step 17F.8 — true only for entries representing the recurring
          // FIXED-FEE/period component (the sortedSubInvoices loop below) —
          // never overage, one-time fees, or commercial-rule entries. Only
          // these are subject to the fixedFeeBillingTiming override, since
          // that rule governs exclusively the fixed component's own
          // invoice-issuance date.
          isFixedFeeComponent?: boolean
          // commercial-rule only: a confirmed metric-level commitment whose
          // cadence window hasn't closed yet, so no real invoice row exists.
          commercialRule?: { meterKey: string; mode: string; cadence: string; windowEnd: string; partialPeriod: CommercialRuleEvent['partialPeriod']; isDeterministic: boolean }
          // Step 17H.2A item 18 — presentation-only; see
          // lib/invoice-history-classification.ts's isManualOriginInvoice
          // for why this is derived from already-persisted data (fee_label)
          // rather than a new schema field.
          isManualOrigin?: boolean
          // Step 17H.2B item 3/4 — set ONLY for a genuine recurring-period
          // entry (the sortedSubInvoices loop below, one real
          // planned_invoices 'period' row). Never set for annualDraftInvoices
          // (a multi-period aggregate, not one real period — enriching it
          // would misrepresent several periods as one), one-time/pending-
          // setup, or commercial-rule entries — item 4's "never create fake
          // periods for event-driven invoices" holds by construction: no
          // periodStart/periodEnd means no period-execution join is even
          // attempted for that entry.
          periodStart?: string | null
          periodEnd?: string | null
        }
        const entries: TLEntry[] = []

        // Helper: parse a contract date string as local midnight
        const contractDate = (iso: string | null | undefined): Date | null =>
          iso ? new Date(iso + 'T00:00:00') : null

        // Helper: planned issue date label — "Issued" only if the planned date is
        // in the past (the billing event has already occurred per the schedule).
        const dateLabel = (planned: Date) => planned <= new Date() ? 'Issued' : 'Will be issued'

        // Subscription invoices — sort oldest-first so index i maps to billing period i.
        // Stripe returns newest-first by default; reversing ensures month 1 → period 0, etc.
        // Date = contractStart + (i * billing interval), which is contract-centric and works
        // for both monthly and annual billing (unlike the old paymentSchedule index mapping,
        // which only had one entry per year and broke for monthly contracts).
        const sortedSubInvoices = [...invoices].sort(
          (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime()
        )
        const base = contractDate(contractStart)
        for (let i = 0; i < sortedSubInvoices.length; i++) {
          const inv = sortedSubInvoices[i]
          let planned: Date
          // New model: scheduled_date metadata is the authoritative period_start date.
          // Legacy subscription model: compute from contract start + billing interval index.
          if (inv.scheduledDate) {
            planned = new Date(inv.scheduledDate + 'T00:00:00')
          } else if (base) {
            const d = new Date(base)
            if (sub.interval === 'year') {
              d.setFullYear(d.getFullYear() + i * sub.intervalCount)
            } else {
              d.setMonth(d.getMonth() + i * sub.intervalCount)
            }
            planned = d
          } else {
            planned = new Date(inv.created)
          }
          // Label: use formatted period date for new-model entries (scheduledDate present),
          // or 'Subscription' for legacy subscription invoices.
          const label = inv.scheduledDate
            ? (sub.interval === 'year'
                ? `Year ${(inv.yearNum ?? i) || i + 1} base fee`
                : new Date(inv.scheduledDate + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }))
            : 'Subscription'
          entries.push({
            id: inv.id, label,
            dateLabel: dateLabel(planned), date: planned,
            amount: inv.amount, currency: inv.currency,
            status: inv.status, hostedUrl: inv.hostedUrl, pdfUrl: inv.pdfUrl, kind: 'subscription',
            baseAmount: inv.baseAmount ?? inv.amount,
            overageLineItems: inv.overageLineItems ?? [],
            overageTotal: inv.overageTotal ?? 0,
            errorMessage: inv.errorMessage ?? null,
            vatMode: inv.vatMode, vatRatePct: inv.vatRatePct, vatSource: inv.vatSource,
            netAmount: inv.netAmount, vatAmount: inv.vatAmount, grossAmount: inv.grossAmount,
            isFixedFeeComponent: true,
            // Only the new planned_invoices model carries real period
            // bounds (scheduledDate === row.period_start, periodEnd ===
            // row.period_end) — a legacy subscription-model invoice with no
            // scheduledDate has no real period row to join against.
            periodStart: inv.scheduledDate ?? null,
            periodEnd: inv.periodEnd ?? null,
          })
        }

        // Annual base-fee draft invoices — commitment view, one entry per year.
        // Only add to the timeline when billing is annual: for monthly contracts the
        // individual period rows above already give the right per-invoice granularity,
        // and the year aggregate would appear as a confusing extra lump-sum entry.
        if (sub.interval === 'year' || invoices.length === 0) {
          for (const inv of annualDraftInvoices) {
            const planned = inv.scheduledDate
              ? new Date(inv.scheduledDate + 'T00:00:00')
              : contractDate(paymentSchedule?.find(p => p.year === inv.yearNum)?.periodStart)
                ?? contractDate(contractStart)
                ?? new Date(inv.created)
            entries.push({
              id: inv.id, label: `Year ${inv.yearNum ?? '?'} commitment`,
              dateLabel: dateLabel(planned), date: planned,
              amount: inv.amount, currency: inv.currency,
              status: inv.status, hostedUrl: inv.hostedUrl, pdfUrl: inv.pdfUrl, kind: 'subscription',
              baseAmount: inv.baseAmount ?? inv.amount,
              overageLineItems: inv.overageLineItems ?? [],
              overageTotal: inv.overageTotal ?? 0,
              vatMode: inv.vatMode, vatRatePct: inv.vatRatePct, vatSource: inv.vatSource,
              netAmount: inv.netAmount, vatAmount: inv.vatAmount, grossAmount: inv.grossAmount,
              isFixedFeeComponent: true,
            })
          }
        }

        // One-time fee invoices — date from scheduledDate (new model) or contract fee's due_date.
        for (const inv of oneTimeInvoices) {
          const matchingFee = oneTimeFees.find(f => f.fee_label === inv.feeLabel)
          const planned = inv.scheduledDate
            ? new Date(inv.scheduledDate + 'T00:00:00')
            : contractDate(matchingFee?.due_date)
              ?? contractDate(contractStart)
              ?? new Date(inv.created)
          entries.push({
            id: inv.id, label: inv.feeLabel ?? 'One-time fee',
            dateLabel: dateLabel(planned), date: planned,
            amount: inv.amount, currency: inv.currency,
            status: inv.status, hostedUrl: inv.hostedUrl, pdfUrl: inv.pdfUrl, kind: 'one-time',
            baseAmount: inv.amount, overageLineItems: [], overageTotal: 0,
            description: matchingFee?.description ?? null,
            quantity: inv.quantity ?? null, unitPrice: inv.unitPrice ?? null,
            errorMessage: inv.errorMessage ?? null,
            isManualOrigin: isManualOriginInvoice(inv.feeLabel),
          })
        }

        // One-time fees not yet in Stripe — date from contract fee or contract start
        if (oneTimeInvoices.length === 0 && oneTimeFees.length > 0) {
          for (const fee of oneTimeFees) {
            const planned = contractDate(fee.due_date)
              ?? contractDate(contractStart)
              ?? new Date()
            entries.push({
              id: `pending-${fee.fee_label}`, label: fee.fee_label,
              dateLabel: 'Will be issued', date: planned,
              amount: fee.amount, currency,
              status: 'pending', kind: 'pending-setup',
              baseAmount: fee.amount, overageLineItems: [], overageTotal: 0,
              description: fee.description ?? null,
            })
          }
        }

        // Commercial-rule events — a confirmed additive/floor/etc. commitment
        // whose cadence window hasn't closed yet, so no real planned_invoices
        // row exists for it (real billing only writes one once the period
        // closes). Without this, the timeline silently contradicts
        // Commercial Logic & Billing Setup, which already shows the rule
        // as confirmed.
        for (const ev of commercialRuleEvents ?? []) {
          const windowStart = new Date(ev.windowStart + 'T00:00:00')
          const windowEnd   = new Date(ev.windowEnd   + 'T00:00:00')
          const cadenceLabel = ev.cadence === 'quarterly'
            ? `Q${Math.floor(windowStart.getMonth() / 3) + 1} ${windowStart.getFullYear()}`
            : ev.cadence === 'annual'
              ? `${windowStart.getFullYear()}`
              : windowStart.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
          entries.push({
            id: ev.id, label: `${cadenceLabel} · ${ev.meterKey} usage`,
            // The API only emits events whose window hasn't closed yet
            // (windowEnd >= today), so anchoring on windowEnd — roughly when
            // the arrears charge actually gets invoiced — guarantees this
            // always sorts into "upcoming", never "past", even for a window
            // already in progress (windowStart before today).
            // A floor/minimum_spend/etc. commitment isn't a promised invoice
            // amount — max(usage, threshold) isn't knowable until usage is
            // pulled — so this never claims "Scheduled" the way a
            // deterministic additive fee or a real draft invoice can.
            dateLabel: ev.isDeterministic ? 'Scheduled' : 'Awaiting usage', date: windowEnd,
            amount: ev.amount, currency: ev.currency,
            status: 'scheduled', kind: 'commercial-rule',
            baseAmount: 0, overageLineItems: [], overageTotal: 0,
            commercialRule: { meterKey: ev.meterKey, mode: ev.mode, cadence: ev.cadence, windowEnd: ev.windowEnd, partialPeriod: ev.partialPeriod, isDeterministic: ev.isDeterministic },
          })
        }

        // ── Parked obligations (Step 17H.2A items 6-12, 20) ──────────────
        // Deliberately NOT merged into `entries` above: those are sorted by
        // a real or projected DATE, and item 12 forbids fabricating one for
        // an event-driven parked fee (there is no calendar date to sort by
        // — only a condition). Rendered as their own grouping instead
        // (item 11's "Invoice history / Parked-conditional / Planned
        // schedule" structure), same connected-timeline visual language,
        // no date column. Classification itself lives in the shared,
        // pure lib/billing-timeline-entry.ts adapter (item 20) — the same
        // structural discriminators ParkedInvoicesCard uses, kept in one
        // place rather than re-derived here.
        const parkedEntries: BillingTimelineEntry[] = (parkedInvoices ?? []).map(buildParkedTimelineEntry)

        if (entries.length === 0 && parkedEntries.length === 0) return null

        // Sort chronologically
        entries.sort((a, b) => a.date.getTime() - b.date.getTime())

        const today = new Date()

        // Step 17F.9, item 1 — classification is the invoice's own
        // LIFECYCLE STATE (e.status, computed upstream by mapPlanned from
        // real provider/paid/failed/sent facts — never recomputed here),
        // not its calendar date. A row that is still status='scheduled'/
        // 'draft' (no provider invoice id, no sent_at) stays under
        // "Planned schedule" even once its planned date has passed —
        // exactly the shape a row held by the fixed-fee-timing scheduler
        // gate (lib/fixed-fee-invoice-scheduling.ts) can take: genuinely
        // overdue by date, but never sent. Only a status the provider
        // actually assigned (paid/failed/open/sent) counts as real
        // invoice history — date alone must never promote a row into it.
        const pastEntries   = entries.filter(e => isGenuinelyIssuedInvoice(e.status))
        const futureEntries = entries.filter(e => !isGenuinelyIssuedInvoice(e.status))
        // Purely a visual reference WITHIN the planned-schedule list (which
        // of these are overdue vs. genuinely still ahead) — never a
        // classifier: every planned entry renders with isPast=false
        // regardless of which side of "today" it falls on, so an overdue
        // one-time fee still gets its "Move to parked" action rather than
        // being silently treated as settled history.
        const overduePlanned  = futureEntries.filter(e => e.date <= today)
        const upcomingPlanned = futureEntries.filter(e => e.date >  today)

        const timelineIcon = (status: string | null): { icon: string; color: string } => {
          if (status === 'paid')    return { icon: 'ti-circle-check',  color: '#27AE60' }
          if (status === 'open')    return { icon: 'ti-clock',         color: '#D97706' }
          if (status === 'failed')  return { icon: 'ti-alert-triangle', color: '#DC2626' }
          if (status === 'draft')   return { icon: 'ti-circle-dashed', color: '#9CA3AF' }
          if (status === 'pending') return { icon: 'ti-circle-dashed', color: '#9CA3AF' }
          if (status === 'scheduled') return { icon: 'ti-calendar-time', color: '#9CA3AF' }
          return { icon: 'ti-circle-dashed', color: '#9CA3AF' }
        }

        const moveToParked = async (entryId: string) => {
          setParking(prev => new Set(prev).add(entryId))
          try {
            await fetch(`/api/jobs/${jobId}/parked-invoices`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ planned_invoice_id: entryId }),
            })
            await handleRefresh()
          } finally {
            setParking(prev => { const s = new Set(prev); s.delete(entryId); return s })
          }
        }

        // Step 17H.2B item 3 — the ONE join point between a genuine
        // recurring-period timeline entry and the authoritative period-
        // execution model (lib/billing-period-workspace.ts's
        // derivePeriodExecutionModel — the SAME function
        // BillingPeriodWorkspaceCard calls). Returns null (no enrichment,
        // exactly today's behavior) whenever any prerequisite is missing:
        // no periodStart/periodEnd (not a real period entry — item 4), no
        // terms (caller hasn't passed them), or consumption/performance
        // data hasn't loaded yet.
        const periodExecutionFor = (e: TLEntry): PeriodExecutionModel | null => {
          if (!terms || !e.periodStart || !e.periodEnd) return null
          const period = periodBoundsFromRange(e.periodStart, e.periodEnd)
          const consumptionPeriod = consumptionPeriods?.find(cp => cp.periodStart === e.periodStart) ?? null
          return derivePeriodExecutionModel({
            terms, currency: e.currency, usageSourceCards: usageSourceCards ?? [],
            period, consumptionPeriod, performanceShareResults,
          })
        }

        // Step 17H.2B item 21/22 — the real, re-verified arrears
        // relationship (app/api/admin/invoice-scheduler/route.ts: a
        // period's usage/performance is computed for the CLOSED window and
        // attached to the NEXT period's own invoice, alongside that next
        // period's advance fixed fee). Only ever names a REAL subsequent
        // period entry already present on this timeline — never fabricates
        // a future invoice reference that doesn't exist yet.
        const nextPeriodEntryAfter = (e: TLEntry): TLEntry | null => {
          if (!e.periodEnd) return null
          const candidates = entries.filter(o => o.kind === 'subscription' && o.periodStart && o.periodStart > e.periodEnd!)
          if (candidates.length === 0) return null
          return candidates.reduce((earliest, c) => (c.periodStart! < earliest.periodStart! ? c : earliest))
        }

        // Step 17H.2B items 5-21 — the enriched recurring-period hierarchy,
        // rendered inside the SAME expandable panel the existing invoice
        // table already occupies (never a new top-level section — item 1).
        // Execution consequences only (item 31) — never the full pricing/
        // band/interpretation setup Commercial Logic already owns.
        const renderPeriodExecutionDetail = (e: TLEntry, model: PeriodExecutionModel) => {
          const { workspace, consumptionPeriodStatus } = model
          const readiness = consumptionPeriodStatus === 'past' && workspace.readiness === 'upcoming'
            ? PERIOD_READINESS_LABEL.past
            : PERIOD_READINESS_LABEL[workspace.readiness]
          const nextEntry = nextPeriodEntryAfter(e)
          // Step E8.2 §8 — traced against the real component statuses
          // (never both "will bill" as one blanket promise): a usage
          // component still open/pending WILL close and join the next
          // invoice regardless of anything else (deterministic, calendar-
          // driven). A performance component only reaches the deferred
          // list once it's blocked on operational inputs a reviewer hasn't
          // entered yet (see buildDeferredItems) — its destination is not
          // guaranteed, since nothing ties its eventual calculation to
          // nextEntry specifically. computed/waived/not_started components
          // on either side are already resolved or not yet relevant, so
          // they don't belong in either promise.
          const hasDeferredUsage = workspace.usage.some(u => u.status !== 'computed' && u.status !== 'awaiting_source')
          const hasConditionalPerformance = workspace.performance.some(p => p.status === 'pending_operational_inputs')
          const calcBasisOpen = expandedCalcBasis.has(e.id)
          // Step 17H.4B0D4H1B4E8.1 §6-9/§20 — this period's OWN measurement
          // phase, from its real start/end dates (never a new date
          // calculation — periodBoundsFromRange already computed these).
          // Fed into the tiles, the calculation-basis table, and the
          // Deferred section below so all three agree (§21) — one
          // authoritative derivation, not three independent date checks.
          const measurementPhase = deriveMeasurementPhase(workspace.period.start, workspace.period.end)
          const measurementStartLabel = measurementPhase === 'not_started' ? fmtDate(workspace.period.start) : undefined
          // Step 17H.4B0D4H1B4E8 §4-8 — category tiles, generic and
          // count-derived: rendered only for categories that actually
          // apply to this component/period, never a forced 2-4 column
          // layout. Pure functions (lib/billing-period-card-summary.ts),
          // directly unit-tested against the same workspace shape this
          // page already builds.
          const tiles = [
            buildFixedTile(workspace.fixed, e.currency, fmt),
            buildUsageTile(workspace.usage, measurementPhase, measurementStartLabel),
            buildPerformanceTile(workspace.performance, measurementPhase, measurementStartLabel),
          ].filter((t): t is CategoryTile => t !== null)
          const tileColor = (state: TileState) =>
            state === 'ready' ? { fg: '#0B5C36', bg: 'rgba(11,92,54,0.06)' }
              : state === 'attention' ? { fg: '#B45309', bg: 'rgba(180,83,9,0.06)' }
              : { fg: '#57534E', bg: 'rgba(87,83,78,0.04)' }

          return (
            <div className="mb-3 rounded-xl overflow-hidden text-[11px]" style={{ border: '1px solid rgba(26,61,43,0.08)' }}>
              {/* Step 17H.4B0D4H1B4E8 §1 — no separate "Period execution"
                  sub-heading: the outer entry header (period label, date,
                  amount, lifecycle StatusBadge) already establishes what
                  this card is. The more granular execution-readiness badge
                  (a distinct, finer-grained state than the outer
                  StatusBadge — e.g. "Parked"/"Awaiting operational inputs",
                  which no single category tile alone conveys) is kept,
                  always shown, now attached directly above the tile row
                  rather than under its own redundant heading. */}
              <div className="p-4" style={{ background: 'rgba(26,61,43,0.02)' }}>
                <div className="flex justify-end mb-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ color: readiness.color, background: readiness.background }}>
                    {readiness.label}
                  </span>
                </div>
                <div className="grid gap-x-4 gap-y-2.5" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(tiles.length, 1), 4)}, minmax(0, 1fr))` }}>
                  {tiles.map(t => {
                    const c = tileColor(t.state)
                    return (
                      <div key={t.title} className="min-w-0">
                        <p className="text-[9px] font-bold text-stone/60 uppercase tracking-[0.1em]">{t.title}</p>
                        <p className="text-[13px] font-semibold mt-0.5" style={{ color: t.state === 'ready' ? '#0B5C36' : t.state === 'attention' ? '#B45309' : '#1C1917' }}>{t.label}</p>
                        <p className="text-[10px] mt-0.5" style={{ color: c.fg, opacity: 0.85 }}>{t.sub}</p>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="px-4 pt-3 pb-3">
                {/* Step 17H.4B0D4H1B4E8 §9 — the period-to-invoice sentence,
                    unchanged logic (a real, already-computed next timeline
                    entry — never a fabricated forward reference), now
                    prominent right after the tiles rather than buried
                    below the old always-expanded detail blocks. */}
                {hasDeferredUsage && hasConditionalPerformance && nextEntry && (
                  <p className="text-stone text-[11px] mb-2.5">
                    Usage from this window will bill on the <span className="font-medium text-ink">{nextEntry.label}</span> invoice; performance is calculated after close, once the required inputs are available.
                  </p>
                )}
                {hasDeferredUsage && !hasConditionalPerformance && nextEntry && (
                  <p className="text-stone text-[11px] mb-2.5">
                    Usage from this window will bill on the <span className="font-medium text-ink">{nextEntry.label}</span> invoice.
                  </p>
                )}
                {!hasDeferredUsage && hasConditionalPerformance && (
                  <p className="text-stone text-[11px] mb-2.5">
                    Performance for this window is calculated after close, once the required inputs are available — its destination invoice isn&apos;t fixed yet.
                  </p>
                )}

                {/* Step 17H.4B0D4H1B4E8 §10 — collapsed by default; no
                    current-period auto-expand implemented in this pass
                    (deliberately deferred, per the task's own instruction
                    not to build that unsafely here). Exception periods
                    stay visible regardless, via workspace.missingDependencies
                    rendered inside once expanded — never hidden, only not
                    expanded by default. */}
                <button
                  onClick={() => setExpandedCalcBasis(prev => {
                    const next = new Set(prev)
                    if (next.has(e.id)) next.delete(e.id); else next.add(e.id)
                    return next
                  })}
                  className="text-[11px] font-semibold text-forest hover:underline flex items-center gap-1"
                >
                  <i className={`ti ti-chevron-down transition-transform ${calcBasisOpen ? 'rotate-180' : ''}`} style={{ fontSize: 10 }} />
                  {calcBasisOpen ? 'Hide calculation basis & sources' : 'See calculation basis & sources'}
                </button>

                {calcBasisOpen && (() => {
                  // Step E8.2 §2/§3/§6 — replaces the old always-expanded
                  // "Fixed charges" / "Consumption / usage" / "Performance
                  // / outcome" prose blocks AND the duplicate bottom
                  // "Known fixed / Variable charges / Performance / Invoice
                  // total" summary (the tiles above are now the ONE
                  // authoritative category summary — see item 6 of the
                  // task report) with a single compact COMPONENT / BASIS /
                  // SOURCE / STATE table. Same underlying workspace data,
                  // no data deleted — only the presentation collapses from
                  // several duplicate narrative blocks into one table.
                  const manualSourceKeys = new Set(
                    (usageSourceCards ?? []).filter(c => c.sourceType === 'manual' && c.semanticInputKey).map(c => c.semanticInputKey as string),
                  )
                  const rows = buildComponentDetailRows({
                    fixed: workspace.fixed, usage: workspace.usage, performance: workspace.performance,
                    currency: e.currency, periodRangeLabel: workspace.period.label, phase: measurementPhase, fmt,
                    manualSourceKeys,
                  })
                  return (
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                      <table className="w-full text-[11px]" style={{ borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th className="text-left font-semibold text-stone/60 pb-1.5" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Component</th>
                            <th className="text-left font-semibold text-stone/60 pb-1.5" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Basis</th>
                            <th className="text-left font-semibold text-stone/60 pb-1.5" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Source</th>
                            <th className="text-right font-semibold text-stone/60 pb-1.5" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em' }}>State</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map(row => {
                            // Step §4 — business source label first; the
                            // small uppercase SOURCE TYPE tag stays (API
                            // METER / MANUAL INPUT / CONTRACT CLAUSE /
                            // DERIVED), the readable label sits right under
                            // it, never a raw key as the primary line.
                            const p = row.key.startsWith('performance:') ? workspace.performance.find(x => `performance:${x.feeLabel}` === row.key) : undefined
                            const u = row.key.startsWith('usage:') ? workspace.usage.find(x => `usage:${x.key}` === row.key) : undefined
                            return (
                              <tr key={row.key} style={{ borderTop: '1px solid rgba(26,61,43,0.05)' }}>
                                <td className="py-2 pr-2 align-top text-ink">{row.component}</td>
                                <td className="py-2 pr-2 align-top text-stone">{row.basis}</td>
                                <td className="py-2 pr-2 align-top">
                                  {row.sourceType && <p className="text-[9px] font-semibold text-stone/50 tracking-wide">{row.sourceType}</p>}
                                  {row.sourceLabel && <p className="text-stone">{row.sourceLabel}</p>}
                                  {/* Step E8.3 §1 — the configured meter's own
                                      display name/key stays available as
                                      muted, always-visible technical detail
                                      (never hover-only) — never hidden, even
                                      when it looks unrelated to the business
                                      metric above it. */}
                                  {row.sourceDetail && <p className="text-[9px] text-stone/40 font-mono mt-0.5">{row.sourceDetail}</p>}
                                  {/* Step E8.3.1 §5 — contract context stays
                                      visually and structurally distinct from
                                      the provenance claim above it (never
                                      merged into sourceLabel) — evidence a
                                      reviewer decision may still reference,
                                      never implied to BE the reviewer's rule.
                                      Reuses the SAME field_sources heading
                                      Commercial Logic's own "View source
                                      clause" link for this exact fact uses
                                      (page.tsx), never the paraphrased
                                      source_clause text itself as a PDF
                                      locator. */}
                                  {row.contextClause && (onViewSource || !(terms?.field_sources?.base_monthly_fee ?? terms?.field_sources?.base_annual_fee)) && (
                                    <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                                      <span className="text-[9px] text-stone/40">Contract context:</span>
                                      <SourceClauseLink
                                        section={terms?.field_sources?.base_monthly_fee ?? terms?.field_sources?.base_annual_fee}
                                        onViewSource={onViewSource}
                                        hasClauseText
                                      />
                                    </div>
                                  )}
                                </td>
                                <td className="py-2 align-top text-right">
                                  <span className="font-medium" style={{ color: row.state.state === 'ready' ? '#0B5C36' : row.state.state === 'attention' ? '#B45309' : '#57534E' }}>
                                    {row.state.label}
                                  </span>
                                  {/* Step §7 — genuinely additional
                                      diagnostic/execution detail (a live
                                      in-progress reading, an actual
                                      operational-input entry affordance),
                                      never a repeat of the tile's own
                                      category-level narrative. */}
                                  {u?.status === 'live_not_final' && u.quantity != null && (
                                    <p className="text-[10px] text-stone/50 mt-0.5">{u.quantity.toLocaleString()} to date</p>
                                  )}
                                  {u?.status === 'computed' && (
                                    <p className="text-[10px] text-stone/50 mt-0.5">{fmt(u.amount ?? 0, e.currency)}</p>
                                  )}
                                  {p?.status === 'computed' && (
                                    <p className="text-[10px] text-stone/50 mt-0.5">{fmt(p.amount ?? 0, p.currency ?? e.currency)}</p>
                                  )}
                                  {p?.status === 'computed' && p.derivedPct != null && p.selectedRatePct != null && (
                                    <p className="text-[10px] text-stone/50 mt-0.5">{p.derivedPct.toFixed(2)}% → {p.selectedRatePct.toFixed(2)}% rate</p>
                                  )}
                                  {/* Step §7 — this fee's OWN invoice-timing
                                      decision (independent of the fixed
                                      component's own, in the Fixed row
                                      above) — a genuinely different axis
                                      from measurement readiness (the STATE
                                      column), so it's never folded into
                                      that same label. */}
                                  {p && p.status !== 'not_started' && p.timingUnresolved && (
                                    <p className="text-[10px] font-medium mt-0.5" style={{ color: '#B45309' }}>
                                      {p.variableInvoiceTiming === 'invoice_at_period_end'
                                        ? 'Invoice timing: Confirmed for period end — awaiting execution support'
                                        : 'Invoice timing: Decision required'}
                                    </p>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {/* Step E8.3 §4/§5 — Timeline is the period STATUS
                          surface, never a second manual-entry workspace.
                          The date/value inputs and Save draft/Mark final
                          controls this used to render inline (duplicating
                          Billing Operations' own ManualInputEntry) are
                          gone; a genuinely blocked (not merely not-yet-
                          started — same condition as before) performance
                          fee instead gets a concise, named action pointing
                          at the one authoritative place to actually enter
                          the value. Never rendered merely because the
                          contract HAS manual performance inputs — only
                          when this period's own state is actionable. */}
                      {workspace.performance.filter(p => p.status === 'pending_operational_inputs' && measurementPhase !== 'not_started').map(p => (
                        (p.missingKeys ?? []).length > 0 && (
                          <div key={p.feeLabel} className="mt-2 pt-2 flex items-start justify-between gap-3" style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                            <div className="min-w-0">
                              <p className="text-[10px] font-semibold text-stone uppercase tracking-wide mb-1">{p.feeLabel} — required inputs</p>
                              <p className="text-[10px] text-stone/70">{(p.missingKeys ?? []).map(humanizeKey).join(', ')}</p>
                            </div>
                            {onNavigateToOperationalInputs && (
                              <button
                                type="button"
                                onClick={onNavigateToOperationalInputs}
                                className="text-[10px] font-medium text-forest hover:underline whitespace-nowrap flex-shrink-0"
                              >
                                Enter performance inputs →
                              </button>
                            )}
                          </div>
                        )
                      ))}
                      {measurementRefreshedAt && workspace.usage.some(u => u.status === 'live_not_final') && (
                        <p className="text-[10px] text-stone/40 mt-2">
                          Updated {measurementRefreshedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      )}
                      {/* Step §2/§6 — workspace.missingDependencies is real
                          diagnostic information not otherwise represented
                          (it's the source the tiles' own attention states
                          are derived from, not a duplicate of them) —
                          kept, not part of the removed bottom summary. */}
                      {workspace.missingDependencies.length > 0 && (
                        <div className="mt-2 pt-2" style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                          <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: workspace.readiness === 'parked' ? '#DC2626' : '#B45309' }}>
                            {(workspace.readiness === 'parked' || workspace.readiness === 'waiting_for_operational_inputs') ? 'Parked — missing:' : 'Missing:'}
                          </p>
                          <ul className="mt-0.5 space-y-0.5">
                            {workspace.missingDependencies.map((d, i) => (
                              <li key={i} className="text-stone">• {d}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            </div>
          )
        }

        const renderEntry = (e: TLEntry, isPast: boolean) => {
          // Verdix terminology: contract date is the gate.
          // Past date + Stripe open/paid = Issued (sent to customer, awaiting payment)
          // Past date + Stripe paid      = Paid
          // Future date                  = Draft (not yet issued, regardless of Stripe status)
          const effectiveStatus = e.kind === 'commercial-rule' ? 'scheduled' : (isPast ? e.status : 'draft')
          const canPark = !isPast && e.kind === 'one-time'
          const isOpen = expanded.has(e.id)
          // Step 17F.8 — a not-yet-issued fixed-fee entry must never claim
          // a definite "Will be issued <date>" while fixed_fee_billing_timing
          // is still an open reviewer decision — the scheduler itself holds
          // this exact row until it's resolved (lib/fixed-fee-invoice-
          // scheduling.ts), so showing a confident date here would
          // contradict what the system will actually do. Only applies to
          // not-yet-issued fixed-fee entries — already-issued history and
          // every other entry kind (overage, one-time, commercial-rule)
          // are untouched.
          const timingUnresolvedForThisEntry = !isPast && e.isFixedFeeComponent && !!fixedFeeBillingTiming?.requires_confirmation
          return (
          <div key={e.id} className="flex gap-4 group">
            {/* Icon */}
            <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
              <i className={`ti ${timelineIcon(effectiveStatus).icon} flex-shrink-0`}
                style={{ fontSize: 15, color: timelineIcon(effectiveStatus).color, marginTop: 1 }} />
              <div className="flex-1 w-px mt-1" style={{ background: isPast ? 'rgba(26,61,43,0.12)' : 'rgba(26,61,43,0.06)', minHeight: 12 }} />
            </div>

            {/* Content */}
            <div className="pb-4 flex-1 min-w-0">
              <div
                className="flex items-start justify-between gap-3 cursor-pointer"
                onClick={() => toggleExpanded(e.id)}
                role="button"
                tabIndex={0}
                onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') toggleExpanded(e.id) }}
              >
                <div className="min-w-0 flex items-start gap-1.5">
                  <i className={`ti ti-chevron-right flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                    style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }} />
                  <div className="min-w-0">
                    <p className={`text-[12px] font-medium leading-tight ${isPast ? 'text-ink' : 'text-ink/80'}`}>{e.label}</p>
                    <p className="text-[10px] text-stone mt-0.5">
                      {/* Step 17H.4B0D4H1B4E2.4 §7-8 — names the SPECIFIC
                          blocked component (fixed-fee timing) rather than
                          a bare, identically-repeated "Pending decision"
                          on every period row with no diagnostic value.
                          This label only ever reflects the fixed
                          component's own timing (the one thing that
                          genuinely blocks the period's INVOICE DATE) — a
                          separate performance-fee timing decision, if
                          also unresolved, is a different fact (it blocks
                          that fee's own invoice, not this date) and is
                          shown per-fee inside the expanded Performance /
                          outcome detail instead of being flattened in
                          here. */}
                      {timingUnresolvedForThisEntry ? (
                        <>
                          <span className="text-stone/50">Fixed-fee invoice timing </span>
                          <span className="font-medium" style={{ color: '#B45309' }}>Decision required</span>
                        </>
                      ) : (
                        <>
                          <span className="text-stone/50">{e.dateLabel} </span>
                          {e.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </>
                      )}
                    </p>
                    {effectiveStatus === 'failed' && e.errorMessage && (
                      <p className="text-[10px] mt-1 flex items-start gap-1" style={{ color: '#DC2626' }}>
                        <i className="ti ti-alert-triangle flex-shrink-0" style={{ fontSize: 11, marginTop: 1 }} />
                        <span>{e.errorMessage}</span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    {/* A floor/minimum_spend/etc. threshold is not the final
                        billed amount — max(usage, threshold) isn't known
                        until usage is pulled, so this must never read like a
                        promised invoice total the way a deterministic
                        additive fee or a real draft invoice does. */}
                    {e.kind === 'commercial-rule' && e.commercialRule && !e.commercialRule.isDeterministic ? (
                      <span className="text-[11px] font-medium" style={{ color: '#B9802F' }} title={`${COMMITMENT_MODE_LABEL[e.commercialRule.mode] ?? e.commercialRule.mode}: ${fmt(e.amount, e.currency)} · amount pending usage`}>
                        Pending usage
                      </span>
                    ) : (
                      <div className="flex flex-col items-end">
                        <span className="text-[13px] font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(e.amount, e.currency)}
                        </span>
                        {/* Step 17H.4B0D4H1B4E8.1 §2-4 — audited what e.amount
                            actually is: the exact same value the Invoice
                            Projection table's own "Net" row renders below
                            (both read e.amount directly) — never gross, VAT
                            is added on top of it. The label now says so
                            explicitly, so this figure can never read as an
                            ambiguous, possibly-gross total that contradicts
                            the table underneath it. "Net projected" only for
                            a genuinely not-yet-real entry (draft/scheduled —
                            no actual invoice exists yet); a real historical
                            entry (open/paid/past_due/...) states the settled
                            fact plainly, never "projected". */}
                        <span className="text-[9px] text-stone/50 uppercase tracking-wide mt-0.5">
                          {effectiveStatus === 'draft' || effectiveStatus === 'scheduled' ? 'Net projected' : 'Net'}
                        </span>
                      </div>
                    )}
                    <StatusBadge status={effectiveStatus} />
                    {e.isManualOrigin && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                        style={{ color: '#6B7280', background: 'rgba(107,114,128,0.1)' }}
                        title="Created via Manual Invoice, not the confirmed billing schedule">
                        Manual
                      </span>
                    )}
                    {e.pdfUrl && (
                      <a href={e.pdfUrl} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()}
                        className="text-stone/40 hover:text-stone transition-colors" title="Download PDF">
                        <i className="ti ti-file-download" style={{ fontSize: 11 }} />
                      </a>
                    )}
                  </div>
                  {canPark && (
                    <button
                      onClick={ev => { ev.stopPropagation(); moveToParked(e.id) }}
                      disabled={parking.has(e.id)}
                      className="text-[10px] text-amber-600 hover:text-amber-700 flex items-center gap-1 disabled:opacity-40 transition-colors"
                      title="Move to Parked Invoices — requires manual delivery confirmation before sending"
                    >
                      {parking.has(e.id)
                        ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 10 }} /> Parking…</>
                        : <><i className="ti ti-clock-pause" style={{ fontSize: 10 }} /> Move to parked</>
                      }
                    </button>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="mt-2 ml-[18px]">
                {/* Step 17H.2B items 5-21 — enriched period execution,
                    rendered only for a genuine recurring-period entry once
                    terms/usageSourceCards are available (periodExecutionFor
                    returns null otherwise — no change from today for every
                    other entry kind). */}
                {e.kind === 'subscription' && e.periodStart && (() => {
                  const model = periodExecutionFor(e)
                  return model ? renderPeriodExecutionDetail(e, model) : null
                })()}
                {/* Step 17H.4B0D4H1B4E8 §15 — "Invoice Projection" for a
                    planned/draft invoice; "Sent to {provider}" language is
                    reserved for an entry that has genuinely been
                    transmitted (isPast with a real issued/paid status),
                    never claimed here for a draft. */}
                {e.kind === 'subscription' && (
                  <p className="text-[10px] font-bold text-stone uppercase tracking-widest mb-1.5">
                    {isPast ? 'Invoice' : 'Invoice Projection'}
                  </p>
                )}
                <div className="rounded-xl overflow-hidden text-[11px]" style={{ border: '1px solid rgba(26,61,43,0.08)' }}>
                  <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'rgba(26,61,43,0.03)' }}>
                        <th className="text-left font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Description</th>
                        <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Qty</th>
                        <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Unit price</th>
                        <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.kind === 'subscription' ? (
                        <>
                          {/* Step 17H.4B0D4H1B4E8.1 §15-17 — "Feb 2027" alone
                              is a period label, not a commercial
                              description; a reviewer can't tell WHAT is
                              being charged from the invoice-line table
                              itself. "Platform fee" is the same generic term
                              Commercial Logic & Billing Setup already uses
                              for this exact component ("Platform
                              subscription" — lib/commercial-components.ts),
                              never a fixture-specific name. Waived is stated
                              plainly rather than showing an unexplained
                              SEK 0 line. */}
                          <tr style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                            <td className="px-3 py-2 text-ink">
                              Platform fee · {e.label}
                              {periodExecutionFor(e)?.workspace.fixed.waived && <span className="text-stone/50"> (waived)</span>}
                            </td>
                            <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>1</td>
                            <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.baseAmount, e.currency)}</td>
                            <td className="px-3 py-2 text-right font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.baseAmount, e.currency)}</td>
                          </tr>
                          {e.overageLineItems.length > 0 ? (
                            e.overageLineItems.map((item, i) => {
                              const billable = item.billable_units ?? Math.max(0, item.total_units - item.included_units)
                              const rate     = item.rate_per_unit ?? (billable > 0 ? item.amount / billable : 0)
                              return (
                                <tr key={i} style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                                  <td className="px-3 py-2 text-ink" title={item.description}>{item.meter_key} overage</td>
                                  <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{billable.toLocaleString()}</td>
                                  <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtRate(rate, item.currency)}</td>
                                  <td className="px-3 py-2 text-right font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(item.amount, item.currency)}</td>
                                </tr>
                              )
                            })
                          ) : isPast ? (
                            hasOverageTerms && meterTypes.map(mt => (
                              <tr key={mt} style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                                <td className="px-3 py-2 text-ink">{mt} overage</td>
                                <td className="px-3 py-2 text-right text-stone/40" colSpan={3}>No usage overage for this period</td>
                              </tr>
                            ))
                          ) : (
                            // Step 17H.4B0D4H1B4E8 §16 — this table is
                            // Invoice Projection: only lines genuinely
                            // expected on THIS invoice. An upcoming
                            // period's usage/overage isn't measured yet and
                            // doesn't belong on this invoice at all — it
                            // used to render a pseudo-line here ("— / — /
                            // Will be calculated at the end of the billing
                            // cycle"), which is exactly the anti-pattern
                            // this section must avoid. That fact now
                            // surfaces once, honestly, in the Deferred
                            // section below (buildDeferredItems) instead of
                            // as a fake row in a monetary table.
                            null
                          )}
                        </>
                      ) : e.kind === 'commercial-rule' && e.commercialRule ? (
                        <>
                          {e.commercialRule.isDeterministic ? (
                            <>
                              <tr>
                                <td className="px-3 py-2 text-ink">{COMMITMENT_MODE_LABEL[e.commercialRule.mode] ?? e.commercialRule.mode}</td>
                                <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>1</td>
                                <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.amount, e.currency)}</td>
                                <td className="px-3 py-2 text-right font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.amount, e.currency)}</td>
                              </tr>
                              <tr style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                                <td className="px-3 py-2 text-stone" colSpan={4}>
                                  + variable {e.commercialRule.meterKey} usage · {e.commercialRule.cadence} in arrears, added on top
                                </td>
                              </tr>
                            </>
                          ) : (
                            // A floor/minimum_spend/etc. rule isn't a fixed line
                            // item — the final billed amount is max(usage,
                            // threshold), unknown until usage is pulled at
                            // period close. Showing the threshold as a "Total"
                            // here would misrepresent it as the final invoice
                            // amount, which is exactly the confusion this
                            // table exists to prevent.
                            <>
                              <tr>
                                <td className="px-3 py-2 text-ink" colSpan={2}>{COMMITMENT_MODE_LABEL[e.commercialRule.mode] ?? e.commercialRule.mode}</td>
                                <td className="px-3 py-2 text-right text-stone" colSpan={2} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.amount, e.currency)}</td>
                              </tr>
                              <tr style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                                <td className="px-3 py-2 text-stone" colSpan={2}>Usage charge — {e.commercialRule.cadence} in arrears</td>
                                <td className="px-3 py-2 text-right text-stone/50 italic" colSpan={2}>Pending usage</td>
                              </tr>
                              <tr style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                                <td className="px-3 py-2 font-medium text-ink" colSpan={2}>Billable amount</td>
                                <td className="px-3 py-2 text-right font-medium italic" colSpan={2} style={{ color: '#B9802F' }}>
                                  Pending usage — at least {fmt(e.amount, e.currency)}
                                </td>
                              </tr>
                            </>
                          )}
                          {e.commercialRule.partialPeriod?.isPartial && (
                            <tr style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                              <td className="px-3 py-2" colSpan={4} style={{ color: e.commercialRule.partialPeriod.needsConfirmation ? '#B45309' : '#6B7280' }}>
                                {partialPeriodLabel(e.commercialRule.cadence)}: {e.commercialRule.partialPeriod.needsConfirmation ? 'Needs confirmation' : e.commercialRule.partialPeriod.prorated ? 'Prorated by days' : 'Full amount charged'}
                              </td>
                            </tr>
                          )}
                        </>
                      ) : (
                        <tr>
                          <td className="px-3 py-2 text-ink">{e.description || e.label}</td>
                          <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {e.quantity != null ? e.quantity.toLocaleString() : 1}
                          </td>
                          <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(e.unitPrice ?? e.baseAmount, e.currency)}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.baseAmount, e.currency)}</td>
                        </tr>
                      )}
                    </tbody>
                    {e.kind === 'subscription' && (() => {
                      // Net/VAT/gross — see lib/vat.ts's resolveInvoiceVatDisplay
                      // for the full "prefer the immutable snapshot over a
                      // live projection" rationale.
                      const display = resolveInvoiceVatDisplay(
                        e.amount,
                        e.vatMode ? { vatMode: e.vatMode, vatRatePct: e.vatRatePct ?? null, netAmount: e.netAmount ?? null, vatAmount: e.vatAmount ?? null, grossAmount: e.grossAmount ?? null } : null,
                        vat.treatment,
                      )
                      // Net/VAT/gross colors follow the same financial-
                      // number semantics as the Billing Summary KPI cards
                      // (app/_components/FinancialAmount.tsx) — forest for
                      // net, muted olive-gold for VAT (informational, never
                      // a warning color), darkest forest/charcoal for gross,
                      // which also carries the strongest visual weight
                      // (bold + darkest tone) since it's the final payable
                      // amount.
                      return (
                        <tfoot>
                          <tr style={{ borderTop: '1px solid rgba(26,61,43,0.1)', background: 'rgba(26,61,43,0.02)' }}>
                            <td className="px-3 py-2 font-semibold text-stone" colSpan={3}>Net</td>
                            <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              <FinancialAmount amount={e.amount} currency={e.currency} basis="net" size="sm" />
                            </td>
                          </tr>
                          {display ? (
                            <>
                              <tr>
                                {/* Step 17H.4B0D4H1B4E6 §27 — VAT is
                                    manually configured (customer_default/
                                    override), independent of contract
                                    extraction. A live PROJECTION (not yet
                                    an actual sent invoice) says so
                                    explicitly, so this rate never reads as
                                    something the contract itself stated.
                                    A real, already-sent snapshot keeps its
                                    existing "invoice override" qualifier
                                    only — it's real invoice history, not a
                                    projection, so no additional disclaimer
                                    is needed. */}
                                <td className="px-3 py-2 text-stone" colSpan={3}>
                                  VAT ({display.vatRatePct}%)
                                  {display.isSnapshot && e.vatSource === 'override' ? ' · invoice override' : ''}
                                  {!display.isSnapshot ? ' · Billing configuration' : ''}
                                </td>
                                <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                  <FinancialAmount amount={display.vatAmount} currency={e.currency} basis="vat" size="sm" />
                                </td>
                              </tr>
                              <tr style={{ borderTop: '1px solid rgba(26,61,43,0.1)' }}>
                                <td className="px-3 py-2 font-bold text-stone" colSpan={3}>Gross{display.isSnapshot ? '' : ' (projected)'}</td>
                                <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                  <FinancialAmount amount={display.grossAmount} currency={e.currency} basis="gross" size="md" />
                                </td>
                              </tr>
                            </>
                          ) : (
                            <tr>
                              <td className="px-3 py-2 text-[10px] italic text-amber-600" colSpan={4}>VAT not yet configured — figure above is net only, gross unknown</td>
                            </tr>
                          )}
                        </tfoot>
                      )
                    })()}
                  </table>
                </div>
                {/* Step 17H.4B0D4H1B4E8 §19-22 — Deferred to next invoice:
                    items measured/evaluated in THIS period but destined for
                    a later invoice — never left in Invoice Projection as a
                    pseudo-line (§16, fixed above). Reuses the SAME
                    workspace/nextEntry the period-execution card above
                    already computed (periodExecutionFor is a pure
                    re-derivation over already-loaded state, not a new
                    fetch); omitted entirely when there's nothing deferred
                    (§21 — success/empty state is less UI, not a "None"
                    row). */}
                {e.kind === 'subscription' && e.periodStart && (() => {
                  const model = periodExecutionFor(e)
                  if (!model) return null
                  const nextEntry = nextPeriodEntryAfter(e)
                  const phase = deriveMeasurementPhase(model.workspace.period.start, model.workspace.period.end)
                  const deferred = buildDeferredItems({
                    usage: model.workspace.usage,
                    performance: model.workspace.performance,
                    phase,
                    measurementStartLabel: phase === 'not_started' ? fmtDate(model.workspace.period.start) : undefined,
                  })
                  if (deferred.length === 0) return null
                  return (
                    <div className="mt-3 rounded-xl overflow-hidden text-[11px]" style={{ border: '1px solid rgba(26,61,43,0.08)' }}>
                      {/* Step 17H.4B0D4H1B4E8.1 §10 — the destination is
                          declared ONCE, here, since every current deferred
                          item shares the one next-invoice destination (no
                          per-item destination data exists yet — see
                          buildDeferredItems' own doc). Rows below never
                          repeat it. */}
                      <div className="flex items-center gap-2 px-3 py-2" style={{ background: 'rgba(26,61,43,0.03)' }}>
                        <span className="text-[10px] font-bold text-stone uppercase tracking-widest">Deferred to next invoice</span>
                        {nextEntry && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(26,61,43,0.06)', color: '#57534E' }}>{nextEntry.label}</span>
                        )}
                      </div>
                      {/* Step 17H.4B0D4H1B4E8.1 §18 — `divide-y` alone
                          (Tailwind's child-combinator border utility) has
                          no color of its own without a matching divide-
                          color utility class; the previous style prop on
                          the PARENT never actually reached those generated
                          child borders, so they rendered at the browser's
                          own default (dark) border color — exactly the
                          "heavy/dark rules" this section reported. Explicit
                          per-row borderTop (skipping the first row), same
                          subtle token this file already uses elsewhere,
                          replaces it. */}
                      {deferred.map((d, i) => (
                        <div key={d.key} className="flex items-start justify-between gap-3 px-3 py-2" style={i > 0 ? { borderTop: '1px solid rgba(26,61,43,0.06)' } : undefined}>
                          <div className="min-w-0">
                            <p className="text-ink">{d.label}</p>
                            <p className="text-stone/60 text-[10px] mt-0.5">{d.sub}</p>
                          </div>
                          <span className="text-stone/60 text-[10px] flex-shrink-0 text-right">{d.timingText}</span>
                        </div>
                      ))}
                    </div>
                  )
                })()}
                </div>
              )}
            </div>
          </div>
          )
        }

        // Step 17H.2A items 8/9/10/12 — same connected-timeline shell as
        // renderEntry (icon column + line, collapsible header, expandable
        // detail), deliberately with no date column and no "Move to
        // parked" action (both meaningless for an entry that's already
        // parked). fmt(0, currency) is never rendered here — a manual
        // template shows its per-unit rate instead of a fabricated total.
        const renderParkedEntry = (pe: BillingTimelineEntry) => {
          const isOpen = expanded.has(pe.displayKey)
          const badge = { icon: 'ti-clock-pause', color: '#D97706' }
          if (pe.iconStatusKey === 'parked_evidence_recorded') badge.color = '#6366F1'
          else if (pe.iconStatusKey !== 'parked_awaiting_evidence') badge.color = '#9CA3AF'
          if (pe.iconStatusKey === 'parked_unsupported') badge.icon = 'ti-help-circle'
          return (
            <div key={pe.displayKey} className="flex gap-4 group">
              <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
                <i className={`ti ${badge.icon} flex-shrink-0`} style={{ fontSize: 15, color: badge.color, marginTop: 1 }} />
                <div className="flex-1 w-px mt-1" style={{ background: 'rgba(26,61,43,0.06)', minHeight: 12 }} />
              </div>
              <div className="pb-4 flex-1 min-w-0">
                <div
                  className="flex items-start justify-between gap-3 cursor-pointer"
                  onClick={() => toggleExpanded(pe.displayKey)}
                  role="button" tabIndex={0}
                  onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') toggleExpanded(pe.displayKey) }}
                >
                  <div className="min-w-0 flex items-start gap-1.5">
                    <i className={`ti ti-chevron-right flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }} />
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium leading-tight text-ink/80">{pe.label}</p>
                      <p className="text-[10px] mt-0.5" style={{ color: badge.color }}>{pe.secondaryText}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <div className="flex items-center gap-2">
                      {pe.amount.kind === 'rate_per_unit' ? (
                        <span className="text-[11px] text-stone font-mono">
                          {pe.amount.ratePerUnit != null ? `${fmt(pe.amount.ratePerUnit, pe.amount.currency)}/${pe.amount.unitLabel}` : '—'}
                        </span>
                      ) : (
                        <span className="text-[13px] font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(pe.amount.amount, pe.amount.currency)}
                        </span>
                      )}
                      <StatusBadge status={pe.iconStatusKey} />
                    </div>
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-2 ml-[18px] rounded-xl overflow-hidden text-[11px] px-3 py-3" style={{ border: '1px solid rgba(26,61,43,0.08)', background: 'rgba(26,61,43,0.02)' }}>
                    {pe.description && <p className="text-stone mb-2">{pe.description}</p>}
                    {pe.detail.kind === 'event_gated' && (
                      pe.detail.evidence ? (
                        <p className="text-stone">
                          {EVIDENCE_RECORDED_LABELS[pe.detail.eventType]} on {fmtDate(pe.detail.evidence.occurredAt)}.
                          Will be included on the next scheduled billing run.
                        </p>
                      ) : (
                        <p className="text-stone">
                          This fee becomes billable once {EVIDENCE_WAITING_LABELS[pe.detail.eventType].replace('Waiting for ', '').toLowerCase()} is recorded — see Parked Invoices above.
                        </p>
                      )
                    )}
                    {pe.detail.kind === 'manual_template' && (
                      <p className="text-stone">
                        Each confirmed delivery creates a separate invoice at {pe.detail.ratePerUnit != null ? fmt(pe.detail.ratePerUnit, pe.amount.kind === 'rate_per_unit' ? pe.amount.currency : currency) : '—'} per {pe.detail.metricName ?? 'unit'}. This template stays parked for future deliveries — see Parked Invoices above.
                      </p>
                    )}
                    {pe.detail.kind === 'unsupported' && (
                      <p className="text-stone">
                        Verdix doesn&apos;t recognize this fee&apos;s billing configuration well enough to display more here — review the contract terms directly.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        }

        return (
          <div className="px-6 py-5">
            {/* Step 17H.2C item 18, revised 17H.4B0D4H1B4E2.4 §18 — the
                bold "Billing timeline" heading that used to sit here was
                removed: the card's own outer header (above) now carries
                that exact heading once, as the section's single primary
                title. This description stays as plain explanatory text,
                not a second heading. */}
            <p className="text-[10px] text-stone/60 mb-4">Planned billing events, period execution, conditional obligations, and issued invoice history.</p>

            {/* One-time fee pending-setup notice */}
            {oneTimeInvoices.length === 0 && oneTimeFees.length > 0 && (
              <div className="rounded-xl px-4 py-3 text-[12px] text-amber-800 mb-4" style={{ background: '#FFFBEB', border: '1px solid #FCD34D' }}>
                {oneTimeFees.length} one-time fee{oneTimeFees.length > 1 ? 's' : ''} ({oneTimeFees.map(f => f.fee_label).join(', ')}) — invoices will be created in {providerDisplayName(summary?.billingPlatform)} when you re-push this contract.
              </div>
            )}

            <div>
              {/* Step 17F.9, item 1/3 — this card mixes two genuinely
                  different facts: real invoice objects the provider
                  actually created (paid/failed/open/sent — genuine
                  history), and bare local planned_invoices rows with no
                  provider object at all (still status='scheduled'/'draft').
                  Classified by the invoice's own LIFECYCLE STATE
                  (e.status, computed upstream from real provider/paid/
                  sent facts), never by calendar date — a row held by the
                  fixed-fee-timing scheduler gate (lib/fixed-fee-invoice-
                  scheduling.ts) can have a planned date already in the
                  past while still never having been sent, and must stay
                  under "Planned schedule" regardless. Step 17H.2C — the
                  standalone Billing Periods workspace is retired; this
                  card's own expanded per-entry period-execution panel
                  (via derivePeriodExecutionModel) is now the sole
                  authoritative source for current per-period figures. */}
              {pastEntries.length > 0 && (
                <p className="text-[10px] font-bold text-stone uppercase tracking-widest mb-2">Invoice history</p>
              )}
              {pastEntries.map(e => renderEntry(e, true))}

              {/* Step 17H.2A item 11 — a third grouping, same connected-
                  timeline surface, between real history and the projected
                  schedule: obligations that exist (evidence may already be
                  recorded) but have no calendar date and haven't reached
                  the scheduler yet. ParkedInvoicesCard above remains the
                  place to actually record evidence or confirm a delivery —
                  this is read-only visibility (item 7). */}
              {parkedEntries.length > 0 && (
                <div className="mb-2" style={{ marginTop: pastEntries.length > 0 ? 12 : 0 }}>
                  <p className="text-[10px] font-bold text-stone uppercase tracking-widest">Parked · conditional</p>
                  <p className="text-[10px] text-stone/60 mt-0.5">Not yet on the billing schedule — see Parked Invoices above to record evidence or confirm a delivery.</p>
                </div>
              )}
              {parkedEntries.map(pe => renderParkedEntry(pe))}

              {futureEntries.length > 0 && (
                <div className="mb-2" style={{ marginTop: (pastEntries.length > 0 || parkedEntries.length > 0) ? 12 : 0 }}>
                  <p className="text-[10px] font-bold text-stone uppercase tracking-widest">Planned schedule</p>
                  {/* Step 17H.2C item 17 — "see Billing Periods above" was
                      a reference to the now-removed standalone surface.
                      Period execution detail lives inside each entry's own
                      expandable panel now — point there instead. */}
                  <p className="text-[10px] text-stone/60 mt-0.5">Local projection — not yet created in {providerDisplayName(summary?.billingPlatform)}. Expand a period below for fixed/usage/performance execution detail.</p>
                </div>
              )}
              {/* Overdue-but-still-unsent entries first (e.g. held by the
                  fixed-fee-timing gate) — a purely visual "Today" divider
                  marks where genuinely-still-ahead entries begin; it is
                  never what decides Invoice history vs. Planned schedule
                  above. Every planned entry renders with isPast=false
                  regardless of which side it falls on, so an overdue
                  one-time fee still gets its "Move to parked" action
                  rather than being silently treated as settled. */}
              {overduePlanned.map(e => renderEntry(e, false))}
              {overduePlanned.length > 0 && upcomingPlanned.length > 0 && (
                <div className="flex gap-4 my-1">
                  <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
                    <div className="w-3.5 h-3.5 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5"
                      style={{ background: '#1A3D2B' }}>
                      <div className="w-1.5 h-1.5 rounded-full bg-white" />
                    </div>
                    <div className="flex-1 w-px mt-1" style={{ background: 'rgba(26,61,43,0.06)', minHeight: 12 }} />
                  </div>
                  <div className="pb-4">
                    <p className="text-[10px] font-bold text-[#1A3D2B] uppercase tracking-widest leading-tight mt-0.5">Today</p>
                    <p className="text-[10px] text-stone/60">{today.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                  </div>
                </div>
              )}
              {upcomingPlanned.map(e => renderEntry(e, false))}
            </div>
          </div>
        )
      })()}

      {/* Step 17H.4B0D4H1B4E2.3 §5-7 — Rolling-band evaluation: a
          cross-period runtime evaluation, not tied to any single period
          row (per §7's explicit allowance for Billing Timeline to host
          contract-level runtime cards alongside the period list). Runtime
          STATE only — periods elapsed, current vs. proposed band,
          evaluation readiness, and the actions that resolve a triggered
          transition; the contractual RULE (measurement window, trigger,
          effect, source) lives exclusively in Commercial Logic & Billing
          Setup (lib/commercial-components.ts's buildFixedComponent's
          "Volume adjustment" rows) and is never restated by
          RollingBandMigrationCard itself (see that component's own doc
          comment). Previously a separate top-level page section before
          this card; moved here because it's genuinely WHEN, not HOW. */}
      {(() => {
        const rollingBandMechanisms = (terms?.unsupported_commercial_mechanisms ?? []).filter(
          (m): m is UnsupportedCommercialMechanism & { rolling_band_migration: RollingBandMigrationConfig } =>
            m.execution_status === 'executable' && !!m.rolling_band_migration,
        )
        if (rollingBandMechanisms.length === 0) return null
        return (
          <div className="px-6 py-5" style={{ borderTop: '1px solid rgba(26,61,43,0.07)' }}>
            <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em]">Rolling-band evaluation</p>
            <p className="text-[10px] text-stone/60 mb-3">Current evaluation status of this agreement&apos;s rolling-volume pricing rule.</p>
            <div className="space-y-3">
              {rollingBandMechanisms.map((m, i) => (
                <RollingBandMigrationCard
                  key={`rbm:${i}`}
                  jobId={jobId}
                  mechanismKind={m.kind}
                  title={humanizeMechanismKind(m.kind)}
                  config={m.rolling_band_migration}
                  sourceClause={m.source_clause}
                  sections={m.source_sections}
                  onViewSource={onViewSource}
                  currency={currency}
                  contractedVolume={terms?.base_fee_committed_volume}
                  contractStartDate={contractStart}
                />
              ))}
            </div>
          </div>
        )
      })()}

      {/* Footer link */}
      <div className="px-6 py-3" style={{ background: 'rgba(26,61,43,0.03)', borderTop: '1px solid rgba(26,61,43,0.07)' }}>
        {isRememhill ? (
          <div className="flex items-center justify-end">
            <a href={sub.dashboardUrl} target="_blank" rel="noreferrer"
              className="text-[11px] font-semibold text-forest hover:text-sage transition-colors flex items-center gap-1">
              Open in {providerDisplayName(summary?.billingPlatform)} <i className="ti ti-external-link" style={{ fontSize: 10 }} />
            </a>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-stone/50 font-mono">{sub.id}</p>
            <a href={sub.dashboardUrl} target="_blank" rel="noreferrer"
              className="text-[11px] font-semibold text-forest hover:text-sage transition-colors flex items-center gap-1">
              Open in {providerDisplayName(summary?.billingPlatform)} <i className="ti ti-external-link" style={{ fontSize: 10 }} />
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
