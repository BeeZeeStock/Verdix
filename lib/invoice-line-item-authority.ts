// Step E9B.1 §12 — the complete, PURE authority rule behind Billing
// Timeline's Invoice Projection table: which of the four mutually
// exclusive presentations a period entry's variable-line section gets.
// Extracted out of app/_components/BillingSummaryCard.tsx so the rule
// itself — not just each individual fix — is directly, exhaustively
// testable. `e.overageLineItems.length === 0` is NEVER, by itself,
// sufficient proof that nothing is owed (the original E9 audit concern) —
// it only becomes meaningful once combined with the invoice's own real
// lifecycle status (isPast, from lib/invoice-history-classification.ts's
// isGenuinelyIssuedInvoice — status-driven, never calendar-date-driven)
// and its FAILED/PARKED classification (effectiveStatus).
export type LineItemAuthorityState =
  // Real, persisted invoice composition exists — show it, and ONLY it.
  | 'authoritative'
  // A FAILED invoice's empty array is NOT proof of zero usage — its
  // computation never completed. Never claim "no usage overage" here.
  | 'failed_unknown'
  // A genuinely processed/issued invoice (paid/open/sent, NOT failed)
  // with a real empty array — the computation DID complete and found
  // nothing to bill. This is the one case where "no usage overage for
  // this period" is a confident, earned claim, not a fallback guess.
  | 'confirmed_zero'
  // Not yet processed (an ordinary future/draft entry, OR a held/PARKED
  // one — both share isPast:false) — no persisted composition exists
  // yet by definition, so a live preview (carried-forward ready amounts
  // + unresolved items shown as state, never a fake zero) is the only
  // honest thing to show.
  | 'provisional_preview'

export function resolveLineItemAuthorityState(params: {
  hasRealLineItems: boolean
  isFailed: boolean
  isPast: boolean
}): LineItemAuthorityState {
  if (params.hasRealLineItems) return 'authoritative'
  if (params.isFailed) return 'failed_unknown'
  if (params.isPast) return 'confirmed_zero'
  return 'provisional_preview'
}
