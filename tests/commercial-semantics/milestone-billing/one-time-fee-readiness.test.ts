// Step 11, items 11 & 14 — Step 10's Cases A-E used as READINESS fixtures
// only (never executable — no extraction call, no billing-writer call).
// Hand-constructed OneTimeFee-shaped objects representing each case's
// INTENDED resolved state, proving:
//   - a case whose amount/trigger semantics ARE fully expressible today
//     (Case A, and the signature portion of Case B) can reach genuine
//     readiness through the Step 11 provenance/confirmation path;
//   - a case whose trigger semantics are NOT expressible (Cases C, D, E,
//     and the acceptance-gated portions of Case B) becomes an explicit
//     execution-capability blocker and must NOT become fully billing-ready
//     via ordinary confirmation — never silently forced into a resolved
//     shape just to make the fixture "pass."
// Also proves (item 14) that the generic Step 8 decision-trace composer
// already represents a resolved one_time_fee.amount field with ZERO code
// changes, and that no fabricated trace is produced for a capability-
// blocked fee.
import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload } from '@/lib/commercial-rule-status'
import { buildOneTimeFeeConfirmation } from '@/lib/one-time-fee'
import { buildCommercialDecisionTrace } from '@/lib/rulebook/decision-trace'
import type { OneTimeFee } from '@/lib/types'

describe('Case A — simple fixed milestone: amount/trigger semantics ARE fully expressible today', () => {
  it('an extracted, ambiguous milestone fee needs BOTH amount and billability confirmed independently before reaching genuine readiness', () => {
    // The realistic post-safety-net shape: requires_confirmation (amount
    // ambiguity) AND billability_provenance: null (evaluated, genuinely
    // unresolved — this fee is not manual_trigger, so the timing decision
    // is load-bearing) — both set by lib/contract-extractor.ts's
    // flagAmbiguousOneTimeFees on a fresh extraction.
    const extracted: OneTimeFee = {
      fee_label: 'Milestone 1 — Discovery & Design', amount: 100000, due_date: null, description: null,
      requires_confirmation: true, unresolved_kind: 'needs_review', billability_provenance: null,
    }
    const amountOnlyConfirmed = buildOneTimeFeeConfirmation(extracted, { confirmAmount: true })
    const stillBlocked = computeCommercialRuleWorkload({ one_time_fees: [amountOnlyConfirmed] }, { total: 0, confirmed: 0 })
    expect(stillBlocked.status).not.toBe('all_commercial_rules_confirmed') // amount alone is not enough (item 2)

    const bothConfirmed = buildOneTimeFeeConfirmation(amountOnlyConfirmed, { confirmBillability: true })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [bothConfirmed] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
    expect(workload.executionBlockers).toEqual([])
  })
})

describe('Case B — advance + milestone balance: mixed readiness within one contract', () => {
  it('the signature-triggered portion resolves normally; the two acceptance-gated portions are capability-blocked, not silently resolved', () => {
    const signaturePortion: OneTimeFee = {
      fee_label: 'Signature milestone (20%)', amount: 100000, due_date: '2026-01-15', description: null,
    } // already unambiguous today — real due_date, no manual_trigger — no confirmation needed at all
    const designAcceptancePortion: OneTimeFee = {
      fee_label: 'Design acceptance milestone (40%)', amount: 200000, due_date: null, manual_trigger: true, description: null,
      requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
    }
    const finalAcceptancePortion: OneTimeFee = {
      fee_label: 'Final acceptance milestone (40%)', amount: 200000, due_date: null, manual_trigger: true, description: null,
      requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
    }
    const workload = computeCommercialRuleWorkload(
      { one_time_fees: [signaturePortion, designAcceptancePortion, finalAcceptancePortion] },
      { total: 0, confirmed: 0 },
    )
    expect(workload.status).toBe('execution_blocked')
    expect(workload.executionBlockers).toHaveLength(2)
    expect(workload.totalToConfirm).toBe(0) // never miscounted as ordinary reviewer decisions
  })
})

