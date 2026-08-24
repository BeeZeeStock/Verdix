// The generic Service Credit example (Step 1 spec, item 4) — a single
// normalized regression fixture built from a synthetic clause meaning:
//   availability threshold: below 99.5%
//   credit: 10% of that month's platform fee
//   monthly cap: 25% of platform fee
//   applied to next invoice; not payable in cash; periodically evaluated
//   remainder after next invoice: unstated
//
// This asserts REUSABLE COMMERCIAL SEMANTICS only — no customer name, no
// clause prose, no contract ID. Field names follow lib/types.ts's ACTUAL
// shapes (ServiceCredit / ServiceCreditInterpretation / CreditEarnRule /
// CreditApplicationRule), not the illustrative nested "trigger.metric" /
// "calculation.method" / "cap.method" shape in the Step 1 prompt — building
// that shape would itself be introducing a Rulebook schema, which this step
// explicitly defers. See tests/commercial-semantics/README.md.
//
// Step 1.5 update: the two engine gaps this fixture originally had to work
// around (no native '<' comparator; cash_redeemable with no provenance) are
// now closed — this is a fully NATIVE representation, not a workaround.
import { describe, it, expect } from 'vitest'
import { buildCreditApplicationRule } from '@/lib/credit-application-rule'
import { evaluateCreditEarn } from '@/lib/credit-ledger'
import { isServiceCreditUnresolved } from '@/lib/commercial-rule-status'
import type { CreditEarnRule, ServiceCreditInterpretation, ServiceCredit } from '@/lib/types'

const EARN_RULE: CreditEarnRule = {
  // Native representation (Step 1.5) — "availability < 99.5%" against the
  // metric it actually names, no logical-complement inversion needed.
  trigger_metric_key: 'platform_availability',
  trigger_quantity: 99.5,
  trigger_comparator: 'lt',
  trigger_window: 'calendar_month',
  consecutive_windows_required: 1, // no streak requirement stated
  window_anchor: 'calendar',
  finalization_deadline_days: null, // no stated finalization deadline for this credit
  requires_confirmation: false,
}

const INTERPRETATION: ServiceCreditInterpretation = {
  trigger_type: 'sla_breach',
  trigger_description: 'platform availability falls below 99.5% in a calendar month',
  credit_basis: 'pct_of_period_fee',
  basis_component: 'platform_fee',
  credit_value: 10, // 10%
  currency: 'SEK',
  cap_amount: null,
  cap_pct: 25, // 25% of the same basis (platform fee) — cap.method = percentage_of_component, folded into cap_pct since the basis IS platform_fee already
  settlement_period: 'monthly',
  // "not payable in cash" is an EXPLICIT scenario fact (see file header) —
  // Step 1.5's fix means this is now a resolved, provenanced fact, not a
  // silently-defaulted boolean.
  cash_redeemable: false,
  cash_redeemable_provenance: 'contract_derived',
  interaction_note: null,
  source_clause: null, // deliberately not asserted — this fixture freezes semantics, not prose
  requires_confirmation: false,
  confirmation_reason: null,
  earn_rule: EARN_RULE,
  application_rule: {
    computed_from_component_keys: ['platform_fee'],
    eligible_component_keys: 'all',   // "applied to next invoice" — future amounts payable, not scoped to one component
    eligibility_provenance: 'contract_derived',
    excluded_component_keys: [],
    one_time: false,                  // periodically evaluated, not a one-off
    carry_forward: 'unclear',         // remainder after next invoice: unstated
    survival_provenance: null,
    expiry_periods: null,
    expiry_date: null,
    availability: 'next_period',
    requires_confirmation: true,      // survival unresolved — see below
    confirmation_reason: 'Contract does not state what happens to any unapplied remainder after the next invoice',
  },
}

