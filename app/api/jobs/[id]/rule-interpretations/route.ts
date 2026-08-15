/**
 * GET /api/jobs/[id]/rule-interpretations
 *
 * Read-only: the current (is_current=true) approved interpretation for every
 * commercial rule confirmed on this job, so downstream views (Commercial
 * Terms' "Confirmed rules" card) can show who confirmed it and when, and
 * link back to the source clause / re-open the interpretation flow — without
 * duplicating that bookkeeping into contract_terms/contract_meter_mappings,
 * which only hold the current operational value, not the audit trail.
 *
 * Resilient to the audit table not existing yet (pending migration) — this
 * is a read for a nice-to-have enrichment, not the write path, so a missing
 * table degrades to "no confirmed-rule metadata available" rather than
 * breaking the page that renders it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireOrg() } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data, error } = await supabaseServer
    .from('commercial_rule_interpretations')
    .select('rule_type, contract_unit_type, source_clause, approved_interpretation, reviewer_email, reviewer_name, created_at, propagation_status')
    .eq('job_id', jobId)
    .eq('is_current', true)
    .order('created_at', { ascending: false })

  if (error) {
    if (error.message.includes('commercial_rule_interpretations')) return NextResponse.json({ interpretations: [] })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ interpretations: data ?? [] })
}
