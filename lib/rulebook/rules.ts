// Verdix Global Rulebook — rule registry (Step 2, shadow mode only).
//
// Only rules already validated by the Step 1 regression corpus
// (tests/commercial-semantics/) are encoded here — see each rule's own
// comment for which corpus scenario it freezes. Deliberately NOT
// exhaustive: this is the "approximately 6-8 rules" starting set, not an
// attempt to codify every commercial semantic Verdix knows about.
//
// Every rule is pure: matches()/evaluate() read the CommercialSemanticContext
// they're given and return plain data, nothing else. No rule mutates its
// input, calls the database, or calls an LLM.
import type { VerdixRulebookRule, RulebookFinding, RulebookFindingOutcome } from './types'

export const VERDIX_RULEBOOK_VERSION = '0.1.0'

// A — Minimum floor is non-additive.
// Freezes: tests/commercial-semantics/minimum-floor/minimum-floor.test.ts
// ("floor: max(calculated_charge, minimum), never additive"). Matches any
// normalized minimum commitment in floor mode. When the caller also
// supplies an observed real calculation (a real lib/tariff.ts
// computeMetricOverage result, in practice), checks it against
// max(calculated_charge, minimum) and reports a contradiction if the
// engine's actual output diverges from what floor mode requires — this is
// how shadow mode could have caught a real regression, not just documented
// the invariant in the abstract.
const minimumFloorNonAdditive: VerdixRulebookRule = {
  id: 'minimum.floor.non_additive',
  version: 1,
  // Step 6 classification: invariant. A structural fact about how the
  // CALCULATION ENGINE must behave (payable = max(charge, minimum),
  // never additive) — has nothing to do with what a silent contract
  // should resolve to, and a 'contradicts' finding here is always an
  // engine bug, never a customer-specific ambiguity. Matches the existing
  // Step 3 activation (enforce_invariant, target: execution).
  ruleClass: 'invariant',
  description: 'A minimum commitment in floor mode is payable = max(calculated_charge, minimum), never calculated_charge + minimum — regardless of how the commitment is represented (e.g. duplicated across multiple tier rows).',
  matches: (input) => input.minimumCommitment?.mode === 'floor',
  evaluate: (input) => {
    const mc = input.minimumCommitment!
    if (!mc.observed) {
      return [{
        rule_id: 'minimum.floor.non_additive',
        field: 'minimumCommitment.mode',
        outcome: 'supports',
        expected_value: 'max(calculated_charge, minimum)',
        reason: 'Normalized rule states floor mode; Verdix semantics require payable = max(calculated_charge, minimum), never additive. No observed calculation was supplied to check a real result against.',
      }]
    }
    const expectedPayable = Math.max(mc.observed.calculatedChargeMinor, mc.observed.minimumAmountMinor)
    const outcome: RulebookFindingOutcome = mc.observed.payableMinor === expectedPayable ? 'supports' : 'contradicts'
    return [{
      rule_id: 'minimum.floor.non_additive',
      field: 'minimumCommitment.observed.payableMinor',
      outcome,
      expected_value: expectedPayable,
      reason: outcome === 'supports'
        ? `Observed payable (${mc.observed.payableMinor}) matches max(calculated_charge, minimum) = ${expectedPayable}, as floor mode requires.`
        : `Observed payable (${mc.observed.payableMinor}) does not match max(calculated_charge, minimum) = ${expectedPayable} — floor mode must never behave additively.`,
    }]
  },
}

// B — All-units pricing is not graduated.
// Freezes: tests/commercial-semantics/all-units/all-units.test.ts ("one
// rate selected by total volume applies to every unit... must not execute
// as graduated/progressive pricing"). When an observed execution method is
// supplied (a real lib/tariff.ts computeMetricOverage/computeTransactional
// Overage result), a mismatch against the normalized 'volume' method is the
// exact contradiction shape the Step 2 spec's item 8 calls out
// ("calculation_method = all_units but execution model behaves graduated").
const allUnitsNonGraduated: VerdixRulebookRule = {
  id: 'pricing.all_units.non_graduated',
  version: 1,
  // Step 6 classification: invariant — same reasoning as minimumFloor
  // NonAdditive above: a structural fact about tier-execution behavior,
  // never a customer policy question. Matches the existing Step 3
  // activation (enforce_invariant, target: execution).
  ruleClass: 'invariant',
  description: 'When tier_calculation.method is "volume" (all-units), exactly one tier is selected using total period quantity and its rate applies to ALL qualifying units — never per-band graduated rating.',
  matches: (input) => input.tierCalculation?.method === 'volume',
  evaluate: (input) => {
    const tc = input.tierCalculation!
    if (!tc.observed) {
      return [{
        rule_id: 'pricing.all_units.non_graduated',
        field: 'tierCalculation.method',
        outcome: 'supports',
        expected_value: 'volume',
        reason: 'Normalized rule states volume/all-units pricing: one tier, selected by total period quantity, applies to every qualifying unit. No observed execution result was supplied to check a real result against.',
      }]
    }
    const outcome: RulebookFindingOutcome = tc.observed.method === 'volume' ? 'supports' : 'contradicts'
    return [{
      rule_id: 'pricing.all_units.non_graduated',
      field: 'tierCalculation.observed.method',
      outcome,
      expected_value: 'volume',
      reason: outcome === 'supports'
        ? `Observed execution used method "${tc.observed.method}", matching the normalized volume/all-units rule.`
        : `Observed execution used method "${tc.observed.method}" but the normalized rule states volume/all-units — these must never diverge.`,
    }]
  },
}

function sameComponentSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every(k => b.includes(k))
}

// C — Calculation basis does not, by itself, establish application scope.
// Freezes: tests/commercial-semantics/credits/credits.test.ts's "calculation
// basis vs. application scope are independent questions" block. Matches
// whenever both a credit's calculation basis and its application_rule are
// present. Three outcomes: scope genuinely unresolved (correct — basis
// alone must not fill it in); scope resolved via real independent
// provenance (contract_derived/reviewer_policy) — supports; scope present
// but NOT independently grounded and identical to the basis — the specific
// "looks copied from the basis" failure mode this rule exists to catch.
const creditBasisNeApplicationScope: VerdixRulebookRule = {
  id: 'credit.basis_ne_application_scope',
  version: 1,
  // Step 6 classification: anti_inference, not semantic_interpretation —
  // this rule's entire purpose is to state what must NOT be inferred
  // (calculation basis -> application scope) and catch the specific
  // shape of a wrongly-inferred value (looks copied from the basis, no
  // independent grounding). It never determines/confirms meaning for
  // explicit language on its own — when the field IS independently
  // grounded, it merely affirms that fact; when the field is genuinely
  // open, it reports 'remains_unresolved' and supplies nothing. Matches
  // the existing Step 3 activation (diagnostic only).
  ruleClass: 'anti_inference',
  description: 'A percentage/amount calculated FROM component X does not, by itself, prove that the resulting credit/rebate may only offset component X — application scope requires its own, independent grounding.',
  matches: (input) => !!input.creditBasis?.componentKeys && !!input.creditApplication,
  evaluate: (input) => {
    const basisKeys = input.creditBasis!.componentKeys!
    const app = input.creditApplication!
    const rule_id = 'credit.basis_ne_application_scope'
    const field = 'creditApplication.eligibleComponentKeys'
    if (app.eligibleComponentKeys == null) {
      return [{
        rule_id, field, outcome: 'remains_unresolved',
        reason: 'Calculation basis is known, but application scope was correctly left unresolved rather than inferred from the basis — these are independent questions.',
      }]
    }
    const grounded = app.eligibilityProvenance === 'contract_derived' || app.eligibilityProvenance === 'reviewer_policy'
    const looksCopiedFromBasis = Array.isArray(app.eligibleComponentKeys) && sameComponentSet(app.eligibleComponentKeys, basisKeys)
    if (looksCopiedFromBasis && !grounded) {
      return [{
        rule_id, field, outcome: 'contradicts',
        reason: 'Application scope is identical to the calculation basis with no independent contract_derived/reviewer_policy grounding — looks copied from the basis rather than independently established, which calculation basis alone can never prove.',
      }]
    }
    if (grounded) {
      return [{
        rule_id, field, outcome: 'supports',
        reason: `Application scope is independently grounded (provenance: ${app.eligibilityProvenance}), not merely inferred from the calculation basis.`,
      }]
    }
    return [{
      rule_id, field, outcome: 'remains_unresolved',
      reason: `Application scope has a value but no independent contract_derived/reviewer_policy grounding yet (provenance: ${app.eligibilityProvenance ?? 'none'}).`,
    }]
  },
}

