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
  pdfUrl: string | null
  hostedUrl: string | null
  feeLabel?: string | null
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
  oneTimeInvoices: InvoiceInfo[]
  paymentSchedule: YearPayment[] | null
  oneTimeFees: OneTimeFee[]
  contractStart: string | null
  currency: string
  computedInvoices: { external_invoice_id: string; status: string; total_amount: number; period_start: string }[]
}

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n)
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

  const { subscription: sub, invoices, oneTimeInvoices, paymentSchedule, oneTimeFees, currency } = summary

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

  return (
    <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
      {/* Header */}
      <div className="p-6 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
        <div>
          <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Stripe billing setup</h2>
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
                // Match by position: the n-th subscription invoice = Year n.
                // Date-range matching fails when the subscription starts before
                // the contract year (e.g. created Jul 18 but Year 1 starts Aug 1).
                const matchedInvoice = sortedSubscriptionInvoices[y.year - 1]
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
                      {matchedInvoice
                        ? <div className="flex items-center gap-2">
                            <StatusPill status={matchedInvoice.status} />
                            {matchedInvoice.number && <span className="text-stone font-mono">{matchedInvoice.number}</span>}
                            {matchedInvoice.hostedUrl && (
                              <a href={matchedInvoice.hostedUrl} target="_blank" rel="noreferrer" className="text-forest hover:text-sage" title="View invoice">
                                <i className="ti ti-external-link" style={{ fontSize: 11 }} />
                              </a>
                            )}
                          </div>
                        : <span className="text-stone/50">{y.year > (currentYearNum ?? 0) ? 'Not yet generated' : 'No invoice found'}</span>
                      }
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* One-time fee invoices (standalone, created at push time) */}
      {(oneTimeInvoices.length > 0 || oneTimeFees.length > 0) && (
        <div className="px-6 py-5" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
          <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-3">
            One-time fee invoices
            <span className="ml-2 font-normal normal-case text-stone/60">separate invoices per milestone</span>
          </p>
          {oneTimeInvoices.length > 0 ? (
            <table className="w-full">
              <thead>
                <tr>
                  {['Description', 'Amount', 'Due date', 'Invoice', 'Status', ''].map((h, i) => (
                    <th key={i} className="text-[10px] font-semibold text-stone/60 tracking-[0.09em] pb-2"
                      style={{ borderBottom: '1px solid rgba(26,61,43,0.08)', textAlign: i === 1 ? 'right' : 'left', paddingRight: i < 5 ? 16 : 0 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {oneTimeInvoices.map(inv => (
                  <tr key={inv.id} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                    <td className="py-2.5 pr-4 text-[12px] text-ink">{inv.feeLabel ?? inv.number ?? '—'}</td>
                    <td className="py-2.5 pr-4 text-[13px] font-semibold text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(inv.amount, inv.currency)}
                    </td>
                    <td className="py-2.5 pr-4 text-[12px] text-stone">{fmtDate(inv.dueDate)}</td>
                    <td className="py-2.5 pr-4 text-[11px] font-mono text-stone">{inv.number ?? inv.id.slice(0, 14)}</td>
                    <td className="py-2.5 pr-4"><StatusPill status={inv.status} /></td>
                    <td className="py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {inv.hostedUrl && (
                          <a href={inv.hostedUrl} target="_blank" rel="noreferrer"
                            className="text-[11px] font-semibold text-forest hover:text-sage transition-colors">
                            View
                          </a>
                        )}
                        {inv.pdfUrl && (
                          <a href={inv.pdfUrl} target="_blank" rel="noreferrer"
                            className="text-stone/50 hover:text-stone transition-colors" title="Download PDF">
                            <i className="ti ti-file-download" style={{ fontSize: 12 }} />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="rounded-xl px-4 py-3 text-[12px] text-amber-800" style={{ background: '#FFFBEB', border: '1px solid #FCD34D' }}>
              {oneTimeFees.length} one-time fee{oneTimeFees.length > 1 ? 's' : ''} in contract
              ({oneTimeFees.map(f => f.fee_label).join(', ')}) — invoices will be created in Stripe when you re-push this contract.
            </div>
          )}
        </div>
      )}

      {/* Invoice history */}
      {invoices.length > 0 && (
        <div className="px-6 py-5">
          <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-3">Invoice history</p>
          <table className="w-full">
            <thead>
              <tr>
                {['Invoice', 'Created', 'Due', 'Amount', 'Status', ''].map((h, i) => (
                  <th key={i} className="text-[10px] font-semibold text-stone/60 tracking-[0.09em] pb-2"
                    style={{ borderBottom: '1px solid rgba(26,61,43,0.08)', textAlign: i === 3 ? 'right' : 'left', paddingRight: i < 5 ? 16 : 0 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id} style={{ borderBottom: '1px solid rgba(26,61,43,0.05)' }}>
                  <td className="py-2.5 pr-4 text-[11px] font-mono text-stone">{inv.number ?? inv.id.slice(0, 12)}</td>
                  <td className="py-2.5 pr-4 text-[12px] text-stone">{fmtDate(inv.created)}</td>
                  <td className="py-2.5 pr-4 text-[12px] text-stone">{fmtDate(inv.dueDate)}</td>
                  <td className="py-2.5 pr-4 text-[13px] font-semibold text-ink text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(inv.amount, inv.currency)}
                  </td>
                  <td className="py-2.5 pr-4"><StatusPill status={inv.status} /></td>
                  <td className="py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {inv.hostedUrl && (
                        <a href={inv.hostedUrl} target="_blank" rel="noreferrer"
                          className="text-[11px] font-semibold text-forest hover:text-sage transition-colors">
                          View
                        </a>
                      )}
                      {inv.pdfUrl && (
                        <a href={inv.pdfUrl} target="_blank" rel="noreferrer"
                          className="text-stone/50 hover:text-stone transition-colors" title="Download PDF">
                          <i className="ti ti-file-download" style={{ fontSize: 12 }} />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
