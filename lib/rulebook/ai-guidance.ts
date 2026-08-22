// Verdix Global Rulebook — AI contract-interpretation guidance (Step 7).
//
// Teaches the AI proposal/interpretation layer how NOT to misread a
// contract — it never tells the AI what a silent contract should have
// said. Only rules whose ruleClass is 'anti_inference' or
// 'semantic_interpretation' are ever eligible (enforced here, not just by
// convention — see getRulebookAIGuidance's own filter):
//   - anti_inference rules teach the model what NOT to infer from an
//     adjacent fact (e.g. "next invoice" timing does not imply
//     carry-forward).
//   - semantic_interpretation rules teach the model to trust EXPLICIT
//     language rather than under-read it, without ever becoming the
//     SOURCE of the resulting value — see item 6's worked example below.
// 'invariant' rules are not about contractual meaning at all (they're
// engine-execution facts) and 'default_policy' rules (none exist today)
// must never masquerade as contractual meaning the model should
// "recognize" — see lib/rulebook/README.md's governance note.
//
// Guidance here is static, curated, version-controlled Verdix product
// text — never generated from AI output, never derived from a specific
// customer's contract, never containing an Organization Rulebook policy
// (Organization policy only ever participates AFTER contract
// interpretation, once genuine silence is already established — see
// lib/rulebook/organization-rulebook-production.ts; nothing in this
// module or its callers ever loads organization_rulebook_rules).
//
// This module does not itself create provenance, does not fill contract
// silence, and does not decide which Rulebook rules apply via an LLM
// call — selection is a pure, deterministic function of the caller's
// declared RuleInterpretationContext (never "ask Claude which rules are
// relevant").
import { verdixCommercialRulebook } from './rules'
import type { RuleInterpretationContext, VerdixRulebookRule } from './types'

// Bumped whenever the CONTENT of any rule's aiGuidance changes (a new
// entry added, an existing instruction's wording changed, appliesTo
// narrowed/widened) — never for unrelated Rulebook changes (rule
// matches()/evaluate() logic, activation, classification alone). The
// rendered guidance text is embedded directly in the prompt string
// returned by every builder that calls renderRulebookAIGuidance, which
// means propose-rule/route.ts's existing cache-fingerprint check
// (`cached.promptFingerprint === prompt`, a full-string comparison) ALREADY
// invalidates automatically the moment guidance content changes — this
// version number is embedded directly in the rendered header (see
// renderRulebookAIGuidance below) specifically so that fact is visible
// and explicit in the actual fingerprinted text, not merely true by
// accident of how the cache happens to be keyed today.
export const RULEBOOK_AI_GUIDANCE_VERSION = '1.0.0'

// Deterministic, pure selection (item 3) — never asks an LLM which rules
// are relevant. Filters verdixCommercialRulebook itself (not a separate,
// parallel array) so a rule's guidance can never drift out of sync with
// its own definition/classification. The ruleClass check is structural
// defense-in-depth: even a future rule mistakenly given an aiGuidance
// field while classified 'invariant' or 'default_policy' would still
// never reach a prompt through this function.
export function getRulebookAIGuidance(context: RuleInterpretationContext): VerdixRulebookRule[] {
  return verdixCommercialRulebook.filter(rule =>
    (rule.ruleClass === 'anti_inference' || rule.ruleClass === 'semantic_interpretation') &&
    !!rule.aiGuidance &&
    rule.aiGuidance.appliesTo.includes(context)
  )
}

// The ONE canonical renderer (item 4) — every prompt builder that wants
// Rulebook guidance calls this; no prompt builder duplicates instruction
// text itself. Deterministic order: verdixCommercialRulebook's own
// registry order, never re-sorted per call, so repeated calls with the
// same context produce a byte-identical block. Returns '' (nothing to
// insert) when no guidance applies to this context — a prompt builder for
// an unrelated rule type (e.g. minimum commitment) sees no Rulebook
// section at all, not an empty header.
//
// Always ends with the item 7 reinforcement sentence, whenever guidance
// is non-empty — Rulebook guidance constrains interpretation, it does not
// supply missing contract terms. This is REINFORCEMENT of the existing
// "contract silence != contract_derived" invariant (lib/rulebook/rules.ts's
// silenceCannotBecomeContractDerived, still separately and independently
// enforced downstream — see activation.ts/promotion-guard.ts), not a
// replacement for it.
export function renderRulebookAIGuidance(context: RuleInterpretationContext): string {
  const applicable = getRulebookAIGuidance(context)
  if (applicable.length === 0) return ''
  const lines = applicable.map(rule => `- ${rule.aiGuidance!.instruction}`)
  return `VERDIX COMMERCIAL INTERPRETATION RULES (v${RULEBOOK_AI_GUIDANCE_VERSION})

${lines.join('\n')}

Verdix Rulebook guidance constrains interpretation but does not supply missing contract terms. If the source does not answer a field, preserve it as unresolved even if a commercially plausible treatment exists.`
}
