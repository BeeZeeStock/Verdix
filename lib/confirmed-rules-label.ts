// Step 17E.3, item 4 — the "Confirmed billing rules" section's count badge
// previously read "N rule(s) confirmed" unconditionally, implying every
// card behind it was a reviewer decision. Cards in that section span a mix
// of provenance (contract_derived — the source was unambiguous, no human
// judgment call — and reviewer_policy — a human actually decided). This
// derives an accurate label from the SAME provenance values already
// attached to each rendered card (never re-classifies anything): when every
// one of them is reviewer_policy, say so explicitly; otherwise these are a
// genuinely mixed/typed set of compiled commercial rules, and the existing
// generic wording is the accurate one.
export function deriveConfirmedRulesLabel(cardCount: number, provenanceValues: Array<string | null | undefined>): string {
  const known = provenanceValues.filter((v): v is string => !!v)
  const allReviewerPolicy = known.length > 0 && known.every(v => v === 'reviewer_policy')
  return allReviewerPolicy
    ? `${cardCount} reviewer polic${cardCount === 1 ? 'y' : 'ies'} confirmed`
    : `${cardCount} billing rule${cardCount === 1 ? '' : 's'} confirmed`
}
