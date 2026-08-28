/**
 * POST /api/jobs/[id]/reconcile-line-items
 *
 * Step 17E.2, item 2 — the explicit, idempotent write path for repairing
 * an already-confirmed contract's STALE stored line_items (a placeholder
 * base-fee row left over from before it was confirmed; a
 * percentage_of_basis fee's stale "€0 / Usage-based" row from before Step
 * 17E's fix existed) — for a job confirmed before either fix existed, so
 * there is no confirm-rule call left to trigger it naturally going
 * forward. Deliberately a SEPARATE, explicit action from GET (which must
 * stay read-only — see app/api/jobs/[id]/route.ts) and from confirm-rule
 * (which already reconciles as part of ITS OWN write, right after a
 * reviewer's actual confirmation — this route exists for the legacy case
 * that write never happened for).
 *
 * Idempotent: a job with nothing stale returns { staleIds: [], freshItems: [] }
 * and writes nothing, on every call — safe to call any number of times,
 * including as a one-time backfill across every already-confirmed job.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { reconcileStaleLineItemsForJob } from '@/lib/line-items-reconciliation'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Same write-class gate as confirm-rule (the other place this exact
  // reconciliation happens) — this persists a correction to billing-
  // facing data, never merely confirms/views one.
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, currency, contract_terms ( * )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
  if (!terms) return NextResponse.json({ error: 'No contract terms on file for this job' }, { status: 400 })

  const currency = (job.currency as string | undefined) ?? terms.currency ?? 'USD'
  const result = await reconcileStaleLineItemsForJob({ jobId, terms, currency })

  return NextResponse.json({
    reconciled: result.staleIds.length > 0,
    staleIdsRemoved: result.staleIds.length,
    freshItemsInserted: result.freshItems.length,
  })
}
