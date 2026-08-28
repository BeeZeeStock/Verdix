/**
 * POST /api/jobs/[id]/reconcile-fixed-fee-timing
 *
 * Step 17F.4, item 2 — the explicit, idempotent write path for backfilling
 * a MISSING fixed_fee_billing_timing on a contract extracted before that
 * field existed (Step 17F.3, item 2/8). See
 * lib/fixed-fee-billing-timing-reconciliation.ts's own header for why this
 * is a trivial, unconditional default — never an inference engine.
 * Deliberately a separate, explicit action — never triggered from GET
 * (which must stay read-only), never infers bill_at_period_start from
 * planned-invoice dates/scheduler behavior/cadence/payment terms.
 *
 * Idempotent: a job with nothing to backfill (no fixed fee, or a rule
 * already on file — resolved or not) returns { backfilled: false } and
 * writes nothing, on every call.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { planFixedFeeBillingTimingReconciliation } from '@/lib/fixed-fee-billing-timing-reconciliation'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Same write-class gate as the sibling reconciliation routes (reconcile-
  // line-items, reconcile-semantic-keys) — this persists a correction to
  // billing-facing data, never merely confirms/views one.
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, contract_terms ( id, base_monthly_fee, base_annual_fee, fixed_fee_billing_timing, base_fee_proration )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const terms = unwrapEmbedded(job.contract_terms as unknown as (ContractTerms & { id: string }) | (ContractTerms & { id: string })[])
  if (!terms) return NextResponse.json({ error: 'No contract terms on file for this job' }, { status: 400 })

  const plan = planFixedFeeBillingTimingReconciliation(terms)
  if (!plan.needsBackfill) {
    return NextResponse.json({ backfilled: false })
  }

  const { error } = await supabaseServer
    .from('contract_terms')
    .update({ fixed_fee_billing_timing: plan.rule })
    .eq('id', terms.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ backfilled: true, rule: plan.rule })
}
