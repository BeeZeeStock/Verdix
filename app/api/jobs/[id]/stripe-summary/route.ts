import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import type { ContractTerms } from '@/lib/types'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_subscription_id, billing_customer_id, billing_platform, contract_terms(*)')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!job.billing_subscription_id) return NextResponse.json({ error: 'No subscription configured' }, { status: 404 })
  if (job.billing_platform === 'chargebee') return NextResponse.json({ error: 'Chargebee not supported here' }, { status: 400 })

  const { data: integration } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', org.orgId)
    .eq('connector_name', 'stripe')
    .eq('is_active', true)
    .maybeSingle()

  const stripeKey = (integration?.config as Record<string, string>)?.secret_key ?? process.env.STRIPE_SECRET_KEY!

  const { default: Stripe } = await import('stripe')
  const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

  const subId        = job.billing_subscription_id
  const customerId   = job.billing_customer_id as string | null

  try {
    const [subscription, subscriptionInvRes, allCustomerInvRes, computedRes] = await Promise.all([
      stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] }),
      stripe.invoices.list({ subscription: subId, limit: 12 }),
      // Also fetch standalone (one-time fee) invoices for this customer.
      // These have no subscription attached and are identified by verdix_job metadata.
      customerId
        ? stripe.invoices.list({ customer: customerId, limit: 50 })
        : Promise.resolve({ data: [] }),
      supabaseServer
        .from('computed_invoices')
        .select('*')
        .eq('job_id', id)
        .order('period_start', { ascending: false }),
    ])

    const terms = (job.contract_terms as unknown as ContractTerms[])?.[0]

    // Build per-year payment schedule from contract terms
    const paymentSchedule = terms?.year_pricing
      ? Object.entries(terms.year_pricing).map(([key, amount]) => {
          const yearNum = parseInt(key.replace('year', ''), 10)
          const contractStart = terms?.contract_start_date ? new Date(terms.contract_start_date) : null
          let periodStart: string | null = null
          let periodEnd: string | null = null
          if (contractStart) {
            const ys = new Date(contractStart)
            ys.setFullYear(ys.getFullYear() + yearNum - 1)
            const ye = new Date(ys)
            ye.setFullYear(ye.getFullYear() + 1)
            ye.setDate(ye.getDate() - 1)
            periodStart = ys.toISOString().slice(0, 10)
            periodEnd   = ye.toISOString().slice(0, 10)
          }
          return { year: yearNum, amount, currency: terms?.currency ?? 'EUR', periodStart, periodEnd }
        })
      : null

    const baseItem = subscription.items.data[0]
    const recurringInterval      = baseItem?.price?.recurring?.interval       ?? 'month'
    const recurringIntervalCount = baseItem?.price?.recurring?.interval_count ?? 1

    // Separate standalone invoices from subscription invoices.
    // Subscription invoices are returned by invoices.list({ subscription: subId }).
    // Standalone invoices have no subscription and carry verdix_job metadata.
    // They fall into two categories:
    //   annual_base — pre-created year 2/3 drafts (invoice_type: 'annual_base')
    //   one_time    — PS / implementation fees (fee_type: 'one_time')
    const subscriptionInvIds = new Set(subscriptionInvRes.data.map(inv => inv.id))
    const standaloneInvoices = allCustomerInvRes.data.filter(inv => {
      if (subscriptionInvIds.has(inv.id)) return false
      const meta = inv.metadata as Record<string, string> | null
      return meta?.verdix_job === id
    })
    const annualDraftInvoices = standaloneInvoices.filter(inv => {
      const meta = inv.metadata as Record<string, string> | null
      return meta?.invoice_type === 'annual_base'
    })
    const oneTimeStandaloneInvoices = standaloneInvoices.filter(inv => {
      const meta = inv.metadata as Record<string, string> | null
      return meta?.invoice_type !== 'annual_base'
    })

    // current_period_start/end were removed in the dahlia API; derive from the
    // most-recent (non-void, non-draft) subscription invoice period instead.
    const latestInvoice = subscriptionInvRes.data.find(
      inv => inv.status !== 'void' && inv.status !== 'draft',
    ) ?? subscriptionInvRes.data[0]
    const currentPeriodStart = latestInvoice?.period_start
      ? new Date(latestInvoice.period_start * 1000).toISOString()
      : null
    const currentPeriodEnd = latestInvoice?.period_end
      ? new Date(latestInvoice.period_end * 1000).toISOString()
      : null

    // cancel_at_period_end may also have moved; access defensively.
    const sub = subscription as unknown as Record<string, unknown>
    const cancelAtPeriodEnd = typeof sub.cancel_at_period_end === 'boolean'
      ? sub.cancel_at_period_end
      : false

    const mapInvoice = (inv: import('stripe').Stripe.Invoice) => {
      const meta = inv.metadata as Record<string, string> | null
      return {
        id:          inv.id,
        number:      inv.number,
        status:      inv.status,
        amount:      (inv.amount_due ?? 0) / 100,
        currency:    inv.currency?.toUpperCase() ?? 'EUR',
        dueDate:     inv.due_date   ? new Date(inv.due_date   * 1000).toISOString() : null,
        created:     new Date(inv.created * 1000).toISOString(),
        pdfUrl:      inv.invoice_pdf         ?? null,
        hostedUrl:   inv.hosted_invoice_url  ?? null,
        feeLabel:    meta?.fee_label    ?? null,
        // For annual_base drafts: which contract year this covers
        yearNum:     meta?.year ? parseInt(meta.year, 10) : null,
        scheduledDate: meta?.scheduled_date ?? null,
      }
    }

    return NextResponse.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        interval: recurringInterval,
        intervalCount: recurringIntervalCount,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd,
        isTest: !subscription.livemode,
        dashboardUrl: `https://dashboard.stripe.com/${!subscription.livemode ? 'test/' : ''}subscriptions/${subscription.id}`,
      },
      // Annual base-fee invoices from the subscription (Year 1 + finalized later years)
      invoices: subscriptionInvRes.data.map(mapInvoice),
      // Pre-created annual base draft invoices for future years (Year 2+, status: draft)
      annualDraftInvoices: annualDraftInvoices.map(mapInvoice),
      // Separate one-time fee invoices (one per PS fee, created at push time)
      oneTimeInvoices: oneTimeStandaloneInvoices.map(mapInvoice),
      paymentSchedule,
      oneTimeFees: terms?.one_time_fees ?? [],
      contractStart: terms?.contract_start_date ?? null,
      currency: terms?.currency ?? 'EUR',
      computedInvoices: computedRes.data ?? [],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
