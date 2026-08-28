// A mapping row is only genuinely resolved once its classification's own
// requirement is met — "confirmed: true" alone is not enough for a 'meter'
// row, since a legacy row can carry confirmed:true with an empty meter_key
// (written before this invariant existed). Different classifications have
// different requirements entirely: 'derived'/'persisted_balance' rows are
// never meter-mapped at all, so they're resolved by definition.
//
// Step 17D.2, item C — 'meter' and 'meter_or_manual_input' are now
// RESOLUTION-IDENTICAL: both accept either a real meter_key or a manual
// value. The distinction still exists purely as classifyInput's own
// informational text-matching guess (chargeback/downtime-style metrics vs.
// everything else) — it must never be what GATES whether a reviewer is
// offered manual entry. "The type of the commercial fact determines that
// it is a usage metric; weak text classification should not determine
// whether manual entry is permitted" — any usage metric (anything that
// isn't derived/persisted_balance, which need no source at all) can always
// be satisfied by a meter OR a manually-entered value.
export type InputClassification = 'meter' | 'meter_or_manual_input' | 'derived' | 'persisted_balance'

export function isMeterMappingResolved(s: {
  classification: InputClassification
  confirmed: boolean
  meter_key: string
  manual_value_configured?: boolean
}): boolean {
  switch (s.classification) {
    case 'meter':
    case 'meter_or_manual_input':
      return s.confirmed && (s.meter_key.trim().length > 0 || !!s.manual_value_configured)
    case 'derived':
    case 'persisted_balance':
      return true
  }
}

export function allMeterMappingsResolved(rows: Parameters<typeof isMeterMappingResolved>[0][]): boolean {
  return rows.length > 0 && rows.every(isMeterMappingResolved)
}
