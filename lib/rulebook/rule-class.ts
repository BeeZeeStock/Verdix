// Verdix Global Rulebook — rule class taxonomy (Step 6).
//
// Classifies WHAT KIND of authority a Verdix Global Rulebook rule is
// allowed to have, independent of (and never to be conflated with) Step
// 3's activation layer (lib/rulebook/activation.ts's RulebookAuthority —
// 'diagnostic' | 'enforce_invariant' | 'resolve_semantic' — and
// RulebookEnforcementTarget — 'execution' | 'promotion'). The two answer
// different questions:
//   VerdixRuleClass    — what KIND of thing is this rule, architecturally
//                         (can it ever fill contract silence? interpret
//                         explicit language? enforce a structural fact?)
//   RulebookAuthority   — is THIS rule, TODAY, switched on in production,
//                         and if so, where does its effect land
//
// A rule's class is a description of its inherent nature and does not by
// itself grant production authority — see activation.ts for that. This
// module only classifies and constrains; it does not activate anything,
// does not change readiness, and does not touch billing.
import type { ResolutionAuthority } from './resolution'

export type VerdixRuleClass =
  // Prevents a logically invalid interpretation or execution — a
  // structural fact the calculation/readiness engine must always hold
  // (e.g. "floor mode is never additive", "a value claiming contract_
  // derived provenance must have real source text behind it"). Violating
  // an invariant is always a bug, never a customer-specific ambiguity.
  // Never supplies missing customer policy — it has nothing to do with
  // what a SILENT contract should resolve to.
  | 'invariant'
  // Helps Verdix deterministically interpret EXPLICIT contract language
  // that is already there — it never fills silence. The resulting field's
  // AUTHORITY remains contract_derived (or reviewer_policy); the Rulebook
  // only ever contributes METHOD ("how was this value arrived at"), never
  // authority ("why does this value count") — see resolveFieldAuthority's
  // own authority-vs-method distinction in lib/rulebook/resolution.ts, and
  // this module's assertAuthorityAllowedForClass, which enforces exactly
  // this boundary.
  | 'semantic_interpretation'
  // May supply a value when the contract, a contract-specific reviewer
  // decision, AND an Organization Rulebook policy are all silent — the
  // ONLY class that may ever produce a RuleResolutionCandidate, and the
  // only class whose candidate may carry authority: 'verdix_rulebook'.
  // Organization Rulebook policy always outranks it (see
  // RESOLUTION_AUTHORITY_PRECEDENCE). As of Step 6, ZERO current Verdix
  // Global Rulebook rules are classified default_policy — see this
  // module's own governance note (lib/rulebook/README.md) for what a
  // rule would have to satisfy to ever become one, and Step 6's own
  // audit conclusion for why none of the current eight qualify.
  | 'default_policy'
  // Explicitly states what Verdix must NOT infer — the mirror image of
  // semantic_interpretation. Exists specifically to catch a value that
  // LOOKS like it was (wrongly) derived from an adjacent fact without
  // independent grounding (e.g. "calculation basis does not, by itself,
  // establish application scope"). Preserves silence/'remains_unresolved'
  // state; never supplies a value, never produces a resolution candidate,
  // regardless of how confidently a hypothetical inference could be made.
  | 'anti_inference'

export interface RuleClassCapabilities {
  // May participate in Step 3 invariant enforcement (resolveVerdixRulebook
  // Activation's execution-target violations, evaluateFieldPromotion's
  // promotion-target denials).
  canEnforceInvariant: boolean
  // May help establish the meaning of contract language that is already
  // explicit — contributing interpretation METHOD, never authority.
  canInterpretContract: boolean
  // May produce a lib/rulebook/resolution.ts RuleResolutionCandidate at
  // all — the single gate every other production-authority behavior
  // (minting verdix_rulebook authority, clearing readiness from Rulebook
  // silence, being overrideable by an Organization Rulebook policy)
  // depends on. False here makes all of those structurally unreachable.
  canProduceResolutionCandidate: boolean
  // May supply a value for a field the contract/reviewer/organization
  // left genuinely silent on.
  canFillContractSilence: boolean
}

