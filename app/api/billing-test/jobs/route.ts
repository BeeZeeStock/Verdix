/**
 * GET /api/billing-test/jobs?org_id=<id>&meter_key=<key>
 *   Lists an org's agreements (jobs) for the Billing Test agreement picker —
 *   an org can have several bespoke agreements, each with its own confirmed
 *   meter tiers, so testing needs to target one specifically.
 *   org_id omitted  → caller must be an org admin; their own org is used.
 *   org_id provided → caller must be a platform admin (Verdix staff).
 *   meter_key provided → only jobs with a *confirmed* contract_meter_mappings
 *     row for that meter are returned — an org's other agreements (mapped to
 *     different meters, or unconfirmed) aren't valid simulation targets for
 *     the currently selected meter.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { requireAdmin } from '@/lib/admin'

async function resolveOrgId(bodyOrgId: string | null): Promise<string | Response> {
  if (bodyOrgId) {
    try { await requireAdmin() } catch (res) { return res as Response }
    return bodyOrgId
  }
  try {
    const org = await requireOrg('admin')
    return org.orgId
  } catch (res) {
    return res as Response
  }
}

export async function GET(req: NextRequest) {
  const url          = new URL(req.url)
  const orgIdParam   = url.searchParams.get('org_id')
  const meterKeyParam = url.searchParams.get('meter_key')
  const orgIdOrRes = await resolveOrgId(orgIdParam)
  if (orgIdOrRes instanceof Response) return orgIdOrRes
  const orgId = orgIdOrRes

  let jobIdFilter: string[] | null = null
  if (meterKeyParam) {
    const { data: mappedJobs } = await supabaseServer
      .from('contract_meter_mappings')
      .select('job_id, jobs!inner(org_id)')
      .eq('meter_key', meterKeyParam)
      .eq('confirmed', true)
      .eq('jobs.org_id', orgId)
    jobIdFilter = ((mappedJobs ?? []) as unknown as { job_id: string }[]).map(m => m.job_id)
    if (jobIdFilter.length === 0) return NextResponse.json({ jobs: [] })
  }

  let jobsQuery = supabaseServer
    .from('jobs')
    .select('id, created_at, contract_terms(customer_name)')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
  if (jobIdFilter) jobsQuery = jobsQuery.in('id', jobIdFilter)
  const { data: jobs } = await jobsQuery

  type JobRow = { id: string; created_at: string; contract_terms: { customer_name: string | null }[] }

  const result = ((jobs ?? []) as unknown as JobRow[]).map(j => ({
    id:    j.id,
    label: j.contract_terms?.[0]?.customer_name
      ?? `${j.id.slice(0, 8)}… — ${new Date(j.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
  }))

  return NextResponse.json({ jobs: result })
}
