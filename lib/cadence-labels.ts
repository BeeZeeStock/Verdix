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

// Step 16A — the volume-tier-method explanatory copy, generalized by the
// contract's own unitType instead of hardcoded to "transaction". This
// string previously appeared verbatim in three places (two in
// configure/[id]/page.tsx, one in RevenueModelTab.tsx) and always said
// "total monthly transaction volume ... every transaction", which is wrong
// for any contract priced on a different unit (e.g. OS-2026-09's SQMs).
// No pricing semantics here — copy only.
export function volumeTierCopy(unitType: string | null | undefined): string {
  const unit = unitType?.trim() || 'unit'
  return `The rate corresponding to total monthly ${unit} volume applies to every ${unit} in that calendar month; tiers are not progressive.`
}

function ordinal(day: number): string {
  const j = day % 10, k = day % 100
  if (j === 1 && k !== 11) return `${day}st`
  if (j === 2 && k !== 12) return `${day}nd`
  if (j === 3 && k !== 13) return `${day}rd`
  return `${day}th`
}

// "17th–16th" — the contract's own billing-period boundary when its start
// date doesn't land on day 1, used to phrase a "bill by contract month, not
// calendar month" option concretely instead of leaving a reviewer to work
// out what that would even mean for this specific agreement. Null when the
// contract already starts on day 1 (contract month and calendar month are
// the same thing — no distinct option is meaningful) or when no start date
// is known yet.
export function contractMonthLabel(startDate: string | null | undefined): string | null {
  if (!startDate) return null
  const day = new Date(startDate + 'T00:00:00').getDate()
  if (day === 1) return null
  return `${ordinal(day)}–${ordinal(day - 1)}`
}
