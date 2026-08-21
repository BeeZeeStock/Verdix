// Verdix Global Rulebook — shadow resolver (Step 2, shadow mode only).
//
// resolveVerdixRulebookShadow is the ONLY entry point into the Rulebook.
// It is a pure function: given a CommercialSemanticContext, it identifies
// which registered rules apply, evaluates them, and returns findings. It
// never mutates its input, never writes to a normalized commercial rule,
// never touches the database, and never calls an LLM.
//
// No production route handler, calculation function, or readiness
// predicate calls this yet — see tests/commercial-semantics/rulebook/ for
// how it's exercised. The intended (not-yet-built) future shape is:
//
//   contract
//     -> existing extraction / interpretation
//     -> current normalized commercial rule
//        |-> current production flow (unchanged)
//        `-> resolveVerdixRulebookShadow(context) -> findings only
//
// and, later still (NOT this step — see lib/rulebook/rules.ts's Step 2
// scope note), an organization-rulebook layer ahead of this one. Wiring
// this resolver into a real call site, and adding organization-level
// rules, are both explicitly out of scope for Step 2.
import { verdixCommercialRulebook, VERDIX_RULEBOOK_VERSION } from './rules'
import type { CommercialSemanticContext, RulebookShadowResult } from './types'

export function resolveVerdixRulebookShadow(context: CommercialSemanticContext): RulebookShadowResult {
  const matched = verdixCommercialRulebook.filter(rule => rule.matches(context))
  const findings = matched.flatMap(rule => rule.evaluate(context))
  return {
    rulebookVersion: VERDIX_RULEBOOK_VERSION,
    matchedRuleIds: matched.map(rule => rule.id),
    findings,
  }
}
