// Verdix Global Rulebook — domain model (Step 2, shadow mode only).
//
// This is NOT a new production data model, and this module has no
// production call sites yet. A VerdixRulebookRule reads a
// CommercialSemanticContext — a small, purpose-built shape adapted FROM
// today's real normalized structures (MinimumCommitment,
// TierCalculationMethod, CreditApplicationRule, FieldProvenance — all
// lib/types.ts, see lib/rulebook/context.ts for the adapters) — and returns
// findings. A rule never reads contract_terms, never calls the database or
// an LLM, and never mutates the context it's given; see
// lib/rulebook/resolver.ts's resolveVerdixRulebookShadow, the sole entry
// point, and tests/commercial-semantics/rulebook/ for how this is exercised
// against the same scenarios the Step 1 regression corpus already covers.
import type { FieldProvenance, MinimumCommitment, TierCalculationMethod, CreditApplicationRule } from '@/lib/types'
import type { VerdixRuleClass } from './rule-class'

export type { VerdixRuleClass }

export type RulebookFindingOutcome =
  // The normalized state (and, where supplied, the observed execution
  // result) agrees with what this rule expects.
  | 'supports'
  // The normalized state (or an observed execution result) actively
  // disagrees with what this rule expects — a real, reportable divergence.
  | 'contradicts'
  // Neither of the above — the rule matched, but the field in question is
  // genuinely, correctly still open (e.g. carry_forward: 'unclear'). Not a
  // problem; documents that the Rulebook agrees nothing should have been
  // inferred here.
  | 'remains_unresolved'

// The Rulebook's only output shape. Never a mutation of the input, never a
// value written back into a normalized rule — see the module doc comment
// above. "Given this normalized representation, Verdix semantic rule X
// would conclude Y" — evaluate() returns these, resolveVerdixRulebookShadow
// just collects them.
export interface RulebookFinding {
  rule_id: string
  field: string
  outcome: RulebookFindingOutcome
  expected_value?: unknown
  reason: string
}

// A single field that carries FieldProvenance, described generically enough
// to cover eligibility/survival/cash_redeemable/or any future provenanced
// field without a bespoke shape per field. sourceTextPresent is distinct
// from provenance itself — provenance records what Verdix CLAIMED about a
// field; sourceTextPresent records whether the underlying contract text
// actually contains evidence for it. The two are supposed to always agree
// (a real 'contract_derived' claim should always have real source text
// behind it) — Rule G exists specifically to catch the case where a bug
// makes them disagree.
export interface ProvenancedField {
  field: string
  value: unknown
  provenance: FieldProvenance | null | undefined
  sourceTextPresent: boolean
}

// A real, already-computed result from lib/tariff.ts's computeMetricOverage
// (or the equivalent hand-computed expectation) — optional. Most Rulebook
// findings are about the normalized RULE alone; shadow mode never triggers
// a calculation itself. When a caller (typically a test) supplies one, a
// rule can additionally check "did the execution engine's real output
// actually match what the normalized rule says it should" — the
// contradiction-detection case called out in the Step 2 spec (item 8).
export interface ObservedMinimumCalculation {
  calculatedChargeMinor: number
  minimumAmountMinor: number
  payableMinor: number
}
export interface ObservedTierCalculation {
  method: TierCalculationMethod['method']
}

