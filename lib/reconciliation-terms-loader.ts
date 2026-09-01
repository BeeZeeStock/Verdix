// Step 17H.4B0D4H1B3.2 — the single canonical "full reconciliation terms"
// column set and loader, shared by every route that must build fresh line
// items and/or plan a Model B+ reconciliation from PERSISTED contract_terms
// (never a pre-write in-memory object, which DB normalization/defaults may
// have altered — see loadFullReconciliationTermsForJob's own comment).
//
// Exists specifically to close a real, recurring bug CLASS: confirm-rule's
// own base_fee_proration reconciliation call (17H.4B0D4H1B2) originally
// selected a hand-picked column list that omitted overage_tiers/
// one_time_fees/escalators entirely (fixed in 17H.4B0D4H1B2/.1's own
// report) — and, found again while auditing for 17H.4B0D4H1B3.2, that same
// hand-picked list ALSO omitted `discounts`, even though buildLineItems's
// own recurring-base-fee loop calls computeDiscountMultiplier(terms, d)
// (lib/tariff.ts), which reads terms.discounts directly. Two independent
// omissions from two independent ad hoc selects — the exact pattern a
// single canonical list is meant to make structurally impossible going
// forward: every caller building freshItems or a ReconciliationTermsContext
// must go through this one function, not its own SELECT.
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildLineItems } from './line-items'
import type { ContractTerms } from './types'

// Every field buildLineItems (lib/line-items.ts) or the pure calculation
// primitives it calls (computeMonthlyBaseRate/computeEscalatorMultiplier/
// computeDiscountMultiplier, lib/tariff.ts) reads from a ContractTerms
// object, PLUS the three fields planCurrentLineItemReconciliation's own
// ReconciliationTermsContext needs (overage_tiers/additional_recurring_
// fees/base_fee_proration — a subset already covered below). Re-audit both
// call graphs directly before ever removing a field from this list.
export const FULL_RECONCILIATION_TERMS_COLUMNS = [
  'base_monthly_fee', 'base_annual_fee', 'ramp_schedule', 'year_pricing',
  'contract_start_date', 'contract_end_date', 'contract_term_months', 'billing_frequency',
  'currency', 'field_sources', 'extraction_confidence',
  'base_fee_proration', 'additional_recurring_fees', 'overage_tiers', 'one_time_fees', 'escalators',
  'discounts',
].join(', ')

export type FullReconciliationTerms = Pick<
  ContractTerms,
  'base_monthly_fee' | 'base_annual_fee' | 'ramp_schedule' | 'year_pricing'
  | 'contract_start_date' | 'contract_end_date' | 'contract_term_months' | 'billing_frequency'
  | 'currency' | 'field_sources' | 'extraction_confidence'
  | 'base_fee_proration' | 'additional_recurring_fees' | 'overage_tiers' | 'one_time_fees' | 'escalators'
  | 'discounts'
>

export interface LoadedReconciliationTerms {
  terms: FullReconciliationTerms
  currency: string
}

// Reads the AUTHORITATIVE, PERSISTED contract_terms row for a job — never
// an in-memory pre-write object a caller happens to still be holding.
// Deliberately queried by job_id (contract_terms has a unique constraint
// on job_id — one canonical row per job, see execute/route.ts's own
// comment on buildContractTermsUpsertPayload) rather than requiring the
// caller to already know the row's own id, so every caller (which always
// has jobId) can use this identically. Returns null when no contract_terms
// row exists for the job at all — callers must treat that as a hard
// failure (never silently skip reconciliation), since a route that just
// wrote contract_terms successfully but finds nothing here means something
// is deeply wrong (e.g. update() silently matched zero rows).
export async function loadFullReconciliationTermsForJob(
  supabase: SupabaseClient, jobId: string,
): Promise<LoadedReconciliationTerms | null> {
  const { data: rawTerms } = await supabase
    .from('contract_terms')
    .select(FULL_RECONCILIATION_TERMS_COLUMNS)
    .eq('job_id', jobId)
    .maybeSingle()
  if (!rawTerms) return null
  const terms = rawTerms as unknown as FullReconciliationTerms

  const { data: jobRow } = await supabase.from('jobs').select('currency').eq('id', jobId).maybeSingle()
  const currency = (jobRow?.currency as string | undefined) ?? (terms.currency as string | undefined) ?? 'USD'

  return { terms, currency }
}

// Thin convenience wrapper — load + buildLineItems in one call, for the
// common case where a caller needs freshItems and nothing else from the
// loaded terms directly.
export async function buildFreshLineItemsFromPersistedTerms(
  supabase: SupabaseClient, jobId: string,
): Promise<{ freshItems: ReturnType<typeof buildLineItems>; loaded: LoadedReconciliationTerms } | null> {
  const loaded = await loadFullReconciliationTermsForJob(supabase, jobId)
  if (!loaded) return null
  const freshItems = buildLineItems(loaded.terms as unknown as Parameters<typeof buildLineItems>[0], loaded.currency)
  return { freshItems, loaded }
}
