import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { REMEMBILL_BASE, remembillHeaders } from '@/lib/billing-writer'
import { AI_INFRA_ERROR_PREFIX } from '@/lib/ai-client'
import { isAdminEmail } from '@/lib/admin'
import { getContractSummaries } from '@/lib/contract-tcv'
import { removeStorageObject } from '@/lib/storage'
import { logDeletion } from '@/lib/deletion-log'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import { resolveStuckAttemptsForJob } from '@/lib/billing-execution-store'
import { planLineItemReconciliation } from '@/lib/line-items-reconciliation'

const GENERIC_INFRA_ERROR = 'This contract couldn’t be processed right now due to a temporary system issue. Please contact bilal@lynoraai.com for help.'

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
    .select('org_id, billing_platform, billing_subscription_id, billing_customer_id, contract_pdf_url, billing_csv_url')
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

  // Deleting the jobs row alone left the actual uploaded document sitting in
  // Storage forever — remove the underlying objects too, and log that it
  // happened (identifiers only, never content).
  for (const [objectType, stored] of [
    ['contract_pdf', job.contract_pdf_url],
    ['billing_csv', job.billing_csv_url],
  ] as const) {
    if (!stored) continue
    const result = await removeStorageObject(stored)
    await logDeletion({
      objectId: result.path ?? stored,
      objectType,
      orgId: job.org_id,
      reason: 'manual_delete',
      storageRemoved: result.removed,
      error: result.error ?? null,
    })
  }

  const { error } = await supabaseServer.from('jobs').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json()
  const { execute_status } = body

  // Step 13 final amendment, Part B item 9 — the explicit, manual-only
  // recovery path for a job stuck at execute_status: 'APPROVING' (e.g. the
  // server process died between claiming APPROVING and reaching a terminal
  // state — approve/route.ts's own try/catch covers every ordinary failure,
  // but cannot run at all if the process itself is killed mid-request).
  // Deliberately NOT automatic — no cron, no timeout-based retry. approve/
  // route.ts's catch block documents that neither Stripe's nor Remembill's
  // invoice-write calls are provably safe to blindly retry, so an automatic
  // transition back to a retryable state could itself cause a duplicate
  // invoice. A human must explicitly decide "I have checked the billing
  // platform, this is genuinely stuck, reset it for retry" — admin-gated,
  // same authorization bar as Approve/Revoke themselves (both
  // billing-execution-adjacent), unlike the ordinary READY_TO_APPROVE
  // promotion below which any org member can trigger.
  if (execute_status === 'FAILED') {
    let org
    try { org = await requireOrg('admin') } catch (res) { return res as Response }

    const { data: job } = await supabaseServer
      .from('jobs').select('org_id, execute_status').eq('id', id).single()
    if (!job || job.org_id !== org.orgId)
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (job.execute_status !== 'APPROVING')
      return NextResponse.json({ error: 'Cannot manually recover from current status — only a stuck "approving" job can be reset this way.' }, { status: 400 })

    const { data: recovered, error } = await supabaseServer
      .from('jobs')
      .update({
        execute_status: 'FAILED',
        error_message: 'Manually recovered from a stuck "approving" state — verify against Stripe/Remembill for a partial or duplicate invoice before retrying.',
      })
      .eq('id', id)
      .eq('execute_status', 'APPROVING') // re-assert atomically — no race with a concurrent legitimate completion
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!recovered || recovered.length === 0)
      return NextResponse.json({ error: 'Job is no longer in the "approving" state — it may have just completed or failed on its own.' }, { status: 409 })

    // Step 14, item 21 — a crash during this job's APPROVING window may
    // have left a non-terminal billing_execution_attempts row behind, with
    // no way to know whether it actually reached the provider. Resolving
    // it to outcome_uncertain here (never silently succeeded/failed_safe)
    // both records that honestly and frees the one-active-attempt-per-
    // job/provider uniqueness constraint for a future, explicitly
    // authorized retry — without this, authorize-billing-retry's own next
    // Approve would otherwise be permanently blocked by the orphaned row.
    const resolvedAttemptIds = await resolveStuckAttemptsForJob(id)
    if (resolvedAttemptIds.length > 0) {
      console.log('[jobs/route] resolved stuck execution attempts to outcome_uncertain during crash recovery:', resolvedAttemptIds)
    }

    // From here the job sits at FAILED like any other failed attempt — the
    // next step, once the admin has actually verified the billing platform,
    // is POST /api/jobs/[id]/authorize-billing-retry (item 5), not a normal
    // Approve call — approve/route.ts's claim boundary no longer accepts
    // FAILED as a source state at all.
    return NextResponse.json({ ok: true })
  }

  if (execute_status !== 'READY_TO_APPROVE')
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })

  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

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

  // An AI-infra failure (out of Anthropic credit, rate-limited, timed out) is
  // an admin problem to go fix, not something a customer viewing their own
  // job can do anything about — never show them the raw technical detail.
  const rawError = job.error_message as string | null
  if (rawError?.startsWith(AI_INFRA_ERROR_PREFIX)) {
    job.error_message = isAdminEmail(org.userEmail)
      ? rawError.slice(AI_INFRA_ERROR_PREFIX.length)
      : GENERIC_INFRA_ERROR
  }

  // Billed to date / Committed contract value — the same canonical figures
  // used by the "New contracts" list and Agreements dashboard, so this
  // page's Commercials footer can never silently diverge from them.
  const summaries = await getContractSummaries([id])
  const summary = summaries[id]

  // The frontend (and its Terms[] type) expects contract_terms as an array,
  // matching how PostgREST used to embed this relationship. Adding
  // contract_terms_job_id_unique made PostgREST recognize it as one-to-one
  // and start returning a single object instead — normalized back to an
  // array here, at the one place this response is built, rather than
  // touching every frontend read site.
  const normalizedTerms = unwrapEmbedded(job.contract_terms as unknown as Record<string, unknown> | Record<string, unknown>[])

  // Step 17E.2, item 1 — GET must stay read-only: a genuine page-load
  // side effect that silently rewrites persisted billing data on an
  // ordinary read is exactly the kind of implicit write this route must
  // never perform, regardless of how "self-healing" the intent. Detection
  // and correction of stale generated rows still happens on every read —
  // via planLineItemReconciliation, the SAME PURE function the explicit
  // write path below uses — but only to shape THIS response's in-memory
  // view; nothing is ever deleted/inserted here. A row this view
  // regenerates carries a locally-minted id (never persisted), so it
  // renders correctly but is not yet editable via saveLineItemField until
  // the explicit reconciliation write (POST /api/jobs/[id]/reconcile-
  // line-items, or a reviewer's own confirm-rule call) actually persists
  // it — an accepted, deliberate consequence of GET never writing.
  let responseLineItems = job.line_items as Array<{ id: string; product_name: string }>
  if (normalizedTerms && responseLineItems?.length > 0) {
    const currency = (job.currency as string | undefined) ?? (normalizedTerms as { currency?: string }).currency ?? 'USD'
    const plan = planLineItemReconciliation({
      terms: normalizedTerms as unknown as Parameters<typeof planLineItemReconciliation>[0]['terms'],
      currency,
      existingItems: responseLineItems.map(i => ({ id: i.id, product_name: i.product_name })),
    })
    if (plan.staleIds.length > 0) {
      const staleIdSet = new Set(plan.staleIds)
      responseLineItems = [
        ...responseLineItems.filter(i => !staleIdSet.has(i.id)),
        ...plan.freshItems.map(item => ({ ...item, id: crypto.randomUUID(), job_id: id })),
      ] as Array<{ id: string; product_name: string }>
    }
  }

  return NextResponse.json({
    ...job,
    line_items: responseLineItems,
    contract_terms: normalizedTerms ? [normalizedTerms] : [],
    billedToDate: summary?.billedToDate ?? 0,
    committedContractValue: summary?.committedContractValue ?? 0,
    // Step 17A hardening (review pass 2), item 3 — the same
    // readiness-aware resolution every other surface exposes; the page's
    // own inline resolveCommittedFixedFeeValue call (using live, possibly
    // unsaved terms state) is authoritative for its main KPI card, but
    // this lets any other server-driven read of committedContractValue on
    // this page know it may be 0-because-unresolved rather than a real
    // zero-value contract.
    committedFixedFeesResolution: summary?.committedFixedFeesResolution ?? null,
  })
}
