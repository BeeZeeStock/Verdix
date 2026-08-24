// Deterministic, extraction-time source-grounding for
// ServiceCreditInterpretation.monetary_basis_recognition (2026-08-30
// follow-up audit) — the same "require explicit textual grounding"
// discipline lib/commercial-rule-status.ts's isServiceCreditFullySourceResolved
// already established (ELIGIBILITY_MARKER_RE/CARRY_FORWARD_MARKER_RE):
// computed from already-extracted free text alone, never from an AI
// proposal's own confidence. AI confidence is not provenance — a model can
// always produce SOME value; only explicit textual grounding earns
// 'contract_derived' here. A false negative (still shown as unresolved
// when a human would agree it's paid) is the safe failure mode; a false
// positive is not, so this stays deliberately narrow.
//
// Only ever derives 'paid' — never 'component_amount'. Recognizing that a
// clause unambiguously means "the stated/invoiced amount, not a paid one"
// is a materially harder, more inference-prone judgment (many real clauses
// simply don't say either way) than recognizing an explicit payment
// statement; building that detector is out of scope for this pass (same
// "do not build a broad new invoiced-vs-accrued accounting engine"
// boundary the runtime execution side already draws — see lib/paid-basis-
// finalization.ts). A clause that fails this check is 'unclear'
// (null/null) — never guessed as 'component_amount' either.
//
// PAYMENT_MARKER_RE matches only unambiguous payment-occurred language:
// "paid" (covers "actually paid", "amounts paid", "fees paid", etc. — all
// contain the word "paid") or "payment received". Deliberately does NOT
// match — and must never be extended to match — commercially different
// concepts that only describe an amount existing or being owed: "fee",
// "amount", "charged", "invoiced", "billed", "payable", "due". None of
// those words share a substring with "paid" ("payable" is a different
// word, not a superstring of "paid"; "unpaid" has no word-boundary
// immediately before "paid" either, so \bpaid\b structurally can't match
// inside it), so this regex cannot accidentally fire on them.
//
// 2026-08-30 follow-up audit (marker locality/negation) — a bare \bpaid\b
// match is NOT sufficient on its own: "fees not paid" contains the literal
// word "paid" but means the opposite. hasUnnegatedMarker below rejects any
// match immediately preceded (within a short character window, not a full
// NLP negation-scope analysis — deliberately narrow, per instruction) by a
// negation word ("not", "never", "no", or an "n't" contraction like
// "hasn't"/"wasn't"). "unpaid" needs no special handling — \bpaid\b simply
// never matches inside it, since there is no word boundary between "un"
// and "paid".
import type { FieldProvenance } from './types'

const PAYMENT_MARKER_RE = /\bpaid\b|\bpayment received\b/gi
const NEGATION_WORD_RE = /\b(?:not|never|no|\w+n't)\b/i
// How far back (characters) to look for a negation word before a payment
// marker — enough to catch "fees not paid"/"fees are not actually paid"
// without turning into unbounded, whole-document negation scoping.
const NEGATION_LOOKBACK_CHARS = 25

function hasUnnegatedMarker(text: string): boolean {
  const re = new RegExp(PAYMENT_MARKER_RE)
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const window = text.slice(Math.max(0, match.index - NEGATION_LOOKBACK_CHARS), match.index)
    if (!NEGATION_WORD_RE.test(window)) return true
    // This occurrence is negated ("not paid") — keep scanning; a LATER,
    // genuinely unnegated occurrence in the same text should still count.
  }
  return false
}

export type MonetaryBasisRecognitionValue = 'paid' | 'component_amount' | 'unclear' | null

export type MonetaryBasisDerivation =
  | { monetary_basis_recognition: 'paid'; monetary_basis_recognition_provenance: 'contract_derived' }
  | { monetary_basis_recognition: null; monetary_basis_recognition_provenance: null }

// 2026-08-30 provenance-locality amendment (final fail-closed tightening)
// — basis_component (what the % is computed from — e.g. Contract B's own
// value literally IS the full source phrase), when present, is the SOLE
// evidence consulted. It is never diluted by ALSO consulting source_clause
// as a fallback: a present-but-inconclusive basis_component ("transaction-
// processing fees", no marker) must resolve to unclear even if the
// surrounding source_clause happens to contain unrelated payment wording
// elsewhere (e.g. a late-payment-fee clause, a different credit's own
// clause folded into the same source_clause string) — that wording says
// nothing about whether THIS specific basis is paid. source_clause is
// consulted ONLY when basis_component itself is absent/empty — the one
// case where basis_component carries no evidence at all, positive or
// negative, so falling back to the fuller clause is the only source
// available. This deliberately prefers a false-negative (still unresolved
// when a human would agree it's paid) over a false-positive
// (contract_derived minted from evidence that isn't actually about this
// basis) — the same fail-closed bias this whole module already commits to.
export function deriveMonetaryBasisRecognition(params: {
  basisComponent?: string | null
  sourceClause?: string | null
}): MonetaryBasisDerivation {
  if (params.basisComponent) {
    return hasUnnegatedMarker(params.basisComponent)
      ? { monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' }
      : { monetary_basis_recognition: null, monetary_basis_recognition_provenance: null }
  }
  if (params.sourceClause && hasUnnegatedMarker(params.sourceClause)) {
    return { monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' }
  }
  return { monetary_basis_recognition: null, monetary_basis_recognition_provenance: null }
}

// The confirm-rule integration point (app/api/jobs/[id]/confirm-rule/
// route.ts's buildServiceCreditInterpretation) — extracted as its own pure,
// directly-testable function for the same reason lib/credit-application-
// rule.ts/lib/credit-earn-rule.ts were: route.ts transitively imports
// next-auth and cannot be unit-tested at all. Once monetary_basis_
// recognition_provenance is ALREADY resolved (contract_derived from a
// prior derivation, reviewer_policy, or organization_rulebook — though
// only contract_derived is actually produced anywhere today), it is NEVER
// re-derived or overwritten by a later, unrelated confirm on the same
// credit (e.g. resolving paid_basis_finalization_policy) — the exact
// "never overwrite an existing reviewer or source-derived value" guarantee
// the Contract B migration's own guards independently re-enforce at the
// data layer.
export function resolveMonetaryBasisRecognition(
  existing: { monetary_basis_recognition?: MonetaryBasisRecognitionValue; monetary_basis_recognition_provenance?: FieldProvenance | null } | null | undefined,
  params: { basisComponent?: string | null; sourceClause?: string | null },
): { monetary_basis_recognition: MonetaryBasisRecognitionValue; monetary_basis_recognition_provenance: FieldProvenance | null } {
  const alreadyResolved = existing?.monetary_basis_recognition_provenance === 'contract_derived'
    || existing?.monetary_basis_recognition_provenance === 'reviewer_policy'
    || existing?.monetary_basis_recognition_provenance === 'organization_rulebook'
  if (alreadyResolved) {
    return {
      monetary_basis_recognition: existing?.monetary_basis_recognition ?? null,
      monetary_basis_recognition_provenance: existing?.monetary_basis_recognition_provenance ?? null,
    }
  }
  return deriveMonetaryBasisRecognition(params)
}
