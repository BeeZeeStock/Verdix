// Verdix Global Rulebook — provenance promotion guard (Step 3).
//
// The ideal place to enforce the two target:'promotion' invariants
// (silence_cannot_become_contract_derived, verdix_recommendation_cannot_
// clear_readiness) is BEFORE a field is promoted into resolved source
// provenance — not by periodically rewriting historical rows. This module
// is that check, expressed as a pure function: given a proposed
// field/value/provenance/evidence tuple, does an active target:'promotion'
// Rulebook invariant deny the promotion?
//
// Promotion denial is a STRUCTURALLY SEPARATE output from
// lib/rulebook/activation.ts's RulebookViolation — a denied promotion is
// not an execution contradiction, and in particular H's denial reason is
// ALWAYS a 'remains_unresolved' finding (a verdix_recommends-graded value
// remaining unresolved is this invariant's entirely correct, expected
// behavior, not a violation of anything). See PromotionDecision below,
// which deliberately does not reuse RulebookViolation.
//
// This REINFORCES, never replaces, isProvenanceResolved()
// (lib/commercial-rule-status.ts) — the sole canonical provenance gate.
// evaluateFieldPromotion never returns `allowed: true` for a case
// isProvenanceResolved would call unresolved, and it can additionally
// deny a case isProvenanceResolved structurally cannot catch on its own:
// a value CLAIMING contract_derived provenance with no real source-text
// evidence behind it (isProvenanceResolved only ever looks at the
// provenance label itself, never at whether real evidence backs it — that
// is a different, complementary check).
//
// Deliberately NOT wired into any route handler in Step 3 — see this
// step's deliverables report for why: app/api/jobs/[id]/confirm-rule/
// route.ts does not currently compute a granular, per-field "does real
// source text support this exact value" boolean (the closest existing
// signal, isServiceCreditFullySourceResolved, is a coarse two-marker
// regex over an entire credit's description/source_clause, not a per-field
// signal this guard could safely consume without risking false rejections
// of genuinely valid confirmations). This function is built and proven
// correct so a future step can wire it in once that per-field signal
// exists — activating it prematurely against an approximate signal would
// risk blocking real reviewer confirmations, which is a worse failure mode
// than the shadow-mode gap it would close.
import { resolveVerdixRulebookShadow } from './resolver'
import { VERDIX_RULEBOOK_ACTIVATION } from './activation'
import { provenancedField } from './context'
import type { RulebookFinding } from './types'
import type { FieldProvenance } from '@/lib/types'

export interface ProposedFieldPromotion {
  field: string
  value: unknown
  provenance: FieldProvenance | null | undefined
  // Whether the underlying contract source text actually contains evidence
  // for this specific field's value — see lib/rulebook/types.ts's
  // ProvenancedField.sourceTextPresent for the same distinction from
  // provenance itself.
  sourceTextPresent: boolean
}

export interface PromotionDecision {
  allowed: boolean
  // The underlying Rulebook findings that caused denial — NOT
  // RulebookViolation[]. A denial reason can be 'contradicts' (G: a
  // fabricated contract_derived claim) or 'remains_unresolved' (H: a
  // verdix_recommends value correctly staying unresolved) — the latter is
  // the invariant succeeding at its job, not a contradiction, so it must
  // never be mislabeled as a "violation". allowed === true whenever
  // `reasons` is empty.
  reasons: RulebookFinding[]
}

export function evaluateFieldPromotion(proposed: ProposedFieldPromotion): PromotionDecision {
  const shadow = resolveVerdixRulebookShadow({
    provenancedFields: [provenancedField(proposed.field, proposed.value, proposed.provenance, proposed.sourceTextPresent)],
  })
  const reasons = shadow.findings.filter(finding => {
    if (finding.outcome === 'supports') return false
    const entry = VERDIX_RULEBOOK_ACTIVATION[finding.rule_id]
    return entry?.authority === 'enforce_invariant' && entry.target === 'promotion'
  })
  return { allowed: reasons.length === 0, reasons }
}
