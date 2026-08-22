// Verdix Global Rulebook — candidate fixture registry (Step 9).
//
// Stable, code-defined IDs that let a VerdixRuleCandidate reference
// evidence WITHOUT embedding contract text or duplicating the corpus.
// Reuses the existing synthetic test suite under tests/commercial-
// semantics/ (this codebase's one and only commercial-semantics fixture
// corpus — see that directory's own layout) rather than creating a second,
// disconnected set of contract fixtures. Each entry's `location` points at
// the real test file/case that actually exercises the fixture; this
// module never re-embeds the clause text itself, only a short, generic
// `description` of the shape (never a specific customer's wording).
export type VerdixFixtureKind =
  // Demonstrates the principle holding — e.g. an anti-inference rule
  // correctly leaving a field unresolved, or an invariant behaving
  // correctly under normal input.
  | 'positive'
  // A deliberately adversarial/edge input for an invariant candidate —
  // item 3: invariants need an adversarial fixture, not just a positive one.
  | 'adversarial'
  // Evidence about the BOUNDARY of an anti-inference/semantic principle —
  // shows what happens when the second concept genuinely IS addressed,
  // proving the rule doesn't over-suppress a real answer. Doubles as the
  // "negative/absent wording" case for a semantic_interpretation candidate
  // when the absent concept is what's being tested.
  | 'counterexample'

export interface VerdixFixtureDescriptor {
  id: string
  kind: VerdixFixtureKind
  // The real test file + case this fixture lives in — never the fixture's
  // own contract text, which stays exactly where it already is (inside
  // the referenced test file), reviewed and version-controlled there.
  location: string
  // A short, generic description of the fixture's SHAPE — never a raw
  // clause, never anything customer-identifying.
  description: string
}

// The registry itself — a plain, statically-defined object (mirrors
// lib/rulebook/rules.ts's own verdixCommercialRulebook convention: no
// database, no network, code-reviewed like everything else here). Add an
// entry here whenever a new candidate needs to cite evidence; never
// reference a fixture ID that isn't registered — see candidate-
// validation.ts's "fixture IDs that do not exist" rejection.
export const VERDIX_FIXTURE_REGISTRY: Record<string, VerdixFixtureDescriptor> = {
  'credit.application_scope_only.cash_unresolved': {
    id: 'credit.application_scope_only.cash_unresolved',
    kind: 'positive',
    location: 'tests/commercial-semantics/rulebook/ai-guidance.test.ts — "F. application restriction only"',
    description: 'A rebate restricted to future transaction-processing fees, with no mention of cash payment at all — cash redeemability correctly stays unresolved rather than being inferred from the application restriction.',
  },
  'credit.application_scope_explicit_no_cash': {
    id: 'credit.application_scope_explicit_no_cash',
    kind: 'counterexample',
    location: 'tests/commercial-semantics/rulebook/ai-guidance.test.ts — "G. explicit no-cash"',
    description: 'Same application restriction, plus an explicit "shall not be paid in cash" clause — proves the rule does not over-suppress a genuinely explicit negative answer; cash_redeemable correctly resolves to false, contract_derived.',
  },
  'credit.application_scope_explicit_cash_allowed': {
    id: 'credit.application_scope_explicit_cash_allowed',
    kind: 'counterexample',
    location: 'tests/commercial-semantics/rulebook/ai-guidance.test.ts — "H. explicit cash allowed"',
    description: 'Same application restriction, plus an explicit clause allowing cash payment at Customer\'s election — proves the rule does not over-suppress a genuinely explicit positive answer; cash_redeemable correctly resolves to true, contract_derived.',
  },

  // Step 10 — milestone/project-billing fixture family. Positive/
  // counterexample evidence for candidate.credit.milestone_delivery_ne_
  // acceptance (rule-candidates.ts). Sourced from real, live baseline
  // extraction runs against the current, unmodified production model (see
  // that candidate's own rationale for the captured results) — not
  // fabricated expectations.
  'milestone.deemed_acceptance_window.acceptance_unresolved_structurally': {
    id: 'milestone.deemed_acceptance_window.acceptance_unresolved_structurally',
    kind: 'positive',
    location: 'tests/commercial-semantics/milestone-billing/baseline-extraction.test.ts — "Case C"',
    description: 'A milestone fee with an explicit 10-business-day deemed-acceptance review window (delivery and acceptance kept distinct) — real baseline extraction preserves the distinction only as free text (no structured acceptance-event field exists yet), never collapsing it into an auto-invoice-on-delivery shape.',
  },
  'milestone.delivery_constitutes_acceptance.explicit_collapse': {
    id: 'milestone.delivery_constitutes_acceptance.explicit_collapse',
    kind: 'counterexample',
    location: 'tests/commercial-semantics/milestone-billing/baseline-extraction.test.ts — "Case G"',
    description: 'A milestone fee where the contract EXPLICITLY states delivery constitutes acceptance with no separate review — proves the principle is "do not infer acceptance from delivery when the contract is silent," never "delivery can never establish acceptance." Real baseline extraction correctly preserves this explicit collapse in free text too (still manual_trigger: true pending delivery confirmation, structurally identical to Case C at the field level — which is itself the semantic-model gap documented in the corresponding candidate record).',
  },
}

export function isRegisteredFixtureId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERDIX_FIXTURE_REGISTRY, id)
}
