import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

async function getStripeKey(orgId: string): Promise<string> {
  const { data } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', orgId)
    .eq('connector_name', 'stripe')
    .eq('is_active', true)
    .single()
  return (data?.config as Record<string, string>)?.secret_key ?? process.env.STRIPE_SECRET_KEY!
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_platform, billing_subscription_id, billing_customer_id')
    .eq('id', id)
    .single()
  if (!job || job.org_id !== org.orgId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // For Stripe: void any open/draft invoices and cancel the subscription.
  if (job.billing_platform !== 'chargebee' && job.billing_subscription_id) {
    try {
      const stripeKey = await getStripeKey(org.orgId)
      const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

      // Void/delete all Stripe invoices for this job:
      //   • Subscription invoices tracked in computed_invoices
      //   • Standalone one-time fee invoices identified by verdix_job metadata
      const customerId = job.billing_customer_id as string | null

      const [{ data: computedInvoices }, customerInvoicesRes] = await Promise.all([
        supabaseServer
          .from('computed_invoices')
          .select('external_invoice_id')
          .eq('job_id', id)
          .not('external_invoice_id', 'is', null),
        customerId
          ? stripe.invoices.list({ customer: customerId, limit: 100 })
          : Promise.resolve({ data: [] }),
      ])

      const subscriptionInvIds = new Set(
        (computedInvoices ?? []).map(r => r.external_invoice_id).filter(Boolean)
      )
      const standaloneInvIds = customerInvoicesRes.data
        .filter(inv => {
          const meta = inv.metadata as Record<string, string> | null
          return !subscriptionInvIds.has(inv.id) && meta?.verdix_job === id
        })
        .map(inv => inv.id)

      await Promise.all(
        [...subscriptionInvIds, ...standaloneInvIds].map(async (invId) => {
          try {
            const inv = await stripe.invoices.retrieve(invId as string)
            if (inv.status === 'open') await stripe.invoices.voidInvoice(invId as string)
            else if (inv.status === 'draft') await stripe.invoices.del(invId as string)
          } catch { /* already voided/deleted — ignore */ }
        })
      )

      await stripe.subscriptions.cancel(job.billing_subscription_id).catch((err: Error) => {
        if (!err.message.includes('No such subscription')) throw err
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { error: `Failed to clean up Stripe billing: ${message}` },
        { status: 502 }
      )
    }
  }

  // Cancel Chargebee subscription.
  if (job.billing_platform === 'chargebee' && job.billing_subscription_id) {
    try {
      const { data: integration } = await supabaseServer
        .from('org_integrations')
        .select('config')
        .eq('org_id', org.orgId)
        .eq('connector_name', 'chargebee')
        .eq('is_active', true)
        .single()
      const cfg = integration?.config as Record<string, string> | null
      const site   = cfg?.site   ?? process.env.CHARGEBEE_SITE!
      const apiKey = cfg?.api_key ?? process.env.CHARGEBEE_API_KEY!
      await fetch(
        `https://${site}.chargebee.com/api/v2/subscriptions/${job.billing_subscription_id}/cancel_for_items`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { error: `Failed to cancel billing subscription: ${message}` },
        { status: 502 }
      )
    }
  }

  // Delete child rows first in case DB lacks cascade rules
  await supabaseServer.from('computed_invoices').delete().eq('job_id', id)
  await supabaseServer.from('partner_findings').delete().eq('job_id', id)
  await supabaseServer.from('partner_invoices').delete().eq('job_id', id)
  await supabaseServer.from('leakage_findings').delete().eq('job_id', id)
  await supabaseServer.from('line_items').delete().eq('job_id', id)
  await supabaseServer.from('contract_terms').delete().eq('job_id', id)

  const { error } = await supabaseServer.from('jobs').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params
  const body = await req.json()
  const { execute_status } = body

  if (execute_status !== 'READY_TO_APPROVE')
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })

  const { data: job } = await supabaseServer
    .from('jobs').select('org_id, execute_status').eq('id', id).single()
  if (!job || job.org_id !== org.orgId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (job.execute_status !== 'PENDING_HUMAN_REVIEW')
    return NextResponse.json({ error: 'Cannot promote from current status' }, { status: 400 })

  const { error } = await supabaseServer
    .from('jobs').update({ execute_status: 'READY_TO_APPROVE' }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id } = await params

  const { data: job, error } = await supabaseServer
    .from('jobs')
    .select(`
      id, name, module, status, execute_status, currency, error_message, contract_pdf_url, created_at, updated_at, billing_subscription_id, billing_platform, billing_customer_id,
      contract_terms ( * ),
      line_items ( * ),
      leakage_findings ( * ),
      partner_invoices ( * ),
      partner_findings ( * )
    `)
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json(job)
}
