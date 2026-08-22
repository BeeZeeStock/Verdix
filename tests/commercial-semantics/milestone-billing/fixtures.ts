// Verdix-controlled synthetic milestone/project-billing contract family
// (Step 10). Six progressively more complex synthetic B2B project-billing
// agreements, wrapped in minimal but complete contract boilerplate so the
// real, unmodified production extraction pipeline (lib/contract-
// extractor.ts's extractContractTerms) has enough context to run
// realistically. No customer data, no real contract text — entirely
// synthetic, generic, and customer-independent, exactly like every other
// fixture under tests/commercial-semantics/.
//
// Each fixture's `expectedConcepts` is NOT an assertion the current model
// must satisfy — it is the list of commercial concepts a human reading the
// clause would identify, used as the yardstick the capability matrix
// (Step 10 deliverables) measures today's ContractTerms/extraction/
// Rulebook against. See lib/rulebook/MILESTONE_BILLING_FINDINGS.md for the
// full analysis this fixture family supports.
export interface MilestoneBillingFixture {
  id: string
  label: string
  contractText: string
  expectedConcepts: string[]
}

const BOILERPLATE_HEADER = (title: string) => `PROJECT SERVICES AGREEMENT

This Agreement is entered into between Acme Vendor AB ("Supplier") and Northwind Customer AB ("Customer").

Effective Date: 2026-01-15
Currency: SEK
Payment Terms: Net 30 days from invoice date

${title}
`

export const FIXTURE_A_SIMPLE_MILESTONE: MilestoneBillingFixture = {
  id: 'milestone.simple_fixed',
  label: 'A. Simple fixed milestone',
  contractText: BOILERPLATE_HEADER('1. Fees') + `
The total project fee is SEK 300,000, payable as follows:

(a) SEK 100,000 becomes billable upon completion and customer acceptance of Milestone 1 (Discovery & Design).
(b) SEK 200,000 becomes billable upon completion and customer acceptance of Milestone 2 (Implementation & Go-Live).
`,
  expectedConcepts: ['milestone amount', 'milestone trigger', 'acceptance condition', 'billable timing'],
}

export const FIXTURE_B_ADVANCE_PLUS_MILESTONES: MilestoneBillingFixture = {
  id: 'milestone.advance_plus_balance',
  label: 'B. Advance + milestone balance',
  contractText: BOILERPLATE_HEADER('1. Fees') + `
The total project fee is SEK 500,000, payable as follows:

(a) 20% of the total project fee is payable upon signature of this Agreement.
(b) 40% of the total project fee is payable upon Customer's acceptance of the Design deliverable.
(c) The remaining 40% of the total project fee is payable upon final acceptance of the completed project.
`,
  expectedConcepts: ['upfront payment', 'milestone percentages', 'percentage calculation basis', 'sequencing'],
}

export const FIXTURE_C_DEEMED_ACCEPTANCE: MilestoneBillingFixture = {
  id: 'milestone.deemed_acceptance_window',
  label: 'C. Milestone with explicit acceptance window',
  contractText: BOILERPLATE_HEADER('1. Fees and Acceptance') + `
The Milestone 1 fee is SEK 150,000.

Customer shall review each deliverable within 10 business days of Supplier's submission. If no rejection identifying material deficiencies is received from Customer during that period, the deliverable is deemed accepted. The related milestone fee becomes invoiceable upon acceptance (whether express or deemed).
`,
  expectedConcepts: ['acceptance event', 'deemed-acceptance mechanism', 'invoiceability', 'delivery vs acceptance distinction'],
}

export const FIXTURE_D_CHANGE_ORDER: MilestoneBillingFixture = {
  id: 'milestone.change_order',
  label: 'D. Change order / variation',
  contractText: BOILERPLATE_HEADER('1. Fees and Scope') + `
The base project fee for the scope described in Exhibit A is SEK 400,000, billable per the milestone schedule in Exhibit A.

Any work requested by Customer that is outside the agreed scope described in Exhibit A requires a written Change Order signed by both parties, specifying the additional fee and any schedule impact. Additional fees for out-of-scope work become billable only after the Change Order has been signed by both parties. Supplier shall not commence out-of-scope work, nor invoice for it, absent a signed Change Order.
`,
  expectedConcepts: ['base project scope', 'additional commercial obligation', 'written approval condition', 'separate billability trigger'],
}

export const FIXTURE_E_RETENTION: MilestoneBillingFixture = {
  id: 'milestone.retention_holdback',
  label: 'E. Retention / holdback',
  contractText: BOILERPLATE_HEADER('1. Fees and Retention') + `
The Milestone 2 fee is SEK 250,000.

For each approved milestone invoice, Customer shall pay 90% of the invoiced amount within the standard payment terms. The remaining 10% of each milestone fee shall be retained by Customer and becomes payable only upon final acceptance of the entire project.
`,
  expectedConcepts: ['gross milestone entitlement', 'immediately billable/payable portion', 'retained portion', 'retention release trigger'],
}

export const FIXTURE_F_DELAY_PENALTY: MilestoneBillingFixture = {
  id: 'milestone.delay_penalty',
  label: 'F. Delay penalty / service adjustment',
  contractText: BOILERPLATE_HEADER('1. Fees and Delivery') + `
The Milestone 3 fee is SEK 180,000, with an agreed completion date of 2026-06-01.

For each complete week of Supplier delay beyond the agreed completion date, Customer shall receive a credit equal to 2% of the Milestone 3 fee, capped at 10% of the Milestone 3 fee.
`,
  expectedConcepts: ['delay trigger', 'complete-week quantity treatment', 'percentage basis', 'cap', 'affected milestone scope'],
}

// Counterexample fixture (item 10) — deliberately proves the OPPOSITE of
// Case C can legitimately exist: here the contract explicitly collapses
// delivery into acceptance, rather than leaving them distinct. Evidence
// for candidate.credit.milestone_delivery_ne_acceptance (lib/rulebook/
// rule-candidates.ts) that the underlying principle is "do not INFER
// acceptance from delivery when the contract is silent" — never "delivery
// can never establish acceptance."
export const FIXTURE_G_DELIVERY_CONSTITUTES_ACCEPTANCE: MilestoneBillingFixture = {
  id: 'milestone.delivery_constitutes_acceptance',
  label: 'G. Counterexample — delivery explicitly constitutes acceptance',
  contractText: BOILERPLATE_HEADER('1. Fees and Acceptance') + `
The Milestone 1 fee is SEK 150,000.

Delivery of the Milestone 1 deliverable shall constitute acceptance, and the milestone fee becomes immediately invoiceable upon delivery. No separate acceptance review or sign-off is required.
`,
  expectedConcepts: ['delivery event', 'explicit delivery-equals-acceptance', 'immediate invoiceability'],
}

export const MILESTONE_BILLING_FIXTURES: MilestoneBillingFixture[] = [
  FIXTURE_A_SIMPLE_MILESTONE,
  FIXTURE_B_ADVANCE_PLUS_MILESTONES,
  FIXTURE_C_DEEMED_ACCEPTANCE,
  FIXTURE_D_CHANGE_ORDER,
  FIXTURE_E_RETENTION,
  FIXTURE_F_DELAY_PENALTY,
  FIXTURE_G_DELIVERY_CONSTITUTES_ACCEPTANCE,
]
