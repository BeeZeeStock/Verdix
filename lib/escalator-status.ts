// Shared "is this escalator still unresolved" check — previously duplicated
// (and at risk of drifting) between configure/[id]/page.tsx's classifyItem
// and any other surface that needs to know whether an escalator's rate is
// safe to treat as a real, executable number yet. An unresolved escalator
// must never render as a plain 0% — that's a real economic value, distinct
// from "not yet known" (see RevenueModelTab's escalator scenario input).

export type EscalatorLike = {
  escalator_pct?: number | null
  interpretation?: {
    requires_confirmation: boolean
    treatment?: 'applies' | 'not_applied' | string
  } | null
}

// A CPI/HICP-linked escalator with no resolved rate/interpretation needs the
// same structured-interpretation flow as an ambiguous minimum — a plain
// "confirm this value" doesn't make sense when there's no value yet. An
// interpretation that's present but still flagged requires_confirmation, or
// whose treatment isn't a recognized value (data predating the treatment
// field), counts as unresolved too, not just an entirely absent interpretation.
export function isEscalatorUnresolved(esc: EscalatorLike | null | undefined): boolean {
  if (!esc) return false
  if (esc.escalator_pct != null) return false
  return (
    !esc.interpretation
    || esc.interpretation.requires_confirmation
    || (esc.interpretation.treatment !== 'applies' && esc.interpretation.treatment !== 'not_applied')
  )
}
