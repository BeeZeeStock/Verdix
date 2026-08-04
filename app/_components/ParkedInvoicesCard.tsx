'use client'

import { useState } from 'react'

type ParkedInvoice = {
  id:          string
  feeLabel:    string | null
  currency:    string
  baseAmount:  number
  metricName:  string | null
  ratePerUnit: number | null
  description: string | null
}

type GeneratedEntry = {
  invoiceId: string
  amount:    number
  hostedUrl: string | null
  label:     string
}

function fmt(amount: number, currency: string) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount)
}

function ParkedFeeRow({
  fee,
  jobId,
  onGenerated,
}: {
  fee:         ParkedInvoice
  jobId:       string
  onGenerated: (entry: GeneratedEntry) => void
}) {
  const [quantity,    setQuantity]    = useState('')
  const [rateOverride, setRateOverride] = useState(fee.ratePerUnit != null ? String(fee.ratePerUnit) : '')
  const [generating,  setGenerating]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [expanded,    setExpanded]    = useState(false)

  const qty      = parseFloat(quantity)  || 0
  const rate     = parseFloat(rateOverride) || 0
  const computed = Math.round(qty * rate * 100) / 100
  const metricLabel = fee.metricName ?? 'units'

  const handleGenerate = async () => {
    if (!qty || !rate) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/parked-invoices`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fee_label:    fee.feeLabel,
          quantity:     qty,
          rate_per_unit: rate,
          metric_name:  metricLabel,
          currency:     fee.currency,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to generate invoice')
        return
      }
      setQuantity('')
      onGenerated({
        invoiceId: data.invoiceId,
        amount:    data.amount,
        hostedUrl: data.hostedUrl,
        label:     `${qty} ${metricLabel} @ ${fmt(rate, fee.currency)}`,
      })
    } catch {
      setError('Network error — please try again')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="border border-forest/10 rounded-xl overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-cream/40 transition-colors"
      >
        <div>
          <p className="text-sm font-medium text-ink">{fee.feeLabel ?? 'Service fee'}</p>
          {fee.description && (
            <p className="text-xs text-stone mt-0.5 line-clamp-1">{fee.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          {fee.ratePerUnit != null && (
            <span className="text-xs text-stone font-mono">
              {fmt(fee.ratePerUnit, fee.currency)}/{metricLabel}
            </span>
          )}
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'} text-stone`} style={{ fontSize: 13 }} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-forest/8 px-5 pb-5 pt-4 bg-cream/20">
          {fee.description && (
            <p className="text-xs text-stone mb-4">{fee.description}</p>
          )}

          <div className="grid grid-cols-2 gap-3 mb-4">
            {/* Quantity */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">
                {metricLabel.charAt(0).toUpperCase() + metricLabel.slice(1)} delivered
              </label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                placeholder={`Enter ${metricLabel}…`}
                className="w-full text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
              />
            </div>

            {/* Rate per unit */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">
                Rate per {metricLabel} ({fee.currency})
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={rateOverride}
                onChange={e => setRateOverride(e.target.value)}
                placeholder="Rate…"
                className="w-full text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
              />
            </div>
          </div>

          {/* Computed amount */}
          {qty > 0 && rate > 0 && (
            <div className="bg-white border border-forest/10 rounded-lg px-4 py-3 mb-4 flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-semibold text-stone mb-0.5">Invoice amount</p>
                <p className="text-lg font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(computed, fee.currency)}
                </p>
              </div>
              <p className="text-xs text-stone font-mono">
                {qty} {metricLabel} × {fmt(rate, fee.currency)}
              </p>
            </div>
          )}

          {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

          <button
            onClick={handleGenerate}
            disabled={generating || !qty || !rate}
            className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-40"
            style={{ background: '#1A3D2B', color: '#fff' }}
          >
            {generating
              ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> Generating…</>
              : <><i className="ti ti-send" style={{ fontSize: 13 }} /> Confirm delivery &amp; send invoice</>
            }
          </button>
        </div>
      )}
    </div>
  )
}

export function ParkedInvoicesCard({
  jobId,
  parkedInvoices,
}: {
  jobId:          string
  parkedInvoices: ParkedInvoice[]
}) {
  const [generated, setGenerated] = useState<GeneratedEntry[]>([])

  if (parkedInvoices.length === 0) return null

  return (
    <div className="bg-white border border-amber-200 rounded-2xl overflow-hidden">
      {/* Card header */}
      <div className="px-6 py-4 border-b border-amber-100 flex items-center gap-3"
        style={{ background: 'linear-gradient(135deg, #fffbf2 0%, #fff8e8 100%)' }}
      >
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: '#FEF3C7' }}
        >
          <i className="ti ti-clock-pause" style={{ fontSize: 16, color: '#D97706' }} />
        </div>
        <div>
          <p className="text-sm font-semibold text-amber-900">Parked Invoices</p>
          <p className="text-xs text-amber-700 mt-0.5">
            {parkedInvoices.length} service {parkedInvoices.length === 1 ? 'fee requires' : 'fees require'} manual confirmation before invoicing
          </p>
        </div>
      </div>

      {/* Fee rows */}
      <div className="px-5 py-4 space-y-3">
        {parkedInvoices.map(fee => (
          <ParkedFeeRow
            key={fee.id}
            fee={fee}
            jobId={jobId}
            onGenerated={entry => setGenerated(prev => [entry, ...prev])}
          />
        ))}
      </div>

      {/* Generated invoice history */}
      {generated.length > 0 && (
        <div className="border-t border-forest/8 px-5 py-4">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-stone mb-3">
            Invoices sent this session
          </p>
          <div className="space-y-2">
            {generated.map((g, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <i className="ti ti-check text-forest" style={{ fontSize: 13 }} />
                  <span className="text-ink font-mono text-xs">{g.invoiceId}</span>
                  <span className="text-stone text-xs">{g.label}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-ink">
                    {fmt(g.amount, 'EUR')}
                  </span>
                  {g.hostedUrl && (
                    <a
                      href={g.hostedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-forest hover:underline"
                    >
                      View →
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-5 pb-4">
        <p className="text-[10px] text-stone">
          Each confirmed delivery creates a separate Stripe invoice. The fee template stays parked so you can generate invoices for future deliveries.
        </p>
      </div>
    </div>
  )
}
