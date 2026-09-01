'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { allMeterMappingsResolved, isMeterMappingResolved } from '@/lib/meter-mapping-status'
import { hasContractStarted } from '@/lib/performance-share-timing'

// Step 17H.4B0D4H1B4E6.1 §8 — business label before the raw input_key
// (same one-liner as page.tsx's own humanizeKey; not worth centralizing a
// single-expression pure function into a shared lib just to avoid this one
// duplication).
function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

type MinimumCommitment = {
  mode: 'floor' | 'additive' | 'minimum_spend' | 'prepaid_commitment' | 'minimum_quantity'
  amount: number
  included_allowance_interaction?: 'before_allowance' | 'after_allowance' | 'unclear'
  requires_confirmation: boolean
  confirmation_reason?: string | null
}

type MeterSuggestion = {
  contract_unit_type: string
  // Step 17D.1, item D/G — the canonical fact this contract requirement
  // needs (e.g. 'issued_payment_request_count'), when extraction/runtime
  // resolution recognized one. Drives which usage_period_values row a
  // manual-entry fallback below writes to and reads back — never the raw
  // contract_unit_type string, which is free text and not a stable key.
  semantic_input_key?: string | null
  meter_key: string
  confidence: number
  // Server-computed: the best guess it could produce was still below a
  // trustworthy-match threshold (e.g. the only candidate was "first
  // available meter, confidence 0.2" — technically compatible on unit type
  // alone, not actually the right meter). meter_key is '' when this is true
  // — nothing is pre-selected, the reviewer must pick one explicitly.
  no_match?: boolean
  confirmed: boolean
  /** meter = needs a real mapped usage source (default); meter_or_manual_input
   *  = a mapped source OR a manual value satisfies it; derived/persisted_balance
   *  are never meter-mapped at all — see lib/meter-mapping-status.ts. */
  input_classification?: 'meter' | 'meter_or_manual_input' | 'derived' | 'persisted_balance'
  /** 'meter_or_manual_input' only — reviewer chose manual entry over a meter. */
  manual_value_configured?: boolean
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

// Step 17B0, item G — a required_operational_inputs entry that isn't
// represented by any overage_tiers unit_type at all (e.g. a monetary
// running total a derived-rate fee depends on) never becomes a
// MeterSuggestion row above — nothing in this panel's existing
// meter-picker machinery fits a value that isn't a countable usage meter.
// Purely informational: never gates onConfirmedChange/allConfirmed, never
// offers a picker — there is no "appropriate source type" mapping
// mechanism built yet (out of scope here). Its only job is to make sure a
// real operational dependency is never silently invisible.
type OperationalDataInput = { key: string; kind: 'monetary' | 'countable'; sources: string[] }

// Corrections pass (post-17B0.4) — a derived metric (a fee's rate computed
// from other raw inputs via a stated formula, e.g. "value-weighted payment
// rate = paid invoice value / total invoice value") is never itself a raw
// operational input — see lib/operational-data-inputs.ts's
// collectDerivedMetrics doc. Shown as its own section so a reviewer sees
// "this rate is computed as X / Y" as a distinct fact from "these are the
// raw values Verdix needs a data source for" (raw_inputs still also appear
// in Operational data inputs above, since those DO need a source). No
// external mapping applies to a derived metric — there is nothing to pick
// here, informational only, same as Operational data inputs.
type DerivedMetric = { metric_name: string; formula: string; raw_inputs: string[]; source: string }

// Step 17C.1a, item 3 — one row as returned by
// GET /api/jobs/[id]/operational-input-values (append/revoke-versioned;
// see lib/operational-input-binding.ts's own header). finalized_at null =
// draft, never used in a real calculation.
type OperationalInputValueRow = {
  id: string
  input_key: string
  period_start: string
  period_end: string
  value: number
  currency: string | null
  finalized_at: string | null
  status: 'active' | 'revoked'
}

// Step 17C.1a, item 3 — the smallest generic UI for the manual source kind
// of lib/operational-input-binding.ts's OperationalInputBinding. This is
// explicitly the CURRENT source method, not the eventual production model
// — a future 'api'/'connector' source would reach the SAME
// operational_input_period_values table through the same typed input_key,
// never a parallel mechanism, so nothing here assumes manual entry is
// permanent. No CSV upload, no Remembill connector — a single period's
// value, typed in and saved, is the entire surface.
// Step 17E, item 1 — exported so the approved-contract GUI's persistent
// Operational Inputs section (app/(dashboard)/configure/[id]/page.tsx) can
// reuse this EXACT entry widget (same operational_input_period_values
// API, same append/revoke/finality discipline) instead of a second
// persistence path — this component was previously only reachable inside
// the review drawer, which is precisely the bug item 1 fixes.
export function ManualInputEntry({ jobId, inputKey }: { jobId: string; inputKey: string }) {
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('')
  const [saving, setSaving] = useState<'draft' | 'final' | null>(null)
  const [rows, setRows] = useState<OperationalInputValueRow[]>([])
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch(`/api/jobs/${jobId}/operational-input-values`)
      .then(r => r.json())
      .then((res: { values?: OperationalInputValueRow[] }) => {
        setRows((res.values ?? []).filter(v => v.input_key === inputKey && v.status === 'active'))
      })
      .catch(() => {})
  }, [jobId, inputKey])

  useEffect(() => { load() }, [load])

  const save = async (isFinal: boolean) => {
    const numericValue = Number(value)
    if (!periodStart || !periodEnd || value.trim() === '' || !Number.isFinite(numericValue)) {
      setMsg('Enter a period and a numeric value first.')
      return
    }
    setSaving(isFinal ? 'final' : 'draft')
    setMsg(null)
    const res = await fetch(`/api/jobs/${jobId}/operational-input-values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input_key: inputKey, period_start: periodStart, period_end: periodEnd,
        value: numericValue, currency: currency.trim() || null, is_final: isFinal,
      }),
    }).catch(() => null)
    setSaving(null)
    if (!res?.ok) { setMsg('Save failed — try again.'); return }
    setMsg(isFinal ? 'Marked final.' : 'Draft saved.')
    setValue('')
    load()
  }

  return (
    <div className="mt-2 pt-2 border-t" style={{ borderColor: 'rgba(26,61,43,0.06)' }}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-stone/70 mb-1.5">Manual entry — current source method</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
          aria-label={`${inputKey} period start`}
          className="text-[11px] border rounded px-1.5 py-1" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        />
        <span className="text-[11px] text-stone/60">–</span>
        <input
          type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
          aria-label={`${inputKey} period end`}
          className="text-[11px] border rounded px-1.5 py-1" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        />
        <input
          type="number" placeholder="Value" value={value} onChange={e => setValue(e.target.value)}
          aria-label={`${inputKey} value`}
          className="text-[11px] border rounded px-1.5 py-1 w-24" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        />
        <input
          type="text" placeholder="EUR" value={currency} onChange={e => setCurrency(e.target.value)}
          aria-label={`${inputKey} currency`}
          className="text-[11px] border rounded px-1.5 py-1 w-14" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        />
        <button
          onClick={() => save(false)} disabled={saving !== null}
          className="text-[11px] font-medium text-stone hover:text-ink px-2 py-1 rounded border disabled:opacity-50"
          style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        >
          {saving === 'draft' ? 'Saving…' : 'Save draft'}
        </button>
        <button
          onClick={() => save(true)} disabled={saving !== null}
          className="text-[11px] font-medium text-white px-2 py-1 rounded bg-forest hover:bg-sage disabled:opacity-50"
        >
          {saving === 'final' ? 'Saving…' : 'Mark final'}
        </button>
      </div>
      {msg && <p className="text-[10px] text-stone/70 mt-1">{msg}</p>}
      {rows.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {rows.map(r => (
            <p key={r.id} className="text-[10px] text-stone/70 font-mono">
              {r.period_start} – {r.period_end}: {r.value}{r.currency ? ` ${r.currency}` : ''} — {r.finalized_at ? 'final' : 'draft'}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// Step 17D, item 13 / 17D.1, item G — one row as returned by
// GET /api/jobs/[id]/usage-values (same append/revoke/finality discipline
// as OperationalInputValueRow above, but a distinct table/model:
// usage_period_values, keyed by semantic_input_key, backs this metric's
// PRODUCTION billing quantity — never operational_input_period_values
// (a different fact family, KPIs like paid_invoice_value) and never a
// meter's mode='test'/test_usage_value (a per-meter simulation aid, not a
// real recorded quantity).
type UsagePeriodValueRow = {
  id: string
  semantic_input_key: string
  period_start: string
  period_end: string
  quantity: number
  finalized_at: string | null
  status: 'active' | 'revoked'
}

// The actual data-entry surface for a metric a reviewer chose "Configure
// manually instead" for (input_classification: 'meter_or_manual_input').
// Writes through resolveUsageQuantityForPeriod's own manual fallback path
// (lib/usage-quantity-resolver.ts), so a value entered here is what real
// per-unit-fee/overage/rolling-migration execution actually reads — not a
// preview-only or cosmetic field.
function ManualUsageEntry({ jobId, semanticInputKey }: { jobId: string; semanticInputKey: string }) {
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [quantity, setQuantity] = useState('')
  const [saving, setSaving] = useState<'draft' | 'final' | null>(null)
  const [rows, setRows] = useState<UsagePeriodValueRow[]>([])
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch(`/api/jobs/${jobId}/usage-values`)
      .then(r => r.json())
      .then((res: { values?: UsagePeriodValueRow[] }) => {
        setRows((res.values ?? []).filter(v => v.semantic_input_key === semanticInputKey && v.status === 'active'))
      })
      .catch(() => {})
  }, [jobId, semanticInputKey])

  useEffect(() => { load() }, [load])

  const save = async (isFinal: boolean) => {
    const numericQuantity = Number(quantity)
    if (!periodStart || !periodEnd || quantity.trim() === '' || !Number.isFinite(numericQuantity)) {
      setMsg('Enter a period and a numeric quantity first.')
      return
    }
    setSaving(isFinal ? 'final' : 'draft')
    setMsg(null)
    const res = await fetch(`/api/jobs/${jobId}/usage-values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        semantic_input_key: semanticInputKey, period_start: periodStart, period_end: periodEnd,
        quantity: numericQuantity, is_final: isFinal,
      }),
    }).catch(() => null)
    setSaving(null)
    if (!res?.ok) { setMsg('Save failed — try again.'); return }
    setMsg(isFinal ? 'Marked final.' : 'Draft saved.')
    setQuantity('')
    load()
  }

  return (
    <div className="mt-2 pt-2 border-t" style={{ borderColor: 'rgba(26,61,43,0.06)' }}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-stone/70 mb-1.5">Enter usage manually</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
          aria-label={`${semanticInputKey} period start`}
          className="text-[11px] border rounded px-1.5 py-1" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        />
        <span className="text-[11px] text-stone/60">–</span>
        <input
          type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
          aria-label={`${semanticInputKey} period end`}
          className="text-[11px] border rounded px-1.5 py-1" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        />
        <input
          type="number" placeholder="Quantity" value={quantity} onChange={e => setQuantity(e.target.value)}
          aria-label={`${semanticInputKey} quantity`}
          className="text-[11px] border rounded px-1.5 py-1 w-24" style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        />
        <button
          onClick={() => save(false)} disabled={saving !== null}
          className="text-[11px] font-medium text-stone hover:text-ink px-2 py-1 rounded border disabled:opacity-50"
          style={{ borderColor: 'rgba(26,61,43,0.15)' }}
        >
          {saving === 'draft' ? 'Saving…' : 'Save draft'}
        </button>
        <button
          onClick={() => save(true)} disabled={saving !== null}
          className="text-[11px] font-medium text-white px-2 py-1 rounded bg-forest hover:bg-sage disabled:opacity-50"
        >
          {saving === 'final' ? 'Saving…' : 'Mark final'}
        </button>
      </div>
      {msg && <p className="text-[10px] text-stone/70 mt-1">{msg}</p>}
      {rows.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {rows.map(r => (
            <p key={r.id} className="text-[10px] text-stone/70 font-mono">
              {r.period_start} – {r.period_end}: {r.quantity} — {r.finalized_at ? 'final' : 'draft'}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

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
  /** Step 17H.4B0D4H1B4E6.1 §3/§4/§16 — contract start date, used only to
   *  decide whether operational-data-input summary reads "required now" vs
   *  "required once billing begins on {date}" (the same hasContractStarted
   *  predicate OperationalInputsSection/OperationalInputCard already use —
   *  never a second, independently-computed check). */
  contractStartDate?: string | null
  /** Step 17H.4B0D4H1B4E6.1 §3/§4/§15/§16 — the manual-entry widget itself
   *  (ManualInputEntry) is owned exclusively by Billing Operations
   *  (OperationalInputsSection on the main page); this panel only summarizes
   *  and deep-links there. Optional so a caller that doesn't yet have a
   *  navigate target (none today — every caller is inside ReviewPanel,
   *  which always provides one) still renders a working summary, just
   *  without a clickable link. */
  onNavigateToOperationalInputs?: () => void
}

const CYCLE_LABELS: Record<string, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', 'semi-annual': 'Semi-annual', yearly: 'Yearly', annual: 'Annual',
}

export function MeterMappingPanel({ jobId, isConfigured, onConfirmedChange, contractBillingFrequency, refreshSignal, contractStartDate, onNavigateToOperationalInputs }: Props) {
  const [suggestions, setSuggestions] = useState<MeterSuggestion[]>([])
  const [meters, setMeters]           = useState<AvailableMeter[]>([])
  const [operationalDataInputs, setOperationalDataInputs] = useState<OperationalDataInput[]>([])
  const [derivedMetrics, setDerivedMetrics] = useState<DerivedMetric[]>([])
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOperationalDataInputs(res.operational_data_inputs ?? [])
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDerivedMetrics(res.derived_metrics ?? [])
  }, [jobId])

  useEffect(() => {
    fetch(`/api/jobs/${jobId}/meter-mappings`)
      .then(r => r.json())
      .then((res: { suggestions: MeterSuggestion[]; available_meters: AvailableMeter[]; operational_data_inputs?: OperationalDataInput[]; derived_metrics?: DerivedMetric[] }) => {
        setSuggestions(res.suggestions ?? [])
        setMeters(res.available_meters ?? [])
        setOperationalDataInputs(res.operational_data_inputs ?? [])
        setDerivedMetrics(res.derived_metrics ?? [])
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
  // (what Commercial Logic & Billing Setup and every other ambiguity check
  // reads) never updated, so the flag would reappear even after a reviewer
  // thought they'd resolved it here. Never re-add a second write path for
  // the same fact.
  const resolveMinimumCommitment = (s: MeterSuggestion): MinimumCommitment | null => {
    const tiers = get(s.contract_unit_type, 'overage_tiers', s.overage_tiers)
    for (const t of tiers) if (t.minimum_commitment) return t.minimum_commitment
    return null
  }

  const mappingResolutionRows = suggestions.map(s => ({
    classification: s.input_classification ?? 'meter' as const,
    confirmed: get(s.contract_unit_type, 'confirmed', s.confirmed),
    meter_key: get(s.contract_unit_type, 'meter_key', s.meter_key),
    manual_value_configured: get(s.contract_unit_type, 'manual_value_configured', s.manual_value_configured ?? false),
  }))
  const allConfirmed = allMeterMappingsResolved(mappingResolutionRows)
  // Step 17H.4B0D4H1B4E6.1 §5/§6 — "No billing meters registered" used to
  // render for ANY empty available_meters list, even when every suggestion
  // present is 'derived'/'persisted_balance' (never meter-mapped at all) or
  // already satisfied by manual entry — producing a false "no meters"
  // warning alongside a genuinely correct "all confirmed" state. Only shown
  // when at least one suggestion could actually be resolved by a meter.
  const anySuggestionNeedsMeter = mappingResolutionRows.some(r =>
    (r.classification === 'meter' || r.classification === 'meter_or_manual_input') && !r.manual_value_configured)
  // Step 17H.4B0D4H1B4E6.1 §5/§25 — "N of M confirmed" count for the compact
  // header badge, reusing the same per-row predicate allConfirmed is built
  // from rather than a second, independently-derived count.
  const confirmedCount = mappingResolutionRows.filter(isMeterMappingResolved).length

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
      // Never omitted — the server upsert overwrites every column in the
      // row on every save, so leaving this out silently reset every
      // metric's classification back to the 'meter' default each time a
      // reviewer saved anything, erasing meter_or_manual_input/derived/
      // persisted_balance regardless of what extraction actually said.
      input_classification:    s.input_classification ?? 'meter',
      manual_value_configured: get(s.contract_unit_type, 'manual_value_configured', s.manual_value_configured ?? false),
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

  if (suggestions.length === 0 && operationalDataInputs.length === 0 && derivedMetrics.length === 0) return null

  const hasUnsaved = Object.keys(edits).length > 0

  // Step 17H.4B0D4H1B4E6.1 §3/§4/§6/§16 — split by kind. Countable inputs
  // are usage events with no other home (informational only — the raw
  // usage mapping itself, if any, is one of the per-metric cards below).
  // Monetary inputs ARE entered somewhere, but that entry widget
  // (ManualInputEntry) is owned exclusively by Billing Operations
  // (OperationalInputsSection on the main page, same jobId/inputKey,
  // same operational_input_period_values API) — this panel summarizes
  // and deep-links there instead of duplicating the form.
  const monetaryInputs  = operationalDataInputs.filter(i => i.kind === 'monetary')
  const countableInputs = operationalDataInputs.filter(i => i.kind !== 'monetary')
  const billingStarted  = hasContractStarted(contractStartDate)
  const contractStartLabel = contractStartDate
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(contractStartDate + 'T00:00:00'))
    : null

  // sources are developer-shaped ("overage_tiers: Issued payment requests",
  // "additional_recurring_fees: Growth Credit (derived_metric)") — the part
  // before the colon names the raw array it came from, never meant for a
  // reviewer. Only the business-readable label after it is shown by default.
  const humanizeSource = (source: string): string =>
    (source.includes(': ') ? source.slice(source.indexOf(': ') + 2) : source)
      .replace(/\s*\(derived_metric\)\s*$/, '')
      .trim()

  const operationalDataInputsSection = operationalDataInputs.length > 0 && (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: 'rgba(26,61,43,0.12)', background: 'white' }}>
      <div className="px-7 py-4" style={{ borderBottom: '1px solid rgba(26,61,43,0.07)' }}>
        <p className="text-sm font-medium text-ink">Operational data inputs</p>
        <p className="text-xs text-stone mt-0.5">
          {countableInputs.length > 0 && monetaryInputs.length > 0
            ? 'These commercial rules depend on the usage and manual values below.'
            : monetaryInputs.length > 0
            ? 'These commercial rules depend on values entered manually.'
            : 'These commercial rules depend on usage data mapped below.'}
        </p>
      </div>
      <div className="px-7 py-4 space-y-2.5">
        {operationalDataInputs.map(input => (
          <div key={input.key} className="flex items-start gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full flex-shrink-0" style={{
              color: input.kind === 'monetary' ? '#B45309' : '#0369A1',
              background: input.kind === 'monetary' ? '#FEF3C7' : '#E0F2FE',
            }}>
              {input.kind === 'monetary' ? 'Manual' : 'Usage-based'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-ink">{humanizeKey(input.key)}</p>
              <p className="text-[11px] text-stone/70">{input.sources.map(humanizeSource).join(' · ')}</p>
            </div>
          </div>
        ))}
      </div>
      {monetaryInputs.length > 0 && (
        <div className="px-7 py-3 flex items-center justify-between gap-3 flex-wrap" style={{ borderTop: '1px solid rgba(26,61,43,0.07)', background: '#FAFAF9' }}>
          <p className="text-[11px] text-stone">
            {billingStarted
              ? `${monetaryInputs.length} manual input${monetaryInputs.length > 1 ? 's' : ''} entered each billing period`
              : `${monetaryInputs.length} manual input${monetaryInputs.length > 1 ? 's' : ''} required once billing begins${contractStartLabel ? ` on ${contractStartLabel}` : ''}`}
          </p>
          {onNavigateToOperationalInputs && (
            <button
              onClick={onNavigateToOperationalInputs}
              className="text-xs font-semibold text-forest hover:text-sage underline underline-offset-2"
            >
              Manage in Billing Operations →
            </button>
          )}
        </div>
      )}
    </div>
  )

  // Step 17H.4B0D4H1B4E6.1 §7/§8 — purely informational, zero reviewer
  // action possible on a derived metric (no confirm/edit/interpret call
  // anywhere below) — compacted to business-labeled rows, formula demoted
  // to a muted secondary line rather than shown as primary copy. A derived
  // metric's raw_inputs still show up in Operational data inputs above
  // (they DO need a real data source); this section shows the computed
  // rate itself, which needs none.
  const derivedMetricsSection = derivedMetrics.length > 0 && (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: 'rgba(11,92,54,0.15)', background: '#F8FDF9' }}>
      <div className="px-7 py-3.5 flex items-center gap-2">
        <i className="ti ti-circle-check-filled" style={{ fontSize: 13, color: '#0B5C36' }} />
        <p className="text-sm font-medium text-ink">
          Performance calculation{derivedMetrics.length > 1 ? 's' : ''} configured
        </p>
      </div>
      <div className="px-7 pb-4 space-y-2">
        {derivedMetrics.map(metric => (
          <div key={metric.metric_name} className="min-w-0">
            <p className="text-xs text-ink">{humanizeKey(metric.metric_name)}</p>
            <p className="text-[10px] text-stone/50 font-mono">{metric.metric_name} = {metric.formula}</p>
          </div>
        ))}
      </div>
    </div>
  )

  // Step 17B0.2, item 4 — no countable usage meter exists to map at all,
  // but that must never read as "nothing here" when real operational
  // dependencies exist — the explicit "No metered usage to map" note only
  // appears alongside the Operational Data Inputs section, never instead
  // of it and never silently on its own.
  if (suggestions.length === 0) return (
    <>
      <div className="rounded-2xl border border-forest/10 bg-white px-7 py-4">
        <p className="text-sm text-stone">No metered usage to map for this contract.</p>
      </div>
      {operationalDataInputsSection}
      {derivedMetricsSection}
    </>
  )

  return (
    <>
    {operationalDataInputsSection}
    {derivedMetricsSection}
    <div className="rounded-2xl border overflow-hidden transition-colors"
      style={{
        borderColor: allConfirmed ? 'rgba(11,92,54,0.2)' : '#FAC775',
        background:  allConfirmed ? '#F8FDF9' : 'white',
      }}>
      {/* Header — flex-wrap so the action group drops to its own row
          instead of squeezing the title/badge below their natural width
          (see the content group's own comment just below for why it
          deliberately does NOT get min-width:0). items-start (not center)
          so the actions stay pinned to the title line — with align-items:
          center, once the content group grows taller than one line
          (title row + description, sometimes + the mixed-schedule note),
          actions would visually drift down to the vertical middle of that
          whole block instead of sitting next to the title. */}
      <div
        className="px-7 py-4 flex flex-wrap items-start justify-between gap-4 cursor-pointer"
        style={collapsed ? undefined : { borderBottom: '1px solid rgba(26,61,43,0.07)' }}
        onClick={() => setCollapsed(c => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') setCollapsed(c => !c) }}
      >
        {/* flex-1 so this group claims all leftover row width on wide
            viewports; deliberately no min-w-0 override — the title/badge
            below are whitespace-nowrap, so their rendered (unbreakable)
            width becomes this item's content-based shrink floor. That
            floor is what makes the flex-wrap on the row above trigger
            (dropping the actions group to its own line) instead of the
            browser quietly shrinking this box past that floor and
            wrapping the title/badge text word-by-word — the actual bug. */}
        <div className="flex-1">
          {/* Deliberately NOT flex-wrap here — its un-wrapped width (icons
              + nowrap title + nowrap badge) is exactly the content-based
              shrink floor the OUTER header row's flex-wrap needs in order
              to decide, correctly, when to drop the actions group to its
              own line. Letting this row wrap internally would lower that
              floor and let the outer row stay "single line" past the
              point where it should have wrapped — reintroducing a
              squeeze, just one level down. */}
          <div className="flex items-center gap-2 mb-0.5">
            <i className={`ti ti-chevron-right text-stone/50 transition-transform ${collapsed ? '' : 'rotate-90'}`} style={{ fontSize: 12 }} />
            <i className="ti ti-plug-connected text-amber-700" style={{ fontSize: 15 }} />
            {/* "Usage mappings" — not "billing configured" — this panel only
                confirms which meter feeds each metric's usage data. It says
                nothing about whether that metric's commercial rules (tier
                calculation method, minimum commitments, etc.) are resolved,
                so its "All confirmed" must never be read as "billing fully
                configured" when other ambiguities remain elsewhere. */}
            <span className="text-sm font-medium text-ink whitespace-nowrap">Usage mappings</span>
            {allConfirmed && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold whitespace-nowrap" style={{ color: '#4A7C59' }}>
                · <i className="ti ti-check" style={{ fontSize: 10 }} /> {`${confirmedCount} of ${mappingResolutionRows.length} confirmed`}
              </span>
            )}
            {/* Status made visually secondary to the section title —
                a compact badge/pill (matching the established treatment
                the VAT section already uses for the identical "Required
                before approval" state) rather than plain inline text
                sitting at the same visual weight as "Usage mappings"
                itself. "approve" -> "approval" also corrected for
                consistency with that same VAT wording.
                whitespace-nowrap only on the short "Required before
                approval" copy — the compact badge that must never break
                word-by-word (the reported bug). The longer "Unconfirmed…"
                message is left free to wrap normally rather than forcing
                a much wider nowrap pill that could itself overflow a
                narrow mobile width. */}
            {!allConfirmed && (
              <span
                className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${isConfigured ? '' : 'whitespace-nowrap flex-shrink-0'}`}
                style={isConfigured ? { background: 'rgba(180,83,9,0.1)', color: '#B45309' } : { background: 'rgba(153,27,27,0.1)', color: '#991B1B' }}
              >
                {isConfigured ? 'Unconfirmed — usage-based billing will skip these meters' : 'Required before approval'}
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
        {/* justify-between on the header (not margin-left:auto here) is
            what right-aligns this group — verified empirically that
            margin-left:auto on this item overflows past the card's right
            edge once flex-wrap has put it alone on its own line (a real
            multi-line-flex + auto-margin interaction, not a hypothetical
            concern). justify-between right-aligns it correctly when it
            shares the row with the heading; once wrapped to its own row
            it's alone on that line and settles at the row's start
            (left-aligned) — a clean, fully-visible fallback rather than
            an overflowing "right-aligned" row. flex-shrink-0 unchanged,
            so the buttons themselves never compress. */}
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
      {/* No meters registered — only when some suggestion actually needs one */}
      {meters.length === 0 && anySuggestionNeedsMeter && (
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
          // Step 17H.4B0D4H1B4E6.1 §6 Case D — a previously-confirmed
          // mapping whose meter_key no longer appears in the CURRENT
          // available_meters list (e.g. the meter was later deleted/
          // renamed at the source). Distinct from both "resolved" (green)
          // and "no mapping exists" (the noMatch/unconfirmed path below) —
          // this row IS confirmed and its meter_key IS set, but what it
          // points at cannot be verified against live data right now.
          // Presentation-only: isMeterMappingResolved still treats this row
          // as resolved (meter_key is non-empty), matching existing backend
          // semantics unchanged — only the wording/color here stops
          // silently asserting a match that can no longer be confirmed.
          const sourceUnavailable = !!meterKey && !matchedMeter
          const minCommitment = resolveMinimumCommitment(s)
          const classification = s.input_classification ?? 'meter'
          // Step 17D.2, item C — manual entry is available for ANY usage
          // metric (anything reaching this point at all — derived/
          // persisted_balance already returned above), never gated on the
          // 'meter_or_manual_input' text-classification guess. The type of
          // the commercial fact (a real usage metric needing a source) is
          // what makes manual entry meaningful; classifyInput's
          // chargeback/downtime pattern-match was never more than a weak
          // hint about which source a reviewer might prefer by default.
          const manualConfigured = get(s.contract_unit_type, 'manual_value_configured', s.manual_value_configured ?? false)
          const chooseManual = () => {
            setEdit(s.contract_unit_type, 'manual_value_configured', true)
            setEdit(s.contract_unit_type, 'meter_key', '')
            setEdit(s.contract_unit_type, 'confirmed', true)
          }

          const choose = (key: string) => {
            setEdit(s.contract_unit_type, 'meter_key', key)
            setEdit(s.contract_unit_type, 'manual_value_configured', false)
            setEdit(s.contract_unit_type, 'confirmed', true)
          }

          // derived/persisted_balance values are never meter-mapped — no
          // picker to show, just a short note explaining where the value
          // actually comes from. isMeterMappingResolved already treats these
          // as resolved, so this never blocks "All confirmed".
          if (classification === 'derived' || classification === 'persisted_balance') {
            return (
              <div key={s.contract_unit_type} className="rounded-2xl border overflow-hidden" style={{ borderColor: 'rgba(11,92,54,0.2)', background: '#F8FDF9' }}>
                <div className="px-4 pt-4 pb-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-stone mb-1.5">Contract says</div>
                  <div className="text-sm font-medium text-ink font-mono bg-cream px-2.5 py-1.5 rounded-lg inline-block mb-3">
                    {s.contract_unit_type}
                  </div>
                  <div className="flex items-center gap-2 text-xs font-medium" style={{ color: '#0B5C36' }}>
                    <i className="ti ti-circle-check-filled" style={{ fontSize: 14 }} />
                    {classification === 'derived' ? 'Computed automatically from other usage data' : 'Tracked automatically by Verdix\'s credit ledger'}
                  </div>
                </div>
              </div>
            )
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
                  // meterKey can be empty on a legacy row confirmed before
                  // the no-match safeguard existed — shown as its own
                  // distinct, flagged state rather than a blank "Mapped to"
                  // with nothing after it. manualConfigured is a third,
                  // deliberate state (meter_or_manual_input only) — empty
                  // meterKey there is not an error, it's the reviewer's
                  // actual choice.
                  <div>
                    <div className="flex items-center gap-2 text-xs font-medium" style={{ color: sourceUnavailable ? '#B45309' : manualConfigured || meterKey ? '#0B5C36' : '#991B1B' }}>
                      <i className={`ti ${sourceUnavailable ? 'ti-alert-triangle' : manualConfigured || meterKey ? 'ti-circle-check-filled' : 'ti-alert-triangle'}`} style={{ fontSize: 14 }} />
                      {sourceUnavailable
                        ? `Configured source unavailable — "${meterKey}" is no longer registered`
                        : manualConfigured ? 'Configured for manual entry each period' : meterKey ? `Mapped to ${matchedMeter?.display_name ?? meterKey}` : 'No meter selected'}
                      <button onClick={() => setEdit(s.contract_unit_type, 'confirmed', false)} className="ml-auto text-stone hover:text-ink underline underline-offset-2 font-normal">
                        Change
                      </button>
                    </div>
                    {/* Readiness audit, final correction — confidence is
                        frozen from whichever generation pass first created
                        this row and is never recomputed against the final
                        selected meter_key, so it cannot support any claim
                        about the CURRENT mapping's semantic quality (AI
                        matched, manual override, high/low confidence) —
                        using it that way would assert something the data
                        model doesn't actually know. `confirmed` alone,
                        however, IS reliable: the server only ever sets it
                        true together with confirmed_by (POST handler,
                        same route), so a real human decision is the one
                        thing this note can honestly claim. */}
                    {!manualConfigured && meterKey && !sourceUnavailable && (
                      <p className="text-[10px] text-stone mt-1 flex items-center gap-1">
                        <i className="ti ti-user-check" style={{ fontSize: 11 }} /> Reviewer-confirmed mapping
                      </p>
                    )}
                    {/* Step 17D.1, item G — this is the actual data-entry
                        surface for the "manual entry" choice above; without
                        it a reviewer could confirm manual entry with no way
                        to ever record a real quantity. semantic_input_key
                        must be present (extraction/runtime resolved it) —
                        if not, there is no stable key to write against, so
                        nothing is shown rather than guessing one. */}
                    {manualConfigured && s.semantic_input_key && (
                      <ManualUsageEntry jobId={jobId} semanticInputKey={s.semantic_input_key} />
                    )}
                  </div>
                ) : (
                  <>
                    {noMatch ? (
                      <div className="rounded-xl p-3 mb-3" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                        <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: '#991B1B' }}>
                          <i className="ti ti-alert-triangle" style={{ fontSize: 13 }} /> No suitable meter configured
                        </p>
                        <p className="text-[11px] mt-1" style={{ color: '#7F1D1D' }}>
                          None of the registered meters is a clear semantic match for this contract term — select the correct one below,{' '}
                          <a href="/settings/meters" className="underline underline-offset-2 font-medium hover:text-[#991B1B]">connect a new meter</a>,
                          {' '}or enter usage manually instead (below).
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

                    {/* Step 17D.2, item C — every usage metric (any row
                        that reaches this point at all — derived/
                        persisted_balance never do) may be satisfied by
                        manual entry, not only ones classifyInput happened
                        to text-match as 'meter_or_manual_input'. Shown as
                        a peer choice to the meter list above, never a
                        replacement for it. */}
                    <div className="mt-2 pt-2" style={{ borderTop: '1px dashed rgba(26,61,43,0.15)' }}>
                      <label className="flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors"
                        style={{ background: 'transparent', border: '1px solid rgba(26,61,43,0.1)' }}>
                        <input type="radio" name={`meter-${s.contract_unit_type}`} className="mt-0.5" checked={false} onChange={chooseManual} />
                        <span>
                          <span className="block text-xs font-semibold text-ink">Enter usage manually instead</span>
                          <span className="block text-[11px] text-stone">No billing meter — the reviewer enters this value each period.</span>
                        </span>
                      </label>
                    </div>
                  </>
                )}
              </div>

              {/* Minimum commitment — read-only pointer to where this actually
                  gets resolved (the Review panel's own rule-interpretation
                  card for this metric), never a second interactive widget
                  here. Resolving it in THIS panel used to only ever write to
                  contract_meter_mappings — Commercial Logic & Billing Setup
                  and every other ambiguity check read contract_terms, which
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
    </>
  )
}