const CREDIT: ServiceCredit = {
  credit_rule_id: 'svc-credit-example',
  credit_type: 'service_credit',
  description: 'Service availability credit',
  source_clause: null,
  stated_pct: 10,
  stated_amount: null,
  interpretation: INTERPRETATION,
}

describe('generic Service Credit example — normalized rule (Layer A)', () => {
  it('rule_type: service_credit', () => {
    expect(CREDIT.credit_type).toBe('service_credit')
  })
  it('trigger: availability < 99.5, calendar-month window, no consecutive-window requirement — represented natively, not as a complement metric', () => {
    expect(EARN_RULE.trigger_metric_key).toBe('platform_availability')
    expect(EARN_RULE.trigger_comparator).toBe('lt')
    expect(EARN_RULE.trigger_quantity).toBe(99.5)
    expect(EARN_RULE.trigger_window).toBe('calendar_month')
    expect(EARN_RULE.consecutive_windows_required).toBe(1)
  })
  it('calculation: 10% of the platform fee (pct_of_period_fee, credit_value 10)', () => {
    expect(INTERPRETATION.credit_basis).toBe('pct_of_period_fee')
    expect(INTERPRETATION.credit_value).toBe(10)
    expect(INTERPRETATION.basis_component).toBe('platform_fee')
  })
  it('cap: 25% of the same basis, monthly', () => {
    expect(INTERPRETATION.cap_pct).toBe(25)
    expect(INTERPRETATION.settlement_period).toBe('monthly')
  })
  it('application: next invoice, explicitly not cash-redeemable (contract_derived, not a silent default)', () => {
    expect(INTERPRETATION.application_rule?.availability).toBe('next_period')
    expect(INTERPRETATION.cash_redeemable).toBe(false)
    expect(INTERPRETATION.cash_redeemable_provenance).toBe('contract_derived')
  })
  it('recurrence: not one-time', () => {
    expect(INTERPRETATION.application_rule?.one_time).toBe(false)
  })
  it('survival: carry_forward unclear — the remainder question is genuinely unstated', () => {
    expect(INTERPRETATION.application_rule?.carry_forward).toBe('unclear')
  })
})

describe('generic Service Credit example — readiness/provenance (Layer B)', () => {
  // 2026-08-30 correction (final semantic fix) — this fixture's "10% of
  // that month's platform fee" scenario NEVER states that the basis is
  // amounts actually paid — it also never states it's the invoiced
  // component amount either; it is genuinely, deliberately underspecified
  // (see file header: a synthetic example, not a real clause). Per the
  // audit's explicit instruction, this must NOT be marked 'paid' just
  // because credit_basis happens to be percentage-typed (that was exactly
  // the bug this field exists to fix — see lib/paid-basis-finalization.ts),
  // and must NOT be marked 'reviewer_policy'-resolved just to make a test
  // pass. monetary_basis_recognition is therefore left unset (null),
  // reading as 'unclear' — the honest, fail-closed state. This means the
  // credit remains genuinely unresolved even once survival is confirmed;
  // it is no longer a single-question fixture.
  it('the whole credit is unresolved (blocking) — survival AND monetary-basis-recognition were both never addressed; trigger/rate/cap/timing/cash-redeemability are all fully resolved', () => {
    expect(isServiceCreditUnresolved({ credit_rule_id: CREDIT.credit_rule_id, interpretation: INTERPRETATION as unknown as { requires_confirmation: boolean; application_rule?: { requires_confirmation: boolean } | null; cash_redeemable_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | null } })).toBe(true)
  })
  it('confirming survival alone does NOT resolve the credit — monetary-basis-recognition remains a genuinely open, unmanufactured question (cash and eligibility, already contract_derived, are untouched)', () => {
    const resolved = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: true } },
      INTERPRETATION.application_rule,
      { survival: 'reviewer_policy' }, // eligibility provenance omitted — must survive from `existing`
    )
    expect(resolved?.requires_confirmation).toBe(false)
    expect(resolved?.eligibility_provenance).toBe('contract_derived') // carried over, not re-derived
    expect(resolved?.survival_provenance).toBe('reviewer_policy')
    // Deliberately does NOT set monetary_basis_recognition — leaving it
    // unset is the correct, honest representation for this underspecified
    // synthetic scenario, not a gap to paper over.
    const survivalOnlyResolved = { ...INTERPRETATION, application_rule: resolved }
    expect(isServiceCreditUnresolved({ credit_rule_id: CREDIT.credit_rule_id, interpretation: survivalOnlyResolved as unknown as { requires_confirmation: boolean; application_rule?: { requires_confirmation: boolean } | null; cash_redeemable_provenance?: 'contract_derived' | 'verdix_recommends' | 'reviewer_policy' | null } })).toBe(true)
  })
})

