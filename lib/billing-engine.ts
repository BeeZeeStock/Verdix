/**
 * Verdix billing engine.
 * Verdix owns all pricing and billing cycle logic. Stripe is used only for
 * payment collection, tax, and receipts.
 *
 * Self-service orgs:  plan pricing from verdix_plans, auto-charge immediately.
 * Enterprise orgs:    contract pricing from org_billing_config, create draft
 *                     invoice for admin review before charging.
 */
import { supabaseServer } from './supabase'
import { getPlan, getOrgSubscription } from './billing'
import { computeMetricOverage } from './tariff'
import type { OverageTier } from './types'

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

function advancePeriod(from: string, cycle: string): string {
  const d = new Date(from)
  if (cycle === 'quarterly') d.setMonth(d.getMonth() + 3)
  else if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1)
  else d.setMonth(d.getMonth() + 1)
  return d.toISOString()
}

export type BillingLineItem = {
  description: string
  amount_eur:  number
  metadata:    Record<string, string>
}

export type BillingRunResult = {
  org_id:        string
  period_start:  string
  period_end:    string
  line_items:    BillingLineItem[]
  total_eur:     number
  invoice_id:    string | null
  invoice_url:   string | null
  dry_run:       boolean
  is_enterprise: boolean
}

export async function runBillingForOrg(
  orgId: string,
  opts?: { dryRun?: boolean; periodStart?: string; periodEnd?: string },
): Promise<BillingRunResult> {
  const sub = await getOrgSubscription(orgId)

  const periodStart = opts?.periodStart
    ?? sub.current_period_start
    ?? new Date(new Date().setDate(1)).toISOString()
  const periodEnd = opts?.periodEnd
    ?? sub.current_period_end
    ?? new Date().toISOString()

  type OrgBillingConfig = {
    meter_key:      string
    included_units: number
    overage_tiers:  ConfigTier[]
    billing_cycle:  string
    source:         string
  }

  const { data: configs } = await supabaseServer
    .from('org_billing_config')
    .select('*')
    .eq('org_id', orgId)
    .eq('active', true)

  const lineItems: BillingLineItem[] = []
  let billingCycle  = (sub as unknown as Record<string, unknown>).billing_cycle as string ?? 'monthly'
  const isEnterprise = Boolean(configs?.length && (configs as OrgBillingConfig[]).some(c => c.source === 'agreement'))

  // ── Build line items ───────────────────────────────────────────────────────

  if (configs && configs.length > 0) {
    // Enterprise / contract path
    billingCycle = (configs as OrgBillingConfig[])[0].billing_cycle ?? 'monthly'

    for (const cfg of (configs as OrgBillingConfig[])) {
      let count = 0

      // Try registered pull endpoint first
      const { data: meterDef } = await supabaseServer
        .from('billing_meters')
        .select('pull_endpoint_url, pull_auth_token, pull_param_name')
        .or(`org_id.is.null,org_id.eq.${orgId}`)
        .eq('meter_key', cfg.meter_key)
        .maybeSingle()

      if (meterDef?.pull_endpoint_url) {
        try {
          const url = new URL(meterDef.pull_endpoint_url)
          url.searchParams.set('period_start', periodStart)
          url.searchParams.set('period_end',   periodEnd)
          if (meterDef.pull_param_name) url.searchParams.set(meterDef.pull_param_name, cfg.meter_key)
          const res  = await fetch(url.toString(), {
            headers: meterDef.pull_auth_token ? { Authorization: `Bearer ${meterDef.pull_auth_token}` } : {},
          })
          const data = await res.json() as { total_billable_units?: number }
          count = Number(data.total_billable_units ?? 0)
        } catch (err) {
          console.error(`[billing-engine] pull endpoint failed for ${cfg.meter_key}:`, err)
        }
      }

      if (count === 0) {
        const { data: usageSum } = await supabaseServer.rpc('sum_usage_for_period', {
          org_id_param:      orgId,
          meter_key_param:   cfg.meter_key,
          period_start:      periodStart,
          period_end:        periodEnd,
          include_simulated: false,
        })
        count = Number(usageSum ?? 0)
      }

      const tiers      = toOverageTiers(cfg.overage_tiers ?? [], cfg.meter_key)
      const included   = cfg.included_units ?? 0
      const overageAmt = tiers.length > 0 ? computeMetricOverage(count, tiers, included) : 0
      const overage    = Math.max(0, count - included)

      if (overageAmt > 0) {
        const label = cfg.meter_key.replace(/_/g, ' ')
        const unit  = overage === 1 ? label : `${label}s`
        lineItems.push({
          description: `${label.charAt(0).toUpperCase() + label.slice(1)} overage — ${overage.toLocaleString()} excess ${unit}`,
          amount_eur:  Math.round(overageAmt * 100) / 100,
          metadata:    {
            type: 'overage', meter_key: cfg.meter_key,
            count: String(count), overage: String(overage),
            source: cfg.source, billing_cycle: cfg.billing_cycle,
          },
        })
      }
    }

    // Base plan fee if applicable
    const plan = await getPlan(sub.plan_id)
    if (plan && plan.base_price_eur > 0) {
      lineItems.unshift({
        description: `${plan.name} — ${billingCycle}`,
        amount_eur:  plan.base_price_eur,
        metadata:    { type: 'base_fee', plan_id: sub.plan_id },
      })
    }
  } else {
    // Self-service / plan path
    const plan = await getPlan(sub.plan_id)
    if (!plan) throw new Error(`Plan not found: ${sub.plan_id}`)

    if (plan.base_price_eur > 0) {
      lineItems.push({
        description: `${plan.name}`,
        amount_eur:  plan.base_price_eur,
        metadata:    { type: 'base_fee', plan_id: sub.plan_id },
      })
    }

    const { data: syncSum } = await supabaseServer.rpc('sum_usage_for_period', {
      org_id_param:      orgId,
      meter_key_param:   'sync',
      period_start:      periodStart,
      period_end:        periodEnd,
      include_simulated: false,
    })

    const syncCount   = Number(syncSum ?? 0)
    const syncLimit   = plan.sync_limit ?? 0
    const syncOverage = Math.max(0, syncCount - syncLimit)

    if (syncOverage > 0 && (plan.overage_price_eur ?? 0) > 0) {
      lineItems.push({
        description: `Sync overage — ${syncOverage.toLocaleString()} excess syncs @ €${plan.overage_price_eur}/sync`,
        amount_eur:  Math.round(syncOverage * plan.overage_price_eur! * 100) / 100,
        metadata:    { type: 'sync_overage', count: String(syncCount), overage: String(syncOverage) },
      })
    }
  }

  const totalEur = Math.round(lineItems.reduce((s, i) => s + i.amount_eur, 0) * 100) / 100

  // ── Dry run — return without writing anything ──────────────────────────────
  if (opts?.dryRun) {
    return {
      org_id: orgId, period_start: periodStart, period_end: periodEnd,
      line_items: lineItems, total_eur: totalEur,
      invoice_id: null, invoice_url: null, dry_run: true, is_enterprise: isEnterprise,
    }
  }

  // ── Advance billing period in Verdix ───────────────────────────────────────
  const newPeriodEnd = advancePeriod(periodEnd, billingCycle)
  await supabaseServer.from('org_subscriptions').update({
    current_period_start: periodEnd,
    current_period_end:   newPeriodEnd,
    usage_counters:       {},
    syncs_used:           0,
    updated_at:           new Date().toISOString(),
  }).eq('org_id', orgId)

  if (lineItems.length === 0 || totalEur <= 0) {
    return {
      org_id: orgId, period_start: periodStart, period_end: periodEnd,
      line_items: [], total_eur: 0,
      invoice_id: null, invoice_url: null, dry_run: false, is_enterprise: isEnterprise,
    }
  }

  if (!sub.stripe_customer_id) {
    console.warn(`[billing-engine] No stripe_customer_id for org ${orgId} — period advanced, no invoice created`)
    return {
      org_id: orgId, period_start: periodStart, period_end: periodEnd,
      line_items: lineItems, total_eur: totalEur,
      invoice_id: null, invoice_url: null, dry_run: false, is_enterprise: isEnterprise,
    }
  }

  // ── Push to Stripe ─────────────────────────────────────────────────────────
  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

  for (const item of lineItems) {
    await stripe.invoiceItems.create({
      customer:    sub.stripe_customer_id,
      amount:      Math.round(item.amount_eur * 100),
      currency:    'eur',
      description: item.description,
      metadata:    item.metadata,
    })
  }

  const autoAdvance = !isEnterprise
  const periodLabel = new Date(periodStart).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })

  const invoice = await stripe.invoices.create({
    customer:     sub.stripe_customer_id,
    auto_advance: autoAdvance,
    currency:     'eur',
    description:  `Verdix billing — ${periodLabel}`,
    metadata:     {
      verdix_org_id: orgId,
      period_start:  periodStart,
      period_end:    periodEnd,
      source:        isEnterprise ? 'contract' : 'plan',
    },
  })

  if (autoAdvance) {
    await stripe.invoices.finalizeInvoice(invoice.id)
  }

  return {
    org_id: orgId, period_start: periodStart, period_end: periodEnd,
    line_items: lineItems, total_eur: totalEur,
    invoice_id:  invoice.id,
    invoice_url: (invoice as unknown as Record<string, unknown>).hosted_invoice_url as string | null ?? null,
    dry_run: false, is_enterprise: isEnterprise,
  }
}
