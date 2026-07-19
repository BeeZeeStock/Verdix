import { ContractTerms, BillingRecord, LeakageFinding } from './types'
import { randomUUID } from 'crypto'

const FX_RATES: Record<string, number> = {
  'USD': 1, 'EUR': 1.08, 'GBP': 1.27, 'SEK': 0.096, 'NOK': 0.094, 'DKK': 0.145,
}

function toUSD(amount: number, currency: string): number {
  return amount * (FX_RATES[currency.toUpperCase()] ?? 1)
}

function isoMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Fuzzy customer-name match: normalize out legal suffixes and punctuation
function matchesCustomer(csvName: string, contractName: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/\b(inc|ltd|llc|corp|gmbh|ab|ag|sa|bv|nv|plc)\.?\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim()
  const a = norm(csvName)
  const b = norm(contractName)
  return a.includes(b) || b.includes(a)
}

// Returns true when an invoice looks like a subscription charge (not usage/overage).
// Prefers the explicit invoiceType field; falls back to amount proximity (±25% of
// the contracted base fee) as a last resort. The tight band prevents usage add-ons
// (e.g. €384, €576, €720) from polluting subscription-only detectors.
function isSubscriptionRecord(r: BillingRecord, baseFee: number, contractCurrency: string): boolean {
  if (r.invoiceType) {
    const t = r.invoiceType.toLowerCase()
    // Explicit "subscription" or "recurring" wins
    if (/subscri|recurr|base|platform|saas|license|licence/.test(t)) return true
    // Explicit "usage" or "overage" — exclude
    if (/usage|overage|metered|additional|add.?on|extra|user.?fee/.test(t)) return false
    // Unknown type — fall through to amount-based heuristic
  }
  // Amount-based fallback: billed must be within ±25% of the contracted base fee
  const billedInContractCurrency = toUSD(r.amountBilled, r.currency) / toUSD(1, contractCurrency)
  return Math.abs(billedInContractCurrency - baseFee) < baseFee * 0.25
}

export function reconcile(
  terms: ContractTerms,
  billingRecords: BillingRecord[]
): LeakageFinding[] {
  const contractCurrency = terms.currency ?? 'USD'
  const customerName = terms.customer_name ?? 'Unknown'
  const contractId = terms.contract_id
  const baseFee = terms.base_monthly_fee ?? (terms.base_annual_fee ? terms.base_annual_fee / 12 : 0)

  // Step 1 — narrow to records for this customer only.
  // Without this, invoices from other customers with similar amounts contaminate findings.
  const customerRecords = customerName === 'Unknown'
    ? billingRecords
    : billingRecords.filter(r => matchesCustomer(r.customerName, customerName))

  // Step 2 — separate subscription vs all-records for the respective detectors.
  // Escalator miss and discount overhang must only compare against subscription
  // invoices. Overage detector needs all records to check for absence of usage charges.
  const subscriptionRecords = baseFee > 0
    ? customerRecords.filter(r => isSubscriptionRecord(r, baseFee, contractCurrency))
    : customerRecords

  const raw: LeakageFinding[] = [
    ...detectEscalatorMisses(terms, subscriptionRecords, customerName, contractId, contractCurrency),
    ...detectDiscountOverhangs(terms, subscriptionRecords, customerName, contractId, contractCurrency),
    ...detectUnbilledOverage(terms, customerRecords, customerName, contractId, contractCurrency),
  ]

  // Step 3 — collapse overlapping findings for the same billing month.
  // When both ESCALATOR_MISS and DISCOUNT_OVERHANG fire for the same month, the
  // escalator miss finding already captures the full shortfall (contracted post-
  // escalation rate vs. actual billed). Retaining the discount overhang as well
  // would double-count the leakage for that period.
  const escalatorMonths = new Set(
    raw.filter(f => f.leakage_type === 'ESCALATOR_MISS').map(f => f.billing_month)
  )
  return raw.filter(f =>
    f.leakage_type !== 'DISCOUNT_OVERHANG' || !escalatorMonths.has(f.billing_month)
  )
}

function priority(leakage: number): 'CRITICAL' | 'HIGH' | 'MEDIUM' {
  return leakage > 2000 ? 'CRITICAL' : leakage > 500 ? 'HIGH' : 'MEDIUM'
}

function detectEscalatorMisses(
  terms: ContractTerms,
  records: BillingRecord[],
  customerName: string,
  contractId: string | null,
  currency: string
): LeakageFinding[] {
  const findings: LeakageFinding[] = []
  if (!terms.escalators?.length || !terms.contract_start_date) return findings
  if (!terms.base_monthly_fee && !terms.base_annual_fee) return findings

  const startDate = new Date(terms.contract_start_date)
  const baseMonthly = terms.base_monthly_fee ?? (terms.base_annual_fee! / 12)

  for (const escalator of terms.escalators) {
    if (!escalator.escalator_pct || !escalator.effective_date) continue

    const effectiveDate = new Date(escalator.effective_date)

    const postEscalationRecords = records.filter(r => {
      const d = new Date(r.invoiceDate)
      return d >= effectiveDate && d.getFullYear() > startDate.getFullYear()
    })

    for (const record of postEscalationRecords) {
      const invoiceDate   = new Date(record.invoiceDate)
      // Compound escalation: each year after effective_date adds another escalator_pct layer
      const monthsElapsed = (invoiceDate.getFullYear() - effectiveDate.getFullYear()) * 12
        + (invoiceDate.getMonth() - effectiveDate.getMonth())
      const yearsElapsed  = Math.max(0, Math.floor(monthsElapsed / 12))
      const compoundMult  = Math.pow(1 + escalator.escalator_pct / 100, yearsElapsed + 1)
      const expectedRate  = baseMonthly * compoundMult

      const billedMonthly = toUSD(record.amountBilled, record.currency) / toUSD(1, currency)
      const tolerance     = expectedRate * 0.01

      if (billedMonthly < expectedRate - tolerance) {
        const leakageAmount = expectedRate - billedMonthly
        const yearLabel = yearsElapsed > 0 ? ` (Year ${yearsElapsed + 1} compound)` : ''
        findings.push({
          finding_id: randomUUID(),
          leakage_type: 'ESCALATOR_MISS',
          customer_name: customerName,
          contract_id: contractId,
          invoice_id: record.invoiceId,
          billing_month: isoMonth(invoiceDate),
          description: `Price escalator of ${escalator.escalator_pct}% effective ${escalator.effective_date} not fully applied${yearLabel}. Expected ${currency} ${expectedRate.toFixed(2)}/mo, billed ${record.currency} ${record.amountBilled.toFixed(2)}.`,
          contracted_amount: expectedRate,
          billed_amount: billedMonthly,
          leakage_amount: leakageAmount,
          evidence: escalator.description,
          confidence: 'HIGH',
          priority: priority(leakageAmount),
        })
      }
    }
  }

  return findings
}