// D — Next-invoice timing does not establish carry-forward, either way.
// Freezes: tests/commercial-semantics/credits/credits.test.ts's "timing
// never implies a carry-forward answer" cases. This is the Step 2 spec's
// own worked example: "next-invoice + carry_forward=true without
// supporting evidence → Rulebook emits contradiction."
const nextInvoiceTimingNeCarryForward: VerdixRulebookRule = {
  id: 'credit.next_invoice_timing_ne_carry_forward',
  version: 1,
  // Step 6 classification: anti_inference — same shape as
  // creditBasisNeApplicationScope: states what must NOT be inferred
  // (timing -> carry-forward), never itself supplies a value. Matches
  // the existing Step 3 activation (diagnostic only).
  ruleClass: 'anti_inference',
  description: 'availability = "next_period" establishes WHEN a credit becomes available to apply — it does not, by itself, establish carry_forward true or false.',
  matches: (input) => input.creditApplication?.availability === 'next_period',
  evaluate: (input) => {
    const app = input.creditApplication!
    const rule_id = 'credit.next_invoice_timing_ne_carry_forward'
    const field = 'creditApplication.carryForward'
    if (app.carryForward == null || app.carryForward === 'unclear') {
      return [{
        rule_id, field, outcome: 'remains_unresolved',
        reason: 'availability=next_period establishes timing only — it does not by itself resolve carry_forward, which correctly remains unresolved here.',
      }]
    }
    const grounded = app.survivalProvenance === 'contract_derived' || app.survivalProvenance === 'reviewer_policy'
    if (grounded) {
      return [{
        rule_id, field, outcome: 'supports', expected_value: app.carryForward,
        reason: `carry_forward=${app.carryForward} is independently grounded (provenance: ${app.survivalProvenance}), not derived from next-invoice timing.`,
      }]
    }
    return [{
      rule_id, field, outcome: 'contradicts',
      reason: `carry_forward=${app.carryForward} has no independent contract_derived/reviewer_policy grounding — next-invoice timing alone must never establish a carry-forward answer.`,
    }]
  },
}

// E — Future-payable application scope does not establish indefinite
// survival. Freezes: tests/commercial-semantics/credits/credits.test.ts's
// "'applied against future amounts payable' establishes scope/timing but
// never indefinite survival" cases (the Rebate/Service Credit shape).
const futurePayableScopeNeIndefiniteSurvival: VerdixRulebookRule = {
  id: 'credit.future_payable_scope_ne_indefinite_survival',
  version: 1,
  // Step 6 classification: anti_inference — same shape again: states
  // what must NOT be inferred (broad eligible-component scope ->
  // indefinite survival). Matches the existing Step 3 activation
  // (diagnostic only).
  ruleClass: 'anti_inference',
  description: 'eligible_component_keys = "all" (the full future-amounts-payable pool) establishes broad application SCOPE — it does not, by itself, establish that an unused balance survives indefinitely.',
  matches: (input) => input.creditApplication?.eligibleComponentKeys === 'all',
  evaluate: (input) => {
    const app = input.creditApplication!
    const rule_id = 'credit.future_payable_scope_ne_indefinite_survival'
    const field = 'creditApplication.carryForward'
    if (app.carryForward == null || app.carryForward === 'unclear') {
      return [{
        rule_id, field, outcome: 'remains_unresolved',
        reason: 'eligible_component_keys="all" establishes broad future-payable scope, not indefinite survival — carry_forward correctly remains unresolved.',
      }]
    }
    const grounded = app.survivalProvenance === 'contract_derived' || app.survivalProvenance === 'reviewer_policy'
    if (grounded) {
      return [{
        rule_id, field, outcome: 'supports', expected_value: app.carryForward,
        reason: 'carry_forward is independently grounded, not inferred from future-payable scope alone.',
      }]
    }
    return [{
      rule_id, field, outcome: 'contradicts',
      reason: 'carry_forward has no independent contract_derived/reviewer_policy grounding — future-payable eligibility scope alone must never establish indefinite survival.',
    }]
  },
}

// F — Explicit, source-derived carry-forward is authoritative.
// Freezes: tests/commercial-semantics/credits/credits.test.ts's "explicit
// carry-forward language resolves to a concrete, contract_derived survival
// policy" case (Growth Credit: "will carry forward and may be applied ...
// until fully used"). Narrower than D/E on purpose — this is the one case
// where the Rulebook has nothing to add beyond agreeing.
const explicitCarryForwardAuthoritative: VerdixRulebookRule = {
  id: 'credit.explicit_carry_forward_authoritative',
  version: 1,
  // Step 6 classification: semantic_interpretation — the one rule in this
  // registry whose job is to affirm/interpret EXPLICIT contract language
  // rather than police an inference. Its match guard requires
  // survivalProvenance === 'contract_derived' already, so it never
  // determines meaning from scratch — it only ever confirms a grounded
  // reading is Rulebook-consistent. Its resulting authority stays
  // contract_derived regardless (see assertAuthorityAllowedForClass in
  // lib/rulebook/rule-class.ts) — this rule contributes interpretation
  // METHOD only, never authority. Matches the existing Step 3 activation
  // (diagnostic only, since no production route consumes Rulebook
  // findings as authority yet).
  ruleClass: 'semantic_interpretation',
  description: 'When the normalized, source-derived rule explicitly establishes carry_forward (contract_derived provenance), the Rulebook agrees with that treatment — it never second-guesses a grounded contract reading.',
  matches: (input) => input.creditApplication?.carryForward === true && input.creditApplication?.survivalProvenance === 'contract_derived',
  evaluate: () => [{
    rule_id: 'credit.explicit_carry_forward_authoritative',
    field: 'creditApplication.carryForward',
    outcome: 'supports',
    expected_value: true,
    reason: 'Source-derived carry-forward is explicit and authoritative — Verdix semantics agree with the confirmed treatment (unused balance carries forward until fully used).',
  }],
}