// Central, single source of truth for what each class is permitted to do —
// consulted by the assert functions below rather than scattering per-class
// conditionals across call sites. Every future code path that wants to do
// something class-restricted (mint a candidate, enforce an invariant,
// interpret contract text) is expected to consult or assert against this
// matrix rather than re-deriving the same permissions ad hoc.
export const RULE_CLASS_CAPABILITIES: Record<VerdixRuleClass, RuleClassCapabilities> = {
  invariant: {
    canEnforceInvariant: true,
    canInterpretContract: false,
    canProduceResolutionCandidate: false,
    canFillContractSilence: false,
  },
  semantic_interpretation: {
    canEnforceInvariant: false,
    canInterpretContract: true,
    canProduceResolutionCandidate: false,
    canFillContractSilence: false,
  },
  anti_inference: {
    canEnforceInvariant: false,
    canInterpretContract: false,
    canProduceResolutionCandidate: false,
    canFillContractSilence: false,
  },
  default_policy: {
    canEnforceInvariant: false,
    canInterpretContract: false,
    canProduceResolutionCandidate: true,
    canFillContractSilence: true,
  },
}

export function ruleClassAllows(ruleClass: VerdixRuleClass, capability: keyof RuleClassCapabilities): boolean {
  return RULE_CLASS_CAPABILITIES[ruleClass][capability]
}

// Structural guard (Step 6 item 8) — throws immediately rather than
// silently no-op-ing, so a future call site attempting something a rule's
// class does not permit fails loudly in development/tests, not silently
// in production. Covers two of the three named forbidden combinations:
//   - an anti_inference rule producing a RuleResolutionCandidate
//   - an invariant rule producing an organization-overrideable field
//     candidate (impossible without a candidate in the first place, so
//     the same canProduceResolutionCandidate: false gate covers it)
// The third (semantic_interpretation minting authority: 'verdix_rulebook')
// is a value-level concern, not a boolean-capability one — see
// assertAuthorityAllowedForClass below.
export function assertRuleClassCapability(ruleClass: VerdixRuleClass, capability: keyof RuleClassCapabilities, context?: string): void {
  if (!ruleClassAllows(ruleClass, capability)) {
    throw new Error(
      `Verdix Rulebook: rule class "${ruleClass}" does not permit "${capability}"${context ? ` (${context})` : ''} — see RULE_CLASS_CAPABILITIES in lib/rulebook/rule-class.ts.`
    )
  }
}

// Authority vs. method (Step 6 item 6, reconfirming Step 4's existing
// design in lib/rulebook/resolution.ts) — a semantic_interpretation rule
// may contribute METHOD ("the Rulebook helped read this clause") but must
// NEVER become AUTHORITY ("why this value counts"). Only a default_policy
// rule may ever mint authority: 'verdix_rulebook'; every other class
// (invariant, semantic_interpretation, anti_inference) is refused here —
// invariant/anti_inference are already blocked earlier by
// canProduceResolutionCandidate: false (they never reach the point of
// proposing an authority at all), so this function's practical target is
// semantic_interpretation specifically, but it is written to refuse any
// non-default_policy class on principle, not just the one case Step 6
// happens to have an example of today.
export function assertAuthorityAllowedForClass(ruleClass: VerdixRuleClass, proposedAuthority: ResolutionAuthority, context?: string): void {
  if (proposedAuthority === 'verdix_rulebook' && ruleClass !== 'default_policy') {
    throw new Error(
      `Verdix Rulebook: rule class "${ruleClass}" may never mint authority: 'verdix_rulebook'${context ? ` (${context})` : ''} — only a default_policy rule may. ` +
      `A semantic_interpretation rule may appear as method: 'verdix_rulebook' while authority stays contract_derived/reviewer_policy — ` +
      `see the authority-vs-method distinction in lib/rulebook/resolution.ts.`
    )
  }
}
