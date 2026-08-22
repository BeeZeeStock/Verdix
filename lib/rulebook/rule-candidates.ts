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

// Step 10 — the first candidate proposed FROM a new contract family
// (project/milestone billing) rather than a service-credit refinement.
// Reaches VALIDATED (real positive + counterexample evidence, both from
// live baseline runs against the current, unmodified production model —
// see fixture-registry.ts's two milestone entries) but is deliberately
// NOT promoted further — see this record's own rationale for why.
//
//   OBSERVED  — Step 10's synthetic milestone corpus Case C (an explicit
//               10-business-day deemed-acceptance review window) exposed
//               that "delivery" and "acceptance" are two, genuinely
//               distinct commercial events for project billing, exactly
//               the way "next invoice timing" and "carry-forward" are two
//               distinct questions for service credits (credit.next_
//               invoice_timing_ne_carry_forward, already active).
//   CANDIDATE — generalized beyond Case C alone: "delivery of a milestone
//               deliverable does not, by itself, establish that it has
//               been accepted" — reusable across any future project-
//               billing clause with this shape.
//   VALIDATED — Case C (positive: real baseline extraction preserves the
//               distinction, never collapsing it) and a deliberately
//               constructed counterexample, Case G ("delivery shall
//               constitute acceptance") — proving the principle means "do
//               not INFER acceptance from delivery when the contract is
//               silent," never "delivery can never establish acceptance."
//               Both fixtures are real, live Sonnet-via-Bedrock extraction
//               runs against the current, unmodified production model
//               (contract-extractor.ts) — not fabricated expectations.
//
// Stops here deliberately (Step 10 item 9: "Stop before approved / active
// Global Rulebook entry unless separately reviewed"). More importantly:
// this candidate cannot honestly progress to APPROVED/ACTIVE yet even if
// reviewed, because there is no normalized field for it to constrain.
// lib/rulebook rules operate on CommercialSemanticContext slices built
// from REAL persisted structures (CreditApplicationRule, MinimumCommitment,
// ...) — milestone acceptance has no such structure today. Both Case C and
// Case G extract to the STRUCTURALLY IDENTICAL shape (OneTimeFee with
// manual_trigger: true and the distinction folded into free-text
// `description`), which is itself the semantic-model gap this candidate's
// evidence documents (see lib/rulebook/MILESTONE_BILLING_FINDINGS.md).
// Activating this as a Global Rulebook rule before that gap is closed
// would mean writing a rule with nothing real to evaluate — exactly what
// Step 9's governance workflow exists to prevent.
export const MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE: VerdixRuleCandidate = {
  id: 'candidate.milestone.delivery_ne_acceptance',
  proposedRuleId: 'milestone.delivery_ne_acceptance',
  proposedClass: 'anti_inference',
  status: 'validated',
  principle:
    'Delivery of a milestone or project deliverable does not, by itself, establish that the deliverable has ' +
    'been accepted. Acceptance — express, or deemed after a stated review period — is a distinct commercial ' +
    'event from delivery, and must not be inferred from delivery alone unless the contract explicitly equates ' +
    'the two.',
  origin: 'verdix_synthetic_test',
  evidenceFixtureIds: ['milestone.deemed_acceptance_window.acceptance_unresolved_structurally'],
  counterexampleFixtureIds: ['milestone.delivery_constitutes_acceptance.explicit_collapse'],
  rationale:
    'Step 10\'s synthetic milestone/project-billing corpus ran the current, unmodified production extraction ' +
    'model (Sonnet via Bedrock, contract-extractor.ts, no prompt changes) against a deemed-acceptance clause ' +
    '(10 business days to reject, else deemed accepted) and a deliberately opposite clause (delivery explicitly ' +
    'constitutes acceptance, no review). Both correctly avoided over-inference in either direction — neither the ' +
    'deemed-acceptance case invented a false-negative "not yet accepted" block, nor did the explicit-collapse ' +
    'case wrongly withhold billability once delivery is confirmed. This validates the PRINCIPLE. It does NOT yet ' +
    'validate that Verdix can ENFORCE it: both cases currently extract to the same OneTimeFee shape ' +
    '(manual_trigger: true, distinction only in free-text description) because no normalized acceptance-event ' +
    'field exists. Promotion to active is blocked on that semantic-model gap, not on evidence quality — see ' +
    'lib/rulebook/MILESTONE_BILLING_FINDINGS.md.',
}

// Step 10 — four further principles item 8 named as candidates to
// investigate. Each stays at OBSERVED (not CANDIDATE, not VALIDATED) —
// evidence exists that the underlying commercial distinction is real (see
// each rationale), but none has evidence framed as a reusable,
// FIXTURE-testable principle yet, and — same root cause as the delivery/
// acceptance candidate above — none has a normalized field to eventually
// constrain. Recording them as OBSERVED (rather than silently discarding
// them, and rather than inflating them to CANDIDATE/VALIDATED on weaker
// grounds) is itself the correct governance outcome per Step 9/10: a
// real, repeated failure signal is worth tracking even when it isn't
// promotable yet.
export const MILESTONE_RETENTION_NE_DISCOUNT_OBSERVATION: VerdixRuleCandidate = {
  id: 'candidate.milestone.retention_ne_discount',
  proposedRuleId: 'milestone.retention_ne_discount',
  proposedClass: 'anti_inference',
  status: 'observed',
  principle:
    'A retention/holdback (a portion of an otherwise-earned milestone fee withheld until a later release ' +
    'trigger) is not the same commercial concept as a discount (a permanent reduction to the price itself).',
  origin: 'verdix_synthetic_test',
  evidenceFixtureIds: [],
  counterexampleFixtureIds: [],
  rationale:
    'Step 10 Case E (10% of each milestone invoice retained until final project acceptance) extracted with zero ' +
    'discounts and the retention correctly described, in the model\'s own words, as "a contractual payment ' +
    'deferral," not a penalty or price reduction — a single clean, non-adversarial observation, not yet an ' +
    'adversarial positive/counterexample PAIR. More importantly, ContractTerms has no normalized "retention" ' +
    'field at all (the 90/10 split is only ever prose inside OneTimeFee.description) — there is nothing for an ' +
    'anti_inference rule to constrain yet. Recorded as OBSERVED for future reference, not force-fit to CANDIDATE.',
}

