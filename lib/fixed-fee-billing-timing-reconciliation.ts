// Step 17F.4, item 2 — the explicit, idempotent RETROACTIVE backfill path
// for a contract extracted before fixed_fee_billing_timing existed (Step
// 17F.3, item 2/8). lib/contract-extractor.ts's own
// flagUnresolvedFixedFeeBillingTiming already does the equivalent thing at
// FRESH-extraction time; this is the same, deliberately trivial logic
// exposed as its own pure, reusable, separately-tested function for
// ALREADY-extracted jobs — mirrors lib/semantic-input-key-reconciliation.ts's
// exact precedent (Step 17F.1, item 1): a pure plan function here, an
// explicit POST-only write path in the API route, never triggered on GET.
//
// Deliberately NOT an inference engine: there is nothing to infer. The
// backfilled rule is always the SAME unconditional unresolved default
// (timing: 'unclear', requires_confirmation: true) — never derived from
// planned_invoices dates, scheduler behavior, billing_frequency, or
// payment_terms_days/payment_terms_text. A contract whose extraction DID
// produce a genuine structured answer (requires_confirmation: false, or
// an explicit timing already recorded) is left completely untouched.
import type { FixedFeeBillingTimingRule } from './types'

export interface FixedFeeBillingTimingReconciliationTerms {
  base_monthly_fee?: number | null
  base_annual_fee?: number | null
  fixed_fee_billing_timing?: FixedFeeBillingTimingRule | null
  base_fee_proration?: { source_clause?: string | null } | null
}

export interface FixedFeeBillingTimingReconciliationPlan {
  needsBackfill: boolean
  rule: FixedFeeBillingTimingRule | null
}

export function planFixedFeeBillingTimingReconciliation(
  terms: FixedFeeBillingTimingReconciliationTerms,
): FixedFeeBillingTimingReconciliationPlan {
  // Already has a rule — resolved or genuinely still open, either way this
  // is not this reconciliation's job to touch. Only a contract with NO
  // rule at all (the pre-17F.3 extraction-artifact shape) qualifies.
  if (terms.fixed_fee_billing_timing) return { needsBackfill: false, rule: null }
  // No fixed fee at all — nothing to time.
  if (!terms.base_monthly_fee && !terms.base_annual_fee) return { needsBackfill: false, rule: null }

  return {
    needsBackfill: true,
    rule: {
      timing: 'unclear',
      requires_confirmation: true,
      confirmation_reason: 'The agreement does not state whether the recurring fixed fee is invoiced at the beginning or the end of its billing period.',
      source_clause: terms.base_fee_proration?.source_clause ?? null,
    },
  }
}