// G — Contract silence cannot become contract_derived.
// Freezes: tests/commercial-semantics/provenance/provenance.test.ts's
// "contract silence must never become contract_derived" block, extended to
// any provenanced field generically (not just cash_redeemable). Matches
// whenever the context supplies provenancedFields at all; per-field, flags
// the specific case a bug would produce — a field claiming contract_derived
// with no real source-text evidence behind it.
const silenceCannotBecomeContractDerived: VerdixRulebookRule = {
  id: 'provenance.silence_cannot_become_contract_derived',
  version: 1,
  // Step 6 classification: invariant, not anti_inference — this rule
  // polices the PROVENANCE MODEL's own integrity (a contract_derived
  // claim must have real source text behind it), not a specific
  // commercial inference (e.g. "don't derive carry-forward from timing").
  // Violating it is always a bug in how provenance was assigned, never a
  // customer-specific ambiguity — the same structural-guarantee shape as
  // the two execution invariants above. Matches the existing Step 3
  // activation (enforce_invariant, target: promotion).
  ruleClass: 'invariant',
  description: 'A field with no underlying contract source-text evidence must never carry contract_derived provenance — missing contractual evidence cannot become source provenance.',
  matches: (input) => (input.provenancedFields?.length ?? 0) > 0,
  evaluate: (input) => input.provenancedFields!.map((f): RulebookFinding => {
    const rule_id = 'provenance.silence_cannot_become_contract_derived'
    if (f.provenance === 'contract_derived' && !f.sourceTextPresent) {
      return {
        rule_id, field: f.field, outcome: 'contradicts',
        reason: `Field "${f.field}" is marked contract_derived but no source-text evidence is present — contract silence must never become contract_derived.`,
      }
    }
    return {
      rule_id, field: f.field, outcome: 'supports',
      reason: `Field "${f.field}" provenance (${f.provenance ?? 'none'}) is consistent with the available source-text evidence.`,
    }
  }),
}

// H — A Verdix recommendation cannot clear readiness.
// Freezes: tests/commercial-semantics/provenance/provenance.test.ts's
// canonical 4-state matrix ("verdix_recommends + concrete value → still
// unresolved / blocking — AI confidence is not provenance"), and mirrors
// lib/commercial-rule-status.ts's isProvenanceResolved exactly (a
// verdix_recommends-graded field is never treated as resolved here either
// — same single source of truth, read-only).
const verdixRecommendationCannotClearReadiness: VerdixRulebookRule = {
  id: 'provenance.verdix_recommendation_cannot_clear_readiness',
  version: 1,
  // Step 6 classification: invariant, not anti_inference — this rule is
  // unconditional (verdix_recommends NEVER clears readiness, full stop;
  // it does not check whether a specific value was wrongly inferred FROM
  // some other adjacent fact) and directly mirrors isProvenanceResolved()
  // (lib/commercial-rule-status.ts), the single canonical readiness gate
  // — a structural guarantee about the provenance/readiness model itself,
  // not a substantive commercial inference to police. Matches the
  // existing Step 3 activation (enforce_invariant, target: promotion).
  ruleClass: 'invariant',
  description: 'A field graded verdix_recommends is not equivalent to contractual fact or approved reviewer/organization policy — however concrete or well-reasoned the recommended value, it never clears readiness on its own.',
  matches: (input) => (input.provenancedFields ?? []).some(f => f.provenance === 'verdix_recommends'),
  evaluate: (input) => input.provenancedFields!
    .filter(f => f.provenance === 'verdix_recommends')
    .map((f): RulebookFinding => ({
      rule_id: 'provenance.verdix_recommendation_cannot_clear_readiness',
      field: f.field,
      outcome: 'remains_unresolved',
      reason: `Field "${f.field}" is graded verdix_recommends — a Verdix recommendation, however confident, does not clear readiness; only contract_derived or reviewer_policy provenance does.`,
    })),
}

// Code-defined and version-controlled, deliberately not persisted to the
// database (Step 2 spec, item 3) — these are Verdix product semantics, not
// organization/customer data.
export const verdixCommercialRulebook: VerdixRulebookRule[] = [
  minimumFloorNonAdditive,
  allUnitsNonGraduated,
  creditBasisNeApplicationScope,
  nextInvoiceTimingNeCarryForward,
  futurePayableScopeNeIndefiniteSurvival,
  explicitCarryForwardAuthoritative,
  silenceCannotBecomeContractDerived,
  verdixRecommendationCannotClearReadiness,
]
