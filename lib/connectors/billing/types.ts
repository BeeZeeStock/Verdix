import type { ContractTerms } from '@/lib/types'

/**
 * A billing connector configures a downstream billing system from Verdix
 * contract terms, records metered usage, and receives invoice events.
 *
 * Implemented connectors:
 *   - stripe     : lib/billing-writer.ts → configureStripe()
 *   - chargebee  : lib/billing-writer.ts → configureChargebee()
 *
 * Planned connectors:
 *   - zuora, maxio, recurly, …
 */
export interface BillingConnectorResult {
  /** Stable identifier for this connector (matches computed_invoices.connector) */
  connector: string
  /** External subscription/agreement ID in the billing system */
  subscriptionId: string
  /** External customer ID in the billing system */
  customerId: string
  /** Number of billing line items configured */
  lineItemCount: number
  /** Deep link into the billing system's dashboard for this subscription */
  dashboardUrl: string
}

export interface BillingConnector {
  connector: string

  /**
   * Provision a new subscription in the billing system from contract terms.
   * Called once when the human clicks "Configure in billing system".
   */
  configure(
    terms: ContractTerms,
    lineItems: BillingLineItem[],
    jobId?: string,
  ): Promise<BillingConnectorResult>

  /**
   * Record metered usage for a given unit type.
   * Called by POST /api/usage/record.
   */
  recordUsage(params: {
    customerId: string
    unitType: string
    quantity: number
    occurredAt: Date
    jobId: string
  }): Promise<{ eventId: string }>
}

export interface BillingLineItem {
  product_name: string
  quantity: number
  unit_price: number
  billing_period: string
  total_amount: number
  currency: string
  source_section?: string
}

// Whether a connector has a verified, working way to represent a credit
// adjustment on an invoice. 'supported' means real API-level evidence exists
// (Stripe's negative invoice-item amounts are standard, well-documented
// behavior). 'unsupported_pending_vendor_guidance' means the opposite was
// verified — for Remembill, a live sandbox probe (2026-08-21) found no
// working mechanism: negative row amounts are rejected, rows have no
// addressable id to update, no invoice-level discount/adjustment endpoint
// exists, and the `credit_rows` field their own invoice schema exposes has
// no discoverable write path despite trying every plausible variant. This is
// a small, explicit lookup — not a capability framework — extend it only
// when a connector's real, verified capability changes (e.g. once Remembill
// confirms how credit_rows is actually populated).
export type CreditRepresentationCapability = 'supported' | 'unsupported_pending_vendor_guidance'

export const CREDIT_REPRESENTATION_CAPABILITY: Record<string, CreditRepresentationCapability> = {
  stripe: 'supported',
  remembill: 'unsupported_pending_vendor_guidance',
}

export function getCreditRepresentationCapability(billingPlatform: string): CreditRepresentationCapability {
  return CREDIT_REPRESENTATION_CAPABILITY[billingPlatform] ?? 'unsupported_pending_vendor_guidance'
}
