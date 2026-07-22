/**
 * Stripe webhook for Verdix SaaS subscription billing.
 * Separate from /api/stripe/webhook which handles customer contract billing.
 *
 * invoice.paid now runs two paths:
 *
 * 1. Agreement-based (org has org_billing_config rows):
 *    Sums usage_ledger for the invoice period per meter, applies tiered pricing
 *    from the confirmed contract mapping. Handles any billing cycle because
 *    period_start/period_end come directly from the Stripe invoice.
 *
 * 2. Plan-based (self-service, no org_billing_config):
 *    Legacy behaviour — reads usage_counters flat total, prices from verdix_plans.
 *    Backward compatible for all existing orgs.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { resetPeriodSyncs } from '@/lib/billing'
import { computeMetricOverage } from '@/lib/tariff'
import type { OverageTier } from '@/lib/types'

type StripeInvoice = import('stripe').default.Invoice

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodFromInvoice(invoice: StripeInvoice) {
  return {
    start: new Date(invoice.period_start * 1000).toISOString(),
    end:   new Date(invoice.period_end   * 1000).toISOString(),
  }
}

// Resolves plan-based pricing for self-service orgs (no org_billing_config).
async function getPlanMetricPricing(
  metricType: string,
  planId: string,
): Promise<{ included: number | null; pricePerUnit: number }> {
  if (metricType === 'sync') {
    const { data } = await supabaseServer
      .from('verdix_plans')
      .select('sync_limit, overage_price_eur')
      .eq('id', planId)
      .maybeSingle()
    return { included: data?.sync_limit ?? null, pricePerUnit: data?.overage_price_eur ?? 0 }
  }
  const { data } = await supabaseServer
    .from('verdix_plans')
    .select('metric_config')
    .eq('id', planId)
    .maybeSingle()
  type MetricCfg = { included?: number; overage_price_eur?: number }
  const cfg = ((data?.metric_config ?? {}) as Record<string, MetricCfg>)[metricType] ?? {}
  return { included: cfg.included ?? 0, pricePerUnit: cfg.overage_price_eur ?? 0 }
}

// Converts org_billing_config overage_tiers to OverageTier[] for computeMetricOverage.
type ConfigTier = { from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }
function toOverageTiers(raw: ConfigTier[], meterKey: string): OverageTier[] {
  return raw.map((t, i) => ({
    tier_label:    `Tier ${i + 1}`,
    from_unit:     t.from_unit ?? null,
    to_unit:       t.to_unit   ?? null,
    rate_per_unit: t.rate_per_unit ?? 0,
    unit_type:     meterKey,
  }))
}

// ── Webhook handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const sig     = req.headers.get('stripe-signature') ?? ''

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  let event: import('stripe').default.Event
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_BILLING_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET!,
    )
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    // ── checkout.session.completed ───────────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const cs = event.data.object as import('stripe').default.Checkout.Session
      if (cs.mode !== 'subscription') return NextResponse.json({ received: true })

      const orgId  = cs.metadata?.verdix_org_id
      const planId = cs.metadata?.verdix_plan_id
      const cycle  = (cs.metadata?.billing_cycle ?? 'monthly') as string
      const subId  = typeof cs.subscription === 'string' ? cs.subscription : cs.subscription?.id

      if (!orgId || !planId || !subId) return NextResponse.json({ received: true })

      const subscription = await stripe.subscriptions.retrieve(subId, { expand: ['latest_invoice'] })
      const invoice      = subscription.latest_invoice as StripeInvoice | null
      const periodStart  = invoice ? new Date(invoice.period_start * 1000).toISOString() : new Date().toISOString()
      const periodEnd    = invoice ? new Date(invoice.period_end   * 1000).toISOString()
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

      const customerId = typeof cs.customer === 'string' ? cs.customer : (cs.customer as { id: string } | null)?.id ?? null

      await supabaseServer.from('org_subscriptions').upsert({
        org_id:                 orgId,
        plan_id:                planId,
        stripe_customer_id:     customerId,
        stripe_subscription_id: subId,
        billing_cycle:          cycle,
        current_period_start:   periodStart,
        current_period_end:     periodEnd,
        syncs_used:             0,
        status:                 'active',
        updated_at:             new Date().toISOString(),
      }, { onConflict: 'org_id' })

      // Write plan-based billing config so the billing engine knows what's included
      const { data: plan } = await supabaseServer
        .from('verdix_plans')
        .select('sync_limit, overage_price_eur, billing_cycles')
        .eq('id', planId)
        .maybeSingle()

      if (plan) {
        type BillingCycleRow = { cycle: string; price_eur: number }
        const cycleRow = ((plan.billing_cycles ?? []) as BillingCycleRow[]).find(c => c.cycle === cycle)
        const overagePriceEur = plan.overage_price_eur ?? 0

        await supabaseServer.from('org_billing_config').upsert({
          org_id:         orgId,
          meter_key:      'sync',
          included_units: plan.sync_limit ?? 0,
          overage_tiers:  overagePriceEur > 0
            ? [{ from_unit: (plan.sync_limit ?? 0) + 1, to_unit: null, rate_per_unit: overagePriceEur }]
            : [],
          billing_cycle:  cycle,
          cycle_start:    new Date(periodStart).toISOString().split('T')[0],
          source:         'plan',
          active:         true,
          updated_at:     new Date().toISOString(),
          // store chosen cycle price for reference
          ...(cycleRow ? {} : {}),
        }, { onConflict: 'org_id,meter_key' })
      }
    }

    // ── customer.subscription.updated ────────────────────────────────────────
    else if (event.type === 'customer.subscription.updated') {
      const sub   = event.data.object as import('stripe').default.Subscription
      const orgId = sub.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      const planId = sub.metadata?.verdix_plan_id ?? 'core'
      const subExp = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] })
      const invoice = subExp.latest_invoice as StripeInvoice | null

      const updatePayload: Record<string, unknown> = {
        plan_id:    planId,
        status:     sub.status === 'active' ? 'active' : sub.status,
        updated_at: new Date().toISOString(),
      }
      if (invoice) {
        updatePayload.current_period_start = new Date(invoice.period_start * 1000).toISOString()
        updatePayload.current_period_end   = new Date(invoice.period_end   * 1000).toISOString()
      }
      await supabaseServer.from('org_subscriptions').update(updatePayload).eq('org_id', orgId)
    }

    // ── customer.subscription.deleted ────────────────────────────────────────
    else if (event.type === 'customer.subscription.deleted') {
      const sub   = event.data.object as import('stripe').default.Subscription
      const orgId = sub.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      await supabaseServer.from('org_subscriptions').update({
        plan_id:                'trial',
        stripe_subscription_id: null,
        billing_cycle:          'monthly',
        status:                 'active',
        syncs_used:             0,
        updated_at:             new Date().toISOString(),
      }).eq('org_id', orgId)

      // Deactivate billing config so they revert to trial limits
      await supabaseServer
        .from('org_billing_config')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
    }

    // ── invoice.created ──────────────────────────────────────────────────────
    // Fires when Stripe drafts the invoice before charging. We add overage
    // items here so they appear on the SAME invoice as the base subscription fee.
    // Only handle subscription_cycle (renewals) — skip setup and manual invoices.
    else if (event.type === 'invoice.created') {
      const invoice = event.data.object as StripeInvoice
      const billingReason = (invoice as unknown as Record<string, string>).billing_reason
      if (!['subscription_cycle', 'subscription_update'].includes(billingReason)) return NextResponse.json({ received: true })

      const subRef = invoice.parent?.subscription_details?.subscription
      if (!subRef) return NextResponse.json({ received: true })

      const subId        = typeof subRef === 'string' ? subRef : (subRef as { id: string }).id
      const subscription = await stripe.subscriptions.retrieve(subId)
      const orgId        = subscription.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      const customerId = invoice.customer
        ? (typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer as { id: string }).id)
        : null
      if (!customerId) return NextResponse.json({ received: true })

      const invoiceId = (invoice as unknown as Record<string, string>).id
      const { start: periodStart, end: periodEnd } = periodFromInvoice(invoice)
      const testMode = process.env.VERDIX_BILLING_TEST_MODE === 'true'

      const { data: configs } = await supabaseServer
        .from('org_billing_config')
        .select('*')
        .eq('org_id', orgId)
        .eq('active', true)

      type OrgBillingConfig = {
        meter_key:      string
        included_units: number
        overage_tiers:  ConfigTier[]
        billing_cycle:  string
        source:         string
      }

      if (configs && configs.length > 0) {
        // ── Path A: Ledger-based billing (agreement or plan with config) ──────
        for (const cfg of (configs as OrgBillingConfig[])) {
          const { data: usageSum } = await supabaseServer.rpc('sum_usage_for_period', {
            org_id_param:      orgId,
            meter_key_param:   cfg.meter_key,
            period_start:      periodStart,
            period_end:        periodEnd,
            include_simulated: false,
          })

          const count = Number(usageSum ?? 0)
          if (count <= 0) continue

          const tiers         = toOverageTiers(cfg.overage_tiers ?? [], cfg.meter_key)
          const included      = cfg.included_units ?? 0
          const overageAmount = tiers.length > 0
            ? computeMetricOverage(count, tiers, included)
            : 0

          if (overageAmount <= 0) continue

          const overage = Math.max(0, count - included)
          const label   = cfg.meter_key.replace(/_/g, ' ')
          const desc    = `Verdix ${label} overage — ${overage.toLocaleString()} excess ${overage === 1 ? label : label + 's'} (${cfg.billing_cycle})`

          if (testMode) {
            console.log(`[billing/webhook] TEST MODE — would add invoice item`, {
              org_id: orgId, meter_key: cfg.meter_key,
              count, overage, overage_amount_eur: Math.round(overageAmount * 100) / 100,
              invoice_id: invoiceId, period_start: periodStart, period_end: periodEnd,
            })
          } else {
            await stripe.invoiceItems.create({
              customer:    customerId,
              invoice:     invoiceId,
              amount:      Math.round(overageAmount * 100),
              currency:    'eur',
              description: desc,
              metadata: {
                meter_key:     cfg.meter_key,
                count:         String(count),
                overage:       String(overage),
                billing_cycle: cfg.billing_cycle,
                source:        cfg.source,
                period_start:  periodStart,
                period_end:    periodEnd,
              },
            }).catch(err => console.error(`[billing/webhook] invoiceItem failed for ${cfg.meter_key}:`, err))
          }
        }
      } else {
        // ── Path B: Legacy plan-based billing (no org_billing_config yet) ─────
        const { data: sub } = await supabaseServer
          .from('org_subscriptions')
          .select('usage_counters, plan_id')
          .eq('org_id', orgId)
          .maybeSingle()

        if (sub) {
          const counters = (sub.usage_counters ?? {}) as Record<string, number>

          for (const [metricType, rawCount] of Object.entries(counters)) {
            const count = Number(rawCount ?? 0)
            if (count <= 0) continue

            const { included, pricePerUnit } = await getPlanMetricPricing(metricType, sub.plan_id)
            if (pricePerUnit <= 0) continue

            const overage = included != null ? Math.max(0, count - included) : count
            if (overage <= 0) continue

            const label = metricType === 'sync' ? 'agreement sync' : metricType.replace(/_/g, ' ')
            const desc  = `Verdix ${label} overage — ${overage.toLocaleString()} excess ${overage === 1 ? label : label + 's'} @ €${pricePerUnit}/${label}`

            if (testMode) {
              console.log(`[billing/webhook] TEST MODE — would add invoice item`, {
                org_id: orgId, metric_type: metricType, count, overage,
                price_per_unit_eur: pricePerUnit,
                invoice_item_total_eur: Math.round(pricePerUnit * overage * 100) / 100,
                invoice_id: invoiceId,
              })
            } else {
              await stripe.invoiceItems.create({
                customer:    customerId,
                invoice:     invoiceId,
                amount:      Math.round(pricePerUnit * overage * 100),
                currency:    'eur',
                description: desc,
                metadata: { metric_type: metricType, count: String(count), overage: String(overage) },
              }).catch(err => console.error(`[billing/webhook] invoiceItem failed for ${metricType}:`, err))
            }
          }
        }
      }
    }

    // ── invoice.paid ─────────────────────────────────────────────────────────
    // Fires after successful payment. Reset usage counters for the new period.
    else if (event.type === 'invoice.paid') {
      const invoice = event.data.object as StripeInvoice
      const subRef  = invoice.parent?.subscription_details?.subscription
      if (!subRef) return NextResponse.json({ received: true })

      const subId        = typeof subRef === 'string' ? subRef : (subRef as { id: string }).id
      const subscription = await stripe.subscriptions.retrieve(subId)
      const orgId        = subscription.metadata?.verdix_org_id
      if (!orgId) return NextResponse.json({ received: true })

      const { start: periodStart, end: periodEnd } = periodFromInvoice(invoice)
      const testMode = process.env.VERDIX_BILLING_TEST_MODE === 'true'

      if (!testMode) {
        // Deduct usage counters now that the invoice is paid
        const { data: configs } = await supabaseServer
          .from('org_billing_config')
          .select('meter_key')
          .eq('org_id', orgId)
          .eq('active', true)

        if (configs && configs.length > 0) {
          for (const cfg of configs as { meter_key: string }[]) {
            const { data: usageSum } = await supabaseServer.rpc('sum_usage_for_period', {
              org_id_param:      orgId,
              meter_key_param:   cfg.meter_key,
              period_start:      periodStart,
              period_end:        periodEnd,
              include_simulated: false,
            })
            const count = Number(usageSum ?? 0)
            if (count > 0) {
              await supabaseServer.rpc('deduct_usage_counter', {
                org_id_param: orgId,
                metric_type:  cfg.meter_key,
                amount:       count,
              }).then(({ error }) => {
                if (error) console.error(`[billing/webhook] deduct failed for ${cfg.meter_key}:`, error)
              })
            }
          }
        } else {
          const { data: sub } = await supabaseServer
            .from('org_subscriptions')
            .select('usage_counters')
            .eq('org_id', orgId)
            .maybeSingle()
          const counters = (sub?.usage_counters ?? {}) as Record<string, number>
          for (const [metricType, rawCount] of Object.entries(counters)) {
            const count = Number(rawCount ?? 0)
            if (count > 0) {
              await supabaseServer.rpc('deduct_usage_counter', {
                org_id_param: orgId,
                metric_type:  metricType,
                amount:       count,
              }).then(({ error }) => {
                if (error) console.error(`[billing/webhook] deduct failed for ${metricType}:`, error)
              })
            }
          }
        }
      }

      await resetPeriodSyncs(orgId, periodStart, periodEnd)
    }
  } catch (err) {
    console.error('[billing/webhook] handler error', err)
  }

  return NextResponse.json({ received: true })
}
