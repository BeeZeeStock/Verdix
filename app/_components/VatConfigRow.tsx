'use client'

import { useState, useEffect } from 'react'

// Customer-level VAT default — "User-provided billing configuration", never
// "Clear from contract" (this is an operational billing input Verdix never
// infers from country/currency/customer location, not a contract-derived
// figure). Invoicing fails closed until this is set — see
// lib/vat.ts/computeVat and its use in the invoice-scheduler/parked-invoices/
// billing-writer send paths.
//
// Reused in two places: BillingSummaryCard (post-approval — reads/writes
// customer_vat_config directly) and the pre-approval Configure page (writes
// to the job's own pending_vat_* staging fields via the same
// /api/jobs/[id]/vat-config route, which picks the right target server-side
// depending on whether a billing_customer_id exists yet).
type VatTreatment = { mode: 'rate' | 'zero_rated' | 'not_configured'; ratePct: number | null }

export function VatConfigRow({ jobId, onStatusChange }: { jobId: string; onStatusChange?: (configured: boolean) => void }) {
  const [treatment, setTreatment] = useState<VatTreatment | null>(null)
  const [loading, setLoading]     = useState(true)
  const [editing, setEditing]     = useState(false)
  const [draftMode, setDraftMode] = useState<'rate' | 'zero_rated'>('rate')
  const [draftRate, setDraftRate] = useState('25')
  const [saving, setSaving]       = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Fetch defined inline inside the effect (not an extracted, reusable
  // callback) — the stricter set-state-in-effect lint rule requires this
  // shape. save() below performs its own separate fetch-and-refresh rather
  // than sharing this closure.
  useEffect(() => {
    let cancelled = false
    async function doLoad() {
      try {
        const res = await fetch(`/api/jobs/${jobId}/vat-config`)
        const data = await res.json()
        if (cancelled) return
        const t = data.treatment ?? { mode: 'not_configured', ratePct: null }
        setTreatment(t)
        onStatusChange?.(t.mode !== 'not_configured')
      } catch {
        if (!cancelled) { setTreatment({ mode: 'not_configured', ratePct: null }); onStatusChange?.(false) }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    doLoad()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const startEdit = () => {
    setDraftMode(treatment?.mode === 'zero_rated' ? 'zero_rated' : 'rate')
    setDraftRate(treatment?.ratePct != null ? String(treatment.ratePct) : '25')
    setSaveError(null)
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/vat-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftMode === 'rate' ? { mode: 'rate', ratePct: Number(draftRate) } : { mode: 'zero_rated' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setSaveError(data.error ?? 'Could not save VAT configuration.'); return }
      setEditing(false)
      // The POST endpoint only confirms { ok: true } — apply the
      // just-saved value locally rather than issuing a second fetch for
      // data this component already has.
      const t: VatTreatment = draftMode === 'rate' ? { mode: 'rate', ratePct: Number(draftRate) } : { mode: 'zero_rated', ratePct: null }
      setTreatment(t)
      onStatusChange?.(true)
    } catch {
      setSaveError('Network error — could not save VAT configuration.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  const configured = treatment && treatment.mode !== 'not_configured'

  return (
    <div className="px-6 py-3" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)', background: configured ? 'transparent' : '#FEF2F2' }}>
      {!editing ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <i className={`ti ${configured ? 'ti-percentage' : 'ti-alert-triangle'}`} style={{ fontSize: 13, color: configured ? '#6B7280' : '#DC2626' }} />
            {configured ? (
              <span className="text-[12px] text-ink">
                VAT treatment — <span className="font-semibold">{treatment!.mode === 'zero_rated' ? '0% (zero-rated)' : `${treatment!.ratePct}%`}</span>
                <span className="text-stone"> — from customer billing configuration</span>
              </span>
            ) : (
              <span className="text-[12px]" style={{ color: '#991B1B' }}>
                VAT treatment has not been confirmed for this customer — invoicing is blocked until this is set.
              </span>
            )}
          </div>
          <button onClick={startEdit} className="text-[11px] font-semibold text-forest hover:text-sage transition-colors flex-shrink-0">
            {configured ? 'Edit' : 'Configure'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[12px] text-ink cursor-pointer">
              <input type="radio" checked={draftMode === 'rate'} onChange={() => setDraftMode('rate')} /> Rate
            </label>
            {draftMode === 'rate' && (
              <input
                type="number" min={0} max={100} step="0.01" value={draftRate}
                onChange={e => setDraftRate(e.target.value)}
                className="w-20 text-[12px] border rounded-lg px-2 py-1 outline-none"
                style={{ borderColor: 'rgba(26,61,43,0.15)' }}
              />
            )}
            {draftMode === 'rate' && <span className="text-[12px] text-stone">%</span>}
            <label className="flex items-center gap-1.5 text-[12px] text-ink cursor-pointer">
              <input type="radio" checked={draftMode === 'zero_rated'} onChange={() => setDraftMode('zero_rated')} /> Zero-rated (0%)
            </label>
          </div>
          {saveError && <p className="text-[11px]" style={{ color: '#DC2626' }}>{saveError}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={save} disabled={saving}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-40"
              style={{ background: '#1A3D2B', color: 'white' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditing(false)} disabled={saving} className="text-[11px] text-stone hover:text-ink">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
