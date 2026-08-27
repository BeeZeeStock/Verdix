// Step 17B0.2 — extracted from app/api/jobs/[id]/execute/route.ts so the
// exact object shape written to contract_terms is directly unit-testable
// (no precedent in this codebase for mocking supabaseServer to test a
// route handler directly — same convention lib/line-items.ts and
// lib/discount-component-targeting.ts already established).
//
// This exists because of a real, confirmed bug: several ContractTerms
// fields (customer_org_number, renewal_notice_months,
// unsupported_commercial_mechanisms, ...) were added to lib/types.ts but
// never migrated onto the contract_terms table, and the upsert this
// function replaces picked columns explicitly, so those fields were
// silently excluded from every write — correct in the merged in-memory
// object, invisible in the database and everywhere downstream of it. A
// unit test asserting on THIS function's return value is what actually
// catches that class of bug — a test on ContractTerms alone (mergeExtractions,
// restoreTokensInObject, ...) cannot, because the object itself was always
// correct; only the translation into the persisted row was silently lossy.
import type { ContractTerms } from './types'

export function buildContractTermsUpsertPayload(jobId: string, terms: ContractTerms) {
  return {
    job_id: jobId,
    // Identity
    contract_id: terms.contract_id,
    crm_id: terms.crm_id,
    customer_name: terms.customer_name,
    customer_address: terms.customer_address,
    customer_email: terms.customer_email,
    customer_org_number: terms.customer_org_number,
    billing_contact: terms.billing_contact,
    vendor_name: terms.vendor_name,
    vendor_address: terms.vendor_address,
    // Dates & term
    order_date: terms.order_date,
    contract_start_date: terms.contract_start_date,
    contract_end_date: terms.contract_end_date,
    contract_term_months: terms.contract_term_months,
    auto_renews: terms.auto_renews,
    renewal_notice_days: terms.renewal_notice_days,
    renewal_notice_months: terms.renewal_notice_months,
    renewal_term_months: terms.renewal_term_months,
    // Pricing
    currency: terms.currency,
    base_monthly_fee: terms.base_monthly_fee,
    base_annual_fee: terms.base_annual_fee,
    base_fee_bands: terms.base_fee_bands ?? null,
    base_fee_committed_volume: terms.base_fee_committed_volume ?? null,
    billing_frequency: terms.billing_frequency,
    payment_terms_days: terms.payment_terms_days,
    payment_terms_text: terms.payment_terms_text,
    included_units: terms.included_units,
    included_unit_type: terms.included_unit_type,
    year_pricing: terms.year_pricing,
    base_fee_proration: terms.base_fee_proration ?? null,
    ramp_schedule: terms.ramp_schedule ?? null,
    // Structured arrays
    escalators: terms.escalators ?? [],
    discounts: terms.discounts ?? [],
    service_credits: terms.service_credits ?? [],
    credit_application_priority: terms.credit_application_priority ?? null,
    overage_tiers: terms.overage_tiers ?? [],
    one_time_fees: terms.one_time_fees ?? [],
    additional_recurring_fees: terms.additional_recurring_fees ?? [],
    unsupported_commercial_mechanisms: terms.unsupported_commercial_mechanisms ?? [],
    billing_metered_items: terms.billing_metered_items ?? [],
    // Metadata
    field_sources: terms.field_sources ?? {},
    extraction_confidence: terms.extraction_confidence,
    extraction_notes: terms.extraction_notes,
    number_format: terms.number_format ?? 'dot',
    // Full LLM output preserved for future fields
    raw_extraction: terms,
  }
}