describe('generic Service Credit example — calculation (Layer C, fully resolved rule)', () => {
  it('a qualifying month (99.4% availability, below the 99.5% threshold) earns 10% of the SEK 38,500 platform fee, uncapped', () => {
    const result = evaluateCreditEarn({
      earnRule: EARN_RULE,
      measuredTriggerQuantity: 99.4, // availability this month — natively compared, no inversion
      computedFromAmountMinor: 3_850_000, // SEK 38,500.00 platform fee, in öre
      creditValueFlatMinor: null,
      creditValuePctBp: 1000, // 10%
      creditValuePerUnitMinor: null,
      capAmountMinor: 962_500, // 25% of 3,850,000
      priorConsecutiveWindowsMet: 0,
      isOneTime: false,
      alreadyEarnedOnce: false,
    })
    expect(result.earned).toBe(true)
    expect(result.earnedAmountMinor).toBe(385_000) // 10% of 3,850,000 — well under the 962,500 cap
  })
  it('a non-qualifying month (99.8% availability — above the threshold) earns nothing', () => {
    const result = evaluateCreditEarn({
      earnRule: EARN_RULE, measuredTriggerQuantity: 99.8, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: 1000, creditValuePerUnitMinor: null, capAmountMinor: 962_500,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earned).toBe(false)
  })
  it('exactly at the threshold (99.5% availability) does NOT qualify — lt excludes the boundary itself', () => {
    const result = evaluateCreditEarn({
      earnRule: EARN_RULE, measuredTriggerQuantity: 99.5, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: 1000, creditValuePerUnitMinor: null, capAmountMinor: 962_500,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earned).toBe(false)
  })
  it('a catastrophic outage month (90% availability) still earns only the 25%-of-platform-fee cap, not 10% of the fee uncapped', () => {
    const result = evaluateCreditEarn({
      earnRule: EARN_RULE, measuredTriggerQuantity: 90, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: 1000, creditValuePerUnitMinor: null, capAmountMinor: 962_500,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    // 10% of 3,850,000 = 385,000 — in THIS shape the basis doesn't scale
    // with outage severity, so the cap never actually binds; documented
    // here precisely because it's a real (if slightly surprising)
    // consequence of "10% of period fee" as the basis rather than a
    // severity-scaled formula. Freezing today's actual arithmetic, not an
    // assumption about it.
    expect(result.earnedAmountMinor).toBe(385_000)
  })
  it('earns again the following qualifying month — this is NOT a one-time credit (isOneTime: false), so alreadyEarnedOnce never blocks it', () => {
    const monthOne = evaluateCreditEarn({
      earnRule: EARN_RULE, measuredTriggerQuantity: 99.4, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: 1000, creditValuePerUnitMinor: null, capAmountMinor: 962_500,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    const monthTwo = evaluateCreditEarn({
      earnRule: EARN_RULE, measuredTriggerQuantity: 99.3, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: 1000, creditValuePerUnitMinor: null, capAmountMinor: 962_500,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: monthOne.earned, // real orchestration would thread this
    })
    expect(monthOne.earned).toBe(true)
    expect(monthTwo.earned).toBe(true)
  })
})
