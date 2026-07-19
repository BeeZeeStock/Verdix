/**
 * Invoice validator — runs automatically after Verdix injects overages into a
 * Stripe draft invoice, before the invoice is finalised and sent to the customer.
 *
 * Wraps the existing reconciler (historical leakage detection) and adds two
 * checks specific to the pre-send validation use case:
 *
 *   1. Overage spike   — flags if this period's overage is >3× any prior period
 *   2. Rate integrity  — re-derives overage from raw quantity × contract rate
 *                        and flags if the injected amount differs by >1%
 *
 * Returns an array of ValidationFinding objects. Empty array = all clear.
 */

import { reconcile } from './reconciler'
import { computeMetricOverage, slugifyMetricCode } from './tariff'
import type { ContractTerms, BillingRecord, OverageTier } from './types'

export type ValidationFinding = {
  check: 'OVERAGE_SPIKE' | 'RATE_INTEGRITY' | 'ESCALATOR_MISS' | 'DISCOUNT_OVERHANG' | 'OVERAGE_UNBILLED'
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM'
  description: string
  evidence?: string
}

type InjectedLine = {
  type: 'base' | 'overage' | string
  description: string
  amount: number
  currency: string
}

type PriorInvoiceRow = {
  id: string
  period_start: string
  period_end: string
  line_items: InjectedLine[]
  total_amount: number
  currency: string
}

export function validateInvoice(
  terms: ContractTerms,
  injectedLines: InjectedLine[],
  priorInvoices: PriorInvoiceRow[],
): ValidationFinding[] {
  const findings: ValidationFinding[] = []

  const ovgLines    = injectedLines.filter(l => l.type === 'overage')
  const currentOvg  = ovgLines.reduce((s, l) => s + l.amount, 0)

  // ── Check 1: Overage spike ────────────────────────────────────────────────
  if (currentOvg > 0 && priorInvoices.length > 0) {
    const priorOvgAmounts = priorInvoices.map(inv =>
      (inv.line_items ?? [])
        .filter(l => l.type === 'overage')
        .reduce((s, l) => s + l.amount, 0)
    ).filter(a => a > 0)

    if (priorOvgAmounts.length > 0) {
      const maxPrior = Math.max(...priorOvgAmounts)
      if (currentOvg > maxPrior * 3) {
        findings.push({
          check:       'OVERAGE_SPIKE',
          priority:    currentOvg > maxPrior * 10 ? 'CRITICAL' : 'HIGH',
          description: `Overage this period (${fmt(currentOvg, terms.currency)}) is ${(currentOvg / maxPrior).toFixed(1)}× the highest prior period (${fmt(maxPrior, terms.currency)}). Verify usage data before sending.`,
          evidence:    `Prior overage max across ${priorOvgAmounts.length} period(s): ${fmt(maxPrior, terms.currency)}`,
        })
      }
    }
  }

  // ── Check 2: Rate integrity ───────────────────────────────────────────────
  // Re-derive the overage amount from the quantities and contract tiers and compare
  // against what was actually injected into the invoice.
  // Description format (from buildOverageDescription in the webhook):
  //   "<unitType> overage — <billable> excess units @ €<rate>/unit (<total> total, <included> included)"
  for (const line of ovgLines) {
    // Parse total quantity + included units from the parenthetical at the end
    const qtyMatch = line.description.match(/\((\d[\d,]*)\s+total,\s*(\d[\d,]*)\s+included\)/)
    if (!qtyMatch) continue
    const totalQty    = parseInt(qtyMatch[1].replace(/,/g, ''), 10)
    const includedQty = parseInt(qtyMatch[2].replace(/,/g, ''), 10)

    // Identify which metric this line belongs to (prefix before " overage —")
    const metricHint = (line.description.split(' overage —')[0] ?? '').trim()
    const metricSlug = slugifyMetricCode(metricHint)

    // Find the tiers for this metric; fall back to all tiers if no match
    const matchingTiers = (terms.overage_tiers ?? []).filter(t => {
      const slug = slugifyMetricCode(t.unit_type ?? '')
      return slug === metricSlug || slug.includes(metricSlug) || metricSlug.includes(slug)
    }) as OverageTier[]
    const tiers = matchingTiers.length > 0 ? matchingTiers : (terms.overage_tiers ?? []) as OverageTier[]
    if (tiers.length === 0 || tiers.every(t => !t.rate_per_unit)) continue

    // Re-derive using the same graduated-tier function the webhook used
    const expectedAmount = computeMetricOverage(totalQty, tiers, includedQty)
    if (expectedAmount <= 0) continue

    const diff = Math.abs(line.amount - expectedAmount)
    const pct  = diff / expectedAmount

    if (pct > 0.01) {
      findings.push({
        check:       'RATE_INTEGRITY',
        priority:    pct > 0.05 ? 'CRITICAL' : 'HIGH',
        description: `Injected overage (${fmt(line.amount, terms.currency)}) differs from contract re-derivation (${fmt(expectedAmount, terms.currency)}) by ${(pct * 100).toFixed(1)}% for ${metricHint}.`,
        evidence:    `${totalQty.toLocaleString()} total units, ${includedQty.toLocaleString()} included → ${(totalQty - includedQty).toLocaleString()} billable. Re-derived: ${fmt(expectedAmount, terms.currency)}; injected: ${fmt(line.amount, terms.currency)}`,
      })
    }
  }

  // ── Check 3–5: Existing reconciler checks ────────────────────────────────
  // Convert the current invoice into a BillingRecord so the reconciler can run
  // its historical checks (escalator miss, discount overhang, unbilled overage)
  // against a single-record dataset representing the current billing period.
  if (injectedLines.length > 0) {
    const baseAmount  = injectedLines.filter(l => l.type === 'base').reduce((s, l) => s + l.amount, 0)
    const totalAmount = injectedLines.reduce((s, l) => s + l.amount, 0)

    const currentRecord: BillingRecord = {
      invoiceId:    'current',
      customerName: terms.customer_name ?? '',
      invoiceDate:  new Date(),
      amountBilled: baseAmount > 0 ? baseAmount : totalAmount,
      currency:     terms.currency ?? 'EUR',
      status:       'draft',
      invoiceType:  baseAmount > 0 ? 'subscription' : 'usage',
    }

    // Also feed in prior invoices so the reconciler has historical context
    const priorRecords: BillingRecord[] = priorInvoices.map(inv => {
      const base = (inv.line_items ?? []).filter(l => l.type === 'base').reduce((s, l) => s + l.amount, 0)
      const total = inv.total_amount
      return {
        invoiceId:    inv.id,
        customerName: terms.customer_name ?? '',
        invoiceDate:  new Date(inv.period_start),
        amountBilled: base > 0 ? base : total,
        currency:     inv.currency ?? 'EUR',
        status:       'paid',
        invoiceType:  base > 0 ? 'subscription' : 'usage',
      }
    })

    const reconcilerFindings = reconcile(terms, [currentRecord, ...priorRecords])

    for (const f of reconcilerFindings) {
      findings.push({
        check:       f.leakage_type as ValidationFinding['check'],
        priority:    f.priority,
        description: f.description,
        evidence:    f.evidence ?? undefined,
      })
    }
  }

  return findings
}

function fmt(n: number, currency = 'EUR') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, maximumFractionDigits: 2,
  }).format(n)
}
