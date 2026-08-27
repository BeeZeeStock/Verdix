'use client'

import { useState, useEffect, useCallback } from 'react'
import { partialPeriodLabel } from '@/lib/cadence-labels'
import { VatConfigRow } from './VatConfigRow'
import { useVatConfig } from './useVatConfig'
import { resolveInvoiceVatDisplay } from '@/lib/vat'
import { FinancialAmount } from './FinancialAmount'

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

type ParkedInvoiceSummary = {
  id:          string
  // Stable Step-13 subject identity — see lib/types.ts's OneTimeFee.fee_id —
  // null for a genuinely manual/quantity-rate fee that never entered the
  // Step-12 event lifecycle.
  feeId:       string | null
  feeLabel:    string | null
  currency:    string
  baseAmount:  number
  metricName:  string | null
  ratePerUnit: number | null
  description: string | null
  billabilityCondition: { kind: 'immediate' } | { kind: 'fixed_date'; date: string }
    | { kind: 'event'; event_type: 'contract_signature' | 'delivery' | 'customer_acceptance' | 'final_acceptance' | 'change_order_signature' } | null
  evidence:    { occurredAt: string; recordedAt: string } | null
  plannedInvoiceStatus: string
}

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



export function BillingSummaryCard({ jobId, onHasSchedule, onParkedInvoices, onSentOneTimeInvoices }: {
  jobId: string
  onHasSchedule?: (has: boolean) => void
  onParkedInvoices?: (invoices: ParkedInvoiceSummary[]) => void
  onSentOneTimeInvoices?: (invoices: { feeLabel: string | null; amount: number }[]) => void
}) {
  const [summary, setSummary]         = useState<Summary | null>(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [parking, setParking]         = useState<Set<string>>(new Set())
  const [syncing, setSyncing]         = useState(false)
  const [syncResult, setSyncResult]   = useState<{ checked: number; paid: number } | null>(null)
  const [expanded, setExpanded]       = useState<Set<string>>(new Set())
  // For the net/VAT/gross breakdown on each invoice row below — same
  // canonical hook/endpoint every VAT surface in the product uses (see
  // useVatConfig's own comment), read-only here.
  const vat = useVatConfig(jobId)

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
  }, [jobId, onHasSchedule, onParkedInvoices, onSentOneTimeInvoices])

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

  const { subscription: sub, invoices, annualDraftInvoices, oneTimeInvoices, commercialRuleEvents, paymentSchedule, oneTimeFees, currency, paymentTermsDays, contractStart, hasOverageTerms, overageMeterTypes } = summary
  const meterTypes = overageMeterTypes ?? []


  return (
    <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
      {/* Header */}
      <div className="p-6 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
        <div>
          <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Billing setup</h2>
          <p className="text-[11px] text-stone mt-1">
            {isRememhill ? 'Invoice schedule managed via Remembill' : 'Live configuration pulled from your Stripe account'}
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

      {sub.cancelAtPeriodEnd && (
        <div className="px-6 py-2" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)', background: 'rgba(26,61,43,0.02)' }}>
          <p className="text-[10px] text-amber-600">Cancels at period end</p>
        </div>
      )}

      <VatConfigRow jobId={jobId} />


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
          // commercial-rule only: a confirmed metric-level commitment whose
          // cadence window hasn't closed yet, so no real invoice row exists.
          commercialRule?: { meterKey: string; mode: string; cadence: string; windowEnd: string; partialPeriod: CommercialRuleEvent['partialPeriod']; isDeterministic: boolean }
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
        // closes). Without this, the timeline silently contradicts a
        // Commercial Terms card that already says the rule is confirmed.
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

        if (entries.length === 0) return null

        // Sort chronologically
        entries.sort((a, b) => a.date.getTime() - b.date.getTime())

        const today = new Date()

        // Contract date is the gate: past = billing event has occurred per schedule.
        const pastEntries   = entries.filter(e => e.date <= today)
        const futureEntries = entries.filter(e => e.date >  today)

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

        const renderEntry = (e: TLEntry, isPast: boolean) => {
          // Verdix terminology: contract date is the gate.
          // Past date + Stripe open/paid = Issued (sent to customer, awaiting payment)
          // Past date + Stripe paid      = Paid
          // Future date                  = Draft (not yet issued, regardless of Stripe status)
          const effectiveStatus = e.kind === 'commercial-rule' ? 'scheduled' : (isPast ? e.status : 'draft')
          const canPark = !isPast && e.kind === 'one-time'
          const isOpen = expanded.has(e.id)
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
                      <span className="text-stone/50">{e.dateLabel} </span>
                      {e.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
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
                      <span className="text-[13px] font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(e.amount, e.currency)}
                      </span>
                    )}
                    <StatusBadge status={effectiveStatus} />
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
                <div className="mt-2 ml-[18px] rounded-xl overflow-hidden text-[11px]" style={{ border: '1px solid rgba(26,61,43,0.08)' }}>
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
                          <tr style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                            <td className="px-3 py-2 text-ink">{e.label}</td>
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
                          ) : hasOverageTerms ? (
                            meterTypes.map(mt => (
                              <tr key={mt} style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                                <td className="px-3 py-2 text-ink">{mt} overage</td>
                                <td className="px-3 py-2 text-right text-stone/40">—</td>
                                <td className="px-3 py-2 text-right text-stone/40">—</td>
                                <td className="px-3 py-2 text-right text-stone/50 italic">Will be calculated at the end of the billing cycle</td>
                              </tr>
                            ))
                          ) : null}
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
                                <td className="px-3 py-2 text-stone" colSpan={3}>
                                  VAT ({display.vatRatePct}%){display.isSnapshot && e.vatSource === 'override' ? ' · invoice override' : ''}
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
              )}
            </div>
          </div>
          )
        }

        return (
          <div className="px-6 py-5">
            <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-4">Billing timeline</p>

            {/* One-time fee pending-setup notice */}
            {oneTimeInvoices.length === 0 && oneTimeFees.length > 0 && (
              <div className="rounded-xl px-4 py-3 text-[12px] text-amber-800 mb-4" style={{ background: '#FFFBEB', border: '1px solid #FCD34D' }}>
                {oneTimeFees.length} one-time fee{oneTimeFees.length > 1 ? 's' : ''} ({oneTimeFees.map(f => f.fee_label).join(', ')}) — invoices will be created in {isRememhill ? 'Remembill' : 'Stripe'} when you re-push this contract.
              </div>
            )}

            <div>
              {/* Past invoices */}
              {pastEntries.map(e => renderEntry(e, true))}

              {/* Today marker */}
              <div className="flex gap-4 my-1">
                <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
                  <div className="w-3.5 h-3.5 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5"
                    style={{ background: '#1A3D2B' }}>
                    <div className="w-1.5 h-1.5 rounded-full bg-white" />
                  </div>
                  {futureEntries.length > 0 && <div className="flex-1 w-px mt-1" style={{ background: 'rgba(26,61,43,0.06)', minHeight: 12 }} />}
                </div>
                <div className="pb-4">
                  <p className="text-[10px] font-bold text-[#1A3D2B] uppercase tracking-widest leading-tight mt-0.5">Today</p>
                  <p className="text-[10px] text-stone/60">{today.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                </div>
              </div>

              {/* Upcoming invoices */}
              {futureEntries.map(e => renderEntry(e, false))}
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
              Open in Remembill <i className="ti ti-external-link" style={{ fontSize: 10 }} />
            </a>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-stone/50 font-mono">{sub.id}</p>
            <a href={sub.dashboardUrl} target="_blank" rel="noreferrer"
              className="text-[11px] font-semibold text-forest hover:text-sage transition-colors flex items-center gap-1">
              Open in Stripe <i className="ti ti-external-link" style={{ fontSize: 10 }} />
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