// CommercialSemanticContext adapts today's already-shipped normalized
// structures — never a new production data model, never derived from raw
// contract text, never persisted. Every slice is optional; a given
// normalized rule (a minimum commitment, a credit's application scope, ...)
// populates only the slices relevant to it. See lib/rulebook/context.ts for
// the small, pure adapter functions that build this from real
// MinimumCommitment / TierCalculationMethod / CreditApplicationRule values.
export interface CommercialSemanticContext {
  minimumCommitment?: {
    mode: MinimumCommitment['mode'] | null
    observed?: ObservedMinimumCalculation | null
  } | null
  tierCalculation?: {
    method: TierCalculationMethod['method'] | null
    observed?: ObservedTierCalculation | null
  } | null
  // What a %/amount credit is calculated FROM (ServiceCreditInterpretation
  // .basis_component / CreditApplicationRule.computed_from_component_keys)
  // — kept structurally separate from creditApplication
  // .eligibleComponentKeys on purpose. Conflating the two — assuming what a
  // credit is CALCULATED FROM is the same as what it may be APPLIED
  // AGAINST — is exactly the mistake Rule C exists to catch.
  creditBasis?: {
    componentKeys: string[] | null
  } | null
  creditApplication?: {
    eligibleComponentKeys: CreditApplicationRule['eligible_component_keys']
    eligibilityProvenance?: FieldProvenance | null
    carryForward: CreditApplicationRule['carry_forward'] | null
    survivalProvenance?: FieldProvenance | null
    availability?: CreditApplicationRule['availability'] | null
    // Step 7 amendment — cash redeemability lives on
    // ServiceCreditInterpretation (sibling to application_rule), not on
    // CreditApplicationRule itself; see lib/rulebook/context.ts's
    // creditApplicationContext adapter for how the two are joined into
    // this one context slice. 'unclear' (not null) is the genuinely-open
    // case — mirrors carryForward's own three-state shape immediately
    // above, deliberately, since both are "restriction on one axis does
    // not resolve a different axis" questions.
    cashRedeemable?: boolean | 'unclear' | null
    cashRedeemableProvenance?: FieldProvenance | null
  } | null
  provenancedFields?: ProvenancedField[]
}

// Step 7 — closed set of AI call sites that can request Rulebook
// interpretation guidance (lib/rulebook/ai-guidance.ts's
// getRulebookAIGuidance/renderRulebookAIGuidance). A rule's aiGuidance
// .appliesTo is a subset of this union, never a free string — so a typo'd
// context name fails to compile rather than silently matching nothing.
// minimum_commitment_proposal/meter_mapping are unrelated-context proof
// tags only (no rule targets them yet) — they exist so a test can assert
// those prompts see no Rulebook section rather than the Rulebook simply
// never having been asked about them.
export type RuleInterpretationContext =
  | 'service_credit_proposal'
  | 'service_credit_interpretation'
  | 'service_credit_survival'
  | 'minimum_commitment_proposal'
  | 'meter_mapping'

// Static, curated, version-controlled Verdix product text — never
// generated from AI output, never derived from a specific customer's
// contract. See lib/rulebook/ai-guidance.ts's module doc comment for the
// full set of structural guarantees this attaches to (anti_inference/
// semantic_interpretation only, no Organization Rulebook data, no
// authority creation).
export interface RulebookAIGuidance {
  appliesTo: RuleInterpretationContext[]
  instruction: string
}

// A Rulebook entry is pure and read-only by construction: matches/evaluate
// both take the same context and return plain data — no database, no LLM
// call, no mutation of the input, no side effects.
export interface VerdixRulebookRule {
  id: string
  version: number
  // Step 6 — what KIND of authority this rule is architecturally allowed
  // to have (invariant / semantic_interpretation / default_policy /
  // anti_inference — see lib/rulebook/rule-class.ts for the full
  // taxonomy and RULE_CLASS_CAPABILITIES). Distinct from, and never to be
  // conflated with, whether the rule is actually SWITCHED ON in
  // production today — that's lib/rulebook/activation.ts's
  // VERDIX_RULEBOOK_ACTIVATION registry.
  ruleClass: VerdixRuleClass
  description: string
  matches: (input: CommercialSemanticContext) => boolean
  evaluate: (input: CommercialSemanticContext) => RulebookFinding[]
  // Step 7 — optional static AI contract-interpretation guidance. Only
  // ever meaningful for anti_inference/semantic_interpretation rules;
  // lib/rulebook/ai-guidance.ts's getRulebookAIGuidance filters on
  // ruleClass structurally, not just by convention, so an invariant or
  // default_policy rule accidentally given this field still never
  // reaches a prompt.
  aiGuidance?: RulebookAIGuidance
}

export interface RulebookShadowResult {
  rulebookVersion: string
  matchedRuleIds: string[]
  findings: RulebookFinding[]
}
