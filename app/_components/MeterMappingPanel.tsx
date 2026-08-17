'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

type MinimumCommitment = {
  mode: 'floor' | 'additive' | 'minimum_spend' | 'prepaid_commitment' | 'minimum_quantity'
  amount: number
  included_allowance_interaction?: 'before_allowance' | 'after_allowance' | 'unclear'
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

type MeterSuggestion = {
  contract_unit_type: string
  meter_key: string
  confidence: number
  // Server-computed: the best guess it could produce was still below a
  // trustworthy-match threshold (e.g. the only candidate was "first
  // available meter, confidence 0.2" — technically compatible on unit type
  // alone, not actually the right meter). meter_key is '' when this is true
  // — nothing is pre-selected, the reviewer must pick one explicitly.
  no_match?: boolean
  confirmed: boolean
  included_units: number
  overage_tiers: Array<{
    from_unit: number | null
    to_unit: number | null
    rate_per_unit: number
    minimum_commitment?: MinimumCommitment | null
    reset_anchor?: 'contract_start' | 'calendar' | null
  }>
  billing_cycle: string
}

type AvailableMeter = { meter_key: string; display_name: string; unit_label: string }

interface Props {
  jobId: string
  isConfigured?: boolean
  onConfirmedChange: (allConfirmed: boolean) => void
  /** The contract's own overall billing_frequency — used to detect a metric
   *  measuring on a different cadence and surface the "Mixed" schedule note. */
  contractBillingFrequency?: string | null
  /** Bumped by the parent whenever ITS OWN data refreshes (e.g. a minimum
   *  commitment or tier-calculation method confirmed via the Review panel's
   *  RuleInterpretationCard, which writes through /confirm-rule, not this
   *  component's own save path) — this panel manages its own independent
   *  fetch of /meter-mappings, so without this signal it would keep showing
   *  an ambiguity as unresolved even after it was actually resolved
   *  elsewhere, until the page was reloaded. */
  refreshSignal?: number
}

const CYCLE_LABELS: Record<string, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', 'semi-annual': 'Semi-annual', yearly: 'Yearly', annual: 'Annual',
}

