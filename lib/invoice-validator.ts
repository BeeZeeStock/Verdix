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
import type { ContractTerms, BillingRecord } from './types'

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
  // Extract quantity from the description written by buildOverageDescription()
  // Format: "<UnitType> overage — <N> excess units @ €<rate>/unit (<total> total, <included> included)"
  for (const line of ovgLines) {
    const m = line.description.match(/(\d[\d,]*)\s+excess units @ [€$£]?([\d.]+)\/unit/)
    if (!m) continue
    const excessUnits = parseInt(m[1].replace(/,/g, ''), 10)
    const rateFromDesc = parseFloat(m[2])

    // Find the matching tier rate from the contract
    const tier = terms.overage_tiers?.[0]
    if (!tier) continue
    const expectedAmount = excessUnits * tier.rate_per_unit

    const diff = Math.abs(line.amount - expectedAmount)
    const pct  = expectedAmount > 0 ? diff / expectedAmount : 0

    if (pct > 0.01) {
      findings.push({
        check:       'RATE_INTEGRITY',
        priority:    pct > 0.05 ? 'CRITICAL' : 'HIGH',
        description: `Injected overage amount (${fmt(line.amount, terms.currency)}) differs from contract rate re-derivation (${fmt(expectedAmount, terms.currency)}) by ${(pct * 100).toFixed(1)}%.`,
        evidence:    `${excessUnits.toLocaleString()} excess units × ${terms.currency} ${tier.rate_per_unit}/unit = ${fmt(expectedAmount, terms.currency)} (contract); injected: ${fmt(line.amount, terms.currency)}`,
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
