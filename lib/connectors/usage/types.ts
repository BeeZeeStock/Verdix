/**
 * A usage connector pulls metered usage for one customer over one billing
 * period from a partner platform, keyed by their own metric identifiers.
 *
 * Counterpart to lib/connectors/billing/types.ts (which pushes invoices out);
 * this reads usage in. Implemented connectors:
 *   - remembill : lib/connectors/usage/remembill.ts
 */
export type UsageReading = {
  metric: string
  quantity: number
}

export interface UsageConnector {
  connector: string

  pullUsage(params: {
    customerId: string
    periodStart: Date
    periodEnd: Date
  }): Promise<UsageReading[]>
}