export const MILESTONE_ENTITLEMENT_NE_INVOICEABILITY_OBSERVATION: VerdixRuleCandidate = {
  id: 'candidate.milestone.entitlement_ne_invoiceability',
  proposedRuleId: 'milestone.entitlement_ne_invoiceability',
  proposedClass: 'anti_inference',
  status: 'observed',
  principle:
    'A milestone being contractually earned (deliverable complete, fee entitlement accrued) does not by itself ' +
    'mean the full amount is immediately invoiceable — acceptance gating and retention can each independently ' +
    'reduce what is currently payable versus what has been earned.',
  origin: 'verdix_synthetic_test',
  evidenceFixtureIds: [],
  counterexampleFixtureIds: [],
  rationale:
    'The clearest general finding across the whole Step 10 corpus (Cases A, C, E) — see lib/rulebook/' +
    'MILESTONE_BILLING_FINDINGS.md\'s "entitlement vs. invoiceability" section. Today\'s model only expresses ' +
    'this crudely, as OneTimeFee.manual_trigger (an all-or-nothing boolean gate) — there is no field for a ' +
    'PARTIAL entitlement/invoiceable split (Case E\'s 90/10 retention) or for WHICH kind of gate applies ' +
    '(acceptance vs. bilateral change-order approval vs. plain delivery confirmation). This is the single ' +
    'highest-value semantic-model gap this step found; recorded as OBSERVED because a genuinely reusable, ' +
    'fixture-testable principle needs that field to exist first, not because the underlying distinction is in ' +
    'any doubt.',
}

export const MILESTONE_CHANGE_ORDER_APPROVAL_OBSERVATION: VerdixRuleCandidate = {
  id: 'candidate.milestone.change_order_approval_ne_delivery_confirmation',
  proposedRuleId: 'milestone.change_order_approval_ne_delivery_confirmation',
  proposedClass: 'anti_inference',
  status: 'observed',
  principle:
    'A contractual requirement for a signed, bilateral Change Order is a categorically different billability ' +
    'gate from ordinary unilateral delivery/service confirmation — work performed without the required signed ' +
    'approval does not become billable merely because the work happened.',
  origin: 'verdix_synthetic_test',
  evidenceFixtureIds: [],
  counterexampleFixtureIds: [],
  rationale:
    'Step 10 Case D extracted the change-order fee as a second OneTimeFee (amount: 0, manual_trigger: true) — ' +
    'a reasonable REUSE of the existing "amount unknown at contract time" convention, but one that collapses ' +
    'a bilateral-signature legal prerequisite into the SAME manual_trigger boolean as "an ops person confirms ' +
    'hours were delivered." No normalized field distinguishes the two gate TYPES today. Recorded as OBSERVED — ' +
    'one clean extraction result, not an adversarial pair, and no field to constrain yet.',
}

export const MILESTONE_PERCENTAGE_BASIS_NE_PAYMENT_TIMING_OBSERVATION: VerdixRuleCandidate = {
  id: 'candidate.milestone.percentage_basis_ne_payment_timing',
  proposedRuleId: 'milestone.percentage_basis_ne_payment_timing',
  proposedClass: 'anti_inference',
  status: 'observed',
  principle:
    'A milestone fee expressed as a percentage of the total project fee defines the CALCULATION BASIS only — ' +
    'it does not itself establish WHEN that amount becomes payable; timing is a separate, independently-stated ' +
    'question (signature, deliverable acceptance, final acceptance, ...).',
  origin: 'verdix_synthetic_test',
  evidenceFixtureIds: [],
  counterexampleFixtureIds: [],
  rationale:
    'Step 10 Case B (20%/40%/40% of a stated total project fee) extracted each milestone as an absolute SEK ' +
    'amount, correctly paired with its own distinct timing trigger (signature / design acceptance / final ' +
    'acceptance) per line item — so at the EXTRACTION-NOTES level the model did not conflate basis and timing. ' +
    'But the percentage-of-total relationship itself is LOST at the OneTimeFee level (amount is a flat number, ' +
    'not a computed_from_total_pct + basis_amount pair) — structurally identical in shape to credit.basis_ne_' +
    'application_scope (already active) but for a different field pairing (percentage basis vs. payment timing, ' +
    'not calculation basis vs. application scope) and a different field that does not exist yet. Recorded as ' +
    'OBSERVED — the risk of a future extraction error here (e.g. re-deriving a stale absolute amount after a ' +
    'renegotiated total fee) is real, but there is no field to validate a rule against yet.',
}

// The full candidate registry — add a new entry here for every future
// proposed rule, regardless of its eventual status (rejected candidates
// stay in the registry as a record of what was considered).
export const VERDIX_RULE_CANDIDATES: VerdixRuleCandidate[] = [
  CASH_REDEEMABILITY_CANDIDATE,
  MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE,
  MILESTONE_RETENTION_NE_DISCOUNT_OBSERVATION,
  MILESTONE_ENTITLEMENT_NE_INVOICEABILITY_OBSERVATION,
  MILESTONE_CHANGE_ORDER_APPROVAL_OBSERVATION,
  MILESTONE_PERCENTAGE_BASIS_NE_PAYMENT_TIMING_OBSERVATION,
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
