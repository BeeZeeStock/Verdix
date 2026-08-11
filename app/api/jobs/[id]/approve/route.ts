import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { configureBilling } from '@/lib/billing-writer'
import type { ContractTerms } from '@/lib/types'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params
  const body = await req.json()
  const { modifiedLineItems, billing_platform: billingPlatformOverride } = body

  const { data: job, error } = await supabaseServer
    .from('jobs')
    .select('id, name, currency, billing_customer_id, billing_platform, execute_status, contract_terms ( * ), line_items ( * )')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (error || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Capture status before we overwrite it — a re-push of an already-COMPLETED
  // job should not generate a second sync event.
  const wasAlreadyCompleted = (job as unknown as Record<string, unknown>).execute_status === 'COMPLETED'

  const termsArr = job.contract_terms as unknown as ContractTerms[]
  const terms = termsArr?.[0] ?? ({} as ContractTerms)
  const lineItems = (modifiedLineItems ?? job.line_items ?? []) as Array<{
    product_name: string; quantity: number; unit_price: number
    billing_period: string; total_amount: number; currency: string
  }>

  // Server-side mirror of the Configure page's Approve-button gate — the
  // client disables the button until every extracted usage metric has a
  // confirmed contract_meter_mappings row, but that's UI-only. Without this
  // check, a contract can be pushed to billing (base fee configured) while
  // its usage-based overage silently has no meter mapped to pull from —
  // real billing would then skip it every cycle with no visible error.
  const unitTypes = Array.from(new Set((terms.overage_tiers ?? []).map(t => t.unit_type).filter(Boolean)))
  if (unitTypes.length > 0) {
    const { data: mappings } = await supabaseServer
      .from('contract_meter_mappings')
      .select('contract_unit_type, confirmed')
      .eq('job_id', id)
    const confirmedTypes = new Set((mappings ?? []).filter(m => m.confirmed).map(m => m.contract_unit_type))
    const unconfirmed = unitTypes.filter(u => !confirmedTypes.has(u))
    if (unconfirmed.length > 0) {
      return NextResponse.json(
        { error: `Confirm billing meter mappings before approving: ${unconfirmed.join(', ')}` },
        { status: 400 },
      )
    }
  }

  try {
    const existingCustomerId = (job as unknown as Record<string, unknown>).billing_customer_id as string | undefined
    // A job already configured on a platform must stay on it — repushing
    // (e.g. to sync edited terms) must never silently switch platforms.
    // detectOrgPlatform() inside configureBilling picks arbitrarily among an
    // org's active connectors when more than one is configured, which is
    // only safe to fall back on for a job that's never been pushed before.
    const existingPlatform = (job as unknown as Record<string, unknown>).billing_platform as string | null
    const platformToUse = billingPlatformOverride ?? existingPlatform ?? undefined
    const result = await configureBilling(terms, lineItems, platformToUse, id, org.orgId, existingCustomerId ?? undefined)

    await supabaseServer.from('jobs').update({
      execute_status: 'COMPLETED',
      billing_platform: result.platform,
      billing_subscription_id: result.subscriptionId,
      billing_customer_id: result.customerId,
    }).eq('id', id)

    // Only count a sync event on the first successful configuration.
    // Re-pushing an already-configured contract to fix a mismatch does not
    // consume an additional sync credit.
    if (!wasAlreadyCompleted) {
      const { recordSync } = await import('@/lib/billing')
      await recordSync(org.orgId, id, 'contract_configure').catch(err => console.error('[approve] recordSync failed', err))
    }

    return NextResponse.json({
      success: true,
      platform: result.platform,
      stripeSubscriptionId: result.subscriptionId,
      customerId: result.customerId,
      dashboardUrl: result.dashboardUrl,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabaseServer.from('jobs').update({
      execute_status: 'FAILED',
      error_message: message,
    }).eq('id', id)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
