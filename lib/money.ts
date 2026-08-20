// The rest of the codebase computes money as raw JS floats in major units
// with no single, consistently-applied rounding convention (confirmed by
// investigation: lib/tariff.ts/lib/billing-writer.ts round at inconsistent,
// ad hoc points, some in major units, some in minor, right before whichever
// external API call happens to need it). Retrofitting that is out of scope
// here — but the credit ledger is new code with real financial consequences
// (idempotent reservations, caps, percentage rebates), so it defines and
// enforces its own convention: every internal calculation happens in
// integer minor units (öre/cents), converted at the boundary exactly once.
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100)
}

export function fromMinorUnits(minor: number): number {
  return minor / 100
}
