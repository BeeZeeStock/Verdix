// Shared cadence-noun/label helpers — previously defined only inside
// configure/[id]/page.tsx (not importable from other components), which is
// exactly why "Partial-quarter treatment" ended up hardcoded verbatim in
// several places instead of reflecting a metric's actual monthly/quarterly/
// annual cadence. Pure, no imports, safe from both server and client code.

export const CADENCE_NOUN: Record<string, string> = { monthly: 'month', quarterly: 'quarter', 'semi-annual': 'half-year', annual: 'year' }

export function cadenceNoun(period: string | null | undefined): string {
  if (!period) return 'period'
  return CADENCE_NOUN[period] ?? period
}

// "calendar quarter" vs plain "quarter" — the reset_anchor distinction
// (contract-anniversary vs fixed calendar boundaries) changes which real
// dates the rule evaluates on, so a compact rule display must not drop it.
export function ruleCadenceLabel(period: string | null | undefined, resetAnchor: 'contract_start' | 'calendar' | null | undefined): string | null {
  if (!period) return null
  const noun = cadenceNoun(period)
  return resetAnchor === 'calendar' ? `calendar ${noun}` : noun
}

// "Partial-quarter treatment" / "Partial-month treatment" / "Partial-year
// treatment" — the label a partial-period review card/status line uses,
// generalized by the rule's actual cadence instead of a hardcoded "quarter".
export function partialPeriodLabel(period: string | null | undefined): string {
  return `Partial-${cadenceNoun(period)} treatment`
}
