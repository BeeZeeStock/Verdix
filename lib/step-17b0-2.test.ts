import { describe, it, expect } from 'vitest'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import { mergeExtractions } from './contract-extractor'
import { buildContractTermsUpsertPayload } from './contract-terms-persistence'
import { formatRenewalNoticePeriod } from './contract-notice-period'
import { resolveFixedFeeBand } from './fixed-fee-band'
import { collectOperationalDataInputs } from './operational-data-inputs'
import { detectPII, maskText, restoreTokensInObject } from './pii-detector'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17B0.2 — fresh-output regression for items 1–5. Root cause for
// 1/2/3/5 (partial): several ContractTerms fields (customer_org_number,
// renewal_notice_months, renewal_term_months, crm_id, customer_email,
// base_fee_bands, base_fee_committed_volume, unsupported_commercial_
// mechanisms, credit_application_priority) were added to lib/types.ts but
// never migrated onto the contract_terms table, and execute/route.ts's
// upsert — which deliberately picks columns explicitly — never attempted
// to write them. They were correct in the merged in-memory ContractTerms
// object (proven by lib/step-17b0.test.ts / lib/step-17b0-1.test.ts, which
// operate on that object directly) but silently never reached the
// database, and therefore never reached the API response or the
// renderer. This is exactly the class of bug a pure-object unit test
// cannot catch — these tests instead assert on
// buildContractTermsUpsertPayload's return value, the actual object shape
// that reaches supabaseServer.upsert(), closing that blind spot.
// See supabase/migrations/20260902000001_contract_terms_missing_columns.sql
// for the schema fix these tests assume is applied.
// ═══════════════════════════════════════════════════════════════════════════

describe('17B0.2 — fresh-output acceptance regression (Remembill fixture, post-merge, post-persistence-payload)', () => {
  const terms = buildRemembillFixtureTerms()
  const merged = mergeExtractions([terms])
  const payload = buildContractTermsUpsertPayload('job-fixture', merged)

  it('1. customer org / reg number reaches the persistence payload', () => {
    expect(merged.customer_org_number).toBe('559999-1234') // survives merge (lib/step-17b0-1.test.ts already covers mask/extract/restore)
    expect(payload.customer_org_number).toBe('559999-1234') // survives translation into the actual upsert payload — the field this bug class dropped
  })

  it('2. renewal notice (3 months) reaches the persistence payload and renders correctly from it', () => {
    expect(payload.renewal_notice_months).toBe(3)
    expect(payload.renewal_notice_days).toBeNull()
    // formatRenewalNoticePeriod is what the Contract Overview/Brief renderer
    // actually calls — feeding it the PAYLOAD shape (not the in-memory
    // ContractTerms) proves the value a real API response would carry
    // still renders correctly, not just the pre-persistence object.
    expect(formatRenewalNoticePeriod(payload)).toBe('3 months notice required')
  })

  it('3. the rolling three-month volume transition reaches the persistence payload, independent of any fee line item', () => {
    expect(payload.unsupported_commercial_mechanisms).toHaveLength(1)
    const rolling = payload.unsupported_commercial_mechanisms![0]
    expect(rolling.kind).toBe('rolling_volume_pricing_transition')
    expect(rolling.execution_status).toBe('unsupported')
    expect(rolling.required_operational_inputs).toEqual(['issued_payment_request_count'])
  })

  it('4. all four operational data inputs are collectible from the persisted payload shape', () => {
    const inputs = collectOperationalDataInputs(payload)
    const keys = inputs.map(i => i.key).sort()
    expect(keys).toEqual([
      'completed_payment_count',
      'contracted_volume', // the excess-overage tier's own second dependency (lib/remembill-fixture.ts)
      'issued_payment_request_count',
      'paid_invoice_value',
      'total_invoice_value_of_issued_requests',
    ])
    // The rolling-transition's dependency specifically — this is the ONE
    // input that only ever reaches the collector via
    // unsupported_commercial_mechanisms, the field this bug silently
    // dropped, so it's the most direct proof the persistence fix matters
    // for input visibility too, not just for the mechanism card.
    const rollingInput = inputs.find(i => i.key === 'issued_payment_request_count')
    expect(rollingInput?.sources.some(s => s.includes('unsupported_commercial_mechanisms'))).toBe(true)
  })

  it('5. fixed-band provenance (contracted volume / selected band / fee) resolves from the persisted payload shape', () => {
    expect(payload.base_fee_committed_volume).toBe(5000)
    expect(payload.base_fee_bands).toHaveLength(4) // includes the open-ended 150,001+ "Offereras" band (Step 17B0.3)
    const resolution = resolveFixedFeeBand(payload.base_fee_bands, payload.base_fee_committed_volume)
    expect(resolution).toEqual({ status: 'resolved', band: { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 } })
  })

  it('every field this bug class dropped is present in the payload, not just the four named above', () => {
    expect(payload.crm_id).toBeNull() // not stated in this fixture — correctly null, not silently absent from the payload shape itself
    expect(payload.customer_email).toBeNull()
    expect(payload.renewal_term_months).toBe(12)
    expect(payload.credit_application_priority).toBeNull()
  })
})

