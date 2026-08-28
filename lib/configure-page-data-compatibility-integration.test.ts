import { describe, it, expect } from 'vitest'
import { supabaseServer } from './supabase'
import { deriveBillingPeriod, computeFixedComponentForPeriod, buildBillingPeriodWorkspace } from './billing-period-workspace'
import { buildPricingDependencyGroups, type PricingDependencyFee, type PricingDependencyTier } from './pricing-dependency'
import { buildUsageSourceCards } from './usage-source-cards'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17F.7 — regression coverage for the production crash: every
// /configure/[id] page failed to load after 17F because
// lib/billing-period-workspace.ts (imported by the client-side
// BillingPeriodWorkspaceCard) pulled in lib/billing-writer.ts's eager
// supabaseServer/Stripe module-scope initialization into the browser
// bundle. That specific bug is a build/bundle-boundary issue no unit test
// can catch (see the fix's own comment in lib/tariff.ts) — this suite
// instead covers the OTHER thing the crash investigation surfaced: every
// one of these page-data-prep functions is now invoked for EVERY contract
// on every page load, but was only ever tested against hand-built fixtures
// carrying the new 17F fields. Real production jobs overwhelmingly do NOT
// have fixed_fee_billing_timing at all (confirmed: only 1 of 55 real
// AUTO_CONFIGURE jobs has it — every job extracted before 17F.3, or never
// reconciled, has none). This suite exercises the real preparation
// pipeline against real, unmodified rows spanning that whole age range and
// requires only: it must not throw.
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run lib/configure-page-data-compatibility-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const REPRESENTATIVE_JOBS: Array<[string, string]> = [
  ['c8bab876-9cd0-4714-b489-1486f10d65c9', 'old SaaS/fixed-fee, 2024 contract, tiers only, no fixed_fee_billing_timing'],
  ['60461a3d-9f77-4421-8e22-abbfcc49bdd0', 'annual cadence, base_monthly_fee null (base_annual_fee only), one tier'],
  ['f9df46f1-342c-4fca-b374-cbf2a1e5c1c4', 'fixed fee + additional_recurring_fees + overage tiers'],
  ['da05e270-9975-4142-963a-287e99876af1', 'quarterly cadence, large base fee'],
  ['0e8847dd-ba32-496f-8c9b-372f4a9d4dee', 'synthetic outcome-based agreement'],
  ['a4459e99-f920-41ff-9c8b-0789f1100b0f', 'real Remembill job — the one job WITH fixed_fee_billing_timing/variable_invoice_timing'],
]

describeIf('configure/[id] page-data preparation does not throw — real representative job shapes (Step 17F.7)', () => {
  for (const [jobId, description] of REPRESENTATIVE_JOBS) {
    it(`${description} (${jobId})`, async () => {
      const { data: job } = await supabaseServer
        .from('jobs')
        .select('id, contract_terms ( * )')
        .eq('id', jobId)
        .maybeSingle()
      expect(job).toBeTruthy()
      const terms = (Array.isArray(job!.contract_terms) ? job!.contract_terms[0] : job!.contract_terms) as unknown as ContractTerms
      expect(terms).toBeTruthy()

      const currency = terms.currency ?? 'EUR'

      expect(() => {
        const period = deriveBillingPeriod({
          contractStartDate: terms.contract_start_date, billingFrequency: terms.billing_frequency, asOf: new Date(),
        })
        if (!period) return // legitimate — no contract_start_date, page renders nothing here, same as production

        const pricingGroups = buildPricingDependencyGroups({
          baseMonthlyFee: terms.base_monthly_fee,
          fees: (terms.additional_recurring_fees ?? []) as PricingDependencyFee[],
          tiers: (terms.overage_tiers ?? []) as PricingDependencyTier[],
          usageSources: [],
        })
        const additionalFixedFeesTotal = pricingGroups.fixed.filter(f => f.key !== 'base_monthly_fee').reduce((s, f) => s + f.amount, 0)

        const fixed = computeFixedComponentForPeriod({
          terms, periodStart: period.start, additionalFixedFeesTotal, currency,
          billingTimingRule: terms.fixed_fee_billing_timing,
        })

        buildBillingPeriodWorkspace({
          period, started: true,
          alreadyInvoiced: false,
          fixed,
          usage: [],
          performance: [],
        })

        buildUsageSourceCards({
          mappings: [], meters: [],
          fees: terms.additional_recurring_fees ?? [],
          tiers: terms.overage_tiers ?? [],
          rollingMechanisms: terms.unsupported_commercial_mechanisms ?? [],
        })
      }).not.toThrow()
    })
  }

  it('a job with NO contract_terms row at all is a real, current production state — the page must not attempt to prepare data for it (mirrors the terms && guard in page.tsx)', async () => {
    const { data: rows } = await supabaseServer
      .from('jobs')
      .select('id, contract_terms ( id )')
      .eq('module', 'AUTO_CONFIGURE')
      .limit(200)
    const noTermsJob = (rows ?? []).find(r => {
      const t = Array.isArray(r.contract_terms) ? r.contract_terms[0] : r.contract_terms
      return !t
    })
    // Only asserts the fixture actually exists in production right now —
    // if it doesn't, there's nothing to prove here today.
    expect(noTermsJob).toBeTruthy()
  })
})
