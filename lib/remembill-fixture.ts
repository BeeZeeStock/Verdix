// Step 17A, item 15 — the Remembill_Kundavtal_SV.pdf regression fixture.
//
// This is a SYNTHETIC, sanitized ContractTerms object representing the
// CORRECT extraction result this step's fixes target — not a raw-PDF-text
// fixture. Real AI extraction (lib/contract-extractor.ts's live Bedrock/
// Claude call) is never invoked in this test suite (same "no provider
// execution / no live AI calls" discipline used throughout this codebase's
// tests); this fixture instead proves the DETERMINISTIC downstream
// pipeline (buildLineItems, computeCommittedFixedFees, resolveFixedFeeBand,
// computeMetricOverage) produces the correct commercial result GIVEN a
// correctly-shaped extraction — which is what lib/contract-extractor.ts's
// prompt guidance (items 7/8/10/11/12/13) is aimed at producing, and what
// lib/pii-detector.ts (items 2/3/4/5) is aimed at protecting from ever
// being masked.
import type { ContractTerms } from './types'

export function buildRemembillFixtureTerms(): ContractTerms {
  return {
    contract_id: null,
    crm_id: null,
    customer_name: 'NordicFit Test AB',
    customer_address: null,
    billing_contact: null,
    vendor_name: 'CoAccept AB',
    vendor_address: null,
    order_date: '2026-10-01',
    contract_start_date: '2026-10-01',
    contract_end_date: '2027-09-30',
    contract_term_months: 12,
    auto_renews: true,
    renewal_notice_days: null,
    // Item 10 — the contract states THREE MONTHS, preserved as months, not
    // silently converted to a day count.
    renewal_notice_months: 3,
    customer_email: null,
    customer_org_number: '559999-1234', // item 4 — an ORGANIZATION_IDENTIFIER in the PII layer, never PERSON/SSN
    renewal_term_months: 12,
    currency: 'EUR',
    // Item 13 — base_monthly_fee is the SELECTED band's fee; the full
    // table and the committed volume that selected it are preserved
    // separately, not flattened away.
    base_monthly_fee: 2000,
    base_annual_fee: null,
    base_fee_committed_volume: 5000,
    base_fee_bands: [
      { from_unit: 1, to_unit: 500, monthly_fee: 500 },
      { from_unit: 501, to_unit: 1500, monthly_fee: 1200 },
      { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 },
    ],
    // Hardening item 1 (review pass 3) — a SEPARATE Decision Required from
    // the pilot's own scope (discounts[0] above): once the 90-day waiver
    // ends mid-cycle (start 2026-10-01 + 90 days = 2026-12-29, not a clean
    // month boundary), how the platform fee applies to that partial period
    // is not stated. Reuses PeriodProrationRule as-is (no new field) —
    // reset_anchor describes the fee's real billing cadence (contract_start
    // — Remembill has no calendar-boundary language at all), while
    // prorate_partial_periods/requires_confirmation carry the actual open
    // question, triggered by the waiver's expiry rather than by a
    // calendar/contract-start mismatch (see lib/contract-extractor.ts's
    // base_fee_proration guidance, trigger (b)).
    base_fee_proration: {
      reset_anchor: 'contract_start',
      prorate_partial_periods: 'unclear',
      requires_confirmation: true,
      confirmation_reason: 'Pilot waiver on the fixed platform fee ends 90 days after contract start (2026-12-29), which does not align with the fee\'s normal monthly cadence — the contract does not state whether the resumed platform fee is prorated for the remainder of that period or begins in full from the next full billing period.',
      source_clause: 'Övergång till ordinarie plattformsavgift sker efter pilotperiodens utgång.',
    },
    billing_frequency: 'monthly',
    payment_terms_days: 30,
    payment_terms_text: 'Payment due within thirty (30) days of invoice date',
    included_units: 5000,
    included_unit_type: 'payment requests',
    year_pricing: null,
    ramp_schedule: null,
    escalators: [],
    discounts: [
      {
        discount_rule_id: 'pilot-waiver',
        discount_pct: 100,
        discount_amount: null,
        discount_type: 'introductory',
        // Item 8/9 — a day-stated pilot duration with no clean month
        // boundary: duration_days is populated, duration_months/end_date
        // are NOT guessed. applies_to names only the FIXED component
        // (item 9's hybrid-fee scope rule) — the interpretation itself
        // (state: decision_required) lives downstream in the review
        // pipeline, not on this bare extracted record.
        start_date: '2026-10-01',
        end_date: null,
        duration_months: null,
        duration_days: 90,
        applies_to: 'fixed platform fee',
        description: '90-day pilot period with no fixed platform fee. Hybrid platform charge separately includes a performance-based component — see additional_recurring_fees.',
        // Hardening item 1 (review pass 6) — TYPED targeting, the sole
        // authority lib/committed-fixed-fee-resolver.ts consults (never
        // applies_to's free text above, which stays purely for human
        // display/audit). The 100% waiver definitely, structurally covers
        // the fixed recurring fee — extracted unambiguously from "no fixed
        // platform fee" — while whether it ALSO extends to the separate
        // performance component is the genuinely open scope question
        // (item 9's hybrid-fee-scope rule), tracked as merely POSSIBLE
        // until a reviewer resolves it.
        affected_components: ['base_recurring_fee'],
        possibly_affected_components: ['performance_fee'],
      },
    ],
    service_credits: [],
    overage_tiers: [
      // Item 14 — additive: charged ONLY on requests above the contracted
      // volume, on top of (never replacing) the per-unit request fee below.
      // Hardening item 5 — exact dependency pair: the excess count AND the
      // contracted volume that defines where the excess starts.
      {
        tier_label: 'Extra payment requests above contracted volume', from_unit: 5001, to_unit: null, rate_per_unit: 0.6,
        unit_type: 'payment request', measurement_period: 'monthly', reset_anchor: 'contract_start',
        required_operational_inputs: ['issued_payment_request_count', 'contracted_volume'],
      },
    ],
    additional_recurring_fees: [
      // Item 7 — per-unit/variable-rate fees: amount 0, metric_name +
      // rate_per_unit populated, never a fixed committed quantity.
      // Hardening item 5 — each fee's required_operational_inputs is its
      // OWN exact dependency, never the other fee's.
      {
        fee_label: 'Per payment request fee', amount: 0,
        description: 'EUR 0.38 charged per issued payment request, regardless of outcome. Billed monthly.',
        metric_name: 'issued_payment_request', rate_per_unit: 0.38,
        required_operational_inputs: ['issued_payment_request_count'],
      },
      {
        fee_label: 'Success fee per completed payment', amount: 0,
        description: 'EUR 1.70 charged only upon a completed (successful) payment. Billed monthly in arrears.',
        metric_name: 'completed_payment', rate_per_unit: 1.7,
        required_operational_inputs: ['completed_payment_count'],
      },
      // Items 11/12 (refined by hardening items 4/5) — the value-weighted
      // performance mechanism: a genuine rate FORMULA this shape cannot
      // execute yet. Preserved (never dropped), flagged
      // unsupported_semantics. The formula itself (paid ÷ total invoice
      // value) lives in derived_metric — required_operational_inputs holds
      // only this fee's OWN additional direct dependency (the invoice-value
      // base the derived rate is applied to), never a blanket copy of every
      // quantity mentioned anywhere in the clause.
      {
        fee_label: 'Performance share (value-weighted payment rate)', amount: 0,
        description: 'Variable monthly fee based on value-weighted payment rate (paid invoice value / total invoice value of requests issued in the month). Rate ranges from 0.20% to 4.50%, rounded down to the nearest 5-percentage-point step. No performance share below 5% payment rate.',
        derived_metric: {
          metric_name: 'value_weighted_payment_rate',
          formula: 'paid_invoice_value_for_issued_requests / total_invoice_value_for_issued_requests',
          raw_inputs: ['paid_invoice_value_for_issued_requests', 'total_invoice_value_for_issued_requests'],
        },
        required_operational_inputs: ['total_invoice_value_for_issued_requests'],
        unresolved_kind: 'unsupported_semantics',
        source_clause: 'Betalgrad efter uppföljning är utfallet, mätt värdeviktat.',
        // Step 17B0.2, item 6 — this fee's evidence genuinely spans three
        // parts of Bilaga 1 (the rate itself, the calculation formula, and
        // the rate schedule/step table) — each keeps its own independently-
        // navigable locator rather than one heading standing in for all
        // three (see lib/types.ts's AdditionalRecurringFee.source_sections
        // and the extraction prompt's MULTI-SECTION EVIDENCE rule).
        source_sections: ['Bilaga 1, avsnitt 2', 'Bilaga 1, avsnitt 3', 'Bilaga 1, avsnitt 5'],
      },
    ],
    // Hardening item 4 (corrected in the second pass — see item 2 of that
    // review) — the rolling three-month average repricing transition is a
    // VOLUME-band migration rule, not a repricing of the value-weighted
    // performance rate: the contract says "if the three-month average is
    // above the agreed volume, the operator moves to the corresponding
    // level from the next contract period" — i.e. it re-selects which
    // base_fee_bands row applies, based on a rolling average of
    // issued_payment_request_count, NOT the paid/total invoice-value ratio
    // (that ratio belongs solely to the SEPARATE value-weighted
    // performance-share mechanism above — the two must never share
    // dependencies). Not itself a fee (no amount/rate of its own); moved
    // out of additional_recurring_fees into this semantically-correct
    // container — structurally unreachable by buildLineItems/
    // computeCommittedFixedFees (neither reads this array).
    unsupported_commercial_mechanisms: [
      {
        kind: 'rolling_volume_pricing_transition',
        description: 'If the rolling three-month average of issued payment requests exceeds the contracted/agreed volume, the platform-fee band migrates to the corresponding higher level from the next contract period onward.',
        source_clause: 'Om tremånaderssnittet överstiger avtalad volym övergår leverantören till motsvarande nivå från nästa avtalsperiod.',
        required_operational_inputs: ['issued_payment_request_count'],
        execution_status: 'unsupported',
      },
    ],
    one_time_fees: [],
    // Step 17B0.2, item 6 — realistic per-field PDF-locator headings, so
    // the fixture can prove the full extraction -> merge -> persistence ->
    // API -> GUI clause-link chain preserves them, not just the field
    // VALUES they're attached to. One from the main agreement (base fee)
    // and one from Bilaga 1 (the rolling-transition mechanism), per the
    // regression's own explicit requirement.
    field_sources: {
      base_monthly_fee: '1. Plattformsavgift',
      discounts: '1.3 Pilotperiod',
      overage_tiers: '2. Överskjutande förfrågningar',
      renewal_notice_months: '8. Avtalstid och uppsägning',
      customer_org_number: 'Parter',
      unsupported_commercial_mechanisms: 'Bilaga 1, avsnitt 4',
    },
    extraction_confidence: 'medium',
    extraction_notes: null,
    number_format: 'comma',
  }
}