describe('Case C — deemed acceptance: trigger semantics unsupported, must not become fully billing-ready', () => {
  it('a capability-blocked fee cannot be resolved via ordinary amount confirmation', () => {
    const fee: OneTimeFee = {
      fee_label: 'Milestone 1', amount: 150000, due_date: null, manual_trigger: true, description: null,
      requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
    }
    expect(() => buildOneTimeFeeConfirmation(fee, { confirmAmount: true })).toThrow(/capability-blocked/)
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('execution_blocked')
  })
})

describe('Case D — change order: signed approval prerequisite unsupported → capability/model blocker', () => {
  it('the base fee resolves normally; the change-order fee is capability-blocked, not treated as an ordinary "amount unknown" review item', () => {
    const baseFee: OneTimeFee = { fee_label: 'Base project fee', amount: 400000, due_date: null, manual_trigger: true, description: null }
    const changeOrderFee: OneTimeFee = {
      fee_label: 'Out-of-scope / Change Order work', amount: 0, due_date: null, manual_trigger: true, description: null,
      requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
    }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [baseFee, changeOrderFee] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('execution_blocked')
    expect(workload.executionBlockers[0]).toMatchObject({ rule_family: 'one_time_fee', missing_capability: 'event_based_billability' })
  })
})

describe('Case E — retention: current model cannot represent retained vs. immediately billable amount → capability/model blocker', () => {
  it('a fee with a stated retention split is capability-blocked as a whole — Verdix cannot split it into billable-now vs. retained', () => {
    const fee: OneTimeFee = {
      fee_label: 'Milestone 2 Fee', amount: 250000, due_date: null, manual_trigger: true, description: null,
      requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
    }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('execution_blocked')
    // The full gross amount (250,000) is what's on the fee — Step 11 does
    // not invent a partial-amount field; this is the model gap itself,
    // documented, not solved (item 8: propose for Step 12).
    expect(fee.amount).toBe(250000)
  })
})

describe('decision trace already generalizes to one_time_fee.amount, unmodified (item 14)', () => {
  it('a resolved fee (contract_derived amount) produces a real, well-formed trace with the generic Step 8 composer — zero new domain-context wiring', () => {
    const trace = buildCommercialDecisionTrace({
      field: 'one_time_fee.amount',
      currentValue: 100000,
      currentProvenance: 'contract_derived',
      domainContext: {}, // no Global Rulebook domain slice exists for one_time_fee — and none is needed for this to work
      organizationId: 'step11-exploration-org',
      organizationRules: [],
      organizationMatchContext: {},
      asOf: new Date('2026-08-25T00:00:00.000Z'),
    })
    expect(trace.final).toEqual({ value: 100000, authority: 'contract_derived', method: 'existing_normalized_state' })
    expect(trace.execution.readinessBlocking).toBe(false)
    // Organization Rulebook correctly never even considers this field —
    // it's not in PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST (item 15).
    expect(trace.organizationRulebook).toEqual({ considered: false, matchedRuleIds: [], status: 'not_applicable' })
    expect(trace.traceMode).toBe('reconstructed_snapshot')
  })

  it('an unresolved (needs_review) fee produces a correctly-unresolved, readiness-blocking trace', () => {
    const trace = buildCommercialDecisionTrace({
      field: 'one_time_fee.amount',
      currentValue: 100000,
      currentProvenance: null,
      domainContext: {},
      organizationId: 'step11-exploration-org',
      organizationRules: [],
      organizationMatchContext: {},
      asOf: new Date('2026-08-25T00:00:00.000Z'),
    })
    expect(trace.final).toBeUndefined()
    expect(trace.execution.readinessBlocking).toBe(true)
  })

  // Capability-blocked fees deliberately have NO decision trace at all —
  // there is no currentProvenance/value pair to trace (the concept itself,
  // not just its resolution, is unrepresented). Calling
  // buildCommercialDecisionTrace for one would require inventing a
  // field/value that doesn't correspond to anything real — exactly what
  // item 14 forbids ("do not fabricate generic trace fields"). No test
  // calls it for Cases C/D/E's fees; their absence of a trace call IS the
  // "trace unavailable" statement, documented here and in lib/rulebook/
  // MILESTONE_BILLING_FINDINGS.md rather than represented as a runtime value.
})
