// Step 17E, items 6/7/8 — the approved-contract GUI's "Usage input
// configuration" section previously rendered one row per raw
// contract_unit_type with a plain description string built by string
// concatenation (`Meter: ${meter?.display_name ?? row?.meter_key ?? '—'}`)
// — which is also where the "payment request: Meter: " blank-name bug
// lived (`??` never falls through a genuinely empty string, since '' is
// not nullish; a no-match mapping's meter_key is '', not absent).
//
// This module replaces that with a proper card model: ONE card per
// canonical semantic_input_key (never one per raw contract_unit_type,
// which would show the SAME confirmed source three times for a contract
// where a per-unit fee, an overage tier, and a rolling migration all
// reference the identical fact — item 8's explicit "one semantic input ->
// one source card -> multiple consumers"). A contract_unit_type with no
// resolved semantic key still gets its own card (grouped by the raw unit
// type string instead), so nothing becomes invisible merely because
// extraction didn't state a canonical identity for it.
//
// Pure, DB-free, React-free — takes exactly the shapes already available
// from GET /api/jobs/[id]/meter-mappings (suggestions/available_meters)
// and the job's own contract_terms, so no new API surface is needed.
export interface UsageSourceMapping {
  contract_unit_type: string
  semantic_input_key?: string | null
  meter_key: string
  confirmed: boolean
  input_classification?: 'meter' | 'meter_or_manual_input' | 'derived' | 'persisted_balance'
  manual_value_configured?: boolean
}

export interface UsageSourceMeter {
  meter_key: string
  display_name: string
}

export interface UsageSourceFee {
  fee_label: string
  metric_name?: string | null
  rate_per_unit?: number | null
  semantic_input_key?: string | null
}

export interface UsageSourceTier {
  unit_type?: string
  rate_per_unit?: number
  semantic_input_key?: string | null
}

export interface UsageSourceRollingMechanism {
  execution_status: 'unsupported' | 'executable'
  rolling_band_migration?: { aggregate: { input_key: string; window_count: number } } | null
}

export interface UsageSourceCard {
  // Grouping identity — semantic_input_key when resolved, else the raw
  // contract_unit_type (so two units with no shared canonical identity
  // never accidentally merge).
  key: string
  contractUnitType: string
  semanticInputKey: string | null
  label: string
  sourceName: string
  sourceType: 'api_meter' | 'manual' | 'unconfirmed'
  status: 'confirmed' | 'not_confirmed'
  // Human-readable descriptions of every commercial rule this SAME
  // canonical fact feeds — derived from the compiled additional_recurring_
  // fees / overage_tiers / rolling_band_migration configs actually on the
  // contract, never a hard-coded per-connector list (item 8's explicit
  // constraint: "not hard-coded to Remembill").
  consumers: string[]
}

function describeFeeConsumer(fee: UsageSourceFee): string | null {
  if (typeof fee.rate_per_unit !== 'number' || fee.rate_per_unit <= 0) return null
  const unit = (fee.metric_name ?? fee.fee_label).replace(/_/g, ' ').trim()
  return `€${fee.rate_per_unit} per ${unit}`
}

function describeTierConsumer(tier: UsageSourceTier): string | null {
  if (typeof tier.rate_per_unit !== 'number' || tier.rate_per_unit <= 0) return null
  return `€${tier.rate_per_unit} overage above contracted volume`
}

function describeRollingConsumer(mechanism: UsageSourceRollingMechanism): string | null {
  const windowCount = mechanism.rolling_band_migration?.aggregate?.window_count
  if (mechanism.execution_status !== 'executable' || !windowCount) return null
  return `${windowCount}-month rolling volume migration`
}

export function buildUsageSourceCards(params: {
  mappings: UsageSourceMapping[]
  meters: UsageSourceMeter[]
  fees: UsageSourceFee[]
  tiers: UsageSourceTier[]
  rollingMechanisms: UsageSourceRollingMechanism[]
}): UsageSourceCard[] {
  const { mappings, meters, fees, tiers, rollingMechanisms } = params
  const meterByKey = new Map(meters.map(m => [m.meter_key, m]))

  const groups = new Map<string, UsageSourceMapping[]>()
  for (const m of mappings) {
    const key = m.semantic_input_key || m.contract_unit_type
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(m)
  }

  const cards: UsageSourceCard[] = []
  for (const [key, group] of groups) {
    // derived/persisted_balance rows are never a "source" in this sense —
    // they have no meter/manual entry to describe at all (see lib/meter-
    // mapping-status.ts) — excluded from this card list entirely, matching
    // MeterMappingPanel's own treatment of these classifications.
    const representative = group.find(g => g.input_classification !== 'derived' && g.input_classification !== 'persisted_balance')
    if (!representative) continue

    const semanticInputKey = representative.semantic_input_key || null
    const meter = representative.meter_key ? meterByKey.get(representative.meter_key) : undefined
    const isManual = representative.input_classification === 'meter_or_manual_input' && !!representative.manual_value_configured && !representative.meter_key

    let sourceName: string
    let sourceType: UsageSourceCard['sourceType']
    if (isManual) {
      sourceName = 'Manual usage'
      sourceType = 'manual'
    } else if (meter) {
      sourceName = meter.display_name
      sourceType = 'api_meter'
    } else if (representative.meter_key) {
      // A meter_key is set but not found in the available-meters list
      // (e.g. deleted since confirmation) — show the raw key rather than
      // a blank string, never `Meter: ` with nothing after it.
      sourceName = representative.meter_key
      sourceType = 'api_meter'
    } else {
      sourceName = 'Not yet confirmed'
      sourceType = 'unconfirmed'
    }

    const label = meter?.display_name || representative.contract_unit_type

    const consumers: string[] = []
    if (semanticInputKey) {
      for (const fee of fees) {
        if (fee.semantic_input_key !== semanticInputKey) continue
        const d = describeFeeConsumer(fee)
        if (d) consumers.push(d)
      }
      for (const tier of tiers) {
        if (tier.semantic_input_key !== semanticInputKey) continue
        const d = describeTierConsumer(tier)
        if (d) consumers.push(d)
      }
      for (const mech of rollingMechanisms) {
        if (mech.rolling_band_migration?.aggregate?.input_key !== semanticInputKey) continue
        const d = describeRollingConsumer(mech)
        if (d) consumers.push(d)
      }
    } else {
      // No canonical identity resolved — fall back to matching the exact
      // raw unit_type on tiers only (the one shape guaranteed to carry
      // it), so a genuinely-uncanonicalized metric still shows what it
      // feeds instead of an empty "Used by" list.
      for (const tier of tiers) {
        if (tier.unit_type !== representative.contract_unit_type) continue
        const d = describeTierConsumer(tier)
        if (d) consumers.push(d)
      }
    }

    cards.push({
      key,
      contractUnitType: representative.contract_unit_type,
      semanticInputKey,
      label,
      sourceName,
      sourceType,
      status: representative.confirmed ? 'confirmed' : 'not_confirmed',
      consumers,
    })
  }

  return cards
}