function detectDiscountOverhangs(
  terms: ContractTerms,
  records: BillingRecord[],
  customerName: string,
  contractId: string | null,
  currency: string
): LeakageFinding[] {
  const findings: LeakageFinding[] = []
  if (!terms.discounts?.length) return findings
  if (!terms.base_monthly_fee && !terms.base_annual_fee) return findings

  const baseMonthly = terms.base_monthly_fee ?? (terms.base_annual_fee! / 12)

  for (const discount of terms.discounts) {
    if (!discount.end_date && !discount.duration_months) continue

    let discountEndDate: Date | null = null
    if (discount.end_date) {
      discountEndDate = new Date(discount.end_date)
    } else if (discount.start_date && discount.duration_months) {
      discountEndDate = new Date(discount.start_date)
      discountEndDate.setMonth(discountEndDate.getMonth() + discount.duration_months)
    }
    if (!discountEndDate) continue

    const discountPct = discount.discount_pct ?? 0
    const discountedMonthly = baseMonthly * (1 - discountPct / 100)
    const tolerance = baseMonthly * 0.01

    const postExpiry = records.filter(r => new Date(r.invoiceDate) > discountEndDate!)

    for (const record of postExpiry) {
      const billedMonthly = toUSD(record.amountBilled, record.currency) / toUSD(1, currency)

      // Still billing at or near the discounted rate after expiry
      if (billedMonthly < discountedMonthly + (baseMonthly - discountedMonthly) * 0.5 - tolerance) {
        const leakage = baseMonthly - billedMonthly
        findings.push({
          finding_id: randomUUID(),
          leakage_type: 'DISCOUNT_OVERHANG',
          customer_name: customerName,
          contract_id: contractId,
          invoice_id: record.invoiceId,
          billing_month: isoMonth(new Date(record.invoiceDate)),
          description: `${discountPct}% introductory discount expired ${discountEndDate.toISOString().slice(0, 10)} but customer still billed at discounted rate (${currency} ${billedMonthly.toFixed(2)}). Full rate ${currency} ${baseMonthly.toFixed(2)}/mo not applied.`,
          contracted_amount: baseMonthly,
          billed_amount: billedMonthly,
          leakage_amount: leakage,
          evidence: discount.description,
          confidence: 'HIGH',
          priority: priority(leakage),
        })
      }
    }
  }

  return findings
}

function detectUnbilledOverage(
  terms: ContractTerms,
  records: BillingRecord[],
  customerName: string,
  contractId: string | null,
  currency: string
): LeakageFinding[] {
  if (!terms.overage_tiers?.length || !terms.included_units) return []
  const baseMonthly = terms.base_monthly_fee ?? (terms.base_annual_fee ? terms.base_annual_fee / 12 : null)
  if (!baseMonthly) return []

  const overageTier = terms.overage_tiers[0]
  const tolerance = baseMonthly * 0.005

  // Months where only the base fee was collected (no overage line found)
  const monthsWithOnlyBase = records.filter(r => {
    const billed = toUSD(r.amountBilled, r.currency) / toUSD(1, currency)
    return Math.abs(billed - baseMonthly) < tolerance
  })
  if (monthsWithOnlyBase.length === 0) return []

  const sorted = [...records].sort((a, b) => new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime())
  const oldest = sorted[0]
  const newest = sorted[sorted.length - 1]

  return [{
    finding_id: randomUUID(),
    leakage_type: 'OVERAGE_UNBILLED',
    customer_name: customerName,
    contract_id: contractId,
    invoice_id: undefined,
    billing_month: isoMonth(new Date(oldest.invoiceDate)),
    description: `Contract includes ${terms.included_unit_type ?? 'units'} with overage billing at ${currency} ${overageTier.rate_per_unit}/unit beyond ${terms.included_units} included. No overage charges detected across ${monthsWithOnlyBase.length} months (${isoMonth(new Date(oldest.invoiceDate))} – ${isoMonth(new Date(newest.invoiceDate))}). Investigate usage data to quantify exposure.`,
    contracted_amount: baseMonthly + overageTier.rate_per_unit * terms.included_units * 0.1,
    billed_amount: baseMonthly,
    leakage_amount: 0,
    evidence: `Tier: ${overageTier.tier_label ?? 'Tier 1'} at ${overageTier.rate_per_unit} ${currency}/${overageTier.unit_type} · ${monthsWithOnlyBase.length} months checked`,
    confidence: 'LOW',
    priority: 'CRITICAL',
  }]
}
