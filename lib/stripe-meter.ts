/**
 * Stripe Billing Meter helpers.
 *
 * Meters are account-level (one per unit_type, shared across all customers).
 * Metered subscription prices are set to $0 — Verdix is the source of truth
 * for amounts and injects them as invoiceitems during the webhook.
 */

import type Stripe from 'stripe'
import { slugifyMetricCode } from './tariff'

// ── Meters ────────────────────────────────────────────────────────────────────

/**
 * Returns an existing Billing Meter whose event_name matches the unit_type slug,
 * or creates one if it doesn't exist.
 * Meters are account-level — this is idempotent across all contracts.
 */
export async function ensureStripeMeter(
  stripe: Stripe,
  unitType: string,
): Promise<Stripe.Billing.Meter> {
  const eventName = slugifyMetricCode(unitType)

  // List existing meters and match by event_name
  const existing = await stripe.billing.meters.list({ limit: 100 })
  const found = existing.data.find(m => m.event_name === eventName)
  if (found) return found

  return stripe.billing.meters.create({
    display_name: unitType,
    event_name:   eventName,
    default_aggregation: { formula: 'sum' },
    customer_mapping: {
      event_payload_key: 'stripe_customer_id',
      type: 'by_id',
    },
    value_settings: { event_payload_key: 'value' },
  })
}

// ── Metered price (placeholder at $0) ────────────────────────────────────────

/**
 * Creates a metered recurring price at $0.00 linked to a Billing Meter.
 * The $0 amount means Stripe bills nothing for usage — Verdix injects the
 * correct amount as an invoiceitem during the invoice.created webhook.
 */
export async function createMeteredPrice(
  stripe: Stripe,
  params: {
    meterId: string
    currency: string
    interval: 'month' | 'year'
    intervalCount: number
    contractId: string
    unitType: string
    jobId?: string
  },
): Promise<Stripe.Price> {
  return stripe.prices.create({
    currency:     params.currency.toLowerCase(),
    unit_amount:  0,
    recurring: {
      interval:            params.interval,
      interval_count:      params.intervalCount,
      usage_type:          'metered',
      meter:               params.meterId,
    },
    product_data: {
      name: `${params.unitType} usage — ${params.contractId}`,
    },
    metadata: {
      verdix_unit_type:  params.unitType,
      verdix_contract:   params.contractId,
      ...(params.jobId ? { verdix_job_id: params.jobId } : {}),
    },
  })
}

// ── Fixed base price ──────────────────────────────────────────────────────────

/**
 * Creates a fixed recurring price for the base subscription fee.
 *
 * For year_pricing contracts the amount is set to $0 — Verdix will always
 * inject the correct year's amount as an invoiceitem during the webhook so
 * the invoice shows a single clean "Base subscription — Year N" line.
 *
 * For flat monthly/annual contracts the amount is the actual fee and Stripe
 * handles it correctly without any webhook adjustment.
 */
export async function createBasePrice(
  stripe: Stripe,
  params: {
    amountCents: number
    currency: string
    interval: 'month' | 'year'
    intervalCount: number
    contractId: string
    customerName: string
    isYearPricing: boolean
    jobId?: string
  },
): Promise<Stripe.Price> {
  return stripe.prices.create({
    currency:    params.currency.toLowerCase(),
    // year_pricing contracts: $0 — Verdix owns the amount via invoiceitem
    unit_amount: params.isYearPricing ? 0 : params.amountCents,
    recurring: {
      interval:       params.interval,
      interval_count: params.intervalCount,
    },
    product_data: {
      name: `Base subscription — ${params.customerName} (${params.contractId})`,
    },
    metadata: {
      verdix_contract:    params.contractId,
      verdix_year_priced: params.isYearPricing ? 'true' : 'false',
      ...(params.jobId ? { verdix_job_id: params.jobId } : {}),
    },
  })
}

// ── Meter event summaries ─────────────────────────────────────────────────────

/**
 * Fetches aggregated meter usage for a customer over a billing period.
 * Returns the total `aggregated_value` (e.g. total API calls in the period).
 */
export async function getCustomerMeterTotal(
  stripe: Stripe,
  params: {
    meterId: string
    customerId: string
    startTime: Date
    endTime: Date
  },
): Promise<number> {
  // Stripe requires start_time/end_time aligned to midnight UTC when grouping by day
  const startMidnight = new Date(params.startTime)
  startMidnight.setUTCHours(0, 0, 0, 0)
  const endMidnight = new Date(params.endTime)
  endMidnight.setUTCHours(0, 0, 0, 0)
  if (endMidnight <= startMidnight) endMidnight.setUTCDate(endMidnight.getUTCDate() + 1)

  const summaries = await stripe.billing.meters.listEventSummaries(params.meterId, {
    customer:   params.customerId,
    start_time: Math.floor(startMidnight.getTime() / 1000),
    end_time:   Math.floor(endMidnight.getTime() / 1000),
    value_grouping_window: 'day',
  })

  return summaries.data.reduce(
    (sum, s) => sum + (s.aggregated_value ?? 0),
    0,
  )
}

// ── Interval helpers ──────────────────────────────────────────────────────────

export function billingInterval(
  frequency: string | null | undefined,
): { interval: 'month' | 'year'; intervalCount: number } {
  if (frequency === 'annual')    return { interval: 'year',  intervalCount: 1 }
  if (frequency === 'quarterly') return { interval: 'month', intervalCount: 3 }
  return { interval: 'month', intervalCount: 1 }
}
