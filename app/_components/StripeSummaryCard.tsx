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

type Summary = {
  subscription: SubscriptionInfo
  invoices: InvoiceInfo[]
  annualDraftInvoices: InvoiceInfo[]
  oneTimeInvoices: InvoiceInfo[]
  paymentSchedule: YearPayment[] | null
  oneTimeFees: OneTimeFee[]
  contractStart: string | null
  currency: string
  paymentTermsDays: number | null
  computedInvoices: { external_invoice_id: string; status: string; total_amount: number; period_start: string }[]
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

function StatusPill({ status }: { status: string | null }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    active:   { bg: '#D4EAD9', color: '#1A3D2B', label: 'Active' },
    open:     { bg: '#FEF3C7', color: '#92400E', label: 'Open' },
    paid:     { bg: '#D4EAD9', color: '#1A3D2B', label: 'Paid' },
    void:     { bg: '#F3F4F6', color: '#6B7280', label: 'Void' },
    draft:    { bg: '#EFF6FF', color: '#1E40AF', label: 'Draft' },
    uncollectible: { bg: '#FEE2E2', color: '#991B1B', label: 'Uncollectible' },
    past_due: { bg: '#FEE2E2', color: '#991B1B', label: 'Past due' },
    canceled: { bg: '#F3F4F6', color: '#6B7280', label: 'Canceled' },
  }
  const s = status ?? 'unknown'
  const style = map[s] ?? { bg: '#F3F4F6', color: '#6B7280', label: s }
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: style.bg, color: style.color }}>
      {style.label}
    </span>
  )
}