export function MeterMappingPanel({ jobId, isConfigured, onConfirmedChange, contractBillingFrequency, refreshSignal }: Props) {
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
  }, [jobId, refreshSignal])

  const get = <K extends keyof MeterSuggestion>(unitType: string, field: K, fallback: MeterSuggestion[K]) =>
    ((edits[unitType] as Partial<MeterSuggestion>)?.[field] as MeterSuggestion[K]) ?? fallback

  const setEdit = (unitType: string, field: keyof MeterSuggestion, value: unknown) =>
    setEdits(prev => ({ ...prev, [unitType]: { ...prev[unitType], [field]: value } }))

  // Whether this metric's minimum commitment is still ambiguous — read-only
  // here. Resolving it is exclusively the Review panel's RuleInterpretationCard
  // job now (POST /confirm-rule, which writes the full structured mode/period/
  // etc. and mirrors into contract_meter_mappings AND contract_terms). This
  // panel used to offer its own inline before/after-allowance mini-resolution,
  // but that path only ever wrote to contract_meter_mappings — contract_terms
  // (what the Commercial Terms view and every other ambiguity check reads)
  // never updated, so the flag would reappear even after a reviewer thought
  // they'd resolved it here. Never re-add a second write path for the same fact.
  const resolveMinimumCommitment = (s: MeterSuggestion): MinimumCommitment | null => {
    const tiers = get(s.contract_unit_type, 'overage_tiers', s.overage_tiers)
    for (const t of tiers) if (t.minimum_commitment) return t.minimum_commitment
    return null
  }

  const allConfirmed = suggestions.length > 0 && suggestions.every(s =>
    get(s.contract_unit_type, 'confirmed', s.confirmed)
  )

  // A minimum commitment still awaiting a reviewer's interpretation blocks
  // "all confirmed" the same way an unmapped meter does — surfaced, never
  // silently treated as resolved just because the meter mapping itself is.
  const allMinimumCommitmentsResolved = suggestions.every(s => !resolveMinimumCommitment(s)?.requires_confirmation)

  // Mixed billing schedule: true when any confirmed metric measures on a
  // cadence that differs from the contract's own overall billing_frequency
  // — pure display logic, no new data needed (billing_cycle already exists
  // per-metric on contract_meter_mappings).
  const contractCycle = (contractBillingFrequency ?? '').toLowerCase()
  const mixedSchedule = !!contractCycle && suggestions.some(s => {
    const cycle = get(s.contract_unit_type, 'billing_cycle', s.billing_cycle)
    return cycle && cycle.toLowerCase() !== contractCycle
  })

  useEffect(() => {
    onConfirmedChange(allConfirmed && allMinimumCommitmentsResolved)
  }, [allConfirmed, allMinimumCommitmentsResolved, onConfirmedChange])

  // Collapsed by default once everything's already confirmed — nothing left
  // to do here, so don't take up space unless the user wants to check/edit
  // it. Auto-collapses once, the first time it becomes fully confirmed;
  // afterwards the user's own toggle is left alone (e.g. re-opening to fix
  // one row shouldn't immediately snap shut again).
  const [collapsed, setCollapsed] = useState(false)
  const autoCollapsedRef = useRef(false)
  useEffect(() => {
    if (allConfirmed && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true
      setCollapsed(true)
    }
  }, [allConfirmed])

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg(null)

    const mappings = suggestions.map(s => ({
      contract_unit_type: s.contract_unit_type,
      meter_key:          get(s.contract_unit_type, 'meter_key', s.meter_key),
      confirmed:          get(s.contract_unit_type, 'confirmed', s.confirmed),
      included_units:     get(s.contract_unit_type, 'included_units', s.included_units),
      overage_tiers:      get(s.contract_unit_type, 'overage_tiers', s.overage_tiers),
      billing_cycle:      get(s.contract_unit_type, 'billing_cycle', s.billing_cycle),
      confidence:         s.confidence,
    }))

    // Without try/catch/finally here, a thrown fetch (network hiccup) or a
    // non-JSON error response left `saving` stuck true forever — the button
    // showed "Saving…" indefinitely with no error, no way to retry.
    try {
      const res = await fetch(`/api/jobs/${jobId}/meter-mappings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mappings }),
      })
      const data = await res.json().catch(() => ({ error: `Unexpected response (${res.status})` }))
      if (res.ok) {
        setSaveMsg({ ok: true, text: data.all_confirmed ? 'All meters confirmed ✓' : 'Saved ✓' })
        await load()
        setEdits({})
      } else {
        setSaveMsg({ ok: false, text: data.error ?? 'Save failed' })
      }
    } catch {
      setSaveMsg({ ok: false, text: 'Save failed — check your connection and try again' })
    } finally {
      setSaving(false)
    }
  }

  const confirmAll = () => {
    const patch: Record<string, Partial<MeterSuggestion>> = { ...edits }
    for (const s of suggestions) {
      // Never confirm a row with no meter selected — a "no suitable meter
      // found" row (empty meter_key) still needs an explicit human pick;
      // batch-confirming it would silently map the metric to nothing.
      const meterKey = get(s.contract_unit_type, 'meter_key', s.meter_key)
      if (!meterKey) continue
      patch[s.contract_unit_type] = { ...patch[s.contract_unit_type], confirmed: true }
    }
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
    <div className="rounded-2xl border overflow-hidden transition-colors"
      style={{
        borderColor: allConfirmed ? 'rgba(11,92,54,0.2)' : '#FAC775',
        background:  allConfirmed ? '#F8FDF9' : 'white',
      }}>
      {/* Header */}
      <div
        className="px-7 py-4 flex items-center justify-between gap-4 cursor-pointer"
        style={collapsed ? undefined : { borderBottom: '1px solid rgba(26,61,43,0.07)' }}
        onClick={() => setCollapsed(c => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') setCollapsed(c => !c) }}
      >
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <i className={`ti ti-chevron-right text-stone/50 transition-transform ${collapsed ? '' : 'rotate-90'}`} style={{ fontSize: 12 }} />
            <i className="ti ti-plug-connected text-amber-700" style={{ fontSize: 15 }} />
            {/* "Usage mappings" — not "billing configured" — this panel only
                confirms which meter feeds each metric's usage data. It says
                nothing about whether that metric's commercial rules (tier
                calculation method, minimum commitments, etc.) are resolved,
                so its "All confirmed" must never be read as "billing fully
                configured" when other ambiguities remain elsewhere. */}
            <span className="text-sm font-medium text-ink">Usage mappings</span>
            {allConfirmed && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold" style={{ color: '#4A7C59' }}>
                · <i className="ti ti-check" style={{ fontSize: 10 }} /> All confirmed
              </span>
            )}
            {!allConfirmed && (
              <span className="text-[10px] font-semibold" style={{ color: '#B45309' }}>
                {isConfigured ? 'Unconfirmed — usage-based billing will skip these meters' : 'Required before approve'}
              </span>
            )}
          </div>
          <p className="text-xs text-stone">
            Map each usage metric in this contract to your billing meter. Auto-suggestions are based on the extracted unit types — review and confirm each one.
          </p>
          {mixedSchedule && (
            <p className="text-[11px] font-medium mt-1.5" style={{ color: '#B45309' }}>
              <i className="ti ti-arrows-shuffle mr-1" style={{ fontSize: 11 }} />
              Billing schedule: Mixed — one or more metrics measure on a different cadence than the contract&apos;s overall billing frequency.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0" onClick={ev => ev.stopPropagation()}>
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
            disabled={saving || !hasUnsaved}
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

      {!collapsed && <>
      {/* No meters registered */}
      {meters.length === 0 && (
        <div className="px-7 py-6 flex items-start gap-3 bg-amber-50/60 border-t border-amber-100">
          <i className="ti ti-alert-triangle text-amber-600 flex-shrink-0 mt-0.5" style={{ fontSize: 15 }} />
          <div>
            <div className="text-sm font-medium text-amber-900 mb-0.5">No billing meters registered</div>
            <p className="text-xs text-amber-800">
              You need to register at least one billing meter before mapping contract terms.{' '}
              <a href="/settings/meters" className="underline underline-offset-2 font-medium hover:text-amber-900">
                Register a meter →
              </a>
            </p>
          </div>
        </div>
      )}

      {/* Mapping rows — each metric gets its own bordered card, matching the
          rest of the Review panel's rule cards, with every available meter
          listed as a clickable row instead of a native <select> the
          reviewer has to open to even see the options. */}
      <div className="p-4 space-y-3">
        {suggestions.map(s => {
          const meterKey     = get(s.contract_unit_type, 'meter_key', s.meter_key)
          const confirmed    = get(s.contract_unit_type, 'confirmed', s.confirmed)
          const noMatch      = !meterKey
          const matchedMeter = meters.find(m => m.meter_key === meterKey)
          const minCommitment = resolveMinimumCommitment(s)

          const choose = (key: string) => {
            setEdit(s.contract_unit_type, 'meter_key', key)
            setEdit(s.contract_unit_type, 'confirmed', true)
          }

          return (
            <div
              key={s.contract_unit_type}
              className="rounded-2xl border overflow-hidden"
              style={{ borderColor: confirmed ? 'rgba(11,92,54,0.2)' : '#FAC775', background: confirmed ? '#F8FDF9' : 'white' }}
            >
              <div className="px-4 pt-4 pb-3">
                <div className="text-[10px] font-bold uppercase tracking-widest text-stone mb-1.5">Contract says</div>
                <div className="text-sm font-medium text-ink font-mono bg-cream px-2.5 py-1.5 rounded-lg inline-block mb-3">
                  {s.contract_unit_type}
                </div>

                {confirmed ? (
                  <div className="flex items-center gap-2 text-xs font-medium" style={{ color: '#0B5C36' }}>
                    <i className="ti ti-circle-check-filled" style={{ fontSize: 14 }} />
                    Mapped to {matchedMeter?.display_name ?? meterKey}
                    <button onClick={() => setEdit(s.contract_unit_type, 'confirmed', false)} className="ml-auto text-stone hover:text-ink underline underline-offset-2 font-normal">
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    {noMatch ? (
                      <div className="rounded-xl p-3 mb-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                        <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: '#991B1B' }}>
                          <i className="ti ti-alert-triangle" style={{ fontSize: 13 }} /> No suitable meter found
                        </p>
                        <p className="text-[11px] mt-1" style={{ color: '#7F1D1D' }}>
                          None of the registered meters is a clear semantic match for this contract term — select the correct one below, or register a new meter first.
                        </p>
                      </div>
                    ) : matchedMeter ? (
                      <p className="text-[11px] text-stone mb-3">
                        <span className="font-medium text-ink">Verdix suggests</span> {matchedMeter.display_name} ({matchedMeter.unit_label}) — confirm or pick a different meter below.
                      </p>
                    ) : (
                      <p className="text-[11px] text-stone mb-3">Select the billing meter this contract term maps to.</p>
                    )}

                    <div className="text-[10px] font-bold uppercase tracking-widest text-stone mb-1.5">Billing meters</div>
                    <div className="space-y-1.5">
                      {meters.map(m => (
                        <label key={m.meter_key} className="flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors"
                          style={{ background: meterKey === m.meter_key ? '#F0FDF4' : 'transparent', border: `1px solid ${meterKey === m.meter_key ? 'rgba(11,92,54,0.3)' : 'rgba(26,61,43,0.1)'}` }}>
                          <input type="radio" name={`meter-${s.contract_unit_type}`} className="mt-0.5" checked={meterKey === m.meter_key} onChange={() => choose(m.meter_key)} />
                          <span>
                            <span className="block text-xs font-semibold text-ink">{m.display_name}</span>
                            <span className="block text-[11px] text-stone">Unit: {m.unit_label} · {m.meter_key}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Minimum commitment — read-only pointer to where this actually
                  gets resolved (the Review panel's own rule-interpretation
                  card for this metric), never a second interactive widget
                  here. Resolving it in THIS panel used to only ever write to
                  contract_meter_mappings — the Commercial Terms view and
                  every other ambiguity check read contract_terms, which
                  never updated, so the flag reappeared even after a
                  reviewer thought they'd already resolved it. */}
              {minCommitment?.requires_confirmation && (
                <div className="mx-4 mb-4 rounded-xl p-3" style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
                  <p className="text-[11px] font-medium flex items-center gap-1.5" style={{ color: '#92400E' }}>
                    <i className="ti ti-alert-triangle flex-shrink-0" style={{ fontSize: 12 }} />
                    This metric also has a minimum commitment awaiting interpretation — resolve it in the rule card below, not here.
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
      </>}
    </div>
  )
}
