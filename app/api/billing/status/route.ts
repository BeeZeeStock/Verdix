import { NextResponse } from 'next/server'
import { getActiveOrg } from '@/lib/org'
import { getBillingContext, getAllPlans } from '@/lib/billing'
import { supabaseServer } from '@/lib/supabase'

export async function GET() {
  const org = await getActiveOrg()
  if (!org) return NextResponse.json({ error: 'No organisation' }, { status: 401 })

  // Reconcile Supabase against Stripe before returning status.
  // This self-heals when webhooks fail (e.g. wrong secret at time of checkout).
  await reconcileWithStripe(org.orgId)

  const [ctx, plans] = await Promise.all([
    getBillingContext(org.orgId),
    getAllPlans(),
  ])

  return NextResponse.json({ ...ctx, plans, orgId: org.orgId, orgName: org.orgName })
}

async function reconcileWithStripe(orgId: string) {
  try {
    const { data: sub } = await supabaseServer
      .from('org_subscriptions')
      .select('stripe_customer_id, stripe_subscription_id, plan_id, status')
      .eq('org_id', orgId)
      .maybeSingle()

    if (!sub?.stripe_customer_id) return

    const { default: Stripe } = await import('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-06-24.dahlia' })

    // List all active subscriptions for this customer in Stripe
    const list = await stripe.subscriptions.list({
      customer: sub.stripe_customer_id,
      status: 'active',
      expand: ['data.latest_invoice'],
      limit: 10,
    })

    if (list.data.length === 0) return

    // Pick the subscription with the highest-value plan (prefer pro over core)
    const PLAN_RANK: Record<string, number> = { trial: 0, core: 1, pro: 2, enterprise: 3 }
    const activeSub = list.data.reduce((best, s) => {
      const planId = s.metadata?.verdix_plan_id ?? 'core'
      const bestPlanId = best.metadata?.verdix_plan_id ?? 'core'
      return (PLAN_RANK[planId] ?? 0) >= (PLAN_RANK[bestPlanId] ?? 0) ? s : best
    })

    const stripePlanId = activeSub.metadata?.verdix_plan_id
    const stripeSubId  = activeSub.id
    const stripeStatus = activeSub.status

    // Check if PII addon is active on this subscription
    const { data: piiPlan } = await supabaseServer
      .from('verdix_plans')
      .select('stripe_price_id')
      .eq('id', 'pii_addon')
      .maybeSingle()

    const piiEnabled = piiPlan?.stripe_price_id
      ? activeSub.items.data.some(i => i.price.id === piiPlan.stripe_price_id)
      : undefined

    // Only update if something is out of sync
    const needsUpdate =
      sub.stripe_subscription_id !== stripeSubId ||
      (stripePlanId && sub.plan_id !== stripePlanId) ||
      sub.status !== stripeStatus

    if (!needsUpdate) return

    const invoice = activeSub.latest_invoice as import('stripe').default.Invoice | null

    const patch: Record<string, unknown> = {
      stripe_subscription_id: stripeSubId,
      status: stripeStatus,
      updated_at: new Date().toISOString(),
    }
    if (stripePlanId) patch.plan_id = stripePlanId
    if (invoice) {
      patch.current_period_start = new Date(invoice.period_start * 1000).toISOString()
      patch.current_period_end   = new Date(invoice.period_end   * 1000).toISOString()
    }
    if (piiEnabled !== undefined) patch.pii_addon_enabled = piiEnabled

    await supabaseServer
      .from('org_subscriptions')
      .update(patch)
      .eq('org_id', orgId)
  } catch (err) {
    // Reconciliation is best-effort — never block the status response
    console.error('[billing/status] reconcile error', err)
  }
}
