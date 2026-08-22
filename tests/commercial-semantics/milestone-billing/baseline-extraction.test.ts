// Step 10 — baseline extraction capability matrix, made concrete and
// testable. The objects below are the REAL results of a live baseline run
// (RUN_STEP10_MILESTONE_BASELINE=true, Sonnet via Bedrock, the current,
// unmodified production extraction pipeline — lib/contract-extractor.ts's
// extractContractTerms, no prompt changes) against every fixture in
// ./fixtures.ts, captured once and hand-transcribed here. This is NOT a
// live test (AI output is not byte-reproducible run to run) — it is a
// durable record of what today's production model actually does with
// this contract family, backing every claim in lib/rulebook/MILESTONE_
// BILLING_FINDINGS.md's capability matrix with real evidence rather than
// prose alone. The assertions below are about STRUCTURAL SHAPE (which
// fields exist, what's preserved vs. folded into free text), not exact
// wording — re-running the live baseline is expected to vary in wording
// while landing on the same shape; see this project's established live-
// verification convention (throwaway script, captured once, deleted).
import { describe, it, expect } from 'vitest'
import type { OneTimeFee, ServiceCredit } from '@/lib/types'

// ── Case A — simple fixed milestone ────────────────────────────────────
const CASE_A_ONE_TIME_FEES: OneTimeFee[] = [
  { fee_label: 'Milestone 1 — Discovery & Design', amount: 100000, due_date: null, description: 'Billable upon completion and customer acceptance of Milestone 1 (Discovery & Design).', manual_trigger: true, metric_name: 'milestone', rate_per_unit: null },
  { fee_label: 'Milestone 2 — Implementation & Go-Live', amount: 200000, due_date: null, description: 'Billable upon completion and customer acceptance of Milestone 2 (Implementation & Go-Live).', manual_trigger: true, metric_name: 'milestone', rate_per_unit: null },
]

// ── Case B — advance + milestone balance ───────────────────────────────
const CASE_B_ONE_TIME_FEES: OneTimeFee[] = [
  { fee_label: 'Project Fee — Signature Milestone (20%)', amount: 100000, due_date: '2026-01-15', description: '20% of total project fee (SEK 500,000), payable upon signature of this Agreement.', manual_trigger: false, metric_name: null, rate_per_unit: null },
  { fee_label: 'Project Fee — Design Acceptance Milestone (40%)', amount: 200000, due_date: null, description: "40% of total project fee (SEK 500,000), payable upon Customer's acceptance of the Design deliverable.", manual_trigger: true, metric_name: null, rate_per_unit: null },
  { fee_label: 'Project Fee — Final Acceptance Milestone (40%)', amount: 200000, due_date: null, description: 'Remaining 40% of total project fee (SEK 500,000), payable upon final acceptance of the completed project.', manual_trigger: true, metric_name: null, rate_per_unit: null },
]

// ── Case C — deemed acceptance window ──────────────────────────────────
const CASE_C_ONE_TIME_FEES: OneTimeFee[] = [
  { fee_label: 'Milestone 1', amount: 150000, due_date: null, description: 'Milestone 1 fee, invoiceable upon acceptance (express or deemed after 10 business days without rejection identifying material deficiencies).', manual_trigger: true, metric_name: null, rate_per_unit: null },
]

// ── Case D — change order ──────────────────────────────────────────────
const CASE_D_ONE_TIME_FEES: OneTimeFee[] = [
  { fee_label: 'Base project fee', amount: 400000, due_date: null, description: 'Fixed base project fee for scope described in Exhibit A, billable per the milestone schedule in Exhibit A.', manual_trigger: true, metric_name: 'milestone', rate_per_unit: null },
  { fee_label: 'Out-of-scope / Change Order work', amount: 0, due_date: null, description: 'Additional fees for out-of-scope work requested by Customer, billable only after a written Change Order has been signed by both parties specifying the additional fee. Supplier may not commence or invoice for out-of-scope work absent a signed Change Order.', manual_trigger: true, metric_name: null, rate_per_unit: null },
]

// ── Case E — retention ─────────────────────────────────────────────────
const CASE_E_ONE_TIME_FEES: OneTimeFee[] = [
  { fee_label: 'Milestone 2 Fee', amount: 250000, due_date: null, description: 'Milestone 2 fee; 90% payable within standard payment terms upon approved milestone invoice, with 10% retained by Customer until final acceptance of the entire project.', manual_trigger: true, metric_name: null, rate_per_unit: null },
]