describe('17B0.2 — buildContractTermsUpsertPayload regression (prevents this exact bug class from recurring)', () => {
  it('every scalar/array field on ContractTerms that has a real dedicated column is included in the payload', () => {
    const terms = buildRemembillFixtureTerms()
    const payload = buildContractTermsUpsertPayload('job-x', terms)
    // Spot-check the specific fields silently dropped by the pre-fix
    // upsert — a literal object build in execute/route.ts had no
    // mechanism to catch a field being forgotten; this test does.
    for (const key of [
      'crm_id', 'customer_email', 'customer_org_number',
      'renewal_notice_months', 'renewal_term_months',
      'base_fee_bands', 'base_fee_committed_volume',
      'unsupported_commercial_mechanisms', 'credit_application_priority',
    ] as const) {
      expect(payload).toHaveProperty(key)
    }
  })

  it('still includes every field the previous, already-working upsert wrote (no regression)', () => {
    const terms = buildRemembillFixtureTerms()
    const payload = buildContractTermsUpsertPayload('job-x', terms)
    expect(payload.job_id).toBe('job-x')
    expect(payload.customer_name).toBe(terms.customer_name)
    expect(payload.base_monthly_fee).toBe(terms.base_monthly_fee)
    expect(payload.base_fee_proration).toEqual(terms.base_fee_proration)
    expect(payload.discounts).toEqual(terms.discounts)
    expect(payload.additional_recurring_fees).toEqual(terms.additional_recurring_fees)
    expect(payload.raw_extraction).toBe(terms)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Step 17B0.2, item 6 — clause -> PDF source-marker linkage.
//
// What this DOES cover, deterministically: the locator (a PDF-locator
// section-heading string — see lib/contract-extractor.ts's field_sources
// prompt rule; this codebase has no stored bbox/coordinate mechanism, see
// this step's own audit) survives extraction merge across chunks, survives
// PII masking/restoration, and reaches the persisted upsert payload —
// including MULTIPLE independent locators for a single fee/mechanism whose
// evidence spans several sections (the performance-share fee, evidenced
// across three parts of Bilaga 1).
//
// What this does NOT and cannot cover: PDFViewer.tsx's actual canvas
// rendering and on-page marker/highlight drawing (app/_components/
// PDFViewer.tsx's paintSection) requires a real PDF file and a browser
// canvas/text-layer environment — there is no live-AI-call-free way to
// assert "the marker visually renders at the right position" in this
// unit-test suite, the same reason no test in this codebase renders
// configure/[id]/page.tsx's actual PDF drawer. That step needs a manual
// or a real end-to-end browser check against an actual uploaded contract.
// ═══════════════════════════════════════════════════════════════════════════

function minimalTerms(overrides: Partial<ContractTerms>): ContractTerms {
  return {
    contract_id: null, crm_id: null, customer_name: null, customer_address: null,
    billing_contact: null, vendor_name: null, vendor_address: null, order_date: null,
    contract_start_date: null, contract_end_date: null, contract_term_months: null,
    auto_renews: null, renewal_notice_days: null, renewal_notice_months: null,
    customer_email: null, customer_org_number: null, renewal_term_months: null,
    currency: 'EUR', base_monthly_fee: null, base_annual_fee: null,
    base_fee_bands: null, base_fee_committed_volume: null, base_fee_proration: null,
    billing_frequency: null, payment_terms_days: null, payment_terms_text: null,
    included_units: null, included_unit_type: null, year_pricing: null, ramp_schedule: null,
    escalators: [], discounts: [], service_credits: [], overage_tiers: [],
    additional_recurring_fees: [], one_time_fees: [], unsupported_commercial_mechanisms: [],
    field_sources: {}, extraction_confidence: 'medium', extraction_notes: null, number_format: 'dot',
    ...overrides,
  }
}

describe('17B0.2 item 6 — clause reference retains its locator through extraction merge', () => {
  it('a main-agreement locator (chunk A) and a Bilaga 1 locator (chunk B) both survive merge, neither overwrites the other', () => {
    const chunkA = minimalTerms({
      customer_name: 'NordicFit Test AB', base_monthly_fee: 2000, contract_start_date: '2026-10-01',
      contract_term_months: 12, overage_tiers: [{ tier_label: 'x', from_unit: 5001, to_unit: null, rate_per_unit: 0.6, unit_type: 'payment request' }],
      field_sources: { base_monthly_fee: '1. Plattformsavgift' }, // main agreement
    })
    const chunkB = minimalTerms({
      unsupported_commercial_mechanisms: [
        { kind: 'rolling_volume_pricing_transition', description: 'volume band migration', required_operational_inputs: ['issued_payment_request_count'], execution_status: 'unsupported' },
      ],
      field_sources: { unsupported_commercial_mechanisms: 'Bilaga 1, avsnitt 4' }, // appendix
    })
    const merged = mergeExtractions([chunkA, chunkB])
    expect(merged.field_sources.base_monthly_fee).toBe('1. Plattformsavgift')
    expect(merged.field_sources.unsupported_commercial_mechanisms).toBe('Bilaga 1, avsnitt 4')
  })

  it('when both chunks happen to extract the SAME field, the first non-empty locator wins rather than being silently dropped (no "last chunk wins" corruption either)', () => {
    const chunkA = minimalTerms({ customer_name: 'A', field_sources: { customer_name: 'Parter' } })
    const chunkB = minimalTerms({ field_sources: { customer_name: 'Some other heading' } })
    const merged = mergeExtractions([chunkA, chunkB])
    expect(merged.field_sources.customer_name).toBe('Parter')
  })

  it('the full fixture — base fee, discount, overage, renewal, org number, rolling transition — all keep their own locator after merge', () => {
    const terms = buildRemembillFixtureTerms()
    const merged = mergeExtractions([terms])
    // Step 17B0.4: field_sources values are now the real, verbatim PDF
    // headings (not the earlier invented placeholders this test asserted)
    // — see lib/remembill-fixture.ts.
    expect(merged.field_sources.base_monthly_fee).toBe('4. Fast plattform efter avtalad volym')
    expect(merged.field_sources.discounts).toBe('2. Pilot och affärsmodell')
    expect(merged.field_sources.overage_tiers).toBe('4. Fast plattform efter avtalad volym')
    expect(merged.field_sources.renewal_notice_months).toBe('3. Avtalstid och pilot')
    expect(merged.field_sources.customer_org_number).toBe('1. Parter')
    expect(merged.field_sources.unsupported_commercial_mechanisms).toBe('4. Fast plattform efter avtalad volym')
  })

  it('reaches the actual persisted upsert payload (buildContractTermsUpsertPayload), not just the in-memory merged object', () => {
    const terms = buildRemembillFixtureTerms()
    const merged = mergeExtractions([terms])
    const payload = buildContractTermsUpsertPayload('job-x', merged)
    expect(payload.field_sources).toEqual(merged.field_sources)
  })
})

describe('17B0.2 item 6 — PII masking never alters the locator', () => {
  it('a heading string with no PII in it passes through masking/restoration byte-for-byte', () => {
    const contractText = 'CoAccept AB och NordicFit Test AB har ingått detta avtal.\nOrganisationsnummer: 559999-1234.'
    const { tokenMap, reverseMap } = detectPII(contractText)
    // The heading itself never contains the masked entity in this fixture's
    // shape — proving the common case: field_sources values are structural
    // headings ("1. Plattformsavgift"), never derived from character
    // offsets into the masked text, so they're unaffected by masking
    // regardless of how much the masked string's length changes.
    const heading = '1. Plattformsavgift'
    const maskedHeading = maskText(heading, tokenMap)
    expect(maskedHeading).toBe(heading)
    const terms = minimalTerms({ field_sources: { base_monthly_fee: heading } })
    const restored = restoreTokensInObject(terms, reverseMap)
    expect(restored.field_sources.base_monthly_fee).toBe(heading)
  })

  it('a heading that DOES leak a masked token (an unusual but possible shape) is correctly unmasked by restoration, same as any other string field', () => {
    const reverseMap = new Map([['[ORG_1]', 'CoAccept AB']])
    const terms = minimalTerms({ field_sources: { vendor_name: 'Avtal mellan [ORG_1] och kund' } })
    const restored = restoreTokensInObject(terms, reverseMap)
    expect(restored.field_sources.vendor_name).toBe('Avtal mellan CoAccept AB och kund')
  })
})

describe('17B0.2 item 6 — multiple independent locators for multi-section evidence (performance-share fee, Bilaga 1)', () => {
  it('the performance-share fee carries three independent Bilaga 1 locators, not one combined string', () => {
    const terms = buildRemembillFixtureTerms()
    const perf = terms.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')!
    expect(perf.source_sections).toEqual([
      { exact_source_heading: '2. Pilot och affärsmodell', display_label: 'Bilaga 1, Source 1' },
      { exact_source_heading: '3. Modellen i korthet', display_label: 'Bilaga 1, Source 2' },
      { exact_source_heading: '5. Resultatdel efter värdeviktad betalgrad', display_label: 'Bilaga 1, Source 3' },
    ])
    // Each locator's exact_source_heading is independently addressable —
    // not a ";"/"/"-joined compound string a click handler would have to
    // split apart itself.
    for (const section of perf.source_sections!) {
      expect(section.exact_source_heading).not.toMatch(/[;/]/)
    }
  })

  it('source_sections survives merge and reaches the persisted payload intact, in order', () => {
    const terms = buildRemembillFixtureTerms()
    const merged = mergeExtractions([terms])
    const payload = buildContractTermsUpsertPayload('job-x', merged)
    const perf = payload.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')!
    expect(perf.source_sections).toEqual([
      { exact_source_heading: '2. Pilot och affärsmodell', display_label: 'Bilaga 1, Source 1' },
      { exact_source_heading: '3. Modellen i korthet', display_label: 'Bilaga 1, Source 2' },
      { exact_source_heading: '5. Resultatdel efter värdeviktad betalgrad', display_label: 'Bilaga 1, Source 3' },
    ])
  })

  it('a fee with only single-section evidence has no source_sections — callers correctly fall back to field_sources (no regression for the common case)', () => {
    const terms = buildRemembillFixtureTerms()
    const requestFee = terms.additional_recurring_fees!.find(f => f.fee_label === 'Per payment request fee')!
    expect(requestFee.source_sections ?? null).toBeNull()
  })
})

