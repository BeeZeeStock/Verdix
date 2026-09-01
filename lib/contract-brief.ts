// Step 17G.2 — Contract Brief is the executive summary on /configure/[id]
// ("what is this agreement, in 20 seconds?"), a genuinely different
// purpose from Contract Overview (the detailed structured facts — org
// number, currency, exact term, billing cycle, payment terms, renewal,
// notice, committed fixed fees — all untouched, still shown separately).
// Produces 2–4 short, plain-English sentences from typed commercial facts
// only: customer/duration/dates, the broad pricing shape (fixed / usage /
// performance — only the categories actually present, never invented),
// a material pilot/discount, and a material renewal clause. Deliberately
// omits org number/billing email/CRM id/VAT/payment terms/raw field
// names, and never surfaces an unresolved billing-timing decision (that
// belongs in the Action Required / Review surface, not the executive
// brief). Pure, DB-free.
import { describeDiscountForBrief, type DiscountForBrief } from './discount-brief-summary'

export interface ContractBriefFee {
  rate_per_unit?: number | null
  percentage_of_basis?: unknown
}

export interface ContractBriefTerms {
  customer_name?: string | null
  contract_term_months?: number | null
  contract_start_date?: string | null
  contract_end_date?: string | null
  base_monthly_fee?: number | null
  base_annual_fee?: number | null
  year_pricing?: Record<string, number> | null
  ramp_schedule?: unknown[] | null
  additional_recurring_fees?: ContractBriefFee[] | null
  overage_tiers?: unknown[] | null
  discounts?: DiscountForBrief[] | null
  auto_renews?: boolean | null
  renewal_notice_months?: number | null
  renewal_notice_days?: number | null
}

function fmt(n: number | null | undefined, cur = 'EUR') {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function buildContractBrief(terms: ContractBriefTerms | undefined, cur: string): string[] {
  if (!terms) return []
  const lines: string[] = []

  // ── Sentence 1: duration · customer · dates ───────────────────────────
  const duration = terms.contract_term_months ? `${terms.contract_term_months}-month ` : ''
  const customer = terms.customer_name ? ` with ${terms.customer_name}` : ''
  const dates    = terms.contract_start_date && terms.contract_end_date
    ? ` from ${fmtDate(terms.contract_start_date)} to ${fmtDate(terms.contract_end_date)}`
    : terms.contract_start_date ? ` starting ${fmtDate(terms.contract_start_date)}` : ''
  lines.push(`${duration}agreement${customer}${dates}.`.replace(/^agreement/, 'Agreement'))

  // ── Sentence 2: the broad pricing shape — only categories actually
  // present, in plain commercial English. A flat per-unit fee (rate_per_
  // unit) and a tiered/overage fee (overage_tiers) are both "usage-based
  // charges" at this level of detail; a percentage_of_basis fee is
  // "performance-based" — the same two-way split lib/pricing-dependency.ts
  // already uses for the Pricing dependencies section, so this sentence
  // can never disagree with that structured view about what's present. ──
  const fees = terms.additional_recurring_fees ?? []
  const hasUsage = (terms.overage_tiers?.length ?? 0) > 0
    || fees.some(f => typeof f.rate_per_unit === 'number' && f.rate_per_unit > 0 && !f.percentage_of_basis)
  const hasPerformance = fees.some(f => !!f.percentage_of_basis)
  const hasFixed = !!(terms.base_monthly_fee || terms.base_annual_fee
    || (terms.year_pricing && Object.keys(terms.year_pricing).length > 0)
    || (terms.ramp_schedule?.length ?? 0) > 0)

  // A single, clean recurring figure to name (e.g. "SEK 2,000/month
  // platform fee") — only when the contract actually states one plain
  // number; multi-stage ramps/multi-year schedules fall back to a
  // generic "fixed subscription" rather than inventing a single figure
  // that isn't really the whole story.
  let fixedPhrase: string | null = null
  if (terms.base_monthly_fee) fixedPhrase = `a ${fmt(terms.base_monthly_fee, cur)}/month platform fee`
  else if (terms.base_annual_fee) fixedPhrase = `a ${fmt(terms.base_annual_fee, cur)}/year platform fee`
  else if (hasFixed) fixedPhrase = 'a fixed subscription'

  if (hasFixed && !hasUsage && !hasPerformance) {
    lines.push(fixedPhrase!.startsWith('a ')
      ? `The customer pays ${fixedPhrase!.slice(2)}.`
      : `Pricing is ${fixedPhrase}.`)
  } else if (!hasFixed && !hasUsage && hasPerformance) {
    lines.push('Commercial consideration is primarily performance/outcome based.')
  } else if (!hasFixed && hasUsage && !hasPerformance) {
    lines.push('Pricing is usage-based.')
  } else if (hasFixed || hasUsage || hasPerformance) {
    // 2+ of fixed/usage/performance present — join as "A with B" (two
    // parts) or "A, B, and C" (three), never a bare comma list.
    const parts = [
      hasFixed && fixedPhrase,
      hasUsage && 'usage-based charges',
      hasPerformance && 'a performance-based fee',
    ].filter((x): x is string => typeof x === 'string')
    const joined = parts.length === 2
      ? `${parts[0]} with ${parts[1]}`
      : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
    lines.push(`Pricing combines ${joined}.`)
  }

  // ── Sentence 3: pilot / material discount — only when one exists,
  // reusing the same typed, scoped interpretation already built for this
  // exact purpose (never a bare "100% discount" that implies the whole
  // contract is free). ──
  if (terms.discounts && terms.discounts.length > 0) {
    const d = describeDiscountForBrief(terms.discounts[0], fmtDate)
    lines.push(d.charAt(0).toUpperCase() + d.slice(1) + '.')
  }

  // ── Sentence 4: renewal — only when the contract clearly states one;
  // an unclear/unstated renewal is a Contract Overview detail, not an
  // executive-brief disclaimer. ──
  if (terms.auto_renews === true) {
    const n = terms.renewal_notice_months ?? terms.renewal_notice_days ?? null
    const unit = terms.renewal_notice_months != null ? (terms.renewal_notice_months === 1 ? 'month' : 'months') : (terms.renewal_notice_days === 1 ? 'day' : 'days')
    lines.push(n != null
      ? `The agreement renews automatically unless terminated with ${n} ${unit}' notice.`
      : 'The agreement renews automatically unless terminated with advance notice.')
  } else if (terms.auto_renews === false && terms.contract_term_months) {
    lines.push('The agreement does not auto-renew.')
  }

  return lines
}
