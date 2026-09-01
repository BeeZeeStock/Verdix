'use client'

import { useVatConfig } from './useVatConfig'

// Customer-level VAT default — "User-provided billing configuration", never
// "Clear from contract" (this is an operational billing input Verdix never
// infers from country/currency/customer location, not a contract-derived
// figure). Invoicing fails closed until this is set — see
// lib/vat.ts/computeVat and its use in the invoice-scheduler/parked-invoices/
// billing-writer send paths.
//
// Reused in three places, all sharing the same canonical state via
// useVatConfig (never a second, independent VAT value): BillingSummaryCard
// (post-approval — reads/writes customer_vat_config directly), the
// pre-approval Configure page (writes to the job's own pending_vat_*
// staging fields via the same /api/jobs/[id]/vat-config route, which picks
// the right target server-side depending on whether a billing_customer_id
// exists yet), and the Review Panel's VatReviewCard (a differently-styled
// presentation of this exact same hook, not a second data path).
export function VatConfigRow({
  jobId, onStatusChange, refreshSignal, onSaved,
}: {
  jobId: string
  onStatusChange?: (configured: boolean) => void
  // Bumped by a sibling VAT surface (e.g. the Review Panel's VatReviewCard)
  // when IT saves, so this instance picks up the fresh value immediately
  // instead of showing stale state until the next full reload.
  refreshSignal?: number
  // Called after THIS instance successfully saves, so a parent can bump its
  // own refreshSignal for any sibling VAT surfaces to pick up in turn.
  onSaved?: () => void
}) {
  const vat = useVatConfig(jobId, refreshSignal, onStatusChange)
  const { treatment, loading, editing, startEdit, cancelEdit, draftMode, setDraftMode, draftRate, setDraftRate, saving, saveError, configured } = vat

  const handleSave = async () => {
    const ok = await vat.save()
    if (ok) onSaved?.()
  }

  if (loading) return null

  return (
    <div className="px-6 py-3" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)', background: configured ? 'transparent' : '#FEF2F2' }}>
      {!editing ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <i className={`ti ${configured ? 'ti-percentage' : 'ti-alert-triangle'}`} style={{ fontSize: 13, color: configured ? '#6B7280' : '#DC2626' }} />
            {configured ? (
              <span className="text-[12px] text-ink">
                VAT: <span className="font-semibold">{treatment!.mode === 'zero_rated' ? '0% (zero-rated)' : `${treatment!.ratePct}%`}</span>
                <span className="text-stone"> — user-provided billing configuration</span>
              </span>
            ) : (
              <span className="text-[12px]" style={{ color: '#991B1B' }}>
                VAT not configured — billing blocked
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
              onClick={handleSave} disabled={saving}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-40"
              style={{ background: '#1A3D2B', color: 'white' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={cancelEdit} disabled={saving} className="text-[11px] text-stone hover:text-ink">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// Step 17G.3a — a FOURTH presentation of the exact same useVatConfig hook
// (see this file's header comment for the other three), matching the
// hover-reveal-pencil grid-tile pattern every other Contract Setup field
// already uses (EditableStat, and the inline Currency/date editors) —
// VatConfigRow's own always-visible "Edit"/"Configure" button and
// full-width bordered-row chrome read as visually inconsistent sitting
// inside that grid. Same persistence, same hook, same
// onStatusChange/refreshSignal/onSaved contract as VatConfigRow — this is
// presentation-only, never a second VAT data path.
export function VatEditableStat({
  jobId, onStatusChange, refreshSignal, onSaved,
}: {
  jobId: string
  onStatusChange?: (configured: boolean) => void
  refreshSignal?: number
  onSaved?: () => void
}) {
  const vat = useVatConfig(jobId, refreshSignal, onStatusChange)
  const { treatment, loading, editing, startEdit, cancelEdit, draftMode, setDraftMode, draftRate, setDraftRate, saving, saveError, configured } = vat

  const handleSave = async () => {
    const ok = await vat.save()
    if (ok) onSaved?.()
  }

  if (loading) return null

  if (editing) {
    return (
      <div>
        <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">VAT</p>
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-[12px] text-ink cursor-pointer">
              <input type="radio" checked={draftMode === 'rate'} onChange={() => setDraftMode('rate')} /> Rate
            </label>
            {draftMode === 'rate' && (
              <input
                autoFocus
                type="number" min={0} max={100} step="0.01" value={draftRate}
                onChange={e => setDraftRate(e.target.value)}
                className="w-16 text-[12px] border rounded-lg px-2 py-1 outline-none"
                style={{ borderColor: 'rgba(26,61,43,0.15)' }}
              />
            )}
            {draftMode === 'rate' && <span className="text-[12px] text-stone">%</span>}
            <label className="flex items-center gap-1.5 text-[12px] text-ink cursor-pointer">
              <input type="radio" checked={draftMode === 'zero_rated'} onChange={() => setDraftMode('zero_rated')} /> Zero-rated
            </label>
          </div>
          {saveError && <p className="text-[11px]" style={{ color: '#DC2626' }}>{saveError}</p>}
          <div className="flex items-center gap-1.5">
            <button onClick={cancelEdit} disabled={saving} className="text-stone/50 hover:text-ink p-1 transition-colors flex-shrink-0" title="Cancel">
              <i className="ti ti-x" style={{ fontSize: 13 }} />
            </button>
            <button
              onClick={handleSave} disabled={saving}
              className="flex items-center justify-center w-7 h-7 rounded-lg text-white flex-shrink-0 transition-colors disabled:opacity-40"
              style={{ background: '#1A3D2B' }}
              title="Save"
            >
              {saving ? <i className="ti ti-loader-2 animate-spin" style={{ fontSize: 12 }} /> : <i className="ti ti-check" style={{ fontSize: 12 }} />}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group">
      <p className="text-[10px] font-semibold text-stone uppercase tracking-[0.12em] mb-1.5">VAT</p>
      <div className="flex items-start gap-1">
        <p
          onClick={startEdit}
          title={configured ? 'Change VAT' : 'Configure VAT'}
          className={`text-[15px] font-medium leading-snug cursor-pointer rounded -mx-1 px-1 hover:bg-forest/5 transition-colors ${configured ? 'text-ink' : 'text-amber-600 hover:text-amber-700'}`}
        >
          {configured
            ? (treatment!.mode === 'zero_rated' ? '0% (zero-rated)' : `${treatment!.ratePct}%`)
            : 'Not configured'}
        </p>
        <button
          onClick={startEdit}
          title={configured ? 'Change VAT' : 'Configure VAT'}
          className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 p-1 rounded hover:bg-forest/5 mt-0.5"
        >
          <i className="ti ti-pencil-minus" style={{ fontSize: 11, color: '#9CA3AF' }} />
        </button>
      </div>
    </div>
  )
}
