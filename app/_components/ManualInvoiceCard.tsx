'use client'

import { useEffect, useState, useCallback } from 'react'

type Meter = {
  meterKey:      string
  includedUnits: number
  overageTiers:  Array<{ from_unit: number | null; to_unit: number | null; rate_per_unit: number }>
  billingCycle:  string
}

type PresetFee = {
  label:    string
  amount:   number
  currency: string
  kind:     'recurring' | 'one_time'
}

type PreviewLineItem = { description: string; quantity: number; unitPrice: number }
type Preview = { lineItems: PreviewLineItem[]; total: number; currency: string }

function fmt(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

// Per-unit rates are often sub-cent for high-volume metrics (e.g. 0.0012) —
// formatting at a fixed 2 decimals rounds them to 0.00 and makes a real
// price look unset. Show up to 6 decimals, trimmed of trailing zeros.
function fmtRate(n: number, cur = 'EUR') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n)
}

function FeeSection({
  title, presets, enabled, setEnabled, label, setLabel, amount, setAmount,
}: {
  title:      string
  presets:    PresetFee[]
  enabled:    boolean
  setEnabled: (v: boolean) => void
  label:      string
  setLabel:   (v: string) => void
  amount:     string
  setAmount:  (v: string) => void
}) {
  return (
    <div className="border border-forest/10 rounded-xl p-3">
      <label className="flex items-center gap-2 cursor-pointer mb-2">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded" />
        <span className="text-[11px] font-semibold text-ink">{title}</span>
      </label>
      {enabled && (
        <div className="space-y-2 pl-6">
          {presets.length > 0 && (
            <select
              className="w-full text-xs border border-forest/20 rounded-lg px-2.5 py-1.5 bg-white text-ink focus:outline-none focus:border-forest/40"
              onChange={e => {
                const preset = presets.find(p => p.label === e.target.value)
                if (preset) { setLabel(preset.label); setAmount(String(preset.amount)) }
              }}
              defaultValue=""
            >
              <option value="" disabled>Use a preset from the billing configuration…</option>
              {presets.map(p => <option key={p.label} value={p.label}>{p.label} — {fmt(p.amount, p.currency)}</option>)}
            </select>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input
              value={label} onChange={e => setLabel(e.target.value)}
              placeholder="Description"
              className="text-xs border border-forest/20 rounded-lg px-2.5 py-1.5 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
            />
            <input
              type="number" min="0" step="0.01"
              value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="Amount"
              className="text-xs border border-forest/20 rounded-lg px-2.5 py-1.5 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
            />
          </div>
        </div>
      )}
    </div>
  )
}

export function ManualInvoiceCard({ jobId }: { jobId: string }) {
  const [meters,     setMeters]     = useState<Meter[]>([])
  const [presetFees, setPresetFees] = useState<PresetFee[]>([])
  const [currency,   setCurrency]   = useState('EUR')
  const [hasCustomer, setHasCustomer] = useState(true)
  const [loading,    setLoading]    = useState(true)
  const [expanded,   setExpanded]   = useState(false)

  const [meterKey, setMeterKey] = useState('')
  const [usage,    setUsage]    = useState('')

  const [fixedEnabled, setFixedEnabled] = useState(false)
  const [fixedLabel,   setFixedLabel]   = useState('')
  const [fixedAmount,  setFixedAmount]  = useState('')

  const [oneTimeEnabled, setOneTimeEnabled] = useState(false)
  const [oneTimeLabel,   setOneTimeLabel]   = useState('')
  const [oneTimeAmount,  setOneTimeAmount]  = useState('')

  const [preview,     setPreview]     = useState<Preview | null>(null)
  const [previewing,  setPreviewing]  = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pushing,      setPushing]      = useState(false)
  const [pushResult,   setPushResult]   = useState<{ invoiceId: string; hostedUrl: string | null; total: number } | null>(null)
  const [pushError,    setPushError]    = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/jobs/${jobId}/manual-invoice`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data) return
        setMeters(data.meters ?? [])
        setPresetFees(data.presetFees ?? [])
        setCurrency(data.currency ?? 'EUR')
        setHasCustomer(Boolean(data.hasCustomer))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jobId])

  const selectedMeter = meters.find(m => m.meterKey === meterKey) ?? null

  const buildBody = useCallback((push: boolean) => ({
    meterKey:   meterKey || undefined,
    usage:      usage ? parseFloat(usage) : undefined,
    fixedFee:   fixedEnabled && fixedLabel && fixedAmount ? { label: fixedLabel, amount: parseFloat(fixedAmount) } : null,
    oneTimeFee: oneTimeEnabled && oneTimeLabel && oneTimeAmount ? { label: oneTimeLabel, amount: parseFloat(oneTimeAmount) } : null,
    push,
  }), [meterKey, usage, fixedEnabled, fixedLabel, fixedAmount, oneTimeEnabled, oneTimeLabel, oneTimeAmount])

  const runPreview = async () => {
    setPreviewing(true); setPreviewError(null); setPreview(null); setPushResult(null); setPushError(null)
    try {
      const res  = await fetch(`/api/jobs/${jobId}/manual-invoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(false)),
      })
      const data = await res.json()
      if (!res.ok) { setPreviewError(data.error ?? 'Preview failed'); return }
      setPreview(data.preview)
    } catch {
      setPreviewError('Network error — please try again')
    } finally {
      setPreviewing(false)
    }
  }

  const handlePush = async () => {
    setPushing(true); setPushError(null)
    try {
      const res  = await fetch(`/api/jobs/${jobId}/manual-invoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(true)),
      })
      const data = await res.json()
      if (!res.ok) { setPushError(data.error ?? 'Failed to push invoice'); return }
      setPushResult(data)
      setPreview(null)
    } catch {
      setPushError('Network error — please try again')
    } finally {
      setPushing(false)
    }
  }

  const handleCancel = () => {
    setMeterKey(''); setUsage('')
    setFixedEnabled(false); setFixedLabel(''); setFixedAmount('')
    setOneTimeEnabled(false); setOneTimeLabel(''); setOneTimeAmount('')
    setPreview(null); setPreviewError(null); setPushResult(null); setPushError(null)
  }

  if (loading) return null

  return (
    <div className="bg-white rounded-2xl border border-forest/10 overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-6 py-5 text-left hover:bg-cream/30 transition-colors"
      >
        <div>
          <h2 className="text-[10px] font-bold text-stone uppercase tracking-[0.14em] flex items-center gap-2">
            <i className="ti ti-calculator" style={{ fontSize: 13, color: '#1A3D2B' }} />
            Manual invoice
          </h2>
          <p className="text-[11px] text-stone mt-1">Verify volume-based pricing against this agreement, then optionally push a one-off invoice</p>
        </div>
        <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'} text-stone flex-shrink-0`} style={{ fontSize: 14 }} />
      </button>

      {expanded && (
        <div className="px-6 pb-6 border-t border-forest/8 pt-5 space-y-4">
          {/* Meter + usage */}
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">Meter (optional)</label>
            {meters.length === 0 ? (
              <p className="text-xs text-stone/60">No confirmed meter mappings on this job — add a fixed or one-time fee below instead.</p>
            ) : (
              <select
                value={meterKey}
                onChange={e => { setMeterKey(e.target.value); setPreview(null) }}
                className="w-full text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-forest/40"
              >
                <option value="">None</option>
                {meters.map(m => <option key={m.meterKey} value={m.meterKey}>{m.meterKey}</option>)}
              </select>
            )}
          </div>

          {selectedMeter && (
            <div className="space-y-2">
              <div className="border border-forest/10 rounded-xl overflow-hidden text-[11px]">
                <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'rgba(26,61,43,0.03)' }}>
                      <th className="text-left font-semibold text-stone px-3 py-1.5" style={{ fontSize: 10, textTransform: 'uppercase' }}>Tier</th>
                      <th className="text-right font-semibold text-stone px-3 py-1.5" style={{ fontSize: 10, textTransform: 'uppercase' }}>From</th>
                      <th className="text-right font-semibold text-stone px-3 py-1.5" style={{ fontSize: 10, textTransform: 'uppercase' }}>To</th>
                      <th className="text-right font-semibold text-stone px-3 py-1.5" style={{ fontSize: 10, textTransform: 'uppercase' }}>Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                      <td className="px-3 py-1.5 text-stone/60 italic" colSpan={4}>{selectedMeter.includedUnits.toLocaleString()} units included free</td>
                    </tr>
                    {selectedMeter.overageTiers.map((t, i) => (
                      <tr key={i} style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                        <td className="px-3 py-1.5 text-ink">Tier {i + 1}</td>
                        <td className="px-3 py-1.5 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{t.from_unit?.toLocaleString() ?? '—'}</td>
                        <td className="px-3 py-1.5 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{t.to_unit?.toLocaleString() ?? '∞'}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtRate(t.rate_per_unit, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-stone block mb-1.5">Usage to test</label>
                <input
                  type="number" min="0" step="1"
                  value={usage} onChange={e => { setUsage(e.target.value); setPreview(null) }}
                  placeholder="e.g. 15420"
                  className="w-full text-sm border border-forest/20 rounded-lg px-3 py-2 bg-white text-ink placeholder:text-stone/50 focus:outline-none focus:border-forest/40"
                />
              </div>
            </div>
          )}

          {/* Fixed / one-time fees */}
          <FeeSection
            title="Include fixed fee"
            presets={presetFees.filter(p => p.kind === 'recurring')}
            enabled={fixedEnabled} setEnabled={v => { setFixedEnabled(v); setPreview(null) }}
            label={fixedLabel} setLabel={v => { setFixedLabel(v); setPreview(null) }}
            amount={fixedAmount} setAmount={v => { setFixedAmount(v); setPreview(null) }}
          />
          <FeeSection
            title="Include one-time fee"
            presets={presetFees.filter(p => p.kind === 'one_time')}
            enabled={oneTimeEnabled} setEnabled={v => { setOneTimeEnabled(v); setPreview(null) }}
            label={oneTimeLabel} setLabel={v => { setOneTimeLabel(v); setPreview(null) }}
            amount={oneTimeAmount} setAmount={v => { setOneTimeAmount(v); setPreview(null) }}
          />

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={runPreview}
              disabled={previewing}
              className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-40"
              style={{ background: '#EEF9F2', color: '#1A3D2B', border: '1px solid rgba(74,124,89,0.25)' }}
            >
              {previewing ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> Calculating…</> : <><i className="ti ti-calculator" style={{ fontSize: 13 }} /> Calculate</>}
            </button>
            {(preview || previewError || pushResult) && (
              <button onClick={handleCancel} className="text-sm px-4 py-2 rounded-xl border border-forest/20 text-stone hover:bg-forest/5 transition-colors">
                Cancel
              </button>
            )}
          </div>

          {previewError && <p className="text-xs text-red-600">{previewError}</p>}

          {preview && (
            <div className="border-t border-forest/8 pt-4 space-y-3">
              <div className="border border-forest/10 rounded-xl overflow-hidden text-[11px]">
                <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'rgba(26,61,43,0.03)' }}>
                      <th className="text-left font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase' }}>Description</th>
                      <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase' }}>Qty</th>
                      <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase' }}>Unit price</th>
                      <th className="text-right font-semibold text-stone px-3 py-2" style={{ fontSize: 10, textTransform: 'uppercase' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lineItems.map((li, i) => (
                      <tr key={i} style={{ borderTop: '1px solid rgba(26,61,43,0.06)' }}>
                        <td className="px-3 py-2 text-ink">{li.description}</td>
                        <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{li.quantity.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-stone" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(li.unitPrice, preview.currency)}</td>
                        <td className="px-3 py-2 text-right font-medium text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(li.quantity * li.unitPrice, preview.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '1px solid rgba(26,61,43,0.1)', background: 'rgba(26,61,43,0.02)' }}>
                      <td className="px-3 py-2 font-semibold text-ink" colSpan={3}>Total</td>
                      <td className="px-3 py-2 text-right font-semibold text-ink" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(preview.total, preview.currency)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {!hasCustomer ? (
                <p className="text-xs text-amber-600">No billing customer on this job yet — cannot push an invoice.</p>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePush}
                    disabled={pushing}
                    className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-colors disabled:opacity-40"
                    style={{ background: '#1A3D2B', color: '#fff' }}
                  >
                    {pushing ? <><i className="ti ti-loader-2 animate-spin" style={{ fontSize: 13 }} /> Pushing…</> : <><i className="ti ti-send" style={{ fontSize: 13 }} /> Push to billing system</>}
                  </button>
                  <p className="text-[10px] text-stone/60">Creates a real invoice on the connected billing platform</p>
                </div>
              )}
            </div>
          )}

          {pushError && <p className="text-xs text-red-600">{pushError}</p>}

          {pushResult && (
            <div className="bg-cream/40 border border-forest/10 rounded-xl px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <i className="ti ti-check text-forest" style={{ fontSize: 14 }} />
                <span className="text-sm text-ink font-medium">Invoice pushed ✓</span>
                <span className="text-xs text-stone font-mono">{pushResult.invoiceId}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-ink">{fmt(pushResult.total, currency)}</span>
                {pushResult.hostedUrl && (
                  <a href={pushResult.hostedUrl} target="_blank" rel="noreferrer" className="text-xs text-forest hover:underline">View →</a>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
