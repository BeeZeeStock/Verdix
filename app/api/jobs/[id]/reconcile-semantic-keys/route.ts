/**
 * POST /api/jobs/[id]/reconcile-semantic-keys
 *
 * Step 17F.1, item 1 — the explicit, idempotent write path for backfilling
 * a MISSING additional_recurring_fees/overage_tiers.semantic_input_key on
 * a contract extracted before that field existed in the extraction prompt
 * (see lib/semantic-input-key-reconciliation.ts's own header for the
 * confirmed root cause). Deliberately a separate, explicit action — never
 * triggered from GET (which must stay read-only), never inferring from
 * fee_label/tier_label free text, only ever resolving via the strict
 * canonical registry applied to metric_name/unit_type.
 *
 * Idempotent: a job with nothing to resolve returns
 * { reconciled: false, feeUpdates: 0, tierUpdates: 0 } and writes nothing,
 * on every call.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { planSemanticInputKeyReconciliation, applySemanticInputKeyReconciliation, planMeterMappingSemanticKeyReconciliation } from '@/lib/semantic-input-key-reconciliation'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Same write-class gate as reconcile-line-items — this persists a
  // correction to billing-facing data, never merely confirms/views one.
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, contract_terms ( id, additional_recurring_fees, overage_tiers )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const terms = unwrapEmbedded(job.contract_terms as unknown as (ContractTerms & { id: string }) | (ContractTerms & { id: string })[])
  if (!terms) return NextResponse.json({ error: 'No contract terms on file for this job' }, { status: 400 })

  const fees = terms.additional_recurring_fees ?? []
  const tiers = terms.overage_tiers ?? []
  const plan = planSemanticInputKeyReconciliation({ fees, tiers })

  // Step 17F.1, item 3 — contract_meter_mappings.semantic_input_key is a
  // SEPARATE storage location real billing's snapshot-finalize path reads
  // (lib/usage-pull.ts) — resolved from the same strict registry, applied
  // to each row's own contract_unit_type, independent of the contract_terms
  // fee/tier reconciliation above (a job can need one, the other, or both).
  const { data: mappingRows } = await supabaseServer
    .from('contract_meter_mappings')
    .select('contract_unit_type, semantic_input_key')
    .eq('job_id', jobId)
  const mappingPlan = planMeterMappingSemanticKeyReconciliation({ mappings: mappingRows ?? [] })

  if (plan.feeUpdates.length === 0 && plan.tierUpdates.length === 0 && mappingPlan.mappingUpdates.length === 0) {
    return NextResponse.json({ reconciled: false, feeUpdates: 0, tierUpdates: 0, mappingUpdates: 0 })
  }

  if (plan.feeUpdates.length > 0 || plan.tierUpdates.length > 0) {
    const { fees: reconciledFees, tiers: reconciledTiers } = applySemanticInputKeyReconciliation({ fees, tiers, plan })
    const { error } = await supabaseServer
      .from('contract_terms')
      .update({ additional_recurring_fees: reconciledFees, overage_tiers: reconciledTiers })
      .eq('id', terms.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  for (const u of mappingPlan.mappingUpdates) {
    const { error } = await supabaseServer
      .from('contract_meter_mappings')
      .update({ semantic_input_key: u.semantic_input_key })
      .eq('job_id', jobId)
      .eq('contract_unit_type', u.contract_unit_type)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    reconciled: true,
    feeUpdates: plan.feeUpdates.length,
    tierUpdates: plan.tierUpdates.length,
    mappingUpdates: mappingPlan.mappingUpdates.length,
    resolvedKeys: [
      ...plan.feeUpdates.map(u => u.semantic_input_key),
      ...plan.tierUpdates.map(u => u.semantic_input_key),
      ...mappingPlan.mappingUpdates.map(u => u.semantic_input_key),
    ],
  })
}