export function StripeSummaryCard({ jobId }: { jobId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function doLoad() {
      try {
        const res = await fetch(`/api/jobs/${jobId}/stripe-summary`)
        if (cancelled) return
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          setError(d.error ?? `Error ${res.status}`)
        } else {
          setSummary(await res.json())
        }
      } catch {
        if (!cancelled) setError('Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    doLoad()
    return () => { cancelled = true }
  }, [jobId])

  const handleRefresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/stripe-summary`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error ?? `Error ${res.status}`)
      } else {
        setSummary(await res.json())
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [jobId])

  if (loading) return (
    <div className="bg-white rounded-2xl border border-forest/10 p-6 flex items-center gap-3">
      <div className="w-4 h-4 border-2 border-forest border-t-transparent rounded-full animate-spin" />
      <span className="text-[12px] text-stone">Loading Stripe configuration…</span>
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

  const { subscription: sub, invoices, annualDraftInvoices, oneTimeInvoices, paymentSchedule, oneTimeFees, currency, paymentTermsDays } = summary

  const now = new Date()
  const currentYearNum = paymentSchedule?.find(y => {
    const s = y.periodStart ? new Date(y.periodStart) : null
    const e = y.periodEnd   ? new Date(y.periodEnd)   : null
    return s && e && now >= s && now <= e
  })?.year ?? null

  // Match subscription invoices to years by arrival order (1st invoice = Year 1).
  // Matching by creation date fails when the subscription is created weeks before
  // the contract start date (invoice created Jul 18 but Year 1 starts Aug 1).
  const sortedSubscriptionInvoices = [...invoices].sort(
    (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime()
  )

  // Index pre-created annual drafts by year number for O(1) lookup in the table.
  const annualDraftByYear = new Map<number, InvoiceInfo>(
    (annualDraftInvoices ?? [])
      .filter(inv => inv.yearNum != null)
      .map(inv => [inv.yearNum!, inv])
  )

  return (
    <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
      {/* Header */}
      <div className="p-6 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
        <div>
          <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Billing setup</h2>
          <p className="text-[11px] text-stone mt-1">Live configuration pulled from your Stripe account</p>
        </div>
        <div className="flex items-center gap-3">
          {sub.isTest && (
            <span className="text-[10px] font-semibold px-2 py-1 rounded-full" style={{ background: '#EFF6FF', color: '#1E40AF', border: '1px solid #BFDBFE' }}>
              Test mode
            </span>
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

      {/* Subscription status row */}
      <div className="px-6 py-4 grid grid-cols-4 gap-6" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)', background: 'rgba(26,61,43,0.02)' }}>
        <div>
          <p className="text-[10px] font-semibold text-stone/60 uppercase tracking-[0.1em] mb-1.5">Status</p>
          <StatusPill status={sub.status} />
          {sub.cancelAtPeriodEnd && (
            <p className="text-[10px] text-amber-600 mt-1">Cancels at period end</p>
          )}
        </div>
        <div>
          <p className="text-[10px] font-semibold text-stone/60 uppercase tracking-[0.1em] mb-1.5">Billing cadence</p>
          <p className="text-[13px] font-medium text-ink">{intervalLabel(sub.interval, sub.intervalCount)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-stone/60 uppercase tracking-[0.1em] mb-1.5">Current period</p>
          <p className="text-[12px] text-ink">{fmtShortDate(sub.currentPeriodStart)} – {fmtShortDate(sub.currentPeriodEnd)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold text-stone/60 uppercase tracking-[0.1em] mb-1.5">Next invoice</p>
          <p className="text-[13px] font-medium text-ink">{fmtDate(sub.currentPeriodEnd)}</p>
        </div>
      </div>

      {/* Payment schedule */}
      {paymentSchedule && paymentSchedule.length > 0 && (
        <div className="px-6 py-5" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
          <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-3">Payment schedule</p>
          <table className="w-full">
            <thead>
              <tr>
                {['Year', 'Period', 'Invoice amount', 'Status'].map((h, i) => (
                  <th key={h} className="text-[10px] font-semibold text-stone/60 tracking-[0.09em] pb-2"
                    style={{ borderBottom: '1px solid rgba(26,61,43,0.08)', textAlign: i === 0 || i === 3 ? 'left' : i === 2 ? 'right' : 'left', paddingRight: i < 3 ? 24 : 0 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paymentSchedule.map(y => {
                const isCurrent = y.year === currentYearNum
                // Primary: subscription invoice matched by position (1st = Year 1, etc.)
                const subscriptionInvoice = sortedSubscriptionInvoices[y.year - 1]
                // Fallback: pre-created annual_base draft for this year
                const draftInvoice = !subscriptionInvoice ? annualDraftByYear.get(y.year) : undefined
                const displayInvoice = subscriptionInvoice ?? draftInvoice
                return (
                  <tr key={y.year} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                    <td className="py-2.5 pr-6 text-[12px] font-medium" style={{ color: isCurrent ? '#1A3D2B' : '#3D3935' }}>
                      Year {y.year}
                      {isCurrent && (
                        <span className="ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: '#D4EAD9', color: '#1A3D2B' }}>NOW</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-6 text-[12px] text-stone">
                      {y.periodStart && y.periodEnd
                        ? `${fmtShortDate(y.periodStart)} – ${fmtShortDate(y.periodEnd)}`
                        : '—'}
                    </td>
                    <td className="py-2.5 pr-6 text-[13px] font-semibold text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(y.amount, y.currency)}
                    </td>
                    <td className="py-2.5 text-[11px]">
                      {displayInvoice
                        ? <div className="flex items-center gap-2">
                            <StatusPill status={displayInvoice.status} />
                            {draftInvoice && !subscriptionInvoice && (
                              <span className="text-[9px] text-stone/60 italic">pre-created</span>
                            )}
                            {displayInvoice.number && <span className="text-stone font-mono">{displayInvoice.number}</span>}
                            {displayInvoice.hostedUrl && (
                              <a href={displayInvoice.hostedUrl} target="_blank" rel="noreferrer" className="text-forest hover:text-sage" title="View invoice">
                                <i className="ti ti-external-link" style={{ fontSize: 11 }} />
                              </a>
                            )}
                          </div>
                        : <span className="text-stone/50">No invoice found</span>
                      }
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Billing timeline ─────────────────────────────────────── */}
      {(() => {
        // Merge all invoices (subscription + one-time) into a unified chronological timeline
        type TLEntry = {
          id: string; label: string; dateLabel: string; date: Date; amount: number; currency: string
          status: string | null; hostedUrl?: string | null; pdfUrl?: string | null; kind: 'subscription' | 'one-time' | 'pending-setup'
        }
        const entries: TLEntry[] = []
        const netDays = paymentTermsDays ?? 30

        // One-time fee invoices that exist in Stripe — date is when the invoice
        // was issued (created). Already-issued invoices appear in the past section.
        for (const inv of oneTimeInvoices) {
          entries.push({
            id: inv.id, label: inv.feeLabel ?? 'One-time fee',
            dateLabel: 'Issued',
            date: new Date(inv.created), amount: inv.amount, currency: inv.currency,
            status: inv.status, hostedUrl: inv.hostedUrl, pdfUrl: inv.pdfUrl, kind: 'one-time',
          })
        }

        // Subscription invoices — issued invoices use creation date; drafts
        // (not yet sent to the customer) use period_end as the expected issue date
        for (const inv of invoices) {
          const isDraft = inv.status === 'draft'
          const date = isDraft && inv.periodEnd
            ? new Date(inv.periodEnd)
            : new Date(inv.created)
          entries.push({
            id: inv.id, label: 'Subscription',
            dateLabel: isDraft ? 'Will be issued' : 'Issued',
            date, amount: inv.amount, currency: inv.currency,
            status: inv.status, hostedUrl: inv.hostedUrl, pdfUrl: inv.pdfUrl, kind: 'subscription',
          })
        }

        // One-time fees not yet pushed to Stripe — date is approximate issue date
        if (oneTimeInvoices.length === 0 && oneTimeFees.length > 0) {
          for (const fee of oneTimeFees) {
            const issueDate = fee.due_date && new Date(fee.due_date) > new Date()
              ? new Date(fee.due_date)
              : new Date()
            entries.push({
              id: `pending-${fee.fee_label}`, label: fee.fee_label,
              dateLabel: 'Will be issued',
              date: issueDate, amount: fee.amount, currency: currency,
              status: 'pending', kind: 'pending-setup',
            })
          }
        }

        if (entries.length === 0) return null

        // Sort chronologically
        entries.sort((a, b) => a.date.getTime() - b.date.getTime())

        const today = new Date()

        // Draft/pending invoices haven't been sent yet — always in the future section.
        // Sent invoices (open/paid) split on whether their date is before today.
        const isUnsent = (e: TLEntry) => e.status === 'draft' || e.status === 'pending'
        const pastEntries   = entries.filter(e => !isUnsent(e) && e.date <= today)
        const futureEntries = entries.filter(e =>  isUnsent(e) || e.date > today)

        const dotColor = (status: string | null) => {
          if (status === 'paid')    return '#27AE60'
          if (status === 'open')    return '#D97706'
          if (status === 'draft')   return '#6B9FD4'
          if (status === 'pending') return '#9CA3AF'
          return '#9CA3AF'
        }

        const renderEntry = (e: TLEntry, isPast: boolean) => (
          <div key={e.id} className="flex gap-4 group">
            {/* Dot */}
            <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
              <div className="w-3 h-3 rounded-full border-2 border-white flex-shrink-0 mt-0.5"
                style={{ background: dotColor(e.status), boxShadow: `0 0 0 2px ${dotColor(e.status)}40` }} />
              <div className="flex-1 w-px mt-1" style={{ background: isPast ? 'rgba(26,61,43,0.12)' : 'rgba(26,61,43,0.06)', minHeight: 12 }} />
            </div>

            {/* Content */}
            <div className="pb-4 flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className={`text-[12px] font-medium leading-tight ${isPast ? 'text-ink' : 'text-ink/80'}`}>{e.label}</p>
                  <p className="text-[10px] text-stone mt-0.5">
                    <span className="text-stone/50">{e.dateLabel} </span>
                    {e.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[13px] font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(e.amount, e.currency)}
                  </span>
                  <StatusPill status={e.status} />
                  {e.pdfUrl && (
                    <a href={e.pdfUrl} target="_blank" rel="noreferrer"
                      className="text-stone/40 hover:text-stone transition-colors" title="Download PDF">
                      <i className="ti ti-file-download" style={{ fontSize: 11 }} />
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
        )

        return (
          <div className="px-6 py-5">
            <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-4">Billing timeline</p>

            {/* One-time fee pending-setup notice */}
            {oneTimeInvoices.length === 0 && oneTimeFees.length > 0 && (
              <div className="rounded-xl px-4 py-3 text-[12px] text-amber-800 mb-4" style={{ background: '#FFFBEB', border: '1px solid #FCD34D' }}>
                {oneTimeFees.length} one-time fee{oneTimeFees.length > 1 ? 's' : ''} ({oneTimeFees.map(f => f.fee_label).join(', ')}) — invoices will be created in Stripe when you re-push this contract.
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
      <div className="px-6 py-3 flex items-center justify-between" style={{ background: 'rgba(26,61,43,0.03)', borderTop: '1px solid rgba(26,61,43,0.07)' }}>
        <p className="text-[10px] text-stone/50 font-mono">{sub.id}</p>
        <a href={sub.dashboardUrl} target="_blank" rel="noreferrer"
          className="text-[11px] font-semibold text-forest hover:text-sage transition-colors flex items-center gap-1">
          Open in Stripe <i className="ti ti-external-link" style={{ fontSize: 10 }} />
        </a>
      </div>
    </div>
  )
}
