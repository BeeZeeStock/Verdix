/**
 * GET /api/billing-test/jobs?org_id=<id>
 *   Lists an org's agreements (jobs) for the Billing Test agreement picker —
 *   an org can have several bespoke agreements, each with its own confirmed
 *   meter tiers, so testing needs to target one specifically.
 *   org_id omitted  → caller must be an org admin; their own org is used.
 *   org_id provided → caller must be a platform admin (Verdix staff).
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
  const orgIdParam = new URL(req.url).searchParams.get('org_id')
  const orgIdOrRes = await resolveOrgId(orgIdParam)
  if (orgIdOrRes instanceof Response) return orgIdOrRes
  const orgId = orgIdOrRes

  const { data: jobs } = await supabaseServer
    .from('jobs')
    .select('id, created_at, contract_terms(customer_name)')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })

  type JobRow = { id: string; created_at: string; contract_terms: { customer_name: string | null }[] }

  const result = ((jobs ?? []) as unknown as JobRow[]).map(j => ({
    id:    j.id,
    label: j.contract_terms?.[0]?.customer_name
      ?? `${j.id.slice(0, 8)}… — ${new Date(j.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
  }))

  return NextResponse.json({ jobs: result })
}
