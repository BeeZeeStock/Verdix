import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { getBillingReconciliationState } from '@/lib/billing-reconciliation'

/**
 * GET /api/jobs/[id]/billing-reconciliation
 *
 * Step 15, item 19 — a narrow, read-only view onto the SAME derived state
 * the reconciliation resolver computes (lib/billing-reconciliation.ts).
 * Nothing here is persisted specifically for this endpoint: every field is
 * re-derived, on every request, from the immutable execution ledger
 * (billing_execution_attempts/operations) plus the current commercial
 * plan — which is exactly why this survives a page reload (item 24)
 * without depending on a previous HTTP 409 living in client state.
 *
 * Response is deliberately narrow (item 19): current reconciliation
 * state, the relevant attempt's provider/id, operation summaries (never
 * raw provider request/response bodies — the operations table itself
 * never stores those, only normalized error_class/external_object_id),
 * the correction assessment (assessment only, never an authorization to
 * act — item 17), and server-derived available actions (item 21) so the
 * client never has to guess which admin action is currently valid.
 *
 * Tenant/job ownership is server-derived throughout (item 19/26) — org
 * comes from the session, never the request; the job lookup is scoped to
 * both id and org_id, so a job belonging to a different org 404s exactly
 * like every other job-scoped route in this codebase.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params

  const { data: job } = await supabaseServer.from('jobs').select('id').eq('id', id).eq('org_id', org.orgId).maybeSingle()
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const result = await getBillingReconciliationState(id, org.orgId, new Date())

  return NextResponse.json(result)
}
