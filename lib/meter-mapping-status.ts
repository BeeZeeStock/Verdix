// A mapping row is only genuinely resolved once its classification's own
// requirement is met — "confirmed: true" alone is not enough for a 'meter'
// row, since a legacy row can carry confirmed:true with an empty meter_key
// (written before this invariant existed). Different classifications have
// different requirements entirely: 'derived'/'persisted_balance' rows are
// never meter-mapped at all, so they're resolved by definition.
export type InputClassification = 'meter' | 'meter_or_manual_input' | 'derived' | 'persisted_balance'

export function isMeterMappingResolved(s: {
  classification: InputClassification
  confirmed: boolean
  meter_key: string
  manual_value_configured?: boolean
}): boolean {
  switch (s.classification) {
    case 'meter':                return s.confirmed && s.meter_key.trim().length > 0
    case 'meter_or_manual_input': return s.confirmed && (s.meter_key.trim().length > 0 || !!s.manual_value_configured)
    case 'derived':
    case 'persisted_balance':    return true
  }
}

export function allMeterMappingsResolved(rows: Parameters<typeof isMeterMappingResolved>[0][]): boolean {
  return rows.length > 0 && rows.every(isMeterMappingResolved)
}
