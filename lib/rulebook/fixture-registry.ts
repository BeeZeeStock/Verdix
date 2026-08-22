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
}

export function isRegisteredFixtureId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERDIX_FIXTURE_REGISTRY, id)
}
