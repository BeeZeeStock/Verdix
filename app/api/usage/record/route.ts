/**
 * POST /api/usage/record
 *
 * Records metered consumption for a Verdix-managed contract by sending a
 * Stripe Billing Meter event for the matching unit_type.
 *
 * Body:
 *   job_id     — Verdix job UUID
 *   unit_type  — e.g. "API call" (must match an item in billing_metered_items)
 *   quantity   — number of units consumed in this batch
 *   occurred_at — ISO-8601 timestamp (defaults to now); must be within the
 *                 current billing period and no older than 30 days
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { slugifyMetricCode } from '@/lib/tariff'
import type { BillingMeteredItem } from '@/lib/types'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { job_id, unit_type, quantity, occurred_at } = body as {
    job_id: string
    unit_type: string
    quantity: number
    occurred_at?: string
  }

  if (!job_id || !unit_type || !quantity || quantity <= 0) {
    return NextResponse.json(
      { error: 'job_id, unit_type, and a positive quantity are required' },
      { status: 400 },
    )
  }

  // ── 1. Resolve the Stripe meter for this job + unit_type ──────────────────
  const { data: rows, error } = await supabaseServer
    .from('contract_terms')
    .select('billing_metered_items')
    .eq('job_id', job_id)
    .limit(1)

  if (error || !rows?.length) {
    return NextResponse.json({ error: 'Contract not found' }, { status: 404 })
  }

  const items = (rows[0].billing_metered_items ?? []) as BillingMeteredItem[]
  const slug  = slugifyMetricCode(unit_type)
  const match = items.find(i => slugifyMetricCode(i.unit_type) === slug)

  if (!match) {
    return NextResponse.json(
      { error: `No metered item for unit_type "${unit_type}" on this contract` },
      { status: 404 },
    )
  }

  // ── 2. Look up the Stripe customer for this job ───────────────────────────
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('billing_customer_id')
    .eq('id', job_id)
    .single()

  const customerId = job?.billing_customer_id
  if (!customerId) {
    return NextResponse.json({ error: 'Contract has no Stripe customer yet' }, { status: 400 })
  }

  // ── 3. Send the meter event to Stripe ────────────────────────────────────
  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  const timestamp = occurred_at
    ? Math.floor(new Date(occurred_at).getTime() / 1000)
    : Math.floor(Date.now() / 1000)

  const event = await stripe.billing.meterEvents.create({
    event_name: match.meter_id ? slugifyMetricCode(match.unit_type) : match.unit_type,
    timestamp,
    payload: {
      stripe_customer_id: customerId,
      value:              String(quantity),
    },
  })

  return NextResponse.json({
    ok:         true,
    meter_event: event.identifier,
    unit_type,
    quantity,
    customer_id: customerId,
    timestamp,
  })
}
