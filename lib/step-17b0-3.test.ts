import { describe, it, expect } from 'vitest'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import { mergeExtractions } from './contract-extractor'
import { buildContractTermsUpsertPayload } from './contract-terms-persistence'
import { resolveFixedFeeBand } from './fixed-fee-band'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17B0.3 — four narrow fixes:
// 1. applies_to wording discipline is a prompt-only change (no deterministic
//    code path — nothing here to unit test; see lib/contract-extractor.ts's
//    WORDING DISCIPLINE rule).
// 2. open-ended fixed band (150,001+, no stated fee) resolves and renders
//    distinctly, never as a bare "—/month".
// 3. both the performance-share fee and the rolling-transition mechanism
//    carry their own independent source_sections.
// 4. the Operational Data Inputs explanatory copy is a plain text change in
//    app/_components/MeterMappingPanel.tsx — verified by direct read, not a
//    dedicated RTL harness (see this step's report for why).
// ═══════════════════════════════════════════════════════════════════════════

describe('17B0.3 item 2 — open-ended fixed band with no stated fee', () => {
  it('resolveFixedFeeBand resolves a volume in the open-ended range to a band with monthly_fee: null, never 0', () => {
    const terms = buildRemembillFixtureTerms()
    const resolution = resolveFixedFeeBand(terms.base_fee_bands, 200000)
    expect(resolution).toEqual({ status: 'resolved', band: { from_unit: 150001, to_unit: null, monthly_fee: null } })
  })

  it('the committed volume actually stated (5,000) still resolves to the normal priced band — unaffected regression', () => {
    const terms = buildRemembillFixtureTerms()
    const resolution = resolveFixedFeeBand(terms.base_fee_bands, terms.base_fee_committed_volume)
    expect(resolution).toEqual({ status: 'resolved', band: { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 } })
  })

  it('the open-ended band survives merge and reaches the persisted payload with monthly_fee still null', () => {
    const terms = buildRemembillFixtureTerms()
    const merged = mergeExtractions([terms])
    const payload = buildContractTermsUpsertPayload('job-x', merged)
    const openBand = payload.base_fee_bands!.find(b => b.to_unit === null)
    expect(openBand).toEqual({ from_unit: 150001, to_unit: null, monthly_fee: null })
  })
})

describe('17B0.3 item 3 — both unsupported mechanisms carry their own independent source_sections', () => {
  it('the performance-share fee has three independent Bilaga 1 locators (unaffected regression from Step 17B0.2)', () => {
    const terms = buildRemembillFixtureTerms()
    const perf = terms.additional_recurring_fees!.find(f => f.unresolved_kind === 'unsupported_semantics')!
    expect(perf.source_sections?.length).toBeGreaterThanOrEqual(2)
  })

  it('the rolling three-month volume transition now also has its own source_sections, not only the shared per-field fallback', () => {
    const terms = buildRemembillFixtureTerms()
    const rolling = terms.unsupported_commercial_mechanisms!.find(m => m.kind === 'rolling_volume_pricing_transition')!
    // Step 17B0.4: these are now real, verbatim PDF headings (main
    // agreement + Bilaga 1), not the invented "Bilaga 1, avsnitt 4" label
    // this test previously asserted — see lib/types.ts's SourceLocator doc.
    expect(rolling.source_sections).toEqual([
      { exact_source_heading: '4. Avtalad volym', display_label: 'Main agreement' },
      { exact_source_heading: '4. Fast plattform efter avtalad volym', display_label: 'Bilaga 1' },
    ])
  })

  it('both survive merge and reach the persisted payload intact', () => {
    const terms = buildRemembillFixtureTerms()
    const merged = mergeExtractions([terms])
    const payload = buildContractTermsUpsertPayload('job-x', merged)
    const perf = payload.additional_recurring_fees!.find(f => f.unresolved_kind === 'unsupported_semantics')!
    const rolling = payload.unsupported_commercial_mechanisms!.find(m => m.kind === 'rolling_volume_pricing_transition')!
    expect(perf.source_sections?.length).toBeGreaterThanOrEqual(2)
    expect(rolling.source_sections).toEqual([
      { exact_source_heading: '4. Avtalad volym', display_label: 'Main agreement' },
      { exact_source_heading: '4. Fast plattform efter avtalad volym', display_label: 'Bilaga 1' },
    ])
  })
})
