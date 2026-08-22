// Verdix Global Rulebook — activation layer (Step 3).
//
// Step 2's resolveVerdixRulebookShadow is a pure diagnostic: it answers
// "what would the Rulebook conclude", nothing more, and stays that way —
// this module is deliberately layered ON TOP of it, never inside it. A
// RulebookFinding (what the Rulebook concluded) and its production
// AUTHORITY (what, if anything, that finding is allowed to DO) are kept as
// two separate concepts on purpose, so a rule's content and its production
// activation policy can change independently — add a new rule in shadow
// mode, observe it, promote or roll back its authority later, all without
// touching lib/rulebook/rules.ts.
import { resolveVerdixRulebookShadow } from './resolver'
import type { CommercialSemanticContext, RulebookFinding } from './types'

export const VERDIX_RULEBOOK_ACTIVATION_VERSION = '0.1.0'

// diagnostic: a finding is recorded and visible for developer diagnostics
// only — no production effect whatsoever.
// enforce_invariant: a finding may become production-relevant — exactly
// HOW depends on its `target` (see RulebookEnforcementTarget below); the
// authority alone never says whether that means an execution blocker or a
// promotion denial.
// resolve_semantic: a finding would be allowed to FILL a genuinely missing
// field (an outcome of 'remains_unresolved') with a Rulebook-derived value.
// Architecturally supported, deliberately inert in Step 3 — see
// VERDIX_RULEBOOK_ACTIVATION below, where no rule_id is set to this value
// yet, and note 7 in this module's Step 3 scope: activating this would
// require introducing a new 'verdix_rulebook' FieldProvenance value, which
// this step explicitly does not do.
export type RulebookAuthority = 'diagnostic' | 'enforce_invariant' | 'resolve_semantic'

// Invariant AUTHORITY (is this rule allowed to have production effect at
// all) is a separate question from invariant ENFORCEMENT TARGET (where/how
// that effect happens) — conflating them was a real Step 3 bug: it made
// provenance.verdix_recommendation_cannot_clear_readiness's ALWAYS-
// 'remains_unresolved' finding look like it needed to become a generic
// execution blocker to have any effect at all, when 'remains_unresolved'
// is that rule's entirely correct, EXPECTED steady state — the Rulebook
// deliberately preserving uncertainty, not a contradiction to fail closed
// on.
//
// execution: the rule compares a normalized commercial rule against a real,
// observed execution result (e.g. a real lib/tariff.ts calculation) — a
// 'contradicts' finding here is a structural engine bug, never a
// customer-specific ambiguity, and is the ONLY thing that may become a
// RulebookViolation / execution blocker (see resolveVerdixRulebookActivation
// below). A 'remains_unresolved' finding from an execution-target rule
// (which, today, A/B never actually produce — see
// tests/commercial-semantics/rulebook/activation.test.ts's own regression
// guard for that) must NEVER become a violation either — "the Rulebook
// intentionally preserved uncertainty" is not an execution contradiction,
// regardless of which rule said it.
// promotion: the rule governs whether a proposed field VALUE may be
// promoted into resolved provenance at all — enforced exclusively through
// evaluateFieldPromotion (lib/rulebook/promotion-guard.ts), never through
// the execution-blocker path. Both 'contradicts' (G: a fabricated
// contract_derived claim) and 'remains_unresolved' (H: a verdix_recommends
// value that must stay unresolved) outcomes deny a promotion attempt —
// denial is not a "violation" in the execution sense, it is the invariant
// working exactly as intended.
export type RulebookEnforcementTarget = 'execution' | 'promotion'

// A diagnostic rule has no enforcement target — it never has any
// production effect, so there is nothing to target. An enforce_invariant
// (or, later, resolve_semantic) rule MUST declare exactly where its
// authority applies; TypeScript enforces this pairing structurally (a
// diagnostic entry cannot accidentally carry a target, and a
// enforce_invariant entry cannot omit one).
export type RulebookActivationEntry =
  | { authority: 'diagnostic' }
  | { authority: 'enforce_invariant' | 'resolve_semantic'; target: RulebookEnforcementTarget }

// The activation registry — Rulebook CONTENT (lib/rulebook/rules.ts) and
// Rulebook AUTHORITY/TARGET are intentionally two separate, independently
// version-controlled concerns. Every rule_id in verdixCommercialRulebook
// must have an entry here (enforced by a completeness test — see
// tests/commercial-semantics/rulebook/activation.test.ts); a rule with no
// entry is treated as 'diagnostic' by resolveVerdixRulebookActivation and
// evaluateFieldPromotion, the same fail-safe default a brand-new
// shadow-mode rule gets automatically, so forgetting to register a new
// rule here can never accidentally grant it production authority.
//
// Exactly four rules are activated as enforce_invariant in Step 3 — the
// four the spec calls "very safe": both structural pricing/calculation
// invariants (A, B — target: execution) and both provenance-integrity
// invariants (G, H, in lib/rulebook/rules.ts's own lettering — target:
// promotion) that reinforce, rather than compete with, the existing
// isProvenanceResolved() gate (lib/commercial-rule-status.ts). The
// remaining five (C, D, E, F, and the Step 7 amendment's cash-redeemability
// rule) stay diagnostic — they tell Verdix what cannot safely be INFERRED;
// they do not themselves supply the missing customer commercial policy, so
// they must never resolve a field or block execution on their own.
export const VERDIX_RULEBOOK_ACTIVATION: Record<string, RulebookActivationEntry> = {
  'minimum.floor.non_additive': { authority: 'enforce_invariant', target: 'execution' },
  'pricing.all_units.non_graduated': { authority: 'enforce_invariant', target: 'execution' },
  'credit.basis_ne_application_scope': { authority: 'diagnostic' },
  'credit.next_invoice_timing_ne_carry_forward': { authority: 'diagnostic' },
  'credit.future_payable_scope_ne_indefinite_survival': { authority: 'diagnostic' },
  'credit.explicit_carry_forward_authoritative': { authority: 'diagnostic' },
  'credit.application_scope_ne_cash_redeemability': { authority: 'diagnostic' },
  'provenance.silence_cannot_become_contract_derived': { authority: 'enforce_invariant', target: 'promotion' },
  'provenance.verdix_recommendation_cannot_clear_readiness': { authority: 'enforce_invariant', target: 'promotion' },
}

