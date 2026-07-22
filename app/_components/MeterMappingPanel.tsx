'use client'

import { useState, useEffect, useCallback } from 'react'

type MeterSuggestion = {
  contract_unit_type: string
  meter_key: string
  confidence: number
  confirmed: boolean
  included_units: number
  overage_tiers: Array<{ from_unit: number | null; to_unit: number | null; rate_per_unit: number }>
  billing_cycle: string
}

type AvailableMeter = { meter_key: string; display_name: string; unit_label: string }

interface Props {
  jobId: string
  currency: string
  onConfirmedChange: (allConfirmed: boolean) => void
}

const CYCLE_LABELS: Record<string, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
}

const CONFIDENCE_BADGE = (c: number) => {
  if (c >= 0.85) return { label: 'High confidence', bg: '#D4EAD9', color: '#1A3D2B' }
  if (c >= 0.6)  return { label: 'Medium confidence', bg: '#FEF3C7', color: '#B45309' }
  return             { label: 'Low confidence — verify', bg: '#FEE2E2', color: '#B91C1C' }
}

export function MeterMappingPanel({ jobId, currency, onConfirmedChange }: Props) {
  const [suggestions, setSuggestions] = useState<MeterSuggestion[]>([])
  const [meters, setMeters]           = useState<AvailableMeter[]>([])
  const [loading, setLoading]         = useState(true)
  const [saving, setSaving]           = useState(false)
  const [saveMsg, setSaveMsg]         = useState<{ ok: boolean; text: string } | null>(null)

  // Local edits before save
  const [edits, setEdits] = useState<Record<string, Partial<MeterSuggestion>>>({})

  const load = useCallback(async () => {
    const res = await fetch(`/api/jobs/${jobId}/meter-mappings`).then(r => r.json()).catch(() => null)
    if (!res) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSuggestions(res.suggestions ?? [])
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMeters(res.available_meters ?? [])
  }, [jobId])

  useEffect(() => {
    fetch(`/api/jobs/${jobId}/meter-mappings`)
      .then(r => r.json())
      .then((res: { suggestions: MeterSuggestion[]; available_meters: AvailableMeter[] }) => {
        setSuggestions(res.suggestions ?? [])
        setMeters(res.available_meters ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [jobId])

  const get = <K extends keyof MeterSuggestion>(unitType: string, field: K, fallback: MeterSuggestion[K]) =>
    ((edits[unitType] as Partial<MeterSuggestion>)?.[field] as MeterSuggestion[K]) ?? fallback

  const setEdit = (unitType: string, field: keyof MeterSuggestion, value: unknown) =>
    setEdits(prev => ({ ...prev, [unitType]: { ...prev[unitType], [field]: value } }))

  const allConfirmed = suggestions.length > 0 && suggestions.every(s =>
    get(s.contract_unit_type, 'confirmed', s.confirmed)
  )

  useEffect(() => { onConfirmedChange(allConfirmed) }, [allConfirmed, onConfirmedChange])

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg(null)

    const mappings = suggestions.map(s => ({
      contract_unit_type: s.contract_unit_type,
      meter_key:          get(s.contract_unit_type, 'meter_key', s.meter_key),
      confirmed:          get(s.contract_unit_type, 'confirmed', s.confirmed),
      included_units:     get(s.contract_unit_type, 'included_units', s.included_units),
      overage_tiers:      s.overage_tiers,
      billing_cycle:      get(s.contract_unit_type, 'billing_cycle', s.billing_cycle),
      confidence:         s.confidence,
    }))

    const res = await fetch(`/api/jobs/${jobId}/meter-mappings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mappings }),
    })
    const data = await res.json()
    if (res.ok) {
      setSaveMsg({ ok: true, text: data.all_confirmed ? 'All meters confirmed ✓' : 'Saved ✓' })
      await load()
      setEdits({})
    } else {
      setSaveMsg({ ok: false, text: data.error ?? 'Save failed' })
    }
    setSaving(false)
  }

  const confirmAll = () => {
    const patch: Record<string, Partial<MeterSuggestion>> = {}
    suggestions.forEach(s => { patch[s.contract_unit_type] = { ...edits[s.contract_unit_type], confirmed: true } })
    setEdits(patch)
  }

  if (loading) {
    return (
      <div className="bg-white border border-forest/10 rounded-2xl px-7 py-5 flex items-center gap-3">
        <div className="w-3.5 h-3.5 rounded-full border-2 border-forest/20 border-t-forest/70 animate-spin" />
        <span className="text-xs text-stone">Generating billing meter suggestions…</span>
      </div>
    )
  }

  if (suggestions.length === 0) return null

  const hasUnsaved = Object.keys(edits).length > 0

  return (
    <div className="bg-white border border-amber-200/70 rounded-2xl overflow-hidden"
      style={{ background: '#FFFDF7' }}>
      {/* Header */}
      <div className="px-7 py-4 border-b border-amber-100 flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <i className="ti ti-plug-connected text-amber-700" style={{ fontSize: 15 }} />
            <span className="text-sm font-medium text-ink">Configure billing meters</span>
            {allConfirmed && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                style={{ background: '#D4EAD9', color: '#1A3D2B' }}>
                <i className="ti ti-check" style={{ fontSize: 10 }} /> All confirmed
              </span>
            )}
            {!allConfirmed && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                style={{ background: '#FEF3C7', color: '#92400E' }}>
                Required before approve
              </span>
            )}
          </div>
          <p className="text-xs text-stone">
            Map each usage metric in this contract to a Verdix billing meter. Auto-suggestions are based on the extracted unit types — review and confirm each one.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!allConfirmed && (
            <button
              onClick={confirmAll}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-forest/20 text-forest hover:bg-forest/5 transition-colors"
            >
              Confirm all
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || (!hasUnsaved && !allConfirmed)}
            className="text-xs font-semibold px-4 py-1.5 rounded-lg bg-forest text-white hover:bg-sage transition-colors disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saveMsg && (
            <span className={`text-xs font-medium ${saveMsg.ok ? 'text-forest' : 'text-red-600'}`}>
              {saveMsg.text}
            </span>
          )}
        </div>
      </div>

      {/* Mapping rows */}
      <div className="divide-y divide-amber-50">
        {suggestions.map(s => {
          const meterKey    = get(s.contract_unit_type, 'meter_key', s.meter_key)
          const confirmed   = get(s.contract_unit_type, 'confirmed', s.confirmed)
          const cycle       = get(s.contract_unit_type, 'billing_cycle', s.billing_cycle)
          const included    = get(s.contract_unit_type, 'included_units', s.included_units)
          const badge       = CONFIDENCE_BADGE(s.confidence)
          const matchedMeter = meters.find(m => m.meter_key === meterKey)

          return (
            <div key={s.contract_unit_type}
              className="px-7 py-4 flex items-start gap-6"
              style={{ background: confirmed ? '#F6FAF4' : undefined }}>

              {/* Contract unit type */}
              <div className="w-48 flex-shrink-0">
                <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Contract says</div>
                <div className="text-sm font-medium text-ink font-mono bg-cream px-2 py-1 rounded-lg inline-block">
                  {s.contract_unit_type}
                </div>
                <div className="mt-1.5 flex items-center gap-1">
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{ background: badge.bg, color: badge.color }}>
                    {badge.label}
                  </span>
                </div>
              </div>

              {/* Arrow */}
              <div className="flex-shrink-0 mt-6">
                <i className="ti ti-arrow-right text-stone/40" style={{ fontSize: 16 }} />
              </div>

              {/* Meter selector */}
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Verdix meter</div>
                <select
                  value={meterKey}
                  onChange={e => {
                    setEdit(s.contract_unit_type, 'meter_key', e.target.value)
                    setEdit(s.contract_unit_type, 'confirmed', false)
                  }}
                  className="w-full bg-white border border-forest/20 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest"
                >
                  {meters.map(m => (
                    <option key={m.meter_key} value={m.meter_key}>
                      {m.display_name} ({m.meter_key})
                    </option>
                  ))}
                </select>
                {matchedMeter && (
                  <p className="text-[10px] text-stone mt-1">
                    Unit: <span className="font-medium">{matchedMeter.unit_label}</span>
                  </p>
                )}
              </div>

              {/* Billing cycle */}
              <div className="w-36 flex-shrink-0">
                <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Billing cycle</div>
                <select
                  value={cycle}
                  onChange={e => setEdit(s.contract_unit_type, 'billing_cycle', e.target.value)}
                  className="w-full bg-white border border-forest/20 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest"
                >
                  {['monthly', 'quarterly', 'yearly'].map(c => (
                    <option key={c} value={c}>{CYCLE_LABELS[c]}</option>
                  ))}
                </select>
              </div>

              {/* Included units */}
              <div className="w-28 flex-shrink-0">
                <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Included / {CYCLE_LABELS[cycle]?.toLowerCase()}</div>
                <input
                  type="number"
                  min={0}
                  value={included}
                  onChange={e => setEdit(s.contract_unit_type, 'included_units', Number(e.target.value))}
                  className="w-full bg-white border border-forest/20 rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-forest"
                />
              </div>

              {/* Overage tiers summary */}
              <div className="w-48 flex-shrink-0">
                <div className="text-[10px] font-semibold text-stone uppercase tracking-widest mb-1">Overage tiers</div>
                <div className="space-y-0.5">
                  {s.overage_tiers.map((t, i) => (
                    <div key={i} className="text-[10px] text-stone font-mono">
                      {t.from_unit != null ? `${t.from_unit.toLocaleString()}` : '0'}
                      {t.to_unit != null ? `–${t.to_unit.toLocaleString()}` : '+'}
                      {' '}&rarr;{' '}
                      {new Intl.NumberFormat('en', { style: 'currency', currency }).format(t.rate_per_unit)}/unit
                    </div>
                  ))}
                </div>
              </div>

              {/* Confirm toggle */}
              <div className="flex-shrink-0 flex flex-col items-center gap-1 mt-1">
                <button
                  onClick={() => setEdit(s.contract_unit_type, 'confirmed', !confirmed)}
                  className="w-8 h-8 rounded-lg border-2 flex items-center justify-center transition-all"
                  style={confirmed
                    ? { background: '#1A3D2B', borderColor: '#1A3D2B' }
                    : { background: 'white', borderColor: 'rgba(26,61,43,0.25)' }
                  }
                  title={confirmed ? 'Confirmed' : 'Click to confirm'}
                >
                  {confirmed && <i className="ti ti-check text-white" style={{ fontSize: 14 }} />}
                </button>
                <span className="text-[9px] text-stone">{confirmed ? 'Confirmed' : 'Confirm'}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
