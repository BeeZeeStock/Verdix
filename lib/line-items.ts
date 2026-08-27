// Customer-facing job line-item preview/TCV display — extracted from
// app/api/jobs/[id]/execute/route.ts (Step 17A) so it can be unit-tested
// directly with a constructed ContractTerms fixture, without importing a
// whole Next.js route module (Stripe/Remembill/AI-client imports and
// side-effect-bearing module init that has no place in a fast unit test).
//
// Deliberately distinct from lib/billing-writer.ts, which is Verdix's OWN
// SaaS billing engine (see CLAUDE.md's "two layers of billing" note) — this
// file reuses a few of billing-writer.ts's pure calculation primitives
// (computeMonthlyBaseRate/computeEscalatorMultiplier/computeDiscountMultiplier/
// monthCursor) because the math is genuinely identical, but owns none of
// Verdix's own billing concerns and must never be merged into that file.
import { computeMonthlyBaseRate, computeEscalatorMultiplier, computeDiscountMultiplier, monthCursor } from './billing-writer'
import { billingInterval } from './stripe-meter'
import type { ContractTerms } from './types'

export function buildLineItems(terms: ContractTerms, currency: string) {
  const items = []
  const cur = terms.currency || currency
  const src = terms.field_sources ?? {}
  const conf = terms.extraction_confidence === 'high' ? 0.97 : terms.extraction_confidence === 'medium' ? 0.82 : 0.62

  // Recurring base fee — one line item per distinct rate block, on the
  // contract's *actual* billing cadence (monthly/quarterly/...), not always
  // bucketed by calendar year regardless of whether the rate changed within
  // it. Rate logic (ramp schedule → year pricing → flat fee, with compound
  // escalation and any dated discount) mirrors computeBillingSchedule
  // (lib/billing-writer.ts) — the same function real billing (Stripe/
  // Remembill) uses to generate actual invoices — so this display can never
  // disagree with what's really charged (previously it ignored discounts
  // entirely, so a contract with an intro discount showed a higher Base TCV
  // than what actually got billed). Consecutive periods at the same rate
  // collapse into one row; a new row starts wherever the rate actually
  // changes (an escalator/ramp step, or a discount window's edge), so a
  // flat-rate contract shows a single "12 × monthly" row instead of one
  // "Year 1" row per calendar year. quantity stays the number of cycles and
  // unit_price the per-cycle rate (not pre-multiplied) — several billing
  // connectors (e.g. Chargebee) read these fields as literal per-cycle
  // subscription quantities, so only total_amount should ever hold the
  // full-term figure. Falls back to a single flat item when contract dates
  // are missing and a schedule can't be computed.
  const contractStart = terms.contract_start_date ? new Date(terms.contract_start_date + 'T00:00:00') : null
  let termMonths = terms.contract_term_months ?? 0
  if (!termMonths && contractStart && terms.contract_end_date) {
    const ce = new Date(terms.contract_end_date + 'T00:00:00')
    termMonths = (ce.getFullYear() - contractStart.getFullYear()) * 12 + (ce.getMonth() - contractStart.getMonth()) + 1
  }
  const hasRecurringBase = !!(terms.base_monthly_fee || terms.base_annual_fee || terms.ramp_schedule?.length || terms.year_pricing)

  if (hasRecurringBase && contractStart && termMonths > 0) {
    const { interval, intervalCount } = billingInterval(terms.billing_frequency)
    const monthsPerPeriod = interval === 'year' ? 12 * intervalCount : intervalCount
    const freq = terms.billing_frequency ?? 'monthly'

    const periodAmounts: number[] = []
    let monthsUsed = 0
    while (monthsUsed < termMonths) {
      const monthsInThisPeriod = Math.min(monthsPerPeriod, termMonths - monthsUsed)
      let amount = 0
      for (let mi = 0; mi < monthsInThisPeriod; mi++) {
        const globalMonthIdx = monthsUsed + mi
        const d = monthCursor(contractStart, globalMonthIdx)
        amount += computeMonthlyBaseRate(terms, globalMonthIdx, d) * computeEscalatorMultiplier(terms, d) * computeDiscountMultiplier(terms, d)
      }
      periodAmounts.push(amount)
      monthsUsed += monthsInThisPeriod
    }

    let i = 0
    while (i < periodAmounts.length) {
      const rate = periodAmounts[i]
      let j = i
      while (j < periodAmounts.length && Math.abs(periodAmounts[j] - rate) < 0.005) j++
      const periodCount = j - i
      if (rate > 0) {
        const rounded = Math.round(rate * 100) / 100
        items.push({
          product_name: periodCount === periodAmounts.length ? 'Recurring base fee' : `Recurring base fee (periods ${i + 1}–${j})`,
          quantity: periodCount,
          unit_price: rounded,
          billing_period: freq,
          total_amount: Math.round(rate * periodCount * 100) / 100,
          currency: cur,
          confidence_score: conf,
          source_section: src.base_monthly_fee ?? src.year_pricing ?? src.ramp_schedule ?? null,
        })
      }
      i = j
    }
  } else if (terms.base_monthly_fee) {
    items.push({
      product_name: 'Base subscription',
      quantity: 1,
      unit_price: terms.base_monthly_fee,
      billing_period: 'monthly',
      total_amount: terms.base_monthly_fee,
      currency: cur,
      confidence_score: conf,
      source_section: src.base_monthly_fee ?? null,
    })
  }

  // Additional recurring fees (e.g. support tier, add-on modules billed
  // separately) — represented the same way as the base fee above: quantity
  // is the number of billing cycles over the term, unit_price the flat
  // per-cycle amount (not escalated — matches the existing display
  // convention), and total_amount their full contribution to TCV.
  for (const fee of terms.additional_recurring_fees ?? []) {
    // Step 17A, item 7 — a per-unit/variable-rate fee (metric_name +
    // rate_per_unit both populated — see lib/contract-extractor.ts's own
    // enforceVariableRateFeeShape, which already forces amount to 0 for
    // this shape regardless of what extraction produced) has NO fixed
    // quantity at all until real operational usage data exists. The
    // contract's own billing-cycle count (periodCount) is NEVER a stand-in
    // for an operational count — enforced structurally here, not merely by
    // the extraction prompt being followed.
    const isVariableRate = !!fee.metric_name && typeof fee.rate_per_unit === 'number' && fee.rate_per_unit > 0
    if (!fee.amount && !isVariableRate) continue
    const feeFreq = terms.billing_frequency ?? 'monthly'
    const { interval, intervalCount } = billingInterval(feeFreq)
    const feeMonthsPerPeriod = interval === 'year' ? 12 * intervalCount : intervalCount
    const periodCount = termMonths > 0 && feeMonthsPerPeriod > 0 ? Math.ceil(termMonths / feeMonthsPerPeriod) : 1
    items.push({
      product_name: fee.fee_label,
      // Mirrors one_time_fees' own isParked convention below: still
      // visible (so a reviewer/UI can see the rate and metric), never
      // contributing a quantity/amount until usage data supplies a real
      // count — quantity 0 / total 0 is the "operational, unresolved"
      // representation, not an invented committed figure.
      quantity: isVariableRate ? 0 : periodCount,
      unit_price: isVariableRate ? (fee.rate_per_unit ?? 0) : fee.amount,
      billing_period: feeFreq,
      total_amount: isVariableRate ? 0 : Math.round(fee.amount * periodCount * 100) / 100,
      currency: cur,
      confidence_score: conf,
      source_section: src.additional_recurring_fees ?? src.base_monthly_fee ?? null,
    })
  }

  for (const tier of terms.overage_tiers ?? []) {
    items.push({
      // tier_label already fully describes the tier per the extraction
      // prompt's own rules (e.g. "SMS reminders 501–2,000" or "... —
      // included in base fee") — appending "— overage" here duplicated that
      // description instead of adding information ("... — overage —
      // overage", "... — included in base fee — overage").
      product_name: tier.tier_label,
      quantity: 0,
      unit_price: tier.rate_per_unit,
      // A tier can be measured/charged on its own cadence, distinct from the
      // contract's overall billing_frequency (e.g. a quarterly-measured
      // metric inside a monthly-invoiced contract) — show that cadence, not
      // a hardcoded 'monthly' that silently disagreed with the contract text.
      billing_period: tier.measurement_period ?? terms.billing_frequency ?? 'monthly',
      total_amount: 0,
      currency: cur,
      // Previously hardcoded to 0.88 regardless of how explicitly the
      // contract stated the rate — an unambiguous per-unit price (e.g.
      // "SEK 195 per chargeback") was flagged "Needs confirmation" purely
      // because 0.88 < the 0.95 review threshold. Use the same
      // extraction-confidence signal as every other line item kind above.
      confidence_score: conf,
      source_section: src.overage_tiers ?? null,
    })
  }

  for (const fee of (terms.one_time_fees ?? []) as Array<typeof terms.one_time_fees[0] & { manual_trigger?: boolean; rate_per_unit?: number | null; metric_name?: string | null }>) {
    const isParked = fee.manual_trigger && fee.amount === 0
    items.push({
      product_name: fee.fee_label,
      quantity: isParked ? 0 : 1,
      unit_price: isParked ? (fee.rate_per_unit ?? 0) : fee.amount,
      billing_period: 'one_time',
      total_amount: fee.amount,
      currency: cur,
      confidence_score: conf,
      source_section: src.one_time_fees ?? null,
    })
  }

  for (const escalator of terms.escalators ?? []) {
    items.push({
      product_name: `Price escalator (${escalator.escalator_pct ?? ''}% ${escalator.escalator_type})`,
      quantity: 1,
      unit_price: 0,
      billing_period: 'annual',
      total_amount: 0,
      currency: cur,
      confidence_score: conf > 0.9 ? 0.94 : 0.72,
      source_section: src.escalators ?? null,
    })
  }

  return items
}
