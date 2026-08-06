import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { REMEMBILL_BASE, remembillHeaders } from '@/lib/billing-writer'

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

  const platform = (job.billing_platform as string | null) ?? 'stripe'

  // For Stripe: only void/delete non-sent invoices — sent ones represent real
  // payment obligations the customer has received.
  // For Remembill: delete ALL invoices associated with this job. Remembill has no
  // payment processing, and broken pushes (e.g. failed row creation) leave empty
  // invoices marked 'sent' in our DB but still unsent in Remembill's UI.
  const statusFilter = platform === 'remembill'
    ? ['scheduled', 'draft', 'parked', 'processing', 'sent']
    : ['scheduled', 'draft', 'parked', 'processing']

  const { data: plannedToClean } = await supabaseServer
    .from('planned_invoices')
    .select('stripe_invoice_id, status')
    .eq('job_id', id)
    .in('status', statusFilter)
    .not('stripe_invoice_id', 'is', null)

  const unsentExternalIds = (plannedToClean ?? [])
    .map(r => r.stripe_invoice_id as string)
    .filter(Boolean)

  // ── Stripe cleanup ──────────────────────────────────────────────────────────
  if (platform === 'stripe') {
    try {
      const stripeKey = await getStripeKey(org.orgId)
      const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

      // Void/delete unsent planned invoices tracked in planned_invoices.
      // Also catch any subscription invoices in computed_invoices and
      // standalone one-time invoices identified by verdix_job metadata.
      const customerId = job.billing_customer_id as string | null
      const { data: computedInvoices } = await supabaseServer
        .from('computed_invoices')
        .select('external_invoice_id')
        .eq('job_id', id)
        .not('external_invoice_id', 'is', null)

      const computedIds = (computedInvoices ?? []).map(r => r.external_invoice_id as string).filter(Boolean)

      let standaloneIds: string[] = []
      if (customerId) {
        const customerInvs = await stripe.invoices.list({ customer: customerId, limit: 100 }).catch(() => ({ data: [] }))
        standaloneIds = customerInvs.data
          .filter(inv => {
            const meta = inv.metadata as Record<string, string> | null
            return meta?.verdix_job === id
          })
          .map(inv => inv.id)
      }

      const allIds = [...new Set([...unsentExternalIds, ...computedIds, ...standaloneIds])]
      await Promise.all(allIds.map(async (invId) => {
        try {
          const inv = await stripe.invoices.retrieve(invId)
          if (inv.status === 'open') await stripe.invoices.voidInvoice(invId)
          else if (inv.status === 'draft') await stripe.invoices.del(invId)
        } catch { /* already voided/deleted */ }
      }))

      if (job.billing_subscription_id) {
        await stripe.subscriptions.cancel(job.billing_subscription_id as string).catch((err: Error) => {
          if (!err.message.includes('No such subscription')) throw err
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: `Failed to clean up Stripe billing: ${message}` }, { status: 502 })
    }
  }

  // ── Remembill cleanup ───────────────────────────────────────────────────────
  // Delete all Remembill invoices for this job (including 'sent' in our DB) —
  // broken pushes leave empty invoices in Remembill that appear unsent there.
  if (platform === 'remembill' && unsentExternalIds.length > 0) {
    try {
      const { data: rbInt } = await supabaseServer
        .from('org_integrations')
        .select('config')
        .eq('org_id', org.orgId)
        .eq('connector_name', 'remembill')
        .eq('is_active', true)
        .maybeSingle()
      const rbKey = (rbInt?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
      const h = remembillHeaders(rbKey)
      await Promise.all(
        unsentExternalIds.map(invId =>
          fetch(`${REMEMBILL_BASE}/invoices/${invId}`, { method: 'DELETE', headers: h })
            .catch(err => console.error('[delete/remembill] invoice delete failed', invId, err))
        )
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: `Failed to clean up Remembill billing: ${message}` }, { status: 502 })
    }
  }

  // ── Chargebee cleanup ───────────────────────────────────────────────────────
  if (platform === 'chargebee' && job.billing_subscription_id) {
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
      return NextResponse.json({ error: `Failed to cancel Chargebee subscription: ${message}` }, { status: 502 })
    }
  }

  // Delete child rows first in case DB lacks cascade rules
  await supabaseServer.from('planned_invoices').delete().eq('job_id', id)
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
