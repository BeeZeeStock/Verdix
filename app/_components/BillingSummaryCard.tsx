'use client'

import { useState, useEffect, useCallback } from 'react'

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
  amount: number
  currency: string
  description: string
  metric_source: 'meter_pull' | 'client_pull'
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
  feeLabel:    string | null
  currency:    string
  baseAmount:  number
  metricName:  string | null
  ratePerUnit: number | null
  description: string | null
}

type Summary = {
  subscription: SubscriptionInfo
  invoices: InvoiceInfo[]
  annualDraftInvoices: InvoiceInfo[]
  oneTimeInvoices: InvoiceInfo[]
  parkedInvoices?: ParkedInvoiceSummary[]
  paymentSchedule: YearPayment[] | null
  oneTimeFees: OneTimeFee[]
  contractStart: string | null
  currency: string
  paymentTermsDays: number | null
  computedInvoices: { external_invoice_id: string; status: string; total_amount: number; period_start: string }[]
  billingPlatform?: string
  hasOverageTerms?: boolean
}

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
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
  const [repairing, setRepairing]     = useState(false)
  const [repairResult, setRepairResult] = useState<string | null>(null)
  const [expanded, setExpanded]       = useState<Set<string>>(new Set())

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

  const handleRepair = useCallback(async () => {
    setRepairing(true)
    setRepairResult(null)
    try {
      const res  = await fetch(`/api/jobs/${jobId}/remembill-repair`, { method: 'POST' })
      const data = await res.json() as { fixed?: Record<string, unknown>[]; repairedCount?: number; message?: string; error?: string }
      console.log('[remembill-repair] full debug output:', JSON.stringify(data, null, 2))
      if (!res.ok) {
        setRepairResult(`Error: ${data.error ?? res.status}`)
      } else if (data.message) {
        setRepairResult(data.message)
      } else {
        const fixed = data.fixed ?? []
        const hasRowsCount = fixed.filter(r => r.hasRows).length
        const noRowsCount  = fixed.filter(r => r.hasRows === false).length
        if (hasRowsCount > 0) {
          setRepairResult(`${hasRowsCount} invoice${hasRowsCount > 1 ? 's' : ''} repaired ✓`)
          await handleRefresh()
        } else if (noRowsCount > 0) {
          setRepairResult(`Invoice sent but rows still missing — check browser console for debug output`)
        } else {
          setRepairResult('No invoices processed')
        }
      }
    } catch {
      setRepairResult('Network error')
    } finally {
      setRepairing(false)
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

  const { subscription: sub, invoices, annualDraftInvoices, oneTimeInvoices, paymentSchedule, oneTimeFees, currency, paymentTermsDays, contractStart, hasOverageTerms } = summary


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
          {isRememhill && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleRepair}
                disabled={repairing}
                title="Find invoices missing line items and recreate them with the correct rows"
                className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-xl transition-colors disabled:opacity-50"
                style={{ background: '#FFF7ED', color: '#C2410C', border: '1px solid rgba(194,65,12,0.25)' }}
              >
                <i className={`ti ti-tools ${repairing ? 'animate-spin' : ''}`} style={{ fontSize: 11 }} />
                {repairing ? 'Repairing…' : 'Repair rows'}
              </button>
              {repairResult && (
                <span className="text-[11px]" style={{ color: repairResult.startsWith('Error') ? '#DC2626' : '#0B5C36' }}>
                  {repairResult}
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


      {/* ── Billing timeline ─────────────────────────────────────── */}
      {(() => {
        // Merge all invoices (subscription + one-time) into a unified chronological timeline
        type TLEntry = {
          id: string; label: string; dateLabel: string; date: Date; amount: number; currency: string
          status: string | null; hostedUrl?: string | null; pdfUrl?: string | null; kind: 'subscription' | 'one-time' | 'pending-setup'
          baseAmount: number; overageLineItems: OverageLineItem[]; overageTotal: number; description?: string | null
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
          if (status === 'draft')   return { icon: 'ti-circle-dashed', color: '#9CA3AF' }
          if (status === 'pending') return { icon: 'ti-circle-dashed', color: '#9CA3AF' }
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
          const effectiveStatus = isPast ? e.status : 'draft'
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
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(e.amount, e.currency)}
                    </span>
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
                <div className="mt-2 ml-[18px] rounded-xl px-3.5 py-3 text-[11px]" style={{ background: 'rgba(26,61,43,0.025)', border: '1px solid rgba(26,61,43,0.06)' }}>
                  {e.kind === 'subscription' ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-stone">Base subscription fee</span>
                        <span className="font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.baseAmount, e.currency)}</span>
                      </div>
                      {e.overageLineItems.length > 0 ? (
                        <>
                          <p className="text-[10px] font-semibold text-stone uppercase tracking-wide pt-1">Usage-based overage</p>
                          {e.overageLineItems.map((item, i) => (
                            <div key={i} className="flex items-center justify-between gap-3">
                              <span className="text-stone/80 min-w-0 truncate" title={item.description}>
                                {item.meter_key} — {item.total_units.toLocaleString()} used, {item.included_units.toLocaleString()} included
                              </span>
                              <span className="font-medium text-ink flex-shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(item.amount, item.currency)}</span>
                            </div>
                          ))}
                          <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid rgba(26,61,43,0.08)' }}>
                            <span className="font-medium text-ink">Total invoiced</span>
                            <span className="font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(e.amount, e.currency)}</span>
                          </div>
                        </>
                      ) : isPast ? (
                        hasOverageTerms && <p className="text-stone/60">No usage overage for this period.</p>
                      ) : hasOverageTerms ? (
                        <p className="text-stone/60 italic">Actual usage data will be pulled at the end of the billing cycle, as per the agreement.</p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-stone/70">{e.description || 'One-time fee — no additional usage detail.'}</p>
                  )}
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
