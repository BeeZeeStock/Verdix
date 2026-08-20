'use client'

import { useState, useEffect, useCallback } from 'react'

// Single canonical VAT read/write hook — every VAT surface in the product
// (the main GUI's pre-approval row, BillingSummaryCard's post-approval row,
// the Review Panel's review card) calls this same hook against the same
// GET/POST /api/jobs/[id]/vat-config endpoint, rather than each keeping its
// own independent copy of "is VAT configured" — that route is itself the
// canonical branch point (customer_vat_config once a billing_customer_id
// exists, otherwise the job's own pending_vat_* staging fields), so this
// hook never duplicates that decision, only the fetch/save plumbing around it.
//
// refreshSignal lets one surface's save immediately refresh every other
// mounted surface for the same job — bump it (via onSaved below) whenever a
// save succeeds, and every other useVatConfig(jobId, refreshSignal) instance
// picks up the fresh value without a manual page reload.
export type VatTreatment = { mode: 'rate' | 'zero_rated' | 'not_configured'; ratePct: number | null }

export function useVatConfig(
  jobId: string,
  refreshSignal?: number,
  onStatusChange?: (configured: boolean) => void,
) {
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
  }, [jobId, refreshSignal])

  const startEdit = useCallback(() => {
    setDraftMode(treatment?.mode === 'zero_rated' ? 'zero_rated' : 'rate')
    setDraftRate(treatment?.ratePct != null ? String(treatment.ratePct) : '25')
    setSaveError(null)
    setEditing(true)
  }, [treatment])

  const cancelEdit = useCallback(() => setEditing(false), [])

  // Returns whether the save actually succeeded, so a caller can choose to
  // bump its own refreshSignal ONLY on a real, successful write — never on
  // the initial mount-driven load (which also calls onStatusChange above),
  // which is what keeps two mounted instances from ping-ponging refetches.
  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}/vat-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftMode === 'rate' ? { mode: 'rate', ratePct: Number(draftRate) } : { mode: 'zero_rated' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setSaveError(data.error ?? 'Could not save VAT configuration.'); return false }
      setEditing(false)
      // The POST endpoint only confirms { ok: true } — apply the
      // just-saved value locally rather than issuing a second fetch for
      // data this component already has.
      const t: VatTreatment = draftMode === 'rate' ? { mode: 'rate', ratePct: Number(draftRate) } : { mode: 'zero_rated', ratePct: null }
      setTreatment(t)
      onStatusChange?.(true)
      return true
    } catch {
      setSaveError('Network error — could not save VAT configuration.')
      return false
    } finally {
      setSaving(false)
    }
  }, [jobId, draftMode, draftRate, onStatusChange])

  return {
    treatment, loading,
    editing, startEdit, cancelEdit,
    draftMode, setDraftMode, draftRate, setDraftRate,
    saving, saveError, save,
    configured: !!treatment && treatment.mode !== 'not_configured',
  }
}
