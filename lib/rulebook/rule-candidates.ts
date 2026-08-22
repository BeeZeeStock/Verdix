// Verdix Global Rulebook — candidate registry (Step 9).
//
// The actual, code-defined, version-controlled record of every rule
// Verdix has proposed for the Global Rulebook — plain data, reviewed and
// shipped exactly like lib/rulebook/rules.ts itself. Never written to by
// runtime code (no function anywhere sets `status: 'approved'` and pushes
// a rule into verdixCommercialRulebook — see candidate-validation.ts's own
// header comment); every entry here, and every status change on it, is a
// deliberate, reviewed edit a human made in a commit.
import type { VerdixRuleCandidate } from './candidate'

// The first governance example (Step 9, item 6) — a RETROSPECTIVE record
// for a rule that was already promoted (Step 7's amendment,
// credit.application_scope_ne_cash_redeemability, lib/rulebook/rules.ts).
// This record does not change that rule; it exists to document WHY it
// exists, walking through the lifecycle this step formalizes:
//
//   OBSERVED  — Step 7's original synthetic regression corpus (Case D,
//               "explicit calculation + application scope") exposed a
//               real over-inference failure mode during a live Sonnet
//               comparison: application-scope language ("may only be
//               applied against future transaction-processing fees") was
//               getting conflated with an unstated cash-redemption
//               prohibition. The four EXISTING credit rules' guidance
//               happened to correct it as a side effect, but nothing
//               explicitly said WHY that correction was right.
//   CANDIDATE — the pattern was generalized beyond that one fixture: "a
//               restriction on where a credit may be applied does not, by
//               itself, establish whether it may be redeemed in cash, in
//               EITHER direction" — genuinely reusable across any future
//               credit/rebate clause with the same shape, not specific to
//               Case D's exact wording.
//   VALIDATED — three synthetic fixtures were written and run against the
//               real production model (Sonnet, via Bedrock — see this
//               candidate's evidenceFixtureIds/counterexampleFixtureIds):
//               application-restriction-only (cash must stay unresolved),
//               explicit-no-cash (resolves false, contract_derived), and
//               explicit-cash-allowed (resolves true, contract_derived).
//               All three passed, live, before promotion.
//   APPROVED  — accepted as durable Verdix product doctrine rather than
//               continuing to rely on the other four rules' guidance to
//               correct this indirectly (the user's own words at the
//               time: "the new explicit rule should become the durable
//               product doctrine").
//   ACTIVE    — lib/rulebook/rules.ts's creditApplicationScopeNeCashRedeem
//               ability, ruleClass: 'anti_inference', shipped in the Step
//               7 amendment commit. See activeRuleId below.
export const CASH_REDEEMABILITY_CANDIDATE: VerdixRuleCandidate = {
  id: 'candidate.credit.application_scope_ne_cash_redeemability',
  proposedRuleId: 'credit.application_scope_ne_cash_redeemability',
  proposedClass: 'anti_inference',
  status: 'approved',
  principle:
    'Restrictions on where a credit or rebate may be applied on an invoice do not by themselves establish ' +
    'whether the credit may or may not be redeemed or paid in cash. Cash redeemability must remain unresolved ' +
    'unless the source explicitly addresses cash payment/redemption.',
  origin: 'verdix_synthetic_test',
  evidenceFixtureIds: ['credit.application_scope_only.cash_unresolved'],
  counterexampleFixtureIds: [
    'credit.application_scope_explicit_no_cash',
    'credit.application_scope_explicit_cash_allowed',
  ],
  rationale:
    'A live Sonnet A/B comparison during Step 7\'s original development (TEST-PAY-002-adjacent synthetic ' +
    'clauses, not customer data) found the model conflating an explicit invoice-application restriction with ' +
    'an unstated cash-redemption prohibition. The four pre-existing credit rules\' guidance happened to correct ' +
    'this as an indirect side effect; the Step 7 amendment promoted the underlying principle into its own ' +
    'explicit, durable anti_inference rule rather than continuing to rely on that indirect correction. ' +
    'Re-verified live against the production model (Sonnet via Bedrock) after promotion, against the original ' +
    'clause plus two new explicit-cash clauses — all three produced the expected result.',
  proposedAIGuidance:
    'Invoice application scope and cash redeemability are independent. Language restricting a credit to ' +
    'particular invoice components or future invoices does not establish that cash payment is prohibited or ' +
    'allowed. Resolve cash redeemability only from explicit source language.',
  activeRuleId: 'credit.application_scope_ne_cash_redeemability',
}

// The full candidate registry — add a new entry here for every future
// proposed rule, regardless of its eventual status (rejected candidates
// stay in the registry as a record of what was considered).
export const VERDIX_RULE_CANDIDATES: VerdixRuleCandidate[] = [
  CASH_REDEEMABILITY_CANDIDATE,
]

// Step 9 final amendment — the eight rules that existed BEFORE the
// candidate-governance workflow itself existed. auditVerdixRulebook()
// (rulebook-audit.ts) requires every active Global Rulebook rule to have
// EITHER an approved governance candidate pointing at it OR to appear in
// this exact list — closing the "add a rule straight to rules.ts, skip
// the candidate process entirely" bypass. These eight are grandfathered
// because Verdix does not actually have a retrospective candidate history
// for them (they predate Step 9) — manufacturing one after the fact would
// misrepresent evidence that was never actually gathered through this
// process, which is worse than honestly saying "pre-governance."
//
// THIS LIST IS FROZEN. New Global Rulebook entries must NEVER be added
// here — that would turn grandfathering into a permanent escape hatch
// from the candidate/validation/approval workflow this step exists to
// require. The only legitimate path for a new rule is: candidate ->
// validation -> approval -> active Rulebook entry (see rules.ts's own
// ninth entry, credit.application_scope_ne_cash_redeemability, and its
// real candidate record above — CASH_REDEEMABILITY_CANDIDATE — as proof
// that path works and is not itself grandfathered). Enforced by
// tests/commercial-semantics/rulebook/rulebook-audit.test.ts's exact
// content/count assertion, which fails the moment this array changes.
export const GRANDFATHERED_VERDIX_RULE_IDS = [
  'minimum.floor.non_additive',
  'pricing.all_units.non_graduated',
  'credit.basis_ne_application_scope',
  'credit.next_invoice_timing_ne_carry_forward',
  'credit.future_payable_scope_ne_indefinite_survival',
  'credit.explicit_carry_forward_authoritative',
  'provenance.silence_cannot_become_contract_derived',
  'provenance.verdix_recommendation_cannot_clear_readiness',
] as const
