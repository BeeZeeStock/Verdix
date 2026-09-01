'use client'

// Step 17H.2C item 15 — extracted out of the now-removed
// BillingPeriodWorkspaceCard.tsx (Billing Periods' standalone UI surface)
// into its own file, since BillingSummaryCard.tsx's enriched recurring-
// period timeline entries also render this exact operational-input
// interaction. Domain code that's still genuinely reused survives the
// removal of the surface it originated in.
//
// Dates are DERIVED from the billing period (read-only display), never
// typed by the reviewer. Same POST /operational-input-values endpoint
// ManualInputEntry itself calls — no second persistence path.
import { useState, useCallback } from 'react'

export function PeriodOperationalInputEntry({ jobId, inputKey, periodStart, periodEnd }: {
  jobId: string; inputKey: string; periodStart: string; periodEnd: string
}) {
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('')
  const [saving, setSaving] = useState<'draft' | 'final' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const save = useCallback(async (isFinal: boolean) => {
    const numericValue = Number(value)
    if (value.trim() === '' || !Number.isFinite(numericValue)) { setMsg('Enter a numeric value first.'); return }
    setSaving(isFinal ? 'final' : 'draft')
    setMsg(null)
    const res = await fetch(`/api/jobs/${jobId}/operational-input-values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_key: inputKey, period_start: periodStart, period_end: periodEnd, value: numericValue, currency: currency.trim() || null, is_final: isFinal }),
    }).catch(() => null)
    setSaving(null)
    if (!res?.ok) { setMsg('Save failed — try again.'); return }
    setMsg(isFinal ? 'Marked final.' : 'Draft saved.')
  }, [jobId, inputKey, periodStart, periodEnd, value, currency])

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="number" placeholder="Value" value={value} onChange={e => setValue(e.target.value)}
        aria-label={`${inputKey} value`} className="text-[11px] border rounded px-1.5 py-1 w-24" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
      />
      <input
        type="text" placeholder="EUR" value={currency} onChange={e => setCurrency(e.target.value)}
        aria-label={`${inputKey} currency`} className="text-[11px] border rounded px-1.5 py-1 w-14" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
      />
      <button onClick={() => save(false)} disabled={saving !== null}
        className="text-[11px] font-medium text-stone hover:text-ink px-2 py-1 rounded border disabled:opacity-50" style={{ borderColor: 'rgba(26,61,43,0.15)' }}>
        {saving === 'draft' ? 'Saving…' : 'Save draft'}
      </button>
      <button onClick={() => save(true)} disabled={saving !== null}
        className="text-[11px] font-medium text-white px-2 py-1 rounded bg-forest hover:bg-sage disabled:opacity-50">
        {saving === 'final' ? 'Saving…' : 'Mark final'}
      </button>
      {msg && <p className="text-[10px] text-stone/70 w-full">{msg}</p>}
    </div>
  )
}
