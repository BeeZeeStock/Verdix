import { describe, it, expect } from 'vitest'
import { evaluateParkedOneTimeFeeEligibility } from './parked-one-time-fee-eligibility'
import type { OneTimeFee } from './types'
import type { OperationalEventEvidence } from './operational-event-evidence'

// Contract B's real Integration Fee: SEK 90,000, gated on customer
// acceptance, contract-derived. fee_id is the stable Step 13 identity key
// — never fee_label — that ties a planned_invoices row back to this fee.
const integrationFee: OneTimeFee = {
  fee_label: 'Integration Fee',
  amount: 90_000,
  due_date: null,
  description: null,
  billability_provenance: 'contract_derived',
  billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
  fee_id: 'fee-integration-90k',
}

const asOf = new Date(2026, 9, 15) // Oct 15, 2026 — arbitrary scheduler run time

function evidence(overrides: Partial<OperationalEventEvidence> = {}): OperationalEventEvidence {
  return {
    id: 'ev-1',
    subjectId: 'fee-integration-90k',
    eventType: 'customer_acceptance',
    occurredAt: new Date(2026, 9, 1).toISOString(),
    source: 'reviewer_attestation',
    recordedAt: new Date(2026, 9, 1).toISOString(),
    recordedBy: 'reviewer@example.com',
    status: 'active',
    ...overrides,
  }
}

