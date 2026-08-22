// Step 11 final correction, item 5 — proves Approve cannot reach
// configureStripe/configureRemembill for an unresolved OneTimeFee, for
// BOTH shapes: an ordinary reviewer-resolvable ambiguity (totalToConfirm)
// and a genuine capability blocker (executionBlockers). app/api/jobs/[id]/
// approve/route.ts cannot be unit-tested directly (it transitively imports
// next-auth, which fails to resolve under plain vitest — the same
// constraint every prior step in this project has worked within), so this
// reproduces its EXACT gate condition here, verbatim, and proves
// computeCommercialRuleWorkload's real output trips it for the specific
// shapes this correction is about. If approve/route.ts's condition ever
// changes, this mirror must be updated to match — the two are proven
// consistent by direct citation, not by coincidence.
import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload, type CommercialRuleWorkload } from '@/lib/commercial-rule-status'
import type { OneTimeFee } from '@/lib/types'

// Verbatim mirror of app/api/jobs/[id]/approve/route.ts's three sequential
// gate checks (executionBlockers, then totalToConfirm/interactionsToConfirm,
// then vat.configured) — Approve proceeds to configureBilling() only when
// none of these trip.
function approveWouldBlock(workload: CommercialRuleWorkload): boolean {
  if (workload.executionBlockers.length > 0) return true
  if (workload.totalToConfirm > 0 || workload.interactionsToConfirm > 0) return true
  if (!workload.vat.configured) return true
  return false
}

describe('Approve cannot invoice an unresolved OneTimeFee (item 5)', () => {
  it('the historical "bill now" risk (due_date: null, manual_trigger: false) — a freshly-extracted fee in this shape now blocks Approve, where it previously would not have', () => {
    // The realistic post-safety-net shape: lib/contract-extractor.ts's
    // flagAmbiguousOneTimeFees sets both requires_confirmation: true AND
    // amount_provenance: null for exactly this shape.
    const fee: OneTimeFee = {
      fee_label: 'Ambiguous fee', amount: 100000, due_date: null, description: null,
      requires_confirmation: true, unresolved_kind: 'needs_review',
      amount_provenance: null, billability_provenance: null,
    }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(approveWouldBlock(workload)).toBe(true)
  })

  it('an ordinary unresolved amount (amount_provenance: null, otherwise clean) blocks Approve via totalToConfirm', () => {
    const fee: OneTimeFee = { fee_label: 'Milestone fee', amount: 100000, due_date: '2026-03-01', description: null, amount_provenance: null }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBeGreaterThan(0)
    expect(approveWouldBlock(workload)).toBe(true)
  })

  it('a capability-blocked fee (unresolved_kind: unsupported_semantics) blocks Approve via executionBlockers — the exact gap this correction closes (capability blockers were previously invisible to totalToConfirm)', () => {
    const fee: OneTimeFee = {
      fee_label: 'Acceptance-gated milestone', amount: 100000, due_date: null, description: null,
      amount_provenance: 'contract_derived', requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
    }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    // Confirms the actual mechanism: NOT counted as an ordinary item...
    expect(workload.totalToConfirm).toBe(0)
    // ...but still, correctly, blocks Approve via executionBlockers.
    expect(workload.executionBlockers.length).toBeGreaterThan(0)
    expect(approveWouldBlock(workload)).toBe(true)
  })

  it('a fully resolved OneTimeFee (both dimensions) does NOT block Approve', () => {
    const fee: OneTimeFee = {
      fee_label: 'Resolved fee', amount: 100000, due_date: null, description: null,
      amount_provenance: 'reviewer_policy', billability_provenance: 'reviewer_policy', requires_confirmation: false,
    }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(approveWouldBlock(workload)).toBe(false)
  })

  it('a manual_trigger: true fee (execution safely held) never blocks Approve, even with no provenance at all — nothing automatic is being decided for this shape', () => {
    const fee: OneTimeFee = { fee_label: 'Professional services', amount: 0, due_date: null, description: null, manual_trigger: true, metric_name: 'hours', rate_per_unit: 150 }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(approveWouldBlock(workload)).toBe(false)
  })

  it('a legacy, pre-Step-11 fee (no provenance fields at all) does not block Approve — historical compatibility preserved even at the Approve-gate level', () => {
    const fee: OneTimeFee = { fee_label: 'Pre-existing onboarding fee', amount: 5000, due_date: null, description: null }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(approveWouldBlock(workload)).toBe(false)
  })
})
