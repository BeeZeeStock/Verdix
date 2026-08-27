// Step 17A, item 13 — resolves which row of a committed-volume fixed-fee
// band table applies to a signed/stated committed volume, preserving the
// causal chain (volume -> band -> fee) a bare `base_monthly_fee: 2000`
// scalar would otherwise flatten and lose. Same tier-selection SHAPE
// lib/tariff.ts's volumeAmount already uses for usage overage (the band
// containing the total sets the rate for the whole thing) — deliberately
// NOT importing/reusing that function directly, since it operates on
// per-unit overage rates and RUNTIME usage quantities, a materially
// different question from "which flat monthly fee applies to a
// CONTRACTUALLY COMMITTED, fixed volume" — but the same principle.
import type { FixedFeeBand } from './types'

export type ResolveFixedFeeBandResult =
  | { status: 'resolved'; band: FixedFeeBand }
  | { status: 'no_match'; reason: string }
  | { status: 'no_bands'; reason: string }

export function resolveFixedFeeBand(bands: FixedFeeBand[] | null | undefined, committedVolume: number | null | undefined): ResolveFixedFeeBandResult {
  if (!bands || bands.length === 0) {
    return { status: 'no_bands', reason: 'no fixed-fee band table was extracted for this contract' }
  }
  if (committedVolume == null) {
    return { status: 'no_match', reason: 'no committed volume is known to select a band with' }
  }
  const sorted = [...bands].sort((a, b) => a.from_unit - b.from_unit)
  const band = sorted.find(b => committedVolume >= b.from_unit && (b.to_unit === null || committedVolume <= b.to_unit))
  if (!band) {
    return { status: 'no_match', reason: `committed volume ${committedVolume} falls outside every band in the table` }
  }
  return { status: 'resolved', band }
}