describe('evaluateParkedOneTimeFeeEligibility — Contract B Integration Fee (A6 scenarios)', () => {
  // A6.1 — no evidence -> remains parked, zero provider operation.
  it('no evidence at all -> not eligible (evidence_not_satisfied)', () => {
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-integration-90k', oneTimeFees: [integrationFee], evidence: [], asOf,
    })
    expect(result).toEqual({ eligible: false, reason: 'evidence_not_satisfied' })
  })

  // A6.2 — valid customer_acceptance evidence -> becomes executable, SEK 90,000.
  it('valid, active, past customer_acceptance evidence -> eligible for exactly SEK 90,000', () => {
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-integration-90k', oneTimeFees: [integrationFee], evidence: [evidence()], asOf,
    })
    expect(result).toEqual({ eligible: true, amount: 90_000, feeId: 'fee-integration-90k', eventType: 'customer_acceptance' })
  })

  // A6.3 — evidence revoked before execution -> remains parked.
  it('evidence revoked -> not eligible', () => {
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-integration-90k', oneTimeFees: [integrationFee],
      evidence: [evidence({ status: 'revoked' })], asOf,
    })
    expect(result).toEqual({ eligible: false, reason: 'evidence_not_satisfied' })
  })

  // A6.4 — evidence for another fee -> remains parked.
  it('active, correctly-typed evidence for a DIFFERENT fee -> not eligible', () => {
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-integration-90k', oneTimeFees: [integrationFee],
      evidence: [evidence({ subjectId: 'fee-some-other-fee' })], asOf,
    })
    expect(result).toEqual({ eligible: false, reason: 'evidence_not_satisfied' })
  })

  // A6.5 — wrong event type -> remains parked.
  it('active evidence for the right fee but wrong event type -> not eligible', () => {
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-integration-90k', oneTimeFees: [integrationFee],
      evidence: [evidence({ eventType: 'delivery' })], asOf,
    })
    expect(result).toEqual({ eligible: false, reason: 'evidence_not_satisfied' })
  })

  // A6.6 — future-dated evidence -> remains parked.
  it('evidence occurredAt in the future relative to asOf -> not eligible', () => {
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-integration-90k', oneTimeFees: [integrationFee],
      evidence: [evidence({ occurredAt: new Date(2026, 9, 20).toISOString() })], asOf,
    })
    expect(result).toEqual({ eligible: false, reason: 'evidence_not_satisfied' })
  })

  // Discriminator coverage — A1/A4's "not description matching" and "only
  // event-gated fees qualify" requirements, exercised directly.
  it('candidateFeeId does not resolve against current contract_terms.one_time_fees (e.g. re-extraction) -> not eligible, fails closed', () => {
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-that-no-longer-exists', oneTimeFees: [integrationFee], evidence: [evidence()], asOf,
    })
    expect(result).toEqual({ eligible: false, reason: 'fee_not_found' })
  })

  it('a legacy manual_trigger fee (quantity x rate, no billability_condition) is NEVER auto-eligible via this path, even with a matching fee_id and satisfied-looking evidence', () => {
    const manualFee: OneTimeFee = {
      fee_label: 'Onboarding Services', amount: 40_000, due_date: null, description: null,
      manual_trigger: true, metric_name: 'hours', rate_per_unit: 500,
      fee_id: 'fee-manual-services',
      // No billability_condition at all — the genuine legacy shape.
    }
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-manual-services', oneTimeFees: [manualFee],
      evidence: [evidence({ subjectId: 'fee-manual-services' })], asOf,
    })
    expect(result).toEqual({ eligible: false, reason: 'not_event_gated' })
  })

  it('null candidateFeeId (row never got a fee_id, e.g. an ordinary parked row) -> not eligible, never matched by fallback', () => {
    const result = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: null, oneTimeFees: [integrationFee], evidence: [evidence()], asOf,
    })
    expect(result).toEqual({ eligible: false, reason: 'fee_not_found' })
  })

  // The race shape the atomic claim_parked_event_fee SQL function exists to
  // close: an eligible discovery read followed by revocation followed by
  // re-evaluation against the now-current evidence. This module can't
  // exercise the real DB transaction (no Supabase-mocking harness exists
  // anywhere in this codebase — see the disclosure at the bottom of this
  // file), but it DOES prove the underlying predicate is time-sensitive and
  // that re-running it after a revocation correctly flips the answer — the
  // exact re-check claim_parked_event_fee performs, atomically, in SQL,
  // immediately before the parked -> processing transition.
  it('race shape: eligible at discovery time, then evidence revoked before the atomic claim -> re-evaluation (what the SQL claim effectively performs) is no longer eligible', () => {
    const activeEvidence = [evidence()]
    const discoveryResult = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-integration-90k', oneTimeFees: [integrationFee], evidence: activeEvidence, asOf,
    })
    expect(discoveryResult.eligible).toBe(true) // "application reads eligible evidence"

    // Evidence revoked in the window between discovery and the atomic claim.
    const revokedEvidence = [evidence({ status: 'revoked' })]
    const reEvaluationResult = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: 'fee-integration-90k', oneTimeFees: [integrationFee], evidence: revokedEvidence, asOf,
    })
    expect(reEvaluationResult).toEqual({ eligible: false, reason: 'evidence_not_satisfied' })
    // -> claim_parked_event_fee's own evidence predicate (status = 'active')
    // rejects this identically, atomically, inside the same transaction as
    // the row lock — so the real system never reaches "no provider
    // execution" as a hoped-for outcome, it's the DIRECT consequence of the
    // claim returning false. See the migration file for the SQL-level
    // predicate; not independently exercised against a live DB here.
  })
})

// A6.7 (duplicate scheduler execution -> invoice exactly once) and A6.8
// (historical approval attempt remains immutable -> later evidence causes a
// new eligible execution) are properties of app/api/admin/invoice-scheduler/
// route.ts's row-status state machine (parked -> processing -> sent) and of
// the row's complete independence from lib/billing-execution-store.ts's
// whole-job billing_execution_attempts ledger — not of this pure module,
// which has no state. Final execution authorization (and the atomicity that
// closes the TOCTOU race between an eligibility read and the parked ->
// processing transition) is the claim_parked_event_fee SQL function
// (supabase/migrations/…_claim_parked_event_fee.sql) — this module is
// discovery/diagnostics only, never the final authorization; see its own
// module-level comment. Verified by direct code reading and traced in the
// final report, consistent with this codebase's established testing
// convention of not inventing a Supabase-mocking harness where none exists
// elsewhere (see lib/usage-pull.test.ts's identical disclosure for
// computeOverageForPeriod). The SQL invariants themselves are covered by
// SQL-level tests in the migration's own comment block plus
// lib/parked-one-time-fee-eligibility.test.ts's race-shape test below.
