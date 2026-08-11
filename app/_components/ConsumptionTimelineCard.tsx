'use client'

import { useEffect, useState, useCallback } from 'react'

type OverageItem = {
  meter_key:      string
  total_units:    number
  included_units: number
  billable_units: number
  rate_per_unit:  number
  amount:         number
  currency:       string
  description:    string
}

type Period = {
  id:           string
  periodStart:  string
  periodEnd:    string
  status:       'past' | 'current' | 'pending' | 'future'
  currency:     string
  overageItems: OverageItem[]
  overageTotal: number
}

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function periodLabel(start: string, end: string) {
  const s = new Date(start + 'T00:00:00')
  const e = new Date(end   + 'T00:00:00')
  if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()) {
    return s.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  }
  return `${s.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })} – ${e.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}`
}

const STATUS_STYLE: Record<Period['status'], { icon: string; color: string; label: string }> = {
  past:    { icon: 'ti-circle-check',  color: '#27AE60', label: 'Billed' },
  current: { icon: 'ti-clock',         color: '#D97706', label: 'In progress' },
  pending: { icon: 'ti-hourglass-low', color: '#7C3AED', label: 'Awaiting next invoice' },
  future:  { icon: 'ti-circle-dashed', color: '#9CA3AF', label: 'Upcoming' },
}

export function ConsumptionTimelineCard({ jobId }: { jobId: string }) {
  const [periods, setPeriods] = useState<Period[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cardOpen, setCardOpen] = useState(false)

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/consumption-summary`)
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const data = await res.json() as { periods: Period[] }
      setPeriods(data.periods ?? [])
      setError(null)
    } catch {
      setError('Failed to load consumption data')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [jobId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(false)
  }, [load])

  const toggleExpanded = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  if (loading || error || periods.length === 0) return null

  return (
    <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
      <div
        className={`p-6 flex items-start justify-between cursor-pointer ${cardOpen ? 'pb-2' : ''}`}
        style={cardOpen ? { borderBottom: '1px solid rgba(26,61,43,0.07)' } : undefined}
        onClick={() => setCardOpen(o => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') setCardOpen(o => !o) }}
      >
        <div className="flex items-start gap-1.5">
          <i className={`ti ti-chevron-right flex-shrink-0 transition-transform ${cardOpen ? 'rotate-90' : ''}`}
            style={{ fontSize: 12, color: '#9CA3AF', marginTop: 2 }} />
          <div>
            <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em]">Consumption</h2>
            <p className="text-[11px] text-stone mt-1">Usage per billing cycle — what gets pushed into invoicing</p>
          </div>
        </div>
        {cardOpen && (
          <button
            onClick={ev => { ev.stopPropagation(); load(true) }}
            disabled={refreshing}
            className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-xl transition-colors disabled:opacity-50 flex-shrink-0"
            style={{ background: '#EEF9F2', color: '#1A3D2B', border: '1px solid rgba(74,124,89,0.25)' }}
          >
            <i className={`ti ti-refresh ${refreshing ? 'animate-spin' : ''}`} style={{ fontSize: 11 }} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {cardOpen && (
      <div className="px-6 py-5">
        {periods.map(p => {
          const isOpen = expanded.has(p.id)
          const style  = STATUS_STYLE[p.status]
          return (
            <div key={p.id} className="flex gap-4 group">
              <div className="flex flex-col items-center flex-shrink-0" style={{ width: 20 }}>
                <i className={`ti ${style.icon} flex-shrink-0`} style={{ fontSize: 15, color: style.color, marginTop: 1 }} />
                <div className="flex-1 w-px mt-1" style={{ background: p.status === 'future' ? 'rgba(26,61,43,0.06)' : 'rgba(26,61,43,0.12)', minHeight: 12 }} />
              </div>

              <div className="pb-4 flex-1 min-w-0">
                <div
                  className="flex items-start justify-between gap-3 cursor-pointer"
                  onClick={() => toggleExpanded(p.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') toggleExpanded(p.id) }}
                >
                  <div className="min-w-0 flex items-start gap-1.5">
                    <i className={`ti ti-chevron-right flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }} />
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium leading-tight text-ink">{periodLabel(p.periodStart, p.periodEnd)}</p>
                      <p className="text-[10px] text-stone mt-0.5">
                        {fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[13px] font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(p.overageTotal, p.currency)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: style.color }}>
                      <i className={`ti ${style.icon}`} style={{ fontSize: 13 }} />
                      {style.label}
                    </span>
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-2 ml-[18px] rounded-xl overflow-hidden text-[11px]" style={{ border: '1px solid rgba(26,61,43,0.08)' }}>
                    {p.status === 'past' && (
                      <div className="px-3 py-2 flex items-center gap-1.5 text-[10px] text-stone/70" style={{ background: 'rgba(26,61,43,0.02)', borderBottom: '1px solid rgba(26,61,43,0.06)' }}>
                        <i className="ti ti-info-circle flex-shrink-0" style={{ fontSize: 11 }} />
                        <span>Billed in arrears.</span>
                      </div>
                    )}
                    <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'rgba(26,61,43,0.03)' }}>
                          <th className="text-left font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Meter</th>
                          <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total usage</th>
                          <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Included</th>
                          <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Billable</th>
                          <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.status === 'future' ? (
                          <tr>
                            <td className="px-3 py-2 text-stone/50 italic" colSpan={5}>Will be measured at the end of the billing cycle</td>
                          </tr>
                        ) : p.overageItems.length === 0 ? (
                          <tr>
                            <td className="px-3 py-2 text-stone/40" colSpan={5}>
                              {p.status === 'current' ? 'No usage recorded yet this cycle'
                                : p.status === 'pending' ? 'No overage — will be billed with the next invoice'
                                : 'No usage overage for this period'}
                            </td>
                          </tr>
                        ) : (
                          p.overageItems.map((item, i) => (
                            <tr key={i} style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                              <td className="px-3 py-2 text-ink" title={item.description}>{item.meter_key}</td>
                              <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{item.total_units.toLocaleString()}</td>
                              <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{item.included_units.toLocaleString()}</td>
                              <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{item.billable_units.toLocaleString()}</td>
                              <td className="px-3 py-2 text-right font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(item.amount, item.currency)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}