// A real, production-relevant EXECUTION contradiction — the ONLY thing an
// enforce_invariant + target:'execution' rule is allowed to produce.
// Deliberately never populated by a 'remains_unresolved' finding, and
// deliberately never populated by a target:'promotion' rule (G/H) — their
// enforcement is promotion denial, a structurally separate concept, never
// an execution blocker; see evaluateFieldPromotion in
// lib/rulebook/promotion-guard.ts.
export interface RulebookViolation {
  rule_id: string
  field: string
  reason: string
  expected_value?: unknown
}

// Architecturally present, always empty in Step 3 — see resolve_semantic's
// own doc comment above. Kept as its own type (not reusing RulebookFinding)
// so a future step's real implementation doesn't have to redesign the
// shape other code already depends on; resolved_value is what a semantic
// rule would have filled in, had this authority level ever been reached.
export interface RulebookResolution {
  rule_id: string
  field: string
  resolved_value: unknown
  reason: string
}

// The activation-layer's single result shape. `findings` is the complete,
// unfiltered Step 2 shadow output (nothing hidden); `violations` and
// `resolutions` are strict SUBSETS derived from `findings` by applying
// VERDIX_RULEBOOK_ACTIVATION — never independently computed, so they can
// never disagree with what `findings` actually says. Promotion denial is
// NOT represented here — see evaluateFieldPromotion's own PromotionDecision
// return type, a deliberately separate output. Both `rulebookVersion` and
// `activationVersion` are reported together because the same Rulebook
// CONTENT can be re-activated differently over time — a diagnostic hitting
// zero contradictions today says nothing about whether it would still hit
// zero once promoted to enforce_invariant under a later activation version.
export interface RulebookActivationResult {
  rulebookVersion: string
  activationVersion: string
  findings: RulebookFinding[]
  violations: RulebookViolation[]
  resolutions: RulebookResolution[]
}

// The activation layer's entry point — still pure, still no mutation, no
// database access, no LLM call. Wraps resolveVerdixRulebookShadow and
// applies VERDIX_RULEBOOK_ACTIVATION on top; never recomputes findings
// itself. No production route handler or calculation function calls this
// yet in Step 3 (see lib/commercial-rule-status.ts's executionBlockers
// parameter for the one place a caller COULD plug real violations in) —
// this function existing and being correct is what Step 3 delivers, not
// the wiring itself.
export function resolveVerdixRulebookActivation(context: CommercialSemanticContext): RulebookActivationResult {
  const shadow = resolveVerdixRulebookShadow(context)
  const violations: RulebookViolation[] = []
  const resolutions: RulebookResolution[] = []
  for (const finding of shadow.findings) {
    // Only an ACTUAL contradiction from an EXECUTION-target enforce_invariant
    // rule ever becomes a RulebookViolation. 'remains_unresolved' is never
    // converted, for ANY rule, regardless of authority — it means the
    // Rulebook intentionally preserved uncertainty, which is not an
    // execution violation by definition. A target:'promotion' rule's
    // 'contradicts' finding (G) ALSO never reaches `violations` — its
    // enforcement is promotion denial, handled exclusively by
    // evaluateFieldPromotion (lib/rulebook/promotion-guard.ts), a
    // structurally separate output from this function's result.
    if (finding.outcome !== 'contradicts') continue
    const entry = VERDIX_RULEBOOK_ACTIVATION[finding.rule_id] ?? { authority: 'diagnostic' as const }
    if (entry.authority === 'enforce_invariant' && entry.target === 'execution') {
      violations.push({ rule_id: finding.rule_id, field: finding.field, reason: finding.reason, expected_value: finding.expected_value })
    }
    // entry.authority === 'enforce_invariant' && entry.target === 'promotion'
    // (G/H): deliberately not handled here — see evaluateFieldPromotion.
    // entry.authority === 'resolve_semantic' is unreachable in Step 3 — no
    // rule_id is registered at that authority.
    // entry.authority === 'diagnostic' (including any rule_id missing from
    // the registry entirely — the fail-safe default) never reaches
    // `violations` or `resolutions`; the finding is still present in
    // `findings` above.
  }
  return {
    rulebookVersion: shadow.rulebookVersion,
    activationVersion: VERDIX_RULEBOOK_ACTIVATION_VERSION,
    findings: shadow.findings,
    violations,
    resolutions,
  }
}

// A rulebook-detected engine contradiction, shaped for
// lib/commercial-rule-status.ts's computeCommercialRuleWorkload
// (executionBlockers parameter) — that module intentionally does NOT
// import this type (see its own comment: it defines a structurally
// identical local type so it has zero dependency on the optional,
// removable lib/rulebook/ layer). A real RulebookInvariantExecutionBlocker
// produced here is accepted there as-is, by structural typing, with no
// cast required.
export interface RulebookInvariantExecutionBlocker {
  type: 'rulebook_invariant_violation'
  rule_id: string
  field: string
  reason: string
}

export function toRulebookExecutionBlockers(activation: RulebookActivationResult): RulebookInvariantExecutionBlocker[] {
  return activation.violations.map(v => ({ type: 'rulebook_invariant_violation', rule_id: v.rule_id, field: v.field, reason: v.reason }))
}
