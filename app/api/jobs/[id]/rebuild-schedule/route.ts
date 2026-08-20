import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { configureBilling, type LineItemInput } from '@/lib/billing-writer'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'

// Rebuilds planned_invoices from the current contract_terms when a job has a
// billing customer but no schedule yet (e.g. schedule generation was skipped
// or failed at approval time). Delegates to configureBilling — the same
// platform-aware function approve/route.ts uses — instead of hardcoding
// Stripe, so a job already committed to Remembill (or Chargebee) can never
// silently get billed through Stripe instead. Safe to call repeatedly:
// configureBilling's idempotent-repush logic leaves already-sent periods
// untouched rather than duplicating or re-charging them.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_customer_id, billing_platform, contract_terms(*), line_items(*)')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!job.billing_customer_id) return NextResponse.json({ error: 'No customer configured yet — approve the contract first' }, { status: 400 })

  // This route only ever rebuilds the schedule for whichever platform the
  // job was already configured on — never a fallback or default. A job with
  // no recorded platform can't be safely rebuilt without knowing where its
  // existing customer/subscription actually lives.
  const platform = job.billing_platform as 'stripe' | 'remembill' | 'chargebee' | null
  if (!platform) {
    return NextResponse.json({ error: 'This job has no billing platform recorded — re-approve the contract instead of rebuilding.' }, { status: 400 })
  }
  if (platform === 'chargebee') {
    return NextResponse.json({ error: 'Chargebee billing schedules can’t be rebuilt from here yet — contact support.' }, { status: 400 })
  }

  const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
  if (!terms) return NextResponse.json({ error: 'No contract terms' }, { status: 400 })

  const lineItems = (job.line_items ?? []) as LineItemInput[]

  try {
    const result = await configureBilling(
      terms, lineItems, platform, id, org.orgId, job.billing_customer_id as string,
    )
    const { count } = await supabaseServer
      .from('planned_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', id)
    return NextResponse.json({ ok: true, platform: result.platform, periods: count ?? 0 })
  } catch (err) {
    // Surface the real, actionable failure (e.g. a Remembill auth error, a
    // missing org number) instead of a generic message — this is exactly
    // what needs fixing before the schedule can be built.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[rebuild-schedule] configureBilling failed for job ${id} on ${platform}:`, err)
    return NextResponse.json({ error: `Failed to build the ${platform} billing schedule: ${message}` }, { status: 500 })
  }
}