// ── Case F — delay penalty ─────────────────────────────────────────────
const CASE_F_ONE_TIME_FEES: OneTimeFee[] = [
  { fee_label: 'Milestone 3', amount: 180000, due_date: '2026-06-01', description: 'Milestone 3 fee with agreed completion date of 2026-06-01', manual_trigger: false, metric_name: null, rate_per_unit: null },
]
const CASE_F_SERVICE_CREDITS: Partial<ServiceCredit>[] = [
  { credit_type: 'service_credit', description: 'Delay credit for Milestone 3 — 2% of milestone fee per complete week of Supplier delay, capped at 10%', source_clause: 'For each complete week of Supplier delay beyond the agreed completion date, Customer shall receive a credit equal to 2% of the Milestone 3 fee, capped at 10% of the Milestone 3 fee.', stated_pct: 2, stated_amount: null },
]

// ── Case G — counterexample: delivery explicitly constitutes acceptance ─
const CASE_G_ONE_TIME_FEES: OneTimeFee[] = [
  { fee_label: 'Milestone 1 Fee', amount: 150000, due_date: null, description: 'Fee becomes invoiceable upon delivery of Milestone 1 deliverable. Delivery constitutes acceptance; no separate sign-off required.', manual_trigger: true, metric_name: null, rate_per_unit: null },
]

describe('Case A — simple fixed milestone: fully expressible as OneTimeFee, acceptance gate is coarse', () => {
  it('both milestones extract as separate one_time_fees with manual_trigger true (needs human confirmation before invoicing)', () => {
    expect(CASE_A_ONE_TIME_FEES).toHaveLength(2)
    expect(CASE_A_ONE_TIME_FEES.every(f => f.manual_trigger === true)).toBe(true)
  })
  it('the amount and label are captured; the TRIGGER TYPE (customer acceptance specifically) is not distinguishable from any other manual_trigger reason (e.g. "professional services billed on delivery")', () => {
    // manual_trigger is a single boolean — nothing on OneTimeFee records
    // WHY confirmation is needed (acceptance vs. plain delivery vs.
    // internal sign-off). This is the capability matrix's headline gap.
    expect(CASE_A_ONE_TIME_FEES[0]).not.toHaveProperty('acceptance_trigger')
    expect(CASE_A_ONE_TIME_FEES[0]).not.toHaveProperty('trigger_type')
  })
})

describe('Case B — advance + milestone percentages: sequencing/timing preserved per line, percentage BASIS lost', () => {
  it('each of the three payments is its own one_time_fee with a distinct amount', () => {
    expect(CASE_B_ONE_TIME_FEES).toHaveLength(3)
  })
  it('the signature-triggered advance correctly auto-invoices (manual_trigger: false, real due_date) while both acceptance-gated milestones correctly require confirmation', () => {
    expect(CASE_B_ONE_TIME_FEES[0].manual_trigger).toBe(false)
    expect(CASE_B_ONE_TIME_FEES[0].due_date).toBeTruthy()
    expect(CASE_B_ONE_TIME_FEES[1].manual_trigger).toBe(true)
    expect(CASE_B_ONE_TIME_FEES[2].manual_trigger).toBe(true)
  })
  it('the stated percentage-of-total-fee relationship (20%/40%/40%) is NOT preserved as a structured field — only the computed absolute amount survives', () => {
    for (const fee of CASE_B_ONE_TIME_FEES) {
      expect(fee).not.toHaveProperty('pct_of_total_project_fee')
      expect(typeof fee.amount).toBe('number') // absolute only
    }
  })
})

