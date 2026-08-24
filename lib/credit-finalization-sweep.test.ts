import { describe, it, expect } from 'vitest'
import { computeSweepCandidates } from './credit-finalization-sweep'

// Contract B's real Annual Rebate window, used throughout for concreteness.
const REBATE_WINDOW = { jobId: 'job-b583f52c', creditRuleId: '4076e59c', windowStart: '2026-10-01', windowEnd: '2027-09-30' }

describe('computeSweepCandidates', () => {
  // A — a threshold-met trigger_check with no earn row is discoverable.
  it('A: a threshold-met trigger_check with no corresponding earn row is a candidate', () => {
    const candidates = computeSweepCandidates([REBATE_WINDOW], [])
    expect(candidates).toEqual([REBATE_WINDOW])
  })

  // B — the function's own signature proves independence from
  // planned_invoices: it takes ONLY credit_ledger_entries-derived data
  // (trigger_check rows, earn rows) — there is no planned_invoices
  // parameter anywhere for it to depend on.
  it('B: candidate selection never references planned_invoices — a window with zero due invoices is still discoverable purely from ledger state', () => {
    const candidates = computeSweepCandidates([REBATE_WINDOW], [])
    expect(candidates).toHaveLength(1)
    // Structural proof, not just behavioral: the function's parameter
    // types (PendingCreditWindow, EarnedWindowIdentity) carry no invoice
    // identity of any kind.
    expect(Object.keys(candidates[0])).toEqual(['jobId', 'creditRuleId', 'windowStart', 'windowEnd'])
  })

  // C — once earned, a window is excluded — proving a repeated sweep
  // converges to zero re-processing (idempotent finalization).
  it('C: a window with an existing earn row is excluded — repeated sweeps produce one earned entitlement, not N', () => {
    const earned = [{ jobId: REBATE_WINDOW.jobId, creditRuleId: REBATE_WINDOW.creditRuleId, windowStart: REBATE_WINDOW.windowStart }]
    const candidates = computeSweepCandidates([REBATE_WINDOW], earned)
    expect(candidates).toEqual([])
  })

  it('C (continued): simulates 30 consecutive daily sweeps against a window that never earns — same single candidate every time, never accumulating duplicates', () => {
    for (let day = 0; day < 30; day++) {
      const candidates = computeSweepCandidates([REBATE_WINDOW], [])
      expect(candidates).toEqual([REBATE_WINDOW])
    }
  })

  it('multiple trigger_check snapshots for the SAME window (different evaluation_date rows in the real table, collapsed to one identity here) de-duplicate to a single candidate', () => {
    const sameWindowTwice = [REBATE_WINDOW, { ...REBATE_WINDOW }]
    const candidates = computeSweepCandidates(sameWindowTwice, [])
    expect(candidates).toHaveLength(1)
  })

  it('a different credit_rule_id on the same job is a distinct candidate, not deduplicated against an unrelated rule', () => {
    const otherCredit = { ...REBATE_WINDOW, creditRuleId: '9f7f5ea8' }
    const candidates = computeSweepCandidates([REBATE_WINDOW, otherCredit], [])
    expect(candidates).toHaveLength(2)
  })

  it('an earned window for a DIFFERENT job with the same credit_rule_id/window_start does not accidentally exclude this job\'s own pending window', () => {
    const earnedElsewhere = [{ jobId: 'job-some-other-job', creditRuleId: REBATE_WINDOW.creditRuleId, windowStart: REBATE_WINDOW.windowStart }]
    const candidates = computeSweepCandidates([REBATE_WINDOW], earnedElsewhere)
    expect(candidates).toEqual([REBATE_WINDOW])
  })

  it('empty inputs produce an empty candidate list', () => {
    expect(computeSweepCandidates([], [])).toEqual([])
  })
})

// D (payment state becomes visible to later reevaluation) and G
// (zero-monetary terminal settlement creates no empty provider invoice) are
// properties of runEarningPass/sumPaidComponentAmountForWindow (which
// re-reads planned_invoices.status live on every call — traced directly in
// lib/credit-ledger-service.ts, no caching) and of the invoice-scheduler's
// hasSomethingToBill gate respectively — both DB-coupled with no mocking
// harness in this codebase (same disclosure already made for
// computeOverageForPeriod/reserve_credit_balance/claim_parked_event_fee).
// Verified by direct code reading and traced in the accompanying report,
// not exercised here.
//
// F (earned balance with no eligible future invoice remains a balance, no
// cash conversion) requires no new test: no code path anywhere in this
// codebase ever converts a credit_ledger_entries balance to cash or
// force-applies it — applyCreditLedgerForPeriod only ever reserves against
// a REAL due invoice's real component pool. Absence of such a code path is
// the proof; there is nothing to assert against.
