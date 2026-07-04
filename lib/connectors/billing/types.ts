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