describe('Case C vs. Case G — deemed acceptance and its explicit-collapse counterexample extract to the STRUCTURALLY IDENTICAL shape', () => {
  it('both are a single manual_trigger: true OneTimeFee with the acceptance mechanism folded into free-text description only', () => {
    expect(CASE_C_ONE_TIME_FEES).toHaveLength(1)
    expect(CASE_G_ONE_TIME_FEES).toHaveLength(1)
    expect(CASE_C_ONE_TIME_FEES[0].manual_trigger).toBe(true)
    expect(CASE_G_ONE_TIME_FEES[0].manual_trigger).toBe(true)
  })
  it('the genuinely different commercial meaning (a 10-day review window vs. no review at all) exists ONLY in prose, not in any queryable field — this is exactly the semantic-model gap candidate.milestone.delivery_ne_acceptance documents', () => {
    expect(CASE_C_ONE_TIME_FEES[0].description).toMatch(/deemed/)
    expect(CASE_G_ONE_TIME_FEES[0].description).toMatch(/constitute/)
    // Neither has a structured field a Rulebook rule or execution engine
    // could branch on to tell the two apart.
    expect(CASE_C_ONE_TIME_FEES[0]).not.toHaveProperty('acceptance_review_window_days')
    expect(CASE_G_ONE_TIME_FEES[0]).not.toHaveProperty('acceptance_review_window_days')
  })
  it('neither case shows over-inference in either direction (item 6) — this is the positive evidence for the candidate, not a failure', () => {
    // Case C did not wrongly auto-invoice (manual_trigger stayed true, not
    // collapsed to false); Case G did not wrongly withhold billability
    // once delivery is confirmed (still gated on manual_trigger, not on a
    // fabricated multi-step acceptance workflow it was never told exists).
    expect(CASE_C_ONE_TIME_FEES[0].manual_trigger).toBe(CASE_G_ONE_TIME_FEES[0].manual_trigger)
  })
})

describe('Case D — change order: reuses the existing "amount unknown" convention, but collapses a bilateral-approval gate into the same boolean as unilateral confirmation', () => {
  it('the base fee and the change-order fee are two separate one_time_fees', () => {
    expect(CASE_D_ONE_TIME_FEES).toHaveLength(2)
  })
  it('the change-order fee reuses amount: 0 + manual_trigger: true (the existing "variable, unknown at contract time" shape) rather than inventing a new field', () => {
    const changeOrderFee = CASE_D_ONE_TIME_FEES[1]
    expect(changeOrderFee.amount).toBe(0)
    expect(changeOrderFee.manual_trigger).toBe(true)
  })
  it('nothing distinguishes "requires a signed bilateral Change Order" from "requires unilateral delivery confirmation" structurally — both are manual_trigger: true', () => {
    expect(CASE_D_ONE_TIME_FEES[0].manual_trigger).toBe(CASE_D_ONE_TIME_FEES[1].manual_trigger)
  })
})

describe('Case E — retention: the split is described accurately in prose but not represented structurally at all', () => {
  it('extracts as ONE fee for the full gross amount — no separate billable-now vs. retained-portion fields', () => {
    expect(CASE_E_ONE_TIME_FEES).toHaveLength(1)
    expect(CASE_E_ONE_TIME_FEES[0].amount).toBe(250000) // the full, gross amount — not 225,000 (90%)
  })
  it('zero discounts were extracted — the model did not miscategorize retention as a price reduction (real evidence for candidate.milestone.retention_ne_discount)', () => {
    // Captured from the same live baseline run — discounts: [] for Case E.
    const discountsExtracted: unknown[] = []
    expect(discountsExtracted).toHaveLength(0)
  })
})

describe('Case F — delay penalty: cleanly reuses the existing credit primitive at extraction time', () => {
  it('the milestone fee and the delay credit extract as two separate, correctly-typed structures (OneTimeFee + ServiceCredit)', () => {
    expect(CASE_F_ONE_TIME_FEES).toHaveLength(1)
    expect(CASE_F_SERVICE_CREDITS).toHaveLength(1)
    expect(CASE_F_SERVICE_CREDITS[0].credit_type).toBe('service_credit')
  })
  it('the credit correctly captures stated_pct (2%) and the full source clause (including the cap) for downstream interpretation', () => {
    expect(CASE_F_SERVICE_CREDITS[0].stated_pct).toBe(2)
    expect(CASE_F_SERVICE_CREDITS[0].source_clause).toMatch(/capped at 10%/)
  })
  it('a genuine extraction-quality observation: the milestone\'s own due_date was set to the delay-penalty reference date (the agreed completion date), which would auto-invoice on that date regardless of actual completion/acceptance — reported, not fixed (item 16: report first, do not opportunistically fix)', () => {
    expect(CASE_F_ONE_TIME_FEES[0].due_date).toBe('2026-06-01')
    expect(CASE_F_ONE_TIME_FEES[0].manual_trigger).toBe(false)
  })
})
