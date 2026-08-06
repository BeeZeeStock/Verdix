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
    .select('id, name, currency, billing_customer_id, execute_status, contract_terms ( * ), line_items ( * )')
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

  try {
    const existingCustomerId = (job as unknown as Record<string, unknown>).billing_customer_id as string | undefined
    const result = await configureBilling(terms, lineItems, billingPlatformOverride ?? undefined, id, org.orgId, existingCustomerId ?? undefined)

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
