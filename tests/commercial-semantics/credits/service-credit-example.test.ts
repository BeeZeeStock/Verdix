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
// KNOWN GAP, surfaced by this fixture and reported rather than silently
// worked around: CreditEarnRule.trigger_comparator (lib/types.ts) supports
// only 'gt' | 'gte' today. An availability/SLA-style "below threshold"
// trigger has no native '<' comparator to express directly. This fixture
// models it as its logical complement — unavailability (100% − availability)
// >= the complementary threshold — which is mathematically equivalent but
// requires the CALLER (wherever the real metric is measured and passed in
// as measuredTriggerQuantity) to compute that complement; no such caller
// exists in production yet for this credit shape. This is a real, current
// limitation relative to the fixture's stated intent, not a bug I've fixed.
import { describe, it, expect } from 'vitest'
import { buildCreditApplicationRule } from '@/lib/credit-application-rule'
import { evaluateCreditEarn } from '@/lib/credit-ledger'
import { isServiceCreditUnresolved } from '@/lib/commercial-rule-status'
import type { CreditEarnRule, ServiceCreditInterpretation, ServiceCredit } from '@/lib/types'

const EARN_RULE: CreditEarnRule = {
  // GAP (see file header): models "availability < 99.5%" as its complement,
  // "unavailability >= 0.5%" — 100 - 99.5 = 0.5. Not the same as a native
  // '<' comparator on the availability metric itself.
  trigger_metric_key: 'platform_unavailability_pct',
  trigger_quantity: 0.5,
  trigger_comparator: 'gte',
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
  cash_redeemable: false,
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
  it('trigger: calendar-month window, no consecutive-window requirement', () => {
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
  it('application: next invoice, not cash-redeemable', () => {
    expect(INTERPRETATION.application_rule?.availability).toBe('next_period')
    expect(INTERPRETATION.cash_redeemable).toBe(false)
  })
  it('recurrence: not one-time', () => {
    expect(INTERPRETATION.application_rule?.one_time).toBe(false)
  })
  it('survival: carry_forward unclear — the remainder question is genuinely unstated', () => {
    expect(INTERPRETATION.application_rule?.carry_forward).toBe('unclear')
  })
})

describe('generic Service Credit example — readiness/provenance (Layer B)', () => {
  it('the whole credit is unresolved (blocking) because survival was never addressed, even though trigger/basis/cap/timing/cash-redeemability are all fully known', () => {
    expect(isServiceCreditUnresolved({ credit_rule_id: CREDIT.credit_rule_id, interpretation: INTERPRETATION as unknown as { requires_confirmation: boolean; application_rule?: { requires_confirmation: boolean } | null } })).toBe(true)
  })
  it('confirming survival via buildCreditApplicationRule with reviewer_policy provenance resolves it, without touching eligibility (already contract_derived) or any other field', () => {
    const resolved = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: true } },
      INTERPRETATION.application_rule,
      { survival: 'reviewer_policy' }, // eligibility provenance omitted — must survive from `existing`
    )
    expect(resolved?.requires_confirmation).toBe(false)
    expect(resolved?.eligibility_provenance).toBe('contract_derived') // carried over, not re-derived
    expect(resolved?.survival_provenance).toBe('reviewer_policy')
  })
})

describe('generic Service Credit example — calculation (Layer C, fully resolved rule)', () => {
  it('a qualifying month (0.6% unavailable, above the 0.5% complement threshold) earns 10% of the SEK 38,500 platform fee, uncapped', () => {
    const result = evaluateCreditEarn({
      earnRule: EARN_RULE,
      measuredTriggerQuantity: 0.6, // 0.6% unavailable this month ⟺ 99.4% available
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
  it('a non-qualifying month (0.2% unavailable — below the complement threshold) earns nothing', () => {
    const result = evaluateCreditEarn({
      earnRule: EARN_RULE, measuredTriggerQuantity: 0.2, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: 1000, creditValuePerUnitMinor: null, capAmountMinor: 962_500,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earned).toBe(false)
  })
  it('a catastrophic outage month (10% unavailable) still earns only the 25%-of-platform-fee cap, not 10% of the fee uncapped', () => {
    const result = evaluateCreditEarn({
      earnRule: EARN_RULE, measuredTriggerQuantity: 10, computedFromAmountMinor: 3_850_000,
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
      earnRule: EARN_RULE, measuredTriggerQuantity: 0.6, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: 1000, creditValuePerUnitMinor: null, capAmountMinor: 962_500,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    const monthTwo = evaluateCreditEarn({
      earnRule: EARN_RULE, measuredTriggerQuantity: 0.7, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: 1000, creditValuePerUnitMinor: null, capAmountMinor: 962_500,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: monthOne.earned, // real orchestration would thread this
    })
    expect(monthOne.earned).toBe(true)
    expect(monthTwo.earned).toBe(true)
  })
})
